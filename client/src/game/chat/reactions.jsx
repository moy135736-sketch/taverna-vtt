// Реакции: выбор эмодзи (под сообщением или над своим токеном) и всплывающие реакции на доске и у аватаров
import { useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { REACTIONS, REACTION_NAMES } from '@shared/reactions.js';
import { escapeHtml } from '@shared/text.js';
import { tokenOfChar } from '../effects.js';

/** Ряд реакций под сообщением (HTML для чата); actions — можно ли нажимать (в журнале-файле нельзя) */
export function reactionsHtml(msg, store, actions = true) {
  const r = msg.reactions && typeof msg.reactions === 'object' ? msg.reactions : {};
  const me = store.me?.id;
  const chips = REACTIONS.filter((e) => Array.isArray(r[e]) && r[e].length).map((e) => {
    const who = r[e].map((u) => store.members.get(u)?.displayName || 'игрок').join(', ');
    const mine = r[e].includes(me);
    const label = `${REACTION_NAMES[e] || e}: ${who}`;
    return actions
      ? `<a href="#" class="react-chip${mine ? ' on' : ''}" data-action="react" data-ref="${e}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" aria-pressed="${mine}">${e}<b>${r[e].length}</b></a>`
      : `<span class="react-chip">${e}<b>${r[e].length}</b></span>`;
  });
  return chips.length ? `<div class="reactions">${chips.join('')}</div>` : '';
}

/** Кнопка «поставить реакцию» в углу сообщения */
export const reactAddHtml = () =>
  `<a href="#" class="react-add" data-action="react-pick" title="Реакция" aria-label="Поставить реакцию"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="11" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7.6 14.2c.9 1.3 2 1.9 3.4 1.9s2.5-.6 3.4-1.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8.6" cy="10" r="1.1" fill="currentColor"/><circle cx="13.4" cy="10" r="1.1" fill="currentColor"/><path d="M19.5 2.5v5M17 5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></a>`;

/** Выбор реакции: ряд эмодзи у точки (x, y); закрывается щелчком мимо и Esc */
export function ReactionPicker({ x, y, onPick, onClose, label = 'Реакция' }) {
  const ref = useRef();
  useEffect(() => {
    const down = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    const key = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    ref.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, []);
  // не вылезать за край окна
  const w = 10 * 36 + 16;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2));
  const top = y > 70 ? y - 52 : y + 12;
  // поверх всего окна: боковая панель не должна закрывать выбор
  return createPortal(
    <div class="react-picker" ref={ref} role="menu" aria-label={label} style={{ left: left + 'px', top: top + 'px' }}>
      {REACTIONS.map((e) => (
        <button
          type="button"
          role="menuitem"
          title={REACTION_NAMES[e]}
          aria-label={REACTION_NAMES[e]}
          onClick={() => {
            onPick(e);
            onClose();
          }}
        >
          {e}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** Свой токен для всплывающей реакции: выделенный, иначе токен персонажа, от чьего имени говорю, иначе мой персонаж на сцене */
export function myReactionToken(store) {
  const pid = store.ui.pageId;
  const sel = store.selectedObjs().filter((o) => o.pageId === pid && o.type !== 'wall' && store.canControlObj(o));
  if (sel.length === 1) return sel[0];
  const as = store.ui.speakingAs;
  if (as?.type === 'char') {
    const t = tokenOfChar(store, as.id);
    if (t) return t;
  }
  if (store.isGM) return null;
  return [...store.col.obj.values()].find((o) => o.pageId === pid && o.represents && o.layer !== 'gm' && (store.col.char.get(o.represents)?.controlledBy || []).includes(store.me.id)) || null;
}

/** Всплывающие реакции: над токеном на доске или у аватара игрока в верхней панели */
export function watchReactionFloats(app) {
  const { net, store } = app;
  return net.on('react:float', ({ userId, emoji, tokenId, pageId }) => {
    if (!REACTIONS.includes(emoji)) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const board = app.board();
    const o = tokenId && pageId === store.ui.pageId ? store.col.obj.get(tokenId) : null;
    const el = document.createElement('div');
    el.className = 'react-float' + (reduce ? ' still' : '');
    el.textContent = emoji;
    el.setAttribute('aria-hidden', 'true');
    // ветерок: каждая реакция летит чуть по-своему
    el.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 40)}px`);
    if (o && board?.root && board.root.querySelector(`.obj[data-oid="${o.id}"]`)) {
      const p = board.worldToScreen(o.x + o.w / 2, o.y);
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      board.root.appendChild(el);
    } else {
      const chip = document.querySelector(`.g-player[data-uid="${userId}"]`);
      if (!chip) return;
      const r = chip.getBoundingClientRect();
      el.classList.add('at-avatar');
      el.style.left = r.left + r.width / 2 + 'px';
      el.style.top = r.bottom + 'px';
      document.body.appendChild(el);
    }
    setTimeout(() => el.remove(), reduce ? 1600 : 2200);
  });
}
