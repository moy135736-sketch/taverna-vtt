// Разбор листа персонажа Roll20: HTML, CSS, sheet workers, шаблоны бросков, значения по умолчанию.
import { lc } from '@shared/attrs.js';
import { normalizeSheetHtml } from '@shared/text.js';

const WORKER_RE = /<script\b[^>]*type\s*=\s*["']?text\/worker["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_RE = /<script\b[\s\S]*?<\/script\s*>/gi;
const ROLLTEMPLATE_RE = /<rolltemplate\b[^>]*class\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/rolltemplate\s*>/gi;
const CHARMANCER_RE = /<charmancer\b[\s\S]*?<\/charmancer\s*>/gi;

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'applet', 'portal', 'noscript', 'template']);

const NO_PREFIX = /^(sheet-|repeating_|attr_|roll_|act_)/;

/** Класс-атрибут с sheet-префиксами (как Roll20). Блоки {{...}} шаблонов бросков не трогаем */
export function prefixClassValue(val) {
  const parts = String(val).split(/(\{\{[\s\S]*?\}\})/);
  return parts
    .map((seg, i) => {
      if (i % 2) return seg;
      // продолжение значения {{x}}-suffix — это часть того же класса, префикс не нужен
      const glued = i > 0 && !/^\{\{[#/^]/.test(parts[i - 1]) && /^\S/.test(seg);
      let first = true;
      return seg.replace(/(^|\s)([^\s]+)/g, (m, sp, w) => {
        const skip = (first && glued && sp === '') || NO_PREFIX.test(w);
        first = false;
        return sp + (skip ? w : 'sheet-' + w);
      });
    })
    .join('');
}

/** Селектор для legacy-листа: .класс → .sheet-класс */
export function legacySelector(sel) {
  return String(sel).replace(/\.(-?[_a-zA-Z][\w-]*)/g, (m, c) => (c.startsWith('sheet-') ? m : '.sheet-' + c));
}

/** Добавить sheet-префикс к классам: так Roll20 обрабатывает legacy-листы и шаблоны бросков */
export function prefixClasses(html) {
  return html.replace(/(\sclass\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, val) => `${pre}${q}${prefixClassValue(val)}${q}`);
}

/** Перевести data-i18n внутри шаблона броска (простые элементы без вложенных тегов) */
function translateTemplate(src, t) {
  return src.replace(/(<([a-z][\w-]*)\b[^>]*?\sdata-i18n\s*=\s*(["'])([^"']+)\3[^>]*>)([^<]*)(<\/\2\s*>)/gi, (m, open, tag, q, key, text, close) => {
    const v = t(key);
    return v === null || v === undefined ? m : open + v + close;
  });
}

export class SheetTemplate {
  constructor(bundle) {
    this.id = bundle.id;
    this.name = bundle.name;
    this.version = bundle.version;
    this.legacy = bundle.legacy !== false;
    this.meta = bundle.meta || {};
    this.css = bundle.css || '';
    this.lang = bundle.lang || 'en';
    this.translation = { ...(bundle.translation || {}), ...(bundle.langTranslation || {}) };
    this.workerCode = '';
    this.rollTemplates = {};
    this.defaults = new Map(); // lc name -> {current?, max?}
    this.repeating = new Map(); // lc section -> {name, fields: Map(lcField -> {current,max}), html}
    this.rollButtons = new Map(); // lc name (без roll_) -> value
    this.repRollButtons = new Map(); // lc section -> Map(lc name -> value)
    this.actionButtons = new Set();
    this.repActionButtons = new Map();
    this.autocalc = new Map(); // lc name -> формула
    this.repAutocalc = new Map(); // lc section -> Map(lc field -> формула)
    this.parse(bundle.html || '');
  }

  t(key) {
    const v = this.translation[key];
    return v === undefined ? null : v;
  }

  parse(raw) {
    let html = raw;
    // 1) sheet workers
    const workers = [];
    html = html.replace(WORKER_RE, (m, code) => {
      workers.push(code);
      return '';
    });
    this.workerCode = workers.join('\n;\n');
    // <textarea .../>, <span .../>, незакрытый <textarea>: Roll20 их понимает, а HTML5 — нет
    html = normalizeSheetHtml(html);
    // 2) шаблоны бросков (сохраняем как текст — внутри бывают несбалансированные теги)
    html = html.replace(ROLLTEMPLATE_RE, (m, cls, body) => {
      const mm = /sheet-rolltemplate-([^\s"']+)/.exec(cls);
      if (mm) this.rollTemplates[mm[1]] = prefixClasses(translateTemplate(body, (k) => this.t(k)));
      return '';
    });
    // 3) charactermancer и прочие скрипты
    html = html.replace(CHARMANCER_RE, '').replace(SCRIPT_RE, '');
    if (this.legacy) html = prefixClasses(html);
    this.bodyHtml = html;

    // 4) DOM для анализа
    const doc = new DOMParser().parseFromString(`<!doctype html><html><body><div class="charsheet">${html}</div></body></html>`, 'text/html');
    sanitizeTree(doc.body);
    this.doc = doc;
    this.collect(doc);
  }

  collect(doc) {
    const root = doc.body;
    // повторяющиеся секции
    for (const fs of root.querySelectorAll('fieldset')) {
      const cls = [...fs.classList].find((c) => c.startsWith('repeating_'));
      if (!cls) continue;
      const section = cls.slice('repeating_'.length);
      const key = lc(section);
      if (this.repeating.has(key)) continue;
      const info = { name: section, fields: new Map(), rollButtons: new Map(), actions: new Set(), autocalc: new Map() };
      this.repeating.set(key, info);
      for (const el of fs.querySelectorAll('[name]')) this.collectField(el, info.fields, info.rollButtons, info.actions, info.autocalc);
      this.repRollButtons.set(key, info.rollButtons);
      this.repActionButtons.set(key, info.actions);
      this.repAutocalc.set(key, info.autocalc);
    }
    // обычные поля (вне fieldset)
    for (const el of root.querySelectorAll('[name]')) {
      if (el.closest('fieldset')) continue;
      this.collectField(el, this.defaults, this.rollButtons, this.actionButtons, this.autocalc);
    }
  }

  collectField(el, defaults, rollButtons, actions, autocalc) {
    const name = el.getAttribute('name') || '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      // при дублях Roll20 берёт последнюю кнопку в HTML
      if (type === 'roll' && /^roll_/i.test(name)) rollButtons.set(lc(name.slice(5)), el.getAttribute('value') || '');
      else if (type === 'action' && /^act_/i.test(name)) actions.add(lc(name.slice(4)));
      return;
    }
    if (!/^attr_/i.test(name)) return;
    const attr = name.slice(5);
    const { base, max } = splitMaxName(attr);
    const key = lc(base);
    let d = defaults.get(key);
    if (!d) {
      d = {};
      defaults.set(key, d);
    }
    const field = max ? 'max' : 'current';
    const type = (el.getAttribute('type') || '').toLowerCase();
    // «Сильное» значение по умолчанию (явный value, выбранный пункт, отмеченная галочка)
    // важнее «слабого» (поле без value, неотмеченный чекбокс) — как в Roll20
    let value;
    let strong = false;
    if (tag === 'input' && type === 'radio') {
      if (el.hasAttribute('checked')) {
        value = el.getAttribute('value') ?? 'on';
        strong = true;
      } else value = '';
    } else if (tag === 'input' && type === 'checkbox') {
      if (el.hasAttribute('checked')) {
        value = el.getAttribute('value') ?? 'on';
        strong = true;
      } else value = '0';
    } else if (tag === 'select') {
      const opts = [...el.querySelectorAll('option')];
      const sel = opts.find((o) => o.hasAttribute('selected')) || opts[0];
      value = sel ? sel.getAttribute('value') ?? sel.textContent : '';
      strong = !!sel;
    } else if (tag === 'textarea') {
      value = el.textContent || '';
      strong = value !== '';
    } else if (tag === 'input') {
      strong = el.hasAttribute('value');
      value = el.getAttribute('value') ?? '';
      if ((el.hasAttribute('disabled') || el.hasAttribute('readonly')) && /@\{/.test(value)) autocalc.set(lc(attr), value);
    } else {
      // span и прочие показывают атрибут, но значения не задают: атрибут существует с пустым значением
      // (иначе ссылка @{...} на ещё не заполненное поле листа ломала бы бросок)
      if (d[field] === undefined) d[field] = '';
      return;
    }
    const sk = '_s_' + field;
    if (d[field] !== undefined && (d[sk] || !strong)) return;
    d[field] = value;
    if (strong) d[sk] = true;
  }

  /** Значение по умолчанию для атрибута (имя может быть с _max и/или повторяющимся) */
  defaultFor(name) {
    const { base, max } = splitMaxName(name);
    const field = max ? 'max' : 'current';
    const rep = /^repeating_([^_]+)_([^_]+)_(.+)$/i.exec(base);
    if (rep) {
      const sec = this.repeating.get(lc(rep[1]));
      const d = sec?.fields.get(lc(rep[3]));
      return d ? d[field] : undefined;
    }
    const d = this.defaults.get(lc(base));
    return d ? d[field] : undefined;
  }

  isRepField(section, field) {
    const sec = this.repeating.get(lc(section));
    if (!sec) return false;
    const { base } = splitMaxName(field);
    return sec.fields.has(lc(base));
  }

  autocalcFor(name) {
    const rep = /^repeating_([^_]+)_([^_]+)_(.+)$/i.exec(name);
    if (rep) return this.repAutocalc.get(lc(rep[1]))?.get(lc(rep[3])) || null;
    return this.autocalc.get(lc(name)) || null;
  }

  /** CSS листа для окна персонажа (ограничен .charsheet, как в Roll20); разбирается один раз */
  sheetCss() {
    if (this._sheetCss === undefined) this._sheetCss = scopeSheetCss(this.css);
    return this._sheetCss;
  }

  /** CSS для чата: только правила шаблонов бросков */
  chatCss() {
    if (this._chatCss !== undefined) return this._chatCss;
    this._chatCss = filterTemplateCss(this.css);
    return this._chatCss;
  }
}

export function splitMaxName(name) {
  const n = String(name);
  if (/_max$/i.test(n) && n.length > 4) return { base: n.slice(0, -4), max: true };
  return { base: n, max: false };
}

/** Удалить опасное из DOM-дерева листа (лист показывается в песочнице, но перестрахуемся) */
export function sanitizeTree(root) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const remove = [];
  let n = walker.currentNode;
  while (n) {
    const tag = n.tagName ? n.tagName.toLowerCase() : '';
    if (FORBIDDEN_TAGS.has(tag)) remove.push(n);
    else if (n.attributes) {
      for (const a of [...n.attributes]) {
        const an = a.name.toLowerCase();
        const v = a.value || '';
        if (an.startsWith('on') || an === 'formaction' || an === 'srcdoc' || an === 'action') n.removeAttribute(a.name);
        else if ((an === 'href' || an === 'src' || an === 'xlink:href' || an === 'background' || an === 'poster') && /^\s*(javascript|vbscript|data:text)/i.test(v)) n.removeAttribute(a.name);
        else if (an === 'style' && /expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(v)) n.removeAttribute(a.name);
      }
      if (tag === 'a') {
        n.setAttribute('target', '_blank');
        n.setAttribute('rel', 'noopener noreferrer');
      }
    }
    n = walker.nextNode();
  }
  for (const r of remove) r.remove();
}

/** Оставить из CSS листа только правила, относящиеся к шаблонам бросков (+шрифты/анимации) */
export function filterTemplateCss(css) {
  if (!css) return '';
  const imports = [];
  // в общую страницу пропускаем только шрифты Google — чужой CSS не должен влиять на интерфейс
  const cleaned = css.replace(/@import\s+[^;]+;/gi, (m) => {
    if (/^@import\s+(url\(\s*)?["']?https:\/\/fonts\.googleapis\.com\//i.test(m)) imports.push(m);
    return '';
  });
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(cleaned);
  } catch (e) {
    console.warn('[sheet] не удалось разобрать CSS листа', e);
    return imports.join('\n');
  }
  const out = [...imports];
  const walk = (rules, wrapOpen, wrapClose) => {
    for (const r of rules) {
      if (r instanceof CSSStyleRule) {
        const sels = splitSelectors(r.selectorText).filter((s) => /rolltemplate|inlinerollresult|textchatcontainer/.test(s));
        if (!sels.length) continue;
        out.push(`${wrapOpen}${sels.join(', ')} { ${r.style.cssText} }${wrapClose}`);
      } else if (r instanceof CSSMediaRule) {
        walk(r.cssRules, wrapOpen + `@media ${r.conditionText || r.media.mediaText} { `, ' }' + wrapClose);
      } else if (typeof CSSSupportsRule !== 'undefined' && r instanceof CSSSupportsRule) {
        walk(r.cssRules, wrapOpen + `@supports ${r.conditionText} { `, ' }' + wrapClose);
      } else if (r instanceof CSSFontFaceRule || r instanceof CSSKeyframesRule) {
        out.push(r.cssText);
      }
    }
  };
  walk(sheet.cssRules, '', '');
  return out.join('\n');
}

/**
 * CSS листа в окне персонажа — как в Roll20: каждое правило ограничено классом .charsheet
 * («.sheet-coin input» превращается в «.charsheet .sheet-coin input»). От этого зависит вес селекторов:
 * правила листа перебивают базовые стили Roll20 той же точности (например, ширину полей ввода).
 * :root, html и body листа означают сам лист. @import остаются в начале, шрифты и анимации — как есть.
 */
export function scopeSheetCss(css) {
  if (!css) return '';
  const imports = [];
  const cleaned = css.replace(/@charset\s+[^;]+;/gi, '').replace(/@import\s+[^;]+;/gi, (m) => {
    imports.push(m);
    return '';
  });
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(cleaned);
  } catch (e) {
    console.warn('[sheet] не удалось разобрать CSS листа', e);
    return css;
  }
  const block = (rules) => {
    const parts = [];
    for (const r of rules) {
      if (r instanceof CSSStyleRule) {
        const sel = splitSelectors(r.selectorText).map(scopeSelector).join(', ');
        const nested = r.cssRules?.length ? ' ' + [...r.cssRules].map((x) => x.cssText).join(' ') : '';
        parts.push(`${sel} { ${r.style.cssText}${nested} }`);
      } else if (r instanceof CSSMediaRule) parts.push(`@media ${r.conditionText || r.media.mediaText} { ${block(r.cssRules)} }`);
      else if (typeof CSSSupportsRule !== 'undefined' && r instanceof CSSSupportsRule) parts.push(`@supports ${r.conditionText} { ${block(r.cssRules)} }`);
      else if (typeof CSSContainerRule !== 'undefined' && r instanceof CSSContainerRule) parts.push(`@container ${r.conditionText} { ${block(r.cssRules)} }`);
      else if (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule) parts.push(`@layer ${r.name} { ${block(r.cssRules)} }`);
      else parts.push(r.cssText); // @font-face, @keyframes, @page, @layer a, b; …
    }
    return parts.join('\n');
  };
  return [...imports, block(sheet.cssRules)].join('\n');
}

export function scopeSelector(selector) {
  const s = selector.trim();
  if (!s || /\.charsheet(?![\w-])/.test(s)) return s; // уже ограничен листом
  // :root / html / body (и их цепочки вроде «html body») — это сам лист
  const root = /^(?:(?::root|html|body)(?![\w-])\s*)+/i.exec(s);
  if (root) {
    const rest = s.slice(root[0].length);
    if (!rest) return '.charsheet';
    return /^[>+~]/.test(rest) ? `.charsheet ${rest}` : /^[.:#[]/.test(rest) && !/\s$/.test(root[0]) ? `.charsheet${rest}` : `.charsheet ${rest}`;
  }
  return `.charsheet ${s}`;
}

function splitSelectors(text) {
  const out = [];
  let depth = 0,
    cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
