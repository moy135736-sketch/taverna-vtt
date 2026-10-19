// Работа с текстом макросов: HTML-сущности, свойства шаблонов {{key=value}}, экранирование.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lbrace: '{', rbrace: '}', lcub: '{', rcub: '}', lbrack: '[', rbrack: ']', lsqb: '[', rsqb: ']',
  lpar: '(', rpar: ')', vert: '|', verbar: '|', VerticalLine: '|', comma: ',', commat: '@', quest: '?',
  num: '#', percnt: '%', ast: '*', midast: '*', plus: '+', minus: '−', equals: '=', colon: ':', semi: ';',
  excl: '!', dollar: '$', sol: '/', bsol: '\\', Hat: '^', lowbar: '_', grave: '`', tilde: '˜', period: '.',
  NewLine: '\n', Tab: '\t', hyphen: '‐', dash: '‐', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷', middot: '·', bull: '•', frac12: '½',
  frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', plusmn: '±', le: '≤', ge: '≥', ne: '≠', larr: '←',
  rarr: '→', uarr: '↑', darr: '↓', hearts: '♥', spades: '♠', clubs: '♣', diams: '♦', check: '✓', cross: '✗',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sect: '§', para: '¶', euro: '€', pound: '£', yen: '¥',
};

/** Раскодировать HTML-сущности один раз (как делает Roll20 после каждого запроса и в конце). */
export function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
  });
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Разобрать свойства шаблона {{key=value}} из текста сообщения.
 * Возвращает массив [key, value] в порядке появления (повторный ключ заменяет значение, сохраняя позицию).
 */
export function parseTemplateProps(content) {
  const out = [];
  const index = new Map();
  if (!content) return out;
  let i = 0;
  const s = content;
  while (i < s.length) {
    const start = s.indexOf('{{', i);
    if (start < 0) break;
    const end = s.indexOf('}}', start + 2);
    if (end < 0) break;
    const body = s.slice(start + 2, end);
    i = end + 2;
    const eq = body.indexOf('=');
    let key, value;
    if (eq < 0) {
      key = body;
      value = '';
    } else {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    }
    if (!key) continue;
    if (index.has(key)) out[index.get(key)][1] = value;
    else {
      index.set(key, out.length);
      out.push([key, value]);
    }
  }
  return out;
}

/** Номера inline-бросков $[[n]] в строке. */
export function inlineRefs(value) {
  const out = [];
  const re = /\$\[\[(\d+)\]\]/g;
  let m;
  while ((m = re.exec(value))) out.push(Number(m[1]));
  return out;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const SELF_CLOSING_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/>/g;

/**
 * «Самозакрывающиеся» непустые теги → открывающий + закрывающий: <textarea name="x"/> → <textarea name="x"></textarea>.
 * Roll20 понимает такую запись в листах, а парсер HTML5 считает её незакрытым тегом и «проглатывает» всё, что дальше.
 */
export function expandSelfClosing(html) {
  return String(html).replace(SELF_CLOSING_RE, (m, tag, attrs) => (VOID_TAGS.has(tag.toLowerCase()) ? m : `<${tag}${attrs}></${tag}>`));
}

/**
 * Незакрытый <textarea>: Roll20 закрывает его на первом же теге, а парсер HTML5 «проглатывает»
 * всю разметку до следующего </textarea> (или до конца листа). Закрываем такие поля сразу.
 */
export function closeOpenTextareas(html) {
  const s = String(html);
  const re = /<textarea\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = re.exec(s))) {
    const end = m.index + m[0].length;
    if (/\/>$/.test(m[0])) continue;
    const tagRe = /<[a-zA-Z\/!]/g;
    tagRe.lastIndex = end;
    const tm = tagRe.exec(s);
    const lt = tm ? tm.index : -1;
    out += s.slice(pos, end);
    pos = end;
    if (lt < 0) {
      out += '</textarea>';
      continue;
    }
    if (!/^<\/textarea\s*>/i.test(s.slice(lt, lt + 16))) {
      // содержимое — до первого тега, дальше — обычная разметка
      out += s.slice(end, lt) + '</textarea>';
      pos = lt;
    }
  }
  return out + s.slice(pos);
}

/** Привести HTML листа к виду, в котором его понимает Roll20 */
export function normalizeSheetHtml(html) {
  return closeOpenTextareas(expandSelfClosing(html));
}
