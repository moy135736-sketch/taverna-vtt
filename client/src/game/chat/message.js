// HTML одного сообщения чата в структуре, похожей на Roll20 (для совместимости CSS шаблонов листов)
import { escapeHtml } from '@shared/text.js';
import { formatText, templateHtml, rollResultHtml, sanitizeChatHtml } from './format.js';
import { effectsForMessage } from '../effects.js';
import { reactionsHtml, reactAddHtml } from './reactions.jsx';
import { summaryHtml } from './summary.js';

function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function messageHtml(msg, { store, sheet, prev, actions = true }) {
  const me = store.me.id;
  const you = msg.playerId === me;
  const cls = ['message', msg.type || 'general'];
  if (you) cls.push('you');
  if (msg.template) cls.push('has-template');
  const sameSpeaker = prev && prev.who === msg.who && prev.playerId === msg.playerId && prev.type !== 'system' && msg.ts - prev.ts < 5 * 60000 && msg.type !== 'emote' && msg.type !== 'desc';
  if (sameSpeaker) cls.push('cont');
  const showAvatars = store.settings.chatAvatars !== false;
  let head = '';
  if (msg.type === 'system') {
    return sanitizeChatHtml(`<div class="message system ${msg.error ? 'error' : ''}"><span class="sys-text">${formatText(msg.content, msg)}</span></div>`);
  }
  // ловушка сработала — карточка с описанием, броском и спасброском
  if (msg.type === 'trap') {
    const t = msg.trap || {};
    let card = `<div class="trap-card"><div class="trap-card-h"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3L2 20h20zM12 9.5v5M12 17.2v.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><b>${escapeHtml(t.name || msg.who || 'Ловушка')}</b>${t.token ? `<span class="trap-card-who">${escapeHtml(t.token)}</span>` : ''}</div><div class="trap-card-text">${formatText(msg.content, msg)}</div></div>`;
    card += reactionsHtml(msg, store, actions);
    if (actions) card += reactAddHtml();
    return sanitizeChatHtml(`<div class="message trap" data-messageid="${escapeHtml(msg.id)}">${card}</div>`);
  }
  // итоги вечера — карточка без подписи говорящего
  if (msg.type === 'summary' && msg.summary) {
    let card = summaryHtml(msg.summary);
    if (msg.to?.length) card = `<div class="sum-private">Видно только вам. Для всех итоги публикует мастер.</div>` + card;
    card += reactionsHtml(msg, store, actions);
    if (actions) card += reactAddHtml();
    return sanitizeChatHtml(`<div class="message summary" data-messageid="${escapeHtml(msg.id)}">${card}</div>`);
  }
  if (!sameSpeaker && msg.type !== 'desc' && msg.type !== 'emote') {
    const av = showAvatars ? `<div class="avatar" aria-hidden="true">${msg.avatar ? `<img src="${escapeHtml(msg.avatar)}" alt="">` : `<span style="background:${escapeHtml(msg.color || '#777')}">${escapeHtml((msg.who || '?').slice(0, 1).toUpperCase())}</span>`}</div>` : '';
    head = `<div class="spacer"></div>${av}<span class="tstamp" aria-hidden="true">${timeStr(msg.ts)}</span><span class="by" style="--pc:${escapeHtml(msg.color || '#999')}">${escapeHtml(msg.who || '')}:</span>`;
  }
  let body = '';
  if (msg.type === 'whisper') {
    const toMe = (msg.to || []).includes(me) && !you;
    head = `<div class="spacer"></div><span class="tstamp" aria-hidden="true">${timeStr(msg.ts)}</span><span class="by">${toMe ? `(От ${escapeHtml(msg.who)})` : `(Кому: ${escapeHtml(msg.targetName || '')})`}</span>`;
  }
  if (msg.type === 'gmrollresult') head += `<span class="gm-only">(для мастера)</span>`;
  if (msg.template) body += templateHtml(msg, sheet);
  if (msg.roll) body += rollResultHtml(msg);
  if (!msg.template && msg.content) {
    if (msg.type === 'emote') body += `<span class="emote-text">${escapeHtml(msg.who || '')} ${formatText(msg.content, msg)}</span>`;
    else if (msg.type === 'desc') body += `<span class="desc-text">${formatText(msg.content, msg)}</span>`;
    else if (msg.type === 'ooc') body += `<span class="ooc-tag">(вне игры)</span> ${formatText(msg.content, msg)}`;
    else body += `<span class="msg-text">${formatText(msg.content, msg)}</span>`;
  }
  // бросок заклинания или приёма, для которого за столом есть эффект, — кнопка «наложить»
  if (actions) {
    const fx = effectsForMessage(store, msg).slice(0, 3);
    if (fx.length)
      body += `<div class="fx-apply">${fx
        .map((d) => `<a href="#" class="fx-apply-btn" data-action="effect" data-ref="${escapeHtml(d.id)}" title="На выделенные токены; если ничего не выделено — щёлкните по цели">✦ Наложить «${escapeHtml(d.name)}»</a>`)
        .join('')}</div>`;
  }
  // реакции под сообщением и кнопка «поставить реакцию»
  body += reactionsHtml(msg, store, actions);
  if (actions) body += reactAddHtml();
  // цвет игрока — переменной на всём сообщении (оформления стола рисуют им полосу слева)
  const pc = msg.color ? ` style="--pc:${escapeHtml(msg.color)}"` : '';
  return sanitizeChatHtml(`<div class="${cls.join(' ')}" data-messageid="${escapeHtml(msg.id)}"${pc}>${head}${body}</div>`);
}
