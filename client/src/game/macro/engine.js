// Макросы Roll20: %{способности}, #макросы, @{атрибуты} (в т.ч. selected/target), ^{перевод},
// ?{запросы} с вложенностью через HTML-сущности. Порядок обработки — как в Roll20.
import { lc, attrString } from '@shared/attrs.js';
import { decodeEntities } from '@shared/text.js';

const KEYWORDS = new Set(['selected', 'target']);
const CANCEL = Symbol('cancel');

function balanced(s) {
  const cnt = (re) => (s.match(re) || []).length;
  return cnt(/\{\{/g) <= cnt(/\}\}/g) && cnt(/\[\[/g) <= cnt(/\]\]/g);
}

export class MacroEngine {
  constructor({ store, net, sheets, getBoard, prompt, notify }) {
    this.store = store;
    this.net = net;
    this.sheets = sheets;
    this.getBoard = getBoard;
    this.prompt = prompt;
    this.notify = notify;
  }

  splitLines(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const out = [];
    let buf = null;
    for (const line of lines) {
      if (buf !== null) {
        buf += '\n' + line;
        if (balanced(buf)) {
          out.push(buf);
          buf = null;
        }
        continue;
      }
      if (!balanced(line)) {
        buf = line;
        continue;
      }
      out.push(line);
    }
    if (buf !== null) out.push(buf);
    return out.filter((l) => l.trim());
  }

  /**
   * Выполнить макрос и отправить результат в чат.
   * ctx: {charId, rowCtx:{section,rowId}, as, selected, defer}
   */
  async run(text, ctx = {}) {
    const run = { qcache: new Map(), targets: new Map(), errors: [] };
    // &{noerror} — не сообщать об ошибках в ссылках на атрибуты (как в Roll20)
    if (/&\{noerror\}/i.test(String(text ?? ''))) {
      run.noerror = true;
      text = String(text).replace(/\s*&\{noerror\}/gi, '');
    }
    const selected = ctx.selected || [...this.store.ui.selected];
    const speaking = this.store.ui.speakingAs || { type: 'player' };
    const as = ctx.charId ? { type: 'char', id: ctx.charId } : ctx.as || speaking;
    const charId = ctx.charId || (as.type === 'char' ? as.id : null);
    const results = [];
    for (const line of this.splitLines(text)) {
      let exp;
      try {
        exp = await this.expand(line, { ...ctx, charId, selected }, run);
      } catch (e) {
        console.error('[macro]', e);
        run.errors.push(e.message || String(e));
      }
      if (exp === CANCEL) return results;
      if (run.errors.length) {
        this.notify?.(run.errors.join('\n'));
        return results;
      }
      if (!exp || !exp.trim()) continue;
      // /effect Название [--target] [--remove] — эффект стола на выделенные или на цель (в чат не уходит)
      const em = /^\s*\/(?:effect|эффект)(?:\s+([\s\S]*))?$/i.exec(exp);
      if (em && this.effectHandler) {
        const board = this.getBoard?.();
        await this.effectHandler(em[1] || '', { selected, charId, pickTarget: (label) => board?.pickTarget(label, `Цель эффекта «${label}» — щёлкните по токену (Esc — отмена)`) });
        continue;
      }
      const r = await this.net.chat({ text: exp, as, selected, defer: !!ctx.defer });
      results.push(r);
    }
    return results;
  }

  /** Только раскрыть текст (без отправки) — для предпросмотра/отладки */
  async expandOnly(text, ctx = {}) {
    const run = { qcache: new Map(), targets: new Map(), errors: [] };
    if (/&\{noerror\}/i.test(String(text ?? ''))) {
      run.noerror = true;
      text = String(text).replace(/\s*&\{noerror\}/gi, '');
    }
    const r = await this.expand(text, { ...ctx, selected: ctx.selected || [...this.store.ui.selected] }, run);
    return { text: r === CANCEL ? null : r, errors: run.errors };
  }

  async expand(text, ctx, run) {
    let s = String(text);
    if (ctx.charId) s = this.contextualize(s, ctx.charId, ctx.rowCtx || null);
    for (let pass = 0; pass < 200; pass++) {
      // &{noerror} может прийти и из значения атрибута или способности
      if (/&\{noerror\}/i.test(s)) {
        run.noerror = true;
        s = s.replace(/\s*&\{noerror\}/gi, '');
      }
      const before = s;
      s = await this.expandAbilities(s, ctx, run);
      if (s === CANCEL) return CANCEL;
      s = this.expandMacros(s);
      s = await this.expandAttributes(s, ctx, run);
      if (s === CANCEL) return CANCEL;
      s = this.expandTranslations(s);
      if (run.errors.length) return s;
      if (s !== before) continue;
      const q = findQuery(s);
      if (!q) break;
      const ans = await this.askQuery(q, run);
      if (ans === null) return CANCEL;
      s = s.slice(0, q.start) + ans + s.slice(q.end);
      // после каждого запроса Roll20 один раз раскодирует HTML-сущности
      s = decodeEntities(s);
    }
    return s;
  }

  // -------------------------------------------------------------------
  // Привязка ссылок к персонажу и строке повторяющейся секции
  // -------------------------------------------------------------------

  rowFix(name, charId, rowCtx) {
    if (!rowCtx) return name;
    const tpl = this.sheets.template;
    const sec = rowCtx.section;
    const m = /^repeating_([^_]+)_(.+)$/i.exec(name);
    if (m) {
      if (lc(m[1]) !== lc(sec)) return name;
      const first = m[2].split('_')[0];
      if (/^[-$]/.test(first) || this.sheets.rowExists(charId, m[1], first)) return name;
      return `repeating_${m[1]}_${rowCtx.rowId}_${m[2]}`;
    }
    const base = name.replace(/_max$/i, '');
    if ((tpl && tpl.isRepField(sec, base)) || this.store.getAttr(charId, `repeating_${sec}_${rowCtx.rowId}_${base}`)) return `repeating_${sec}_${rowCtx.rowId}_${name}`;
    // кнопки строки
    if (tpl && (tpl.repRollButtons.get(lc(sec))?.has(lc(name)) || tpl.repActionButtons.get(lc(sec))?.has(lc(name)))) return `repeating_${sec}_${rowCtx.rowId}_${name}`;
    return name;
  }

  /** @{x} → @{charId|x}, %{x} → %{charId|x}, (~x) → (~charId|x), с учётом строки */
  contextualize(text, charId, rowCtx) {
    let s = String(text);
    s = s.replace(/([@%])\{([^{}]*)\}/g, (m, sig, inner) => {
      const parts = inner.split('|');
      if (KEYWORDS.has(lc(parts[0]))) return m;
      if (parts.length >= 2 && !(parts.length === 2 && lc(parts[1]) === 'max')) return m;
      const name = this.rowFix(parts[0], charId, rowCtx);
      return `${sig}{${charId}|${name}${parts.length === 2 ? '|max' : ''}}`;
    });
    s = s.replace(/\(~([^)|]+)\)/g, (m, ref) => `(~${charId}|${this.rowFix(ref, charId, rowCtx)})`);
    return s;
  }

  // -------------------------------------------------------------------
  // Способности
  // -------------------------------------------------------------------

  findChar(ref) {
    const store = this.store;
    if (store.col.char.has(ref)) return store.col.char.get(ref);
    return store.charByName(ref);
  }

  selectedToken(ctx) {
    for (const id of ctx.selected || []) {
      const o = this.store.col.obj.get(id);
      if (o && o.type !== 'wall') return o;
    }
    return null;
  }

  async getTarget(label, run) {
    if (run.targets.has(label)) return run.targets.get(label);
    const board = this.getBoard?.();
    if (!board) return null;
    const id = await board.pickTarget(label);
    if (!id) return null;
    run.targets.set(label, id);
    return id;
  }

  async expandAbilities(s, ctx, run) {
    if (!s.includes('%{')) return s;
    return replaceAsync(s, /%\{([^{}]*)\}/g, async (m, inner) => {
      const parts = inner.split('|');
      let charId = null,
        ref;
      if (parts.length === 1) {
        charId = ctx.charId;
        ref = parts[0];
      } else {
        const who = parts[0];
        ref = parts.slice(1).join('|');
        if (lc(who) === 'selected') {
          const t = this.selectedToken(ctx);
          if (!t) {
            run.errors.push(`Не выбран токен для %{${inner}}`);
            return m;
          }
          charId = t.represents;
        } else if (lc(who) === 'target') {
          const tid = await this.getTarget('', run);
          if (!tid) return CANCEL;
          charId = this.store.col.obj.get(tid)?.represents;
        } else charId = this.findChar(who)?.id;
      }
      if (!charId || !this.store.col.char.has(charId)) {
        run.errors.push(`Персонаж не найден для %{${inner}}`);
        return m;
      }
      // кнопка из шаблона броска: [Текст](~перс|кнопка||данные) — данные приходят в событие как originalRollId
      let payload = null;
      const pi = ref.indexOf('||');
      if (pi >= 0) {
        payload = ref.slice(pi + 2);
        ref = ref.slice(0, pi);
      }
      const ch = this.store.col.char.get(charId);
      const ab = (ch.abilities || []).find((a) => lc(a.name) === lc(ref));
      if (ab) return this.contextualize(ab.action || '', charId, null);
      try {
        await this.net.ensureAttrs(charId);
      } catch {
        /* ignore */
      }
      const btn = this.sheets.findButton(charId, ref);
      if (btn?.kind === 'roll') return this.contextualize(btn.value, charId, btn.rowCtx);
      if (btn?.kind === 'action') {
        const extra = payload !== null ? { originalRollId: payload } : ctx.originalRollId ? { originalRollId: ctx.originalRollId } : {};
        this.sheets.triggerClick(charId, btn.name, btn.rowCtx, {}, extra);
        return '';
      }
      run.errors.push(`Способность не найдена: %{${inner}}`);
      return m;
    });
  }

  expandMacros(s) {
    if (!s.includes('#')) return s;
    const macros = [...this.store.col.macro.values()];
    if (!macros.length) return s;
    return s.replace(/(^|\s)#([^\s#{}|]+)/g, (m, pre, name) => {
      const mac = macros.find((x) => x.name === name) || macros.find((x) => lc(x.name) === lc(name));
      return mac ? pre + (mac.action || '') : m;
    });
  }

  expandTranslations(s) {
    if (!s.includes('^{')) return s;
    const tpl = this.sheets.template;
    return s.replace(/\^\{([^{}]*)\}/g, (m, key) => {
      const v = tpl?.t(key);
      return v === null || v === undefined ? key : v;
    });
  }

  // -------------------------------------------------------------------
  // Атрибуты
  // -------------------------------------------------------------------

  async expandAttributes(s, ctx, run) {
    if (!s.includes('@{')) return s;
    return replaceAsync(s, /@\{([^{}]*)\}/g, async (m, inner) => {
      // скрипты листов иногда вставляют &{noerror} уже после раскрытия способностей
      const n0 = run.errors.length;
      const v = await this.resolveAttr(inner, ctx, run);
      if (v === CANCEL) return CANCEL;
      if (v === null) {
        if (run.noerror) {
          run.errors.length = n0;
          return '';
        }
        return m;
      }
      return v;
    });
  }

  tokenProp(t, name, max) {
    const n = lc(name);
    if (n === 'token_name') return t.name || '';
    if (n === 'token_id') return t.id;
    if (n === 'character_id') return t.represents || '';
    if (n === 'character_name') return t.represents ? this.store.col.char.get(t.represents)?.name || '' : '';
    const bm = /^bar(\d+)(?:_(value|max|link))?$/.exec(n);
    if (bm) {
      const bar = (t.bars || [])[Number(bm[1]) - 1];
      if (!bar) return '';
      if (bm[2] === 'link') return bar.link || '';
      return attrString(max || bm[2] === 'max' ? bar.max : bar.value);
    }
    if (n === 'left') return String(Math.round(t.x + t.w / 2));
    if (n === 'top') return String(Math.round(t.y + t.h / 2));
    if (n === 'width') return String(Math.round(t.w));
    if (n === 'height') return String(Math.round(t.h));
    if (n === 'rotation') return String(t.rot || 0);
    return undefined;
  }

  /** @{tracker|Имя} — значение (инициатива) строки порядка ходов с таким именем */
  trackerValue(name) {
    const st = this.store;
    const want = lc(String(name || '').trim());
    for (const e of st.state.turnorder || []) {
      const o = e.tokenId ? st.col.obj.get(e.tokenId) : null;
      const label = e.name || o?.name || '';
      if (lc(String(label).trim()) === want) return String(e.pr ?? '');
    }
    return null;
  }

  async resolveAttr(inner, ctx, run) {
    const parts = inner.split('|');
    const p0 = lc(parts[0]);
    if (p0 === 'tracker' && parts.length >= 2 && !this.findChar(parts[0])) {
      const v = this.trackerValue(parts.slice(1).join('|'));
      if (v === null) {
        run.errors.push(`В порядке ходов нет «${parts.slice(1).join('|')}» (@{${inner}})`);
        return null;
      }
      return v;
    }
    let token = null,
      charId = null,
      name,
      max = false;
    if (p0 === 'target') {
      let rest = parts.slice(1);
      if (rest.length >= 2 && lc(rest[rest.length - 1]) === 'max') {
        max = true;
        rest = rest.slice(0, -1);
      }
      let label = '';
      if (rest.length >= 2) {
        label = rest[0];
        name = rest[1];
      } else name = rest[0];
      const tid = await this.getTarget(label, run);
      if (!tid) return CANCEL;
      token = this.store.col.obj.get(tid);
    } else if (p0 === 'selected') {
      name = parts[1];
      max = lc(parts[2] || '') === 'max';
      token = this.selectedToken(ctx);
      if (!token) {
        run.errors.push(`Не выбран токен для @{${inner}}`);
        return null;
      }
    } else if (parts.length === 1) {
      name = parts[0];
      charId = ctx.charId;
    } else if (parts.length === 2 && lc(parts[1]) === 'max') {
      name = parts[0];
      max = true;
      charId = ctx.charId;
    } else {
      const ch = this.findChar(parts[0]);
      if (!ch) {
        run.errors.push(`Персонаж «${parts[0]}» не найден (@{${inner}})`);
        return null;
      }
      charId = ch.id;
      name = parts[1];
      max = lc(parts[2] || '') === 'max';
    }
    if (name === undefined) {
      run.errors.push(`Неверная ссылка @{${inner}}`);
      return null;
    }
    if (token) {
      const tp = this.tokenProp(token, name, max);
      if (tp !== undefined) return tp;
      charId = token.represents;
      if (!charId) {
        run.errors.push(`Токен «${token.name || token.id}» не связан с персонажем (@{${inner}})`);
        return null;
      }
      if (!this.store.col.char.has(charId)) {
        // чужой персонаж (NPC) — спрашиваем у сервера
        const r = await this.net.request('attrs:peek', { tokenId: token.id, names: [name + (max ? '_max' : '')] });
        let v = r?.values?.[name + (max ? '_max' : '')];
        if (v === undefined) v = this.sheets.template?.defaultFor(name + (max ? '_max' : ''));
        if (v === undefined) {
          run.errors.push(`Атрибут не найден: @{${inner}}`);
          return null;
        }
        return attrString(v);
      }
    }
    if (!charId) {
      run.errors.push(`Для @{${inner}} нужен персонаж: выберите «От имени» персонажа или используйте @{Имя|${name}}`);
      return null;
    }
    if (!this.store.col.char.has(charId)) {
      run.errors.push(`Нет доступа к персонажу для @{${inner}}`);
      return null;
    }
    try {
      await this.net.ensureAttrs(charId);
    } catch (e) {
      run.errors.push(e.message);
      return null;
    }
    let full = name;
    if (charId === ctx.charId && ctx.rowCtx) full = this.rowFix(full, charId, ctx.rowCtx);
    // $N → id строки
    const idx = /^repeating_([^_]+)_\$(\d+)_(.+)$/i.exec(full);
    if (idx) {
      const rid = this.sheets.sectionIds(charId, idx[1])[Number(idx[2])];
      if (!rid) {
        run.errors.push(`Нет строки ${idx[2]} в секции ${idx[1]} (@{${inner}})`);
        return null;
      }
      full = `repeating_${idx[1]}_${rid}_${idx[3]}`;
    }
    const v = this.sheets.attrValue(charId, full + (max ? '_max' : ''));
    if (v === undefined) {
      run.errors.push(`Атрибут не найден: @{${inner}}`);
      return null;
    }
    const rep = /^repeating_([^_]+)_([^_]+)_/i.exec(full);
    return this.contextualize(v, charId, rep ? { section: rep[1], rowId: rep[2] } : null);
  }

  // -------------------------------------------------------------------
  // Запросы ?{...}
  // -------------------------------------------------------------------

  async askQuery(q, run) {
    const key = q.prompt;
    if (run.qcache.has(key)) return run.qcache.get(key);
    const ans = await this.prompt(q);
    if (ans === null || ans === undefined) return null;
    run.qcache.set(key, ans);
    return ans;
  }
}

export function findQuery(s) {
  const start = s.indexOf('?{');
  if (start < 0) return null;
  const end = s.indexOf('}', start + 2);
  if (end < 0) return null;
  const content = s.slice(start + 2, end);
  const parts = content.split('|');
  const prompt = parts[0];
  const q = { start, end: end + 1, prompt, raw: content };
  if (parts.length <= 2) {
    q.type = 'text';
    q.default = parts.length === 2 ? parts[1] : '';
  } else {
    q.type = 'select';
    q.options = parts.slice(1).map((opt) => {
      const i = opt.indexOf(',');
      if (i < 0) return { label: opt, value: opt };
      return { label: opt.slice(0, i), value: opt.slice(i + 1) };
    });
  }
  return q;
}

async function replaceAsync(s, re, fn) {
  const matches = [];
  s.replace(re, (...args) => {
    matches.push(args);
    return args[0];
  });
  if (!matches.length) return s;
  let out = '';
  let last = 0;
  for (const args of matches) {
    const m = args[0];
    const idx = args[args.length - 2];
    const r = await fn(...args);
    if (r === CANCEL) return CANCEL;
    out += s.slice(last, idx) + r;
    last = idx + m.length;
  }
  return out + s.slice(last);
}

export { CANCEL };
