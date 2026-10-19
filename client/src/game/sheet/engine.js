// Движок листов Roll20: атрибуты со значениями по умолчанию, события sheet workers,
// повторяющиеся секции, кнопки бросков и действий, Custom Roll Parsing.
import { api } from '../../api.js';
import { lc, attrString } from '@shared/attrs.js';
import { generateRowID } from '@shared/ids.js';
import { rollExpression } from '@shared/dice.js';
import { SheetTemplate, splitMaxName } from './template.js';
import { SheetWorkerHost } from './worker.js';
import { Emitter } from '../store.js';
import { newBar } from '@shared/defaults.js';
import { R20_FONTS_CSS } from './base-css.js';

const REP_RE = /^repeating_([^_]+)_([^_]+)_(.+)$/i;

export class SheetEngine extends Emitter {
  constructor(store, net, hooks = {}) {
    super();
    this.store = store;
    this.net = net;
    this.hooks = hooks;
    this.template = null;
    this.worker = null;
    this.pendingRows = new Map(); // charId -> Map(lcSection -> [rowId])
    this.loading = null;
    this.styleEl = null;
    this.macro = null; // назначается приложением
    this.jqHandlers = []; // обработчики $20(selector).on(...) из скриптов листа
  }

  get ready() {
    return !!this.template;
  }

  async load() {
    const sheetId = this.store.game?.sheetId;
    if (this.worker) this.worker.stop();
    this.worker = null;
    this.template = null;
    this.jqHandlers = [];
    this.pendingRows.clear();
    if (!sheetId) {
      this.injectCss('');
      this.emit('loaded', null);
      return null;
    }
    const lang = this.store.settings.sheetLanguage || 'ru';
    this.loading = api.get(`/api/sheets/${sheetId}/bundle?lang=${encodeURIComponent(lang)}`);
    try {
      const bundle = await this.loading;
      this.template = new SheetTemplate(bundle);
      this.worker = new SheetWorkerHost(this);
      this.injectCss(this.template.chatCss());
      this.emit('loaded', this.template);
      // запускаем воркер заранее
      this.worker.start();
      return this.template;
    } catch (e) {
      console.error('[sheet] не удалось загрузить лист', e);
      this.hooks.error?.('Не удалось загрузить лист персонажа: ' + e.message);
      this.emit('loaded', null);
      return null;
    }
  }

  injectCss(css) {
    if (!this.styleEl) {
      this.styleEl = document.createElement('style');
      this.styleEl.id = 'sheet-chat-css';
      document.head.appendChild(this.styleEl);
    }
    // шаблоны бросков в чате тоже пользуются Pictos/dicefont
    this.styleEl.textContent = R20_FONTS_CSS + '\n' + (css || '');
  }

  ensure(charId) {
    return this.net.ensureAttrs(charId);
  }

  // -------------------------------------------------------------------
  // Чтение атрибутов
  // -------------------------------------------------------------------

  /** Раскрыть неявную строку: repeating_sec_field → repeating_sec_<row>_field */
  expandRowName(name, rowCtx) {
    if (!rowCtx || !/^repeating_/i.test(name)) return name;
    const m = /^repeating_([^_]+)_(.+)$/i.exec(name);
    if (!m) return name;
    if (lc(m[1]) !== lc(rowCtx.section)) return name;
    const rest = m[2];
    const first = rest.split('_')[0];
    if (/^[-$]/.test(first) || this.rowExists(rowCtx.charId, m[1], first)) return name;
    return `repeating_${m[1]}_${rowCtx.rowId}_${rest}`;
  }

  rowExists(charId, section, rowId) {
    if (!charId) return false;
    return this.sectionIds(charId, section).some((id) => lc(id) === lc(rowId));
  }

  /** «Сырое» значение атрибута (с учётом значений по умолчанию листа) */
  rawValue(charId, name) {
    const ln = lc(name);
    const ch = this.store.col.char.get(charId);
    if (ln === 'character_name') return ch?.name ?? '';
    if (ln === 'character_id') return charId;
    if (ln === 'character_avatar') return ch?.avatar ?? '';
    // изображение токена по умолчанию (как в Roll20 — только для чтения)
    if (ln === 'character_token') return ch?.defaultToken?.src || ch?.defaultToken?.imgsrc || '';
    const { base, max } = splitMaxName(name);
    const a = this.store.getAttr(charId, base);
    if (a) return max ? a.max : a.current;
    // $N в повторяющихся секциях
    const idx = /^repeating_([^_]+)_\$(\d+)_(.+)$/i.exec(base);
    if (idx) {
      const ids = this.sectionIds(charId, idx[1]);
      const rid = ids[Number(idx[2])];
      if (!rid) return undefined;
      return this.rawValue(charId, `repeating_${idx[1]}_${rid}_${idx[3]}${max ? '_max' : ''}`);
    }
    if (this.template) {
      const d = this.template.defaultFor(name);
      if (d !== undefined) {
        // поле по умолчанию существует только для существующих строк
        const rep = REP_RE.exec(base);
        if (rep && !this.rowExists(charId, rep[1], rep[2])) return undefined;
        return d;
      }
    }
    return undefined;
  }

  attrValue(charId, name) {
    const v = this.rawValue(charId, name);
    return v === undefined ? undefined : attrString(v);
  }

  /** Для getAttrs: ключи как запрошены */
  getAttrsFor(charId, names, row) {
    const out = {};
    const rowCtx = row ? { ...row, charId } : null;
    for (const n of names || []) {
      const full = this.expandRowName(n, rowCtx);
      const v = this.rawValue(charId, full);
      if (v !== undefined) out[n] = v;
    }
    return out;
  }

  /** ID строк секции. creationOrder — порядок создания (как getSectionIDs в Roll20), иначе порядок показа */
  sectionIds(charId, section, { creationOrder = false } = {}) {
    let sec = String(section || '');
    if (/^repeating_/i.test(sec)) sec = sec.slice(10);
    const prefix = 'repeating_' + lc(sec) + '_';
    const seen = new Map(); // lc id -> id
    const m = this.store.attrMap(charId);
    if (m) {
      for (const [key, a] of m) {
        if (!key.startsWith(prefix)) continue;
        const rest = a.name.slice(prefix.length);
        const id = rest.split('_')[0];
        if (!id) continue;
        if (!seen.has(lc(id))) seen.set(lc(id), id);
      }
    }
    const pend = this.pendingRows.get(charId)?.get(lc(sec)) || [];
    for (const id of pend) if (!seen.has(lc(id))) seen.set(lc(id), id);
    let ids = [...seen.values()];
    if (creationOrder) return ids;
    const ro = this.store.getAttr(charId, `_reporder_repeating_${sec}`);
    if (ro && ro.current) {
      const order = String(ro.current)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const byLc = new Map(ids.map((id) => [lc(id), id]));
      const out = [];
      for (const o of order) {
        const id = byLc.get(lc(o));
        if (id) {
          out.push(id);
          byLc.delete(lc(o));
        }
      }
      ids = [...out, ...byLc.values()];
    }
    return ids;
  }

  addRow(charId, section) {
    const id = generateRowID();
    let m = this.pendingRows.get(charId);
    if (!m) this.pendingRows.set(charId, (m = new Map()));
    const k = lc(section);
    m.set(k, [...(m.get(k) || []), id]);
    this.emit('rows', charId, section);
    return id;
  }

  // -------------------------------------------------------------------
  // Изменение атрибутов
  // -------------------------------------------------------------------

  /**
   * setAttrs в стиле Roll20.
   * values: {имя: значение}; opts: {source: 'player'|'sheetworker', silent, rowCtx}
   */
  setAttrs(charId, values, opts = {}) {
    const rowCtx = opts.rowCtx ? { ...opts.rowCtx, charId } : null;
    const sets = new Map();
    const changes = [];
    for (const [k0, v0] of Object.entries(values || {})) {
      const name = this.expandRowName(k0, rowCtx);
      const ln = lc(name);
      let v = v0;
      if (v === undefined) continue;
      if (v === null) v = '';
      if (typeof v === 'boolean') v = v ? 'on' : 0;
      if (typeof v === 'object') v = JSON.stringify(v);
      if (ln === 'character_name') {
        const ch = this.store.col.char.get(charId);
        if (ch && ch.name !== String(v)) this.net.update('char', charId, { name: String(v) });
        continue;
      }
      if (ln === 'character_id' || ln === 'character_avatar' || ln === 'character_token') continue;
      const { base, max } = splitMaxName(name);
      const existing = this.store.getAttr(charId, base);
      const prevRaw = existing ? (max ? existing.max : existing.current) : this.template?.defaultFor(name);
      const prev = prevRaw === undefined ? undefined : prevRaw;
      const key = lc(base);
      let s = sets.get(key);
      if (!s) {
        s = { name: existing?.name || base };
        sets.set(key, s);
      }
      s[max ? 'max' : 'current'] = v;
      if (String(prev ?? '') !== String(v) || (!existing && prev === undefined)) changes.push({ name, base, max, prev, next: v });
      // новая строка больше не «ожидающая»
      const rep = REP_RE.exec(base);
      if (rep) this.dropPending(charId, rep[1], rep[2]);
    }
    if (!sets.size) return;
    this.net.setAttrs(charId, [...sets.values()], [], [], { source: opts.source || 'sheetworker' });
    if (!opts.silent && changes.length) this.fireChanges(charId, changes, opts.source || 'sheetworker');
  }

  dropPending(charId, section, rowId) {
    const m = this.pendingRows.get(charId);
    const k = lc(section);
    if (!m?.has(k)) return;
    m.set(
      k,
      m.get(k).filter((id) => lc(id) !== lc(rowId)),
    );
  }

  fireChanges(charId, changes, source) {
    if (!this.worker) return;
    for (const c of changes) {
      const full = lc(c.name);
      const base = lc(c.base);
      const events = [];
      const rep = REP_RE.exec(base);
      if (/^_reporder_repeating_/i.test(base)) {
        const sec = base.slice('_reporder_repeating_'.length);
        events.push(`change:_reporder:${sec}`, `change:_reporder_repeating_${sec}`, `change:_reporder:repeating_${sec}`);
      } else if (rep) {
        events.push(`change:repeating_${rep[1]}:${rep[3]}`, `change:repeating_${rep[1]}:${rep[3]}_max`, `change:repeating_${rep[1]}`);
      } else {
        events.push(`change:${base}`, `change:${base}_max`);
      }
      const info = {
        sourceAttribute: full,
        sourceType: source,
        previousValue: c.prev === undefined ? undefined : c.prev,
        newValue: c.next,
        triggerName: 'change:' + full,
      };
      const row = rep ? { section: rep[1], rowId: rep[2] } : null;
      this.worker.dispatch(charId, events, info, row);
    }
  }

  removeRepeatingRow(charId, rowName, source = 'player') {
    const m = /^repeating_([^_]+)_([^_]+)$/i.exec(String(rowName).replace(/_$/, ''));
    if (!m) return;
    const [, section, rowId] = m;
    const prefix = `repeating_${section}_${rowId}_`;
    const removedInfo = {};
    const map = this.store.attrMap(charId);
    if (map) {
      for (const [k, a] of map) {
        if (k.startsWith(lc(prefix))) {
          removedInfo[lc(a.name)] = a.current;
          if (a.max !== '' && a.max !== undefined) removedInfo[lc(a.name) + '_max'] = a.max;
        }
      }
    }
    this.dropPending(charId, section, rowId);
    const sets = [];
    const ro = this.store.getAttr(charId, `_reporder_repeating_${section}`);
    if (ro && ro.current) {
      const order = String(ro.current)
        .split(',')
        .filter((x) => x && lc(x) !== lc(rowId));
      sets.push({ name: ro.name, current: order.join(',') });
    }
    this.net.setAttrs(charId, sets, [], [prefix], { source });
    this.emit('rows', charId, section);
    this.worker?.dispatch(charId, [`remove:repeating_${lc(section)}`, `remove:repeating_${lc(section)}:${lc(rowId)}`], { sourceAttribute: lc(`repeating_${section}_${rowId}`), sourceType: source, removedInfo, triggerName: `remove:repeating_${lc(section)}` });
  }

  reorderRows(charId, section, ids) {
    this.setAttrs(charId, { [`_reporder_repeating_${section}`]: ids.join(',') }, { source: 'player' });
  }

  // -------------------------------------------------------------------
  // События листа
  // -------------------------------------------------------------------

  sheetOpened(charId) {
    this.worker?.dispatch(charId, ['sheet:opened'], { sourceType: 'player', triggerName: 'sheet:opened' });
  }

  triggerClick(charId, name, rowCtx, htmlAttributes = {}, extra = {}) {
    const n = lc(name);
    let events, src;
    if (rowCtx) {
      src = lc(`repeating_${rowCtx.section}_${rowCtx.rowId}_${name}`);
      events = [`clicked:repeating_${lc(rowCtx.section)}:${n}`, `clicked:repeating_${lc(rowCtx.section)}`];
    } else {
      src = n;
      events = [`clicked:${n}`];
    }
    this.worker?.dispatch(charId, events, { sourceAttribute: src, sourceType: 'player', triggerName: 'clicked:' + src, htmlAttributes, ...extra }, rowCtx ? { section: rowCtx.section, rowId: rowCtx.rowId } : null);
  }

  // -------------------------------------------------------------------
  // Кнопки бросков и действий (для %{перс|кнопка})
  // -------------------------------------------------------------------

  /** Найти кнопку броска по ссылке: имя, repeating_sec_$0_имя, repeating_sec_<id>_имя */
  findButton(charId, ref) {
    const tpl = this.template;
    if (!tpl) return null;
    const r = String(ref);
    const rep = /^repeating_([^_]+)_([^_]+)_(.+)$/i.exec(r);
    if (rep) {
      const sec = lc(rep[1]);
      let rowId = rep[2];
      if (rowId.startsWith('$')) rowId = this.sectionIds(charId, rep[1])[Number(rowId.slice(1))];
      if (!rowId) return null;
      const btn = lc(rep[3]).replace(/^roll_/, '').replace(/^act_/, '');
      const rb = tpl.repRollButtons.get(sec);
      if (rb?.has(btn)) return { kind: 'roll', value: rb.get(btn), rowCtx: { section: rep[1], rowId } };
      if (tpl.repActionButtons.get(sec)?.has(btn)) return { kind: 'action', name: btn, rowCtx: { section: rep[1], rowId } };
      return null;
    }
    const k = lc(r).replace(/^roll_/, '');
    if (tpl.rollButtons.has(k)) return { kind: 'roll', value: tpl.rollButtons.get(k), rowCtx: null };
    const a = lc(r).replace(/^act_/, '');
    if (tpl.actionButtons.has(a)) return { kind: 'action', name: a, rowCtx: null };
    return null;
  }

  runRollButton(charId, value, rowCtx) {
    if (!this.macro) return;
    return this.macro.run(value, { charId, rowCtx, source: 'button' });
  }

  // -------------------------------------------------------------------
  // Custom Roll Parsing
  // -------------------------------------------------------------------

  async startRoll(charId, text, row) {
    if (!this.macro) return null;
    const res = await this.macro.run(text, { charId, rowCtx: row, source: 'crp', defer: true });
    const r = Array.isArray(res) ? res.find((x) => x && x.rollId) : null;
    if (!r) {
      if (Array.isArray(res)) {
        const err = res.find((x) => x?.error);
        if (err) this.hooks.error?.(err.error);
      }
      return null;
    }
    return { rollId: r.rollId, results: r.results || {} };
  }

  finishRoll(rollId, computed) {
    this.net.request('roll:finish', { rollId, computed }).then((r) => r?.error && console.warn('[crp]', r.error));
  }

  /** «Настройки листа по умолчанию» (useroptions) для нового персонажа */
  async applyUserOptions(charId) {
    const opts = this.store.settings.sheetOptions || {};
    const keys = Object.keys(opts);
    if (!keys.length || !this.template) return;
    await this.ensure(charId);
    const values = {};
    for (const k of keys) values[k] = opts[k];
    this.setAttrs(charId, values, { source: 'player', silent: true });
  }

  // -------------------------------------------------------------------
  // Токен по умолчанию (setDefaultToken)
  // -------------------------------------------------------------------

  setDefaultToken(charId, values) {
    const ch = this.store.col.char.get(charId);
    if (!ch || !this.store.canControlChar(ch)) return;
    const t = { ...(ch.defaultToken || {}) };
    const bars = Array.isArray(t.bars) ? [...t.bars] : [];
    const barColor = ['#3eaa49', '#3b7bd8', '#d63a3a'];
    for (let i = 1; i <= 3; i++) {
      const link = values[`bar${i}_link`];
      const val = values[`bar${i}_value`];
      const max = values[`bar${i}_max`];
      if (link === undefined && val === undefined && max === undefined) continue;
      while (bars.length < i) bars.push(newBar(bars.length, { color: barColor[bars.length] }));
      const b = { ...bars[i - 1] };
      if (link !== undefined) b.link = String(link).replace(/^.*\|/, '');
      if (val !== undefined) b.value = val;
      if (max !== undefined) b.max = max;
      bars[i - 1] = b;
    }
    t.bars = bars;
    if (values.name !== undefined) t.name = values.name;
    if (values.showname !== undefined) t.showName = !!values.showname;
    if (values.showplayers_name !== undefined) t.showNameToPlayers = !!values.showplayers_name;
    if (values.width) t.w = Number(values.width);
    if (values.height) t.h = Number(values.height);
    const light = { ...(t.light || {}) };
    if (values.light_radius !== undefined) {
      light.enabled = Number(values.light_radius) > 0;
      light.dim = Number(values.light_radius) || 0;
    }
    if (values.light_dimradius !== undefined) light.bright = Number(values.light_dimradius) || 0;
    t.light = light;
    const vision = { ...(t.vision || {}) };
    if (values.light_hassight !== undefined || values.has_bright_light_vision !== undefined) vision.enabled = !!(values.light_hassight || values.has_bright_light_vision);
    if (values.night_vision_distance !== undefined) vision.darkvision = Number(values.night_vision_distance) || 0;
    t.vision = vision;
    this.net.update('char', charId, { defaultToken: t });
  }

  // -------------------------------------------------------------------
  // Автовычисляемые поля (disabled с формулой)
  // -------------------------------------------------------------------

  computeFormula(charId, formula, rowCtx, depth = 0) {
    let s = String(formula);
    for (let i = 0; i < 30 && /@\{/.test(s); i++) {
      s = s.replace(/@\{([^{}]*)\}/g, (m, inner) => {
        let name = inner.trim();
        let max = false;
        if (/\|max$/i.test(name)) {
          name = name.replace(/\|max$/i, '');
          max = true;
        }
        if (name.includes('|')) return '0';
        let full = name;
        if (rowCtx && this.template?.isRepField(rowCtx.section, name)) full = `repeating_${rowCtx.section}_${rowCtx.rowId}_${name}`;
        full = this.expandRowName(full, rowCtx ? { ...rowCtx, charId } : null);
        const v = this.rawValue(charId, full + (max ? '_max' : ''));
        if (v === undefined || v === '') return '0';
        return String(v);
      });
    }
    try {
      const r = rollExpression(s.replace(/\[\[|\]\]/g, ''), { rng: () => 1 });
      const t = r.total;
      return Number.isFinite(t) ? String(Math.round(t * 1e6) / 1e6) : '';
    } catch {
      return '';
    }
  }
}
