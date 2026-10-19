// Анимация брошенных кубиков: объёмные (three.js) или плоские в углу доски. Итог всегда в чате.
// У каждого игрока свой набор кубиков (settings.dice.skin) — его видят все за столом.
// Натуральные 20 и 1 на d20 отмечаются вспышкой там, где лёг кубик.
import { roll3d, webglAvailable } from './dice3d/index.js';
import { teapot } from '../ui/teapot.js';
import { skinLook } from './dice3d/skins.js';
import { paintSurface, shade2d, hash } from './dice3d/patterns.js';

// формы плоских кубиков в квадрате 100×100
const SHAPES = {
  4: { poly: [[50, 8], [94, 88], [6, 88]], ty: 63, fs: 30 },
  6: { rect: true, ty: 54, fs: 40 },
  8: { poly: [[50, 4], [94, 50], [50, 96], [6, 50]], ty: 53, fs: 34 },
  10: { poly: [[50, 4], [92, 42], [50, 96], [8, 42]], ty: 50, fs: 32 },
  12: { poly: [[50, 4], [95, 37], [78, 92], [22, 92], [5, 37]], ty: 56, fs: 32 },
  20: { poly: [[50, 4], [92, 27], [92, 73], [50, 96], [8, 73], [8, 27]], inner: [[50, 22], [78, 68], [22, 68]], ty: 54, fs: 30 },
};

/** Как показывать брошенные кубики: '3d' — объёмные, '2d' — плоские, 'off' — никак (настройка на этом устройстве) */
export function diceSetting() {
  try {
    const v = localStorage.getItem('tv:diceanim');
    return v === '0' || v === 'off' ? 'off' : v === '2d' ? '2d' : '3d';
  } catch {
    return '3d';
  }
}

/** Что показываем на деле: в режиме чайника вместо объёмных — плоские */
export function diceMode() {
  const m = diceSetting();
  return m === '3d' && teapot() ? '2d' : m;
}

export function setDiceMode(mode) {
  try {
    localStorage.setItem('tv:diceanim', mode === 'off' ? '0' : mode);
  } catch {
    /* хранилище недоступно */
  }
}

export const diceAnimEnabled = () => diceMode() !== 'off';
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Показать кубики броска: объёмные, если можно, иначе плоские. skin — набор кубиков того, кто бросал */
export function showRoll(container, msg, color, skin = 'player') {
  const mode = diceMode();
  if (mode === 'off' || !container) return;
  const dice = diceOfMessage(msg, 12);
  if (!dice.length) return;
  if (mode === '3d' && !reducedMotion() && webglAvailable()) {
    const onSettle = (info) => {
      for (const r of info.results) if (r.sides === 20 && !r.dropped && (r.want === 20 || r.want === 1) && r.screen) diceBurst(r.screen[0], r.screen[1], r.want === 20 ? 'crit' : 'fumble');
    };
    roll3d(container, dice, color, skin, { onSettle }).then((ok) => ok || showDice(container, msg, color, skin));
  } else showDice(container, msg, color, skin);
}

/** Кубики из сообщения: [{sides, v, dropped}] (не больше max) */
export function diceOfMessage(msg, max = 10) {
  const out = [];
  const walk = (parts) => {
    for (const p of parts || []) {
      if (out.length >= max) return;
      if (p.t === 'dice' && Array.isArray(p.dice)) {
        for (const d of p.dice) {
          if (out.length >= max) return;
          if (typeof d.v === 'number') out.push({ sides: p.sides, v: d.v, dropped: !!d.dr, crit: d.v === p.sides, fail: d.v === 1 });
        }
      } else if (p.t === 'group') for (const it of p.items || []) walk(it.parts);
    }
  };
  if (msg.roll) walk(msg.roll.parts);
  for (const r of msg.inlinerolls || []) walk(r.parts);
  return out;
}

function shapePath(ctx, sh, S) {
  const k = S / 100;
  ctx.beginPath();
  if (!sh) ctx.arc(50 * k, 50 * k, 44 * k, 0, Math.PI * 2);
  else if (sh.rect) ctx.roundRect ? ctx.roundRect(8 * k, 8 * k, 84 * k, 84 * k, 14 * k) : ctx.rect(8 * k, 8 * k, 84 * k, 84 * k);
  else {
    sh.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
    ctx.closePath();
  }
}

/** Плоский кубик набора: холст с узором, объёмом, рёбрами и числом */
export function dieCanvas(d, look, px = 58) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const S = Math.round(px * dpr);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  c.style.width = c.style.height = px + 'px';
  const ctx = c.getContext('2d');
  const sh = SHAPES[d.sides] || null;
  const k = S / 100;
  const surf = document.createElement('canvas');
  surf.width = surf.height = S;
  paintSurface(surf.getContext('2d'), { ...look, opacity: 1 }, S, hash(look.key + ':' + d.sides + ':' + d.v));
  ctx.save();
  shapePath(ctx, sh, S);
  ctx.clip();
  ctx.drawImage(surf, 0, 0);
  shade2d(ctx, look, S);
  ctx.restore();
  if (sh?.inner) {
    ctx.strokeStyle = look.edge;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 3 * k;
    ctx.beginPath();
    sh.inner.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const special = d.sides === 20 && !d.dropped && (d.crit || d.fail);
  ctx.strokeStyle = special ? (d.crit ? '#ffd76a' : '#ff6b6b') : look.edge;
  ctx.lineWidth = (special ? 6 : 4.5) * k;
  ctx.lineJoin = 'round';
  shapePath(ctx, sh, S);
  ctx.stroke();
  const ty = sh?.ty ?? 54;
  const fs = sh?.fs ?? (String(d.v).length > 2 ? 26 : 34);
  ctx.font = `700 ${Math.round(fs * k)}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (!look.glowInk) {
    ctx.lineWidth = 3.5 * k;
    ctx.strokeStyle = look.body;
    ctx.globalAlpha = 0.8;
    ctx.lineJoin = 'round';
    ctx.strokeText(String(d.v), 50 * k, ty * k);
    ctx.globalAlpha = 1;
  } else {
    ctx.shadowColor = look.glow;
    ctx.shadowBlur = 8 * k;
  }
  ctx.fillStyle = look.ink;
  ctx.fillText(String(d.v), 50 * k, ty * k);
  return c;
}

/** Показать плоские кубики в контейнере (обычно — область доски) */
export function showDice(container, msg, color = '#7a2e2e', skin = 'player') {
  if (!container || diceMode() === 'off') return;
  const dice = diceOfMessage(msg);
  if (!dice.length) return;
  let tray = container.querySelector('.dice-anim-tray');
  if (!tray) {
    tray = document.createElement('div');
    tray.className = 'dice-anim-tray';
    tray.setAttribute('aria-hidden', 'true');
    container.appendChild(tray);
  }
  const group = document.createElement('div');
  group.className = 'dice-group';
  group.dataset.skin = skin || 'player';
  const reduce = reducedMotion();
  const specials = [];
  dice.forEach((d, i) => {
    const look = skinLook(skin, color, d.dropped);
    const el = document.createElement('div');
    el.className = 'die' + (d.dropped ? ' dropped' : '') + (d.crit && d.sides === 20 ? ' crit' : '') + (d.fail && d.sides === 20 ? ' fail' : '');
    if (look.glow) el.style.setProperty('--glow', look.glow);
    if (look.glow) el.classList.add('glows');
    el.appendChild(dieCanvas(d, look));
    if (!reduce) {
      el.style.setProperty('--dx', `${80 + Math.random() * 160}px`);
      el.style.setProperty('--dy', `${-60 - Math.random() * 120}px`);
      el.style.setProperty('--rot', `${(Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 540)}deg`);
      el.style.animationDelay = `${i * 45}ms`;
    } else el.style.animation = 'none';
    if (d.sides === 20 && !d.dropped && (d.crit || d.fail)) specials.push([el, d.crit ? 'crit' : 'fumble', i]);
    group.appendChild(el);
  });
  tray.appendChild(group);
  while (tray.children.length > 3) tray.firstChild.remove();
  // вспышка, когда кубик долетел
  for (const [el, kind, i] of specials)
    setTimeout(
      () => {
        if (!el.isConnected) return;
        const r = el.getBoundingClientRect();
        diceBurst(r.left + r.width / 2, r.top + r.height / 2, kind);
      },
      reduce ? 0 : 900 + i * 45,
    );
  setTimeout(() => group.classList.add('fade'), 2600);
  setTimeout(() => group.remove(), 3300);
}

/**
 * Вспышка у кубика: kind 'crit' — золотая волна и лучи, «Крит!»; 'fumble' — бурый дым, «Провал!».
 * Без анимации (уменьшение движения) — только надпись.
 */
export function diceBurst(x, y, kind) {
  const reduce = reducedMotion();
  const el = document.createElement('div');
  el.className = `dice-burst ${kind}${reduce ? ' still' : ''}`;
  el.setAttribute('aria-hidden', 'true');
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  let html = '';
  if (!reduce) {
    if (kind === 'crit') {
      html += '<i class="db-ring"></i><i class="db-ring late"></i>';
      for (let i = 0; i < 12; i++) html += `<i class="db-ray" style="--a:${i * 30 + Math.round(Math.random() * 14 - 7)}deg;--l:${46 + Math.round(Math.random() * 30)}px"></i>`;
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 40 + Math.random() * 50;
        html += `<i class="db-spark" style="--x:${Math.round(Math.cos(a) * d)}px;--y:${Math.round(Math.sin(a) * d)}px;--t:${(0.5 + Math.random() * 0.4).toFixed(2)}s"></i>`;
      }
    } else
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 18 + Math.random() * 30;
        html += `<i class="db-puff" style="--x:${Math.round(Math.cos(a) * d)}px;--y:${Math.round(Math.sin(a) * d - 10)}px;--s:${(0.8 + Math.random() * 0.8).toFixed(2)};--t:${(0.9 + Math.random() * 0.5).toFixed(2)}s"></i>`;
      }
  }
  html += `<b class="db-label">${kind === 'crit' ? 'Крит!' : 'Провал!'}</b>`;
  el.innerHTML = html;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}
