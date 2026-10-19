// Отрисовка сообщений чата: inline-броски, ссылки-кнопки, разметка, шаблоны
import DOMPurify from 'dompurify';
import { decodeEntities, escapeHtml, parseTemplateProps, inlineRefs } from '@shared/text.js';
import { critClass, formatNumber } from '@shared/dice.js';
import { renderTemplate, DEFAULT_TEMPLATE } from '../sheet/rolltemplate.js';

const IMG_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?[^#\s]*)?(#.*)?$/i;

/** HTML inline-броска */
export function inlineRollHtml(msg, idx) {
  const r = msg.inlinerolls?.[idx];
  if (!r) return '';
  const crit = critClass(r);
  const val = r.type === 'table' ? escapeHtml(r.tableText ?? '') : escapeHtml(formatNumber(r.total));
  return `<span class="inlinerollresult showtip tipsy-n-right ${crit}" data-mid="${msg.id}" data-roll="${idx}">${val}</span>`;
}

function computedHtml(msg, key) {
  const v = msg.computed?.[key];
  const idx = msg.rollKeys?.[key];
  if (v === undefined) return idx !== undefined ? inlineRollHtml(msg, idx) : '';
  const r = idx !== undefined ? msg.inlinerolls?.[idx] : null;
  const crit = r ? critClass(r) : '';
  return `<span class="inlinerollresult showtip tipsy-n-right computed ${crit}" data-mid="${msg.id}" data-roll="${idx ?? ''}" data-computed="1">${escapeHtml(String(v))}</span>`;
}

/**
 * Отформатировать текст сообщения в HTML.
 * Сущности раскодируются один раз (финальный проход Roll20), затем экранируются.
 */
export function formatText(text, msg, { charId } = {}) {
  if (text === undefined || text === null) return '';
  const rolls = [];
  let s = String(text).replace(/\$\[\[(\d+)\]\]/g, (m, n) => {
    rolls.push(Number(n));
    return `\u0001${rolls.length - 1}\u0002`;
  });
  s = decodeEntities(s);
  s = escapeHtml(s);
  // ссылки [текст](адрес)
  s = s.replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g, (m, label, href) => linkHtml(label, decodeEntities(href.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')), msg, charId));
  // разметка
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/``([^`]+)``|`([^`\n]+)`/g, (m, a, b) => `<code>${a || b}</code>`);
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\r?\n/g, '<br>');
  s = s.replace(/\u0001(\d+)\u0002/g, (m, i) => inlineRollHtml(msg, rolls[Number(i)]));
  return s;
}

function linkHtml(label, href, msg, charId) {
  const lbl = label; // уже экранирован
  const h = href.trim();
  if (!h) return lbl;
  if (/^https?:\/\//i.test(h)) {
    if (IMG_RE.test(h)) return `<img class="chat-img" src="${escapeHtml(h)}" alt="${lbl}">`;
    return `<a href="${escapeHtml(h)}" target="_blank" rel="noopener noreferrer">${lbl}</a>`;
  }
  let action = 'macro';
  let ref = h;
  if (h.startsWith('~')) {
    action = 'ability';
    ref = h.slice(1);
    if (!ref.includes('|') && (charId || msg?.charId)) ref = (charId || msg.charId) + '|' + ref;
  } else if (h.startsWith('!')) {
    // приём Roll20: [Кнопка](!&#13;%{перс|способность}) — выполняем макрос после «!»
    const rest = h.slice(1).replace(/^[\r\n\s]+/, '');
    if (/[%@]\{|^\/|^\[\[/.test(rest)) ref = rest;
    else action = 'api';
  } else if (h.startsWith('#')) action = 'macro';
  else if (h.startsWith('`')) ref = h.slice(1);
  return `<a class="sheet-chatbtn r20-btn" href="${escapeHtml(h)}" data-action="${action}" data-ref="${escapeHtml(ref)}" data-cid="${escapeHtml(charId || msg?.charId || '')}">${lbl}</a>`;
}

/** Отрисовать шаблон броска в HTML */
export function templateHtml(msg, sheet) {
  const name = msg.template || 'default';
  let src = sheet?.rollTemplates?.[name];
  let cls = name;
  if (!src) {
    src = DEFAULT_TEMPLATE;
    cls = name === 'default' ? 'default' : 'default';
  }
  const list = parseTemplateProps(msg.content);
  const props = new Map(list);
  const order = list.map(([k]) => k);
  const fmtCache = new Map();
  const ctx = {
    props,
    order,
    value: (k) => {
      if (!fmtCache.has(k)) fmtCache.set(k, formatText(props.get(k), msg));
      return fmtCache.get(k);
    },
    keyHtml: (k) => formatText(k, msg),
    rollOf: (k) => {
      const v = props.get(k);
      if (v === undefined) return null;
      const refs = inlineRefs(v);
      return refs.length ? msg.inlinerolls?.[refs[0]] || null : null;
    },
    computed: msg.computed || {},
    computedHtml: (k) => computedHtml(msg, k),
  };
  let inner;
  try {
    inner = renderTemplate(src, ctx);
  } catch (e) {
    console.error('[template]', e);
    inner = renderTemplate(DEFAULT_TEMPLATE, ctx);
    cls = 'default';
  }
  return `<div class="sheet-rolltemplate-${escapeHtml(cls)}">${inner}</div>`;
}

let purifyHooked = false;
export function sanitizeChatHtml(html) {
  if (!purifyHooked) {
    purifyHooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('target') === '_blank') node.setAttribute('rel', 'noopener noreferrer');
    });
  }
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-mid', 'data-roll', 'data-action', 'data-ref', 'data-cid', 'data-computed', 'data-i18n'],
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed'],
  });
}

/** Подсказка inline-броска (HTML) */
export function rollTooltipHtml(roll, computed) {
  if (!roll) return '';
  let s = `<div class="rt-head">Бросок ${escapeHtml(roll.expression)}${roll.comment ? ' <i>' + escapeHtml(roll.comment) + '</i>' : ''}</div>`;
  s += `<div class="rt-body">${partsHtml(roll.parts || [])} = <b>${escapeHtml(roll.type === 'table' ? roll.tableText : formatNumber(roll.total))}</b>${roll.type === 'success' ? ' усп.' : ''}</div>`;
  if (computed !== undefined) s = `<div class="rt-head">Итог листа: <b>${escapeHtml(String(computed))}</b></div>` + s;
  return s;
}

export function partsHtml(parts) {
  let s = '';
  for (const p of parts) {
    if (p.t === 'text') s += escapeHtml(p.s);
    else if (p.t === 'label') s += `<span class="rt-label">[${escapeHtml(p.s)}]</span>`;
    else if (p.t === 'dice') {
      s +=
        '(' +
        p.dice
          .map((d) => {
            const cls = ['basicdiceroll'];
            if (d.cs) cls.push('critsuccess');
            if (d.cf) cls.push('critfail');
            if (d.dr) cls.push('dropped');
            if (d.ok) cls.push('success');
            if (d.bad) cls.push('failure');
            if (d.mt) cls.push('match m' + ((d.mt - 1) % 6));
            const rr = d.rr ? `<s class="rerolled">${d.rr.join(',')}</s>` : '';
            return `${rr}<span class="${cls.join(' ')}">${escapeHtml(String(d.v))}</span>`;
          })
          .join('+') +
        ')';
    } else if (p.t === 'group') {
      s += '{' + p.items.map((it) => `<span class="${it.dr ? 'dropped' : ''} ${it.ok ? 'success' : ''}">${partsHtml(it.parts)}</span>`).join(', ') + '}';
    } else if (p.t === 'table') s += `<span class="rt-table">${p.picks.map((x) => escapeHtml(x.name)).join(', ')}</span>`;
  }
  return s;
}

/** Блок результата для /roll */
export function rollResultHtml(msg) {
  const r = msg.roll;
  if (!r) return '';
  let dice = '';
  const walk = (parts) => {
    for (const p of parts) {
      if (p.t === 'dice') {
        for (const d of p.dice) {
          const cls = ['diceroll', 'd' + (p.sides === 'F' ? 'F' : p.sides)];
          if (d.cs) cls.push('critsuccess');
          if (d.cf) cls.push('critfail');
          if (d.dr) cls.push('dropped');
          if (d.ok) cls.push('success');
          if (d.bad) cls.push('failure');
          const v = p.sides === 'F' ? (d.v > 0 ? '+' : d.v < 0 ? '−' : '0') : d.v;
          dice += `<span class="${cls.join(' ')}" title="d${p.sides}">${escapeHtml(String(v))}</span>`;
        }
      } else if (p.t === 'group') for (const it of p.items) walk(it.parts);
    }
  };
  walk(r.parts || []);
  return `<div class="formula">бросок ${escapeHtml(msg.origRoll || r.expression)}</div>
<div class="formula formattedformula"><span class="dicegrouping">${dice || ''}</span><span class="rr-math">${partsHtml(r.parts || [])}</span></div>
<div class="rolled ${critClass(r)}" data-mid="${escapeHtml(msg.id)}" data-roll="main">${escapeHtml(r.type === 'table' ? r.tableText : formatNumber(r.total))}${r.type === 'success' ? ' <small>усп.</small>' : ''}</div>
${r.comment ? `<div class="roll-comment">${escapeHtml(r.comment)}</div>` : ''}`;
}
