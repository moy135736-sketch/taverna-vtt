// Лист персонажа в песочнице (iframe без скриптов): привязка полей attr_*, повторяющиеся секции,
// автовычисляемые поля, кнопки бросков и действий.
import { lc, attrString } from '@shared/attrs.js';
import { SHEET_BASE_CSS } from './base-css.js';
import { sanitizeTree, prefixClasses, legacySelector } from './template.js';

const REP_RE = /^repeating_([^_]+)_([^_]+)_(.+)$/i;

function attrNameOf(el) {
  const n = el.getAttribute('name') || '';
  return /^attr_/i.test(n) ? n.slice(5) : null;
}

/** Применить переводы data-i18n к DOM шаблона */
export function applyTranslations(root, t, fixHtml = (h) => h) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const v = t(el.getAttribute('data-i18n'));
    if (v === null) continue;
    // переводы Roll20 могут содержать разметку (в т.ч. <span name="attr_...">)
    if (/[<&]/.test(v)) el.innerHTML = fixHtml(v);
    else el.textContent = v;
  }
  for (const [attr, target] of [
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-title', 'title'],
    ['data-i18n-label', 'label'],
    ['data-i18n-alt', 'alt'],
    ['data-i18n-aria-label', 'aria-label'],
    ['data-il8n-title', 'title'],
    ['data-i18n-value', 'value'],
  ]) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const v = t(el.getAttribute(attr));
      if (v !== null) el.setAttribute(target, v);
    }
  }
  // сортировка списков по переводу
  for (const list of root.querySelectorAll('[data-i18n-list]')) {
    const order = t(list.getAttribute('data-i18n-list'));
    if (!order) continue;
    const keys = String(order)
      .split(',')
      .map((s) => s.trim());
    const items = [...list.children].filter((c) => c.hasAttribute('data-i18n-list-item'));
    const byKey = new Map(items.map((c) => [c.getAttribute('data-i18n-list-item'), c]));
    for (const k of keys) {
      const el = byKey.get(k);
      if (el) list.appendChild(el);
    }
  }
}

/** HTML документа листа (кэшируется в шаблоне) */
function sheetDocHtml(tpl) {
  return sheetDocBody(tpl);
}

function sheetDocBody(tpl) {
  if (tpl._docHtml) return tpl._docHtml;
  const doc = tpl.doc.cloneNode(true);
  applyTranslations(doc.body, (k) => tpl.t(k), tpl.legacy ? prefixClasses : undefined);
  sanitizeTree(doc.body);
  // формулы автополей храним в data-formula: в value числового поля браузер их не примет
  for (const el of doc.body.querySelectorAll('input[value]')) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    const v = el.getAttribute('value');
    if (/@\{/.test(v) && (el.hasAttribute('disabled') || el.hasAttribute('readonly'))) {
      el.setAttribute('data-formula', v);
      el.removeAttribute('value');
    } else if ((type === 'number' || type === 'range') && v.trim() !== '' && !Number.isFinite(Number(v))) el.removeAttribute('value');
  }
  const inner = doc.querySelector('.charsheet').innerHTML;
  // Внутри листа запрещены скрипты (sandbox без allow-scripts) — CSP на всякий случай
  tpl._docHtml = `<!doctype html><html lang="${tpl.lang}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'">
<base target="_blank">
<style>${SHEET_BASE_CSS}</style>
<style>${tpl.sheetCss().replace(/<\/style/gi, '<\\/style')}</style>
</head><body><div class="ui-dialog characterdialog"><div class="ui-dialog-content"><div class="tab-content"><div class="tab-pane charsheet-tab"><div class="charsheet lang-${tpl.lang}">${inner}</div></div></div></div></div></body></html>`;
  return tpl._docHtml;
}

export class SheetView {
  constructor(engine, charId, container, { readOnly = false } = {}) {
    this.engine = engine;
    this.store = engine.store;
    this.charId = charId;
    this.container = container;
    this.readOnly = readOnly;
    this.bindings = new Map(); // lc имя -> [элементы] (вне секций)
    this.sections = new Map(); // lc секция -> {name, fs, container, control, rows: Map(lcRowId -> {id, el, bindings})}
    this.autocalcEls = []; // [{el, formula, rowCtx}]
    this.unsub = [];
    this.destroyed = false;
  }

  async mount() {
    const tpl = this.engine.template;
    await this.engine.ensure(this.charId);
    if (this.destroyed) return;
    const iframe = document.createElement('iframe');
    iframe.className = 'sheet-frame';
    iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    iframe.setAttribute('title', 'Лист персонажа');
    this.iframe = iframe;
    const loaded = new Promise((res) => (iframe.onload = res));
    iframe.srcdoc = sheetDocHtml(tpl);
    this.container.appendChild(iframe);
    await loaded;
    if (this.destroyed) return;
    this.doc = iframe.contentDocument;
    this.root = this.doc.querySelector('.charsheet');
    // кнопки бросков можно перетащить на панель макросов (как в Roll20)
    if (!this.readOnly) for (const b of this.root.querySelectorAll('button[type=roll]')) b.setAttribute('draggable', 'true');
    this.setupSections();
    this.bindStatic();
    this.renderAll();
    this.attachEvents();
    this.unsub.push(
      this.store.on('attrs', (charId, info) => charId === this.charId && this.onAttrs(info)),
      this.store.on('col:char', (c, id) => id === this.charId && c && this.updateName(c)),
      this.engine.on('rows', (charId, section) => charId === this.charId && this.renderRows(lc(section))),
      this.engine.on('jq:class', (charId, selector, op, cls) => (!charId || charId === this.charId) && this.applyJqClass(selector, op, cls)),
    );
    this.engine.sheetOpened(this.charId);
  }

  /** Масштаб листа (для маленьких экранов и крупного текста) */
  setZoom(z) {
    if (this.doc?.body) this.doc.body.style.zoom = String(z || 1);
  }

  destroy() {
    this.destroyed = true;
    for (const u of this.unsub) u();
    this.iframe?.remove();
  }

  // -------------------------------------------------------------------
  // Повторяющиеся секции
  // -------------------------------------------------------------------

  setupSections() {
    const doc = this.doc;
    for (const fs of this.root.querySelectorAll('fieldset')) {
      if (fs.parentElement.closest('fieldset')) continue;
      const cls = [...fs.classList].find((c) => c.startsWith('repeating_'));
      if (!cls) continue;
      const name = cls.slice(10);
      const key = lc(name);
      if (this.sections.has(key)) continue;
      fs.style.display = 'none';
      const container = doc.createElement('div');
      container.className = 'repcontainer';
      container.setAttribute('data-groupname', cls);
      const control = doc.createElement('div');
      control.className = 'repcontrol';
      control.setAttribute('data-groupname', cls);
      // подписи — как в русском интерфейсе Roll20
      control.innerHTML = '<button type="button" class="btn repcontrol_edit">Изменить</button><button type="button" class="btn repcontrol_add" style="display: inline-block;">+Добавить</button>';
      if (this.readOnly) control.style.display = 'none';
      fs.after(container);
      container.after(control);
      this.sections.set(key, { name, fs, container, control, rows: new Map() });
    }
  }

  renderRows(key) {
    const sec = this.sections.get(key);
    if (!sec) return;
    const ids = this.engine.sectionIds(this.charId, sec.name);
    const want = new Set(ids.map(lc));
    // удаляем исчезнувшие
    for (const [rk, row] of sec.rows) {
      if (!want.has(rk)) {
        row.el.remove();
        sec.rows.delete(rk);
        this.autocalcEls = this.autocalcEls.filter((a) => a.rowEl !== row.el);
      }
    }
    // создаём новые и упорядочиваем
    let prev = null;
    for (const id of ids) {
      const rk = lc(id);
      let row = sec.rows.get(rk);
      if (!row) {
        row = this.createRow(sec, id);
        sec.rows.set(rk, row);
      }
      const expected = prev ? prev.nextSibling : sec.container.firstChild;
      if (row.el !== expected) sec.container.insertBefore(row.el, expected);
      prev = row.el;
    }
  }

  createRow(sec, id) {
    const doc = this.doc;
    const el = doc.createElement('div');
    el.className = 'repitem';
    el.setAttribute('data-reprowid', id);
    const ic = doc.createElement('div');
    ic.className = 'itemcontrol';
    ic.innerHTML = '<button type="button" class="btn btn-danger pictos repcontrol_del">#</button><a class="btn repcontrol_move">≡</a>';
    el.appendChild(ic);
    for (const n of sec.fs.childNodes) el.appendChild(n.cloneNode(true));
    const row = { id, el, bindings: new Map(), section: sec.name };
    // вложенные секции внутри строки не поддерживаются Roll20 — просто привязываем поля
    for (const f of el.querySelectorAll('[name]')) {
      const an = attrNameOf(f);
      if (an === null) continue;
      const k = lc(an);
      if (!row.bindings.has(k)) row.bindings.set(k, []);
      row.bindings.get(k).push(f);
      this.prepareField(f, { section: sec.name, rowId: id }, el);
      this.renderEl(f, `repeating_${sec.name}_${id}_${an}`, { section: sec.name, rowId: id });
    }
    if (this.readOnly) this.lockEls(el);
    return row;
  }

  // -------------------------------------------------------------------
  // Обычные поля
  // -------------------------------------------------------------------

  bindStatic() {
    for (const f of this.root.querySelectorAll('[name]')) {
      if (f.closest('fieldset') || f.closest('.repcontainer')) continue;
      const an = attrNameOf(f);
      if (an === null) continue;
      const k = lc(an);
      if (!this.bindings.has(k)) this.bindings.set(k, []);
      this.bindings.get(k).push(f);
      this.prepareField(f, null, null);
    }
    if (this.readOnly) this.lockEls(this.root);
  }

  lockEls(root) {
    for (const f of root.querySelectorAll('input, select, textarea')) {
      if (f.type === 'radio' || f.type === 'checkbox' || f.tagName === 'SELECT') f.disabled = true;
      else f.readOnly = true;
    }
  }

  prepareField(el, rowCtx, rowEl) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'span' || tag === 'div') {
      const an = attrNameOf(el);
      const v = el.getAttribute('data-formula') ?? el.getAttribute('value');
      const disabled = el.hasAttribute('disabled') || el.hasAttribute('readonly');
      if (tag === 'input' && disabled && v && /@\{/.test(v)) {
        this.autocalcEls.push({ el, formula: v, rowCtx, rowEl, name: an });
        el._autocalc = true;
      } else if (tag !== 'input') {
        // span показывает значение автополя, если оно определено формулой в листе
        const formula = this.engine.template.autocalcFor(rowCtx ? `repeating_${rowCtx.section}_x_${an}` : an);
        if (formula) {
          this.autocalcEls.push({ el, formula, rowCtx, rowEl, name: an });
          el._autocalc = true;
        }
      }
    }
  }

  renderAll() {
    for (const [k, els] of this.bindings) {
      for (const el of els) this.renderEl(el, attrNameOf(el), null);
    }
    for (const key of this.sections.keys()) this.renderRows(key);
    this.updateAutocalc();
  }

  /** Записать значение атрибута в элемент */
  renderEl(el, fullName, rowCtx) {
    if (el._autocalc) return;
    const raw = this.engine.rawValue(this.charId, fullName);
    let v = raw === undefined ? '' : attrString(raw);
    // data-i18n-dynamic: значение — ключ перевода (например, класс «Paladin» → «Паладин»)
    if (v && el.hasAttribute('data-i18n-dynamic')) {
      const tpl = this.engine.template;
      v = tpl?.t(v) ?? tpl?.t(v.toLowerCase()) ?? v;
    }
    setElValue(el, v, this.doc);
  }

  updateName(ch) {
    for (const el of this.bindings.get('character_name') || []) setElValue(el, ch.name || '', this.doc);
    for (const k of ['character_avatar', 'character_token'])
      for (const el of this.bindings.get(k) || []) setElValue(el, this.engine.rawValue(this.charId, k) ?? '', this.doc);
  }

  // -------------------------------------------------------------------
  // Реакция на изменения атрибутов
  // -------------------------------------------------------------------

  onAttrs(info) {
    if (info.loaded) {
      this.renderAll();
      return;
    }
    const touchedSections = new Set();
    const all = [...(info.changed || []).map((c) => c.attr || { name: c.name }), ...(info.removed || [])];
    for (const a of all) {
      const name = a.name;
      const k = lc(name);
      const rep = REP_RE.exec(name);
      if (rep) {
        const sk = lc(rep[1]);
        const sec = this.sections.get(sk);
        if (!sec) continue;
        const row = sec.rows.get(lc(rep[2]));
        if (!row) {
          touchedSections.add(sk);
          continue;
        }
        for (const [suffix, isMax] of [
          ['', false],
          ['_max', true],
        ]) {
          const fk = lc(rep[3]) + suffix;
          for (const el of row.bindings.get(fk) || []) this.renderEl(el, `repeating_${rep[1]}_${rep[2]}_${rep[3]}${suffix}`, { section: rep[1], rowId: rep[2] });
        }
        if ((info.removed || []).includes(a)) touchedSections.add(sk);
        continue;
      }
      if (/^_reporder_repeating_/i.test(name)) {
        touchedSections.add(lc(name.slice('_reporder_repeating_'.length)));
        continue;
      }
      for (const suffix of ['', '_max']) for (const el of this.bindings.get(k + suffix) || []) this.renderEl(el, a.name + suffix, null);
    }
    for (const sk of touchedSections) this.renderRows(sk);
    this.scheduleAutocalc();
  }

  scheduleAutocalc() {
    if (this._acRAF) return;
    this._acRAF = requestAnimationFrame(() => {
      this._acRAF = null;
      this.updateAutocalc();
    });
  }

  updateAutocalc() {
    for (const a of this.autocalcEls) {
      if (!a.el.isConnected) continue;
      // если атрибут сохранён — формулой служит его значение
      const full = a.rowCtx ? `repeating_${a.rowCtx.section}_${a.rowCtx.rowId}_${a.name}` : a.name;
      const stored = this.store.getAttr(this.charId, full.replace(/_max$/i, ''));
      let formula = a.formula;
      if (stored) {
        const sv = /_max$/i.test(full) ? stored.max : stored.current;
        if (sv !== '' && sv !== undefined && sv !== null) formula = String(sv);
      }
      const v = this.engine.computeFormula(this.charId, formula, a.rowCtx);
      if (a.el.tagName === 'INPUT') {
        if (a.el.value !== v) a.el.value = v;
        a.el.setAttribute('value', v);
      } else a.el.textContent = v;
    }
  }

  // -------------------------------------------------------------------
  // События DOM листа
  // -------------------------------------------------------------------

  rowCtxOf(el) {
    const item = el.closest('.repitem');
    if (!item) return null;
    const cont = item.closest('.repcontainer');
    const g = cont?.getAttribute('data-groupname') || '';
    return { section: g.replace(/^repeating_/, ''), rowId: item.getAttribute('data-reprowid'), item };
  }

  attachEvents() {
    const root = this.root;
    root.addEventListener('change', (e) => this.onChange(e));
    // для range — сразу
    root.addEventListener('input', (e) => {
      if (e.target.type === 'range') this.onChange(e);
    });
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    root.addEventListener('submit', (e) => e.preventDefault());
    root.addEventListener('dragstart', (e) => this.onDragStart(e));
    // $20(...).on(...) из скриптов листа
    root.addEventListener('click', (e) => this.jqDispatch(e, 'click'), true);
    root.addEventListener('change', (e) => this.jqDispatch(e, 'change'), true);
    root.addEventListener('mouseover', (e) => this.jqDispatch(e, 'mouseenter'), true);
    root.addEventListener('mouseout', (e) => this.jqDispatch(e, 'mouseleave'), true);
  }

  onDragStart(e) {
    const btn = e.target.closest?.('button[type=roll]');
    if (!btn || this.readOnly) return;
    const name = (btn.getAttribute('name') || '').replace(/^roll_/i, '');
    if (!name) {
      e.preventDefault();
      return;
    }
    const rc = this.rowCtxOf(btn);
    const ref = rc ? `repeating_${rc.section}_${rc.rowId}_${name}` : name;
    // подпись: текст кнопки или подпись поля рядом
    let label = (btn.textContent || '').replace(/\s+/g, ' ').trim() || btn.getAttribute('title') || '';
    if (!label || label.length < 2) {
      const row = btn.closest('.repitem, .sheet-row, div');
      const near = row?.querySelector('input[type=text], span[name], label');
      label = (near?.value || near?.textContent || name).trim();
    }
    e.dataTransfer.setData('application/x-taverna', JSON.stringify({ kind: 'sheetroll', charId: this.charId, ref, label: label.slice(0, 32) }));
    e.dataTransfer.setData('text/plain', `%{${this.store.col.char.get(this.charId)?.name || this.charId}|${ref}}`);
    e.dataTransfer.effectAllowed = 'copy';
  }

  jqDispatch(e, type) {
    const hs = this.engine.jqHandlers;
    if (!hs.length || this.readOnly || !this.engine.worker) return;
    const t = e.target;
    if (!t || !t.closest) return;
    for (const h of hs) {
      if (!h.events.has(type)) continue;
      let el = null;
      try {
        el = t.closest(h.selector);
        if (!el && this.engine.template?.legacy) el = t.closest(legacySelector(h.selector));
      } catch {
        continue;
      }
      if (!el || !this.root.contains(el)) continue;
      // mouseenter/mouseleave: только при пересечении границы элемента
      if ((type === 'mouseenter' || type === 'mouseleave') && e.relatedTarget && el.contains(e.relatedTarget)) continue;
      const htmlAttributes = { tagName: el.tagName.toLowerCase() };
      for (const a of el.attributes) htmlAttributes[a.name] = a.value;
      this.engine.worker.jqEvent(h.id, this.charId, {
        type,
        htmlAttributes,
        altKey: !!e.altKey,
        shiftKey: !!e.shiftKey,
        ctrlKey: !!e.ctrlKey,
        metaKey: !!e.metaKey,
        pageX: e.pageX || 0,
        pageY: e.pageY || 0,
      });
    }
  }

  applyJqClass(selector, op, cls) {
    if (!this.root) return;
    const legacy = this.engine.template?.legacy;
    let els;
    try {
      els = new Set(this.root.querySelectorAll(selector));
      if (legacy) for (const el of this.root.querySelectorAll(legacySelector(selector))) els.add(el);
    } catch {
      return;
    }
    for (const c of String(cls).split(/\s+/).filter(Boolean)) {
      // в legacy-листах классы дублируются с префиксом sheet- (как и разметка)
      const names = legacy && !c.startsWith('sheet-') ? [c, 'sheet-' + c] : [c];
      for (const el of els) {
        const on = op === 'add' ? true : op === 'remove' ? false : !el.classList.contains(c);
        for (const n of names) el.classList.toggle(n, on);
      }
    }
  }

  onChange(e) {
    const el = e.target;
    const an = el && attrNameOf(el);
    if (an === null || el._autocalc) return;
    if (this.readOnly) {
      this.renderAll();
      return;
    }
    const tag = el.tagName.toLowerCase();
    let value;
    if (tag === 'input' && el.type === 'checkbox') value = el.checked ? el.getAttribute('value') ?? 'on' : '0';
    else if (tag === 'input' && el.type === 'radio') {
      if (!el.checked) return;
      value = el.getAttribute('value') ?? 'on';
    } else value = el.value;
    const rc = this.rowCtxOf(el);
    const full = rc ? `repeating_${rc.section}_${rc.rowId}_${an}` : an;
    this.engine.setAttrs(this.charId, { [full]: value }, { source: 'player' });
  }

  onClick(e) {
    const t = e.target;
    const btn = t.closest('button, a.repcontrol_move');
    if (!btn) return;
    const cls = btn.classList;
    // элементы управления повторяющихся секций
    if (cls.contains('repcontrol_add') || cls.contains('repcontrol_edit')) {
      e.preventDefault();
      const ctrl = btn.closest('.repcontrol');
      const g = ctrl.getAttribute('data-groupname').replace(/^repeating_/, '');
      const sec = this.sections.get(lc(g));
      if (!sec) return;
      if (cls.contains('repcontrol_add')) {
        this.engine.addRow(this.charId, sec.name);
      } else {
        const on = !sec.container.classList.contains('editmode');
        sec.container.classList.toggle('editmode', on);
        btn.textContent = on ? 'Готово' : 'Изменить';
        const add = ctrl.querySelector('.repcontrol_add');
        if (add) add.style.display = on ? 'none' : 'inline-block';
      }
      return;
    }
    if (cls.contains('repcontrol_del')) {
      e.preventDefault();
      const rc = this.rowCtxOf(btn);
      if (rc) this.engine.removeRepeatingRow(this.charId, `repeating_${rc.section}_${rc.rowId}`, 'player');
      return;
    }
    if (btn.tagName !== 'BUTTON') return;
    const type = (btn.getAttribute('type') || '').toLowerCase();
    const name = btn.getAttribute('name') || '';
    if (type === 'roll') {
      e.preventDefault();
      if (this.readOnly) return;
      const rc = this.rowCtxOf(btn);
      const value = btn.getAttribute('value') || '';
      this.engine.runRollButton(this.charId, value, rc ? { section: rc.section, rowId: rc.rowId } : null);
    } else if (type === 'action') {
      e.preventDefault();
      if (this.readOnly) return;
      const rc = this.rowCtxOf(btn);
      const html = {};
      for (const a of btn.attributes) if (a.name.startsWith('data-')) html[a.name] = a.value;
      html.name = name;
      this.engine.triggerClick(this.charId, name.replace(/^act_/i, ''), rc ? { section: rc.section, rowId: rc.rowId } : null, html);
    }
  }

  // Перетаскивание строк в режиме «Modify»
  onPointerDown(e) {
    const h = e.target.closest('.repcontrol_move');
    if (!h) return;
    const item = h.closest('.repitem');
    const cont = item?.closest('.repcontainer');
    if (!item || !cont || !cont.classList.contains('editmode')) return;
    e.preventDefault();
    item.classList.add('r20-dragging');
    let target = null;
    const move = (ev) => {
      const el = this.doc.elementFromPoint(ev.clientX, ev.clientY);
      const over = el && el.closest('.repitem');
      if (target) target.classList.remove('r20-drop-before');
      target = over && over !== item && over.parentElement === cont ? over : null;
      if (target) target.classList.add('r20-drop-before');
    };
    const up = () => {
      this.doc.removeEventListener('pointermove', move);
      this.doc.removeEventListener('pointerup', up);
      item.classList.remove('r20-dragging');
      if (target) {
        target.classList.remove('r20-drop-before');
        cont.insertBefore(item, target);
      }
      const g = cont.getAttribute('data-groupname').replace(/^repeating_/, '');
      const ids = [...cont.children].filter((c) => c.classList.contains('repitem')).map((c) => c.getAttribute('data-reprowid'));
      this.engine.reorderRows(this.charId, g, ids);
    };
    this.doc.addEventListener('pointermove', move);
    this.doc.addEventListener('pointerup', up);
  }
}

/** Установить значение элементу формы так, как это делает Roll20 */
export function setElValue(el, v, doc) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') {
      const on = String(v) === String(el.getAttribute('value') ?? 'on') && v !== '' && v !== '0';
      if (el.checked !== on) el.checked = on;
      if (on) el.setAttribute('checked', 'checked');
      else el.removeAttribute('checked');
    } else if (type === 'radio') {
      const on = String(v) === String(el.getAttribute('value') ?? 'on');
      if (el.checked !== on) el.checked = on;
      if (on) el.setAttribute('checked', 'checked');
      else el.removeAttribute('checked');
    } else if ((type === 'number' || type === 'range') && v !== '' && !Number.isFinite(Number(v))) {
      // нечисловое значение в числовом поле — браузер покажет пустое поле (как и в Roll20)
      if (el.value !== '') el.value = '';
      if (el.hasAttribute('value')) el.removeAttribute('value');
    } else {
      const focused = doc && doc.activeElement === el;
      if (!focused && el.value !== v) el.value = v;
      if (el.getAttribute('value') !== v) el.setAttribute('value', v);
    }
  } else if (tag === 'select') {
    if (el.value !== v) el.value = v;
    // значения нет среди опций — Roll20 показывает пустой выбор
    if (el.value !== v && v !== '') el.selectedIndex = -1;
  } else if (tag === 'textarea') {
    if (!(doc && doc.activeElement === el) && el.value !== v) el.value = v;
  } else if (tag === 'img') {
    if (/^(https?:|\/)/.test(v) && el.getAttribute('src') !== v) el.setAttribute('src', v);
  } else {
    // span и прочие «листовые» элементы показывают значение текстом; контейнер с вложенной
    // разметкой не трогаем (Roll20 не затирает, а листы вешают name на обёртки — например, фон)
    if (el.firstElementChild) return;
    if (el.textContent !== v) el.textContent = v;
  }
}
