// Эффекты, с которыми бросок прилетает в чат: листопад, искры, угли, иней, молния, дым, лепестки, звёздная пыль,
// чернила, брызги, руны, глитч. Эффект выбирает тот, кто бросал (settings.dice.fx), — видят все за столом.
// На натуральной 20 эффект богаче и с золотой волной, на единице — приглушённый.
import { ROLL_FX } from '@shared/diceStyle.js';
import { diceOfMessage } from '../diceAnim.js';
import { teapot } from '../../ui/teapot.js';
import './rollfx.css';

/** «По оформлению стола»: у каждого оформления свой эффект */
const THEME_FX = { tavern: 'embers', fantasy: 'runes', cyber: 'glitch' };
export const FX_IDS = ROLL_FX.map(([id]) => id).filter((id) => id !== 'auto' && id !== 'none');

/** Показывать ли эффекты бросков на этом устройстве */
export function rollFxEnabled() {
  try {
    return localStorage.getItem('tv:rollfx') !== '0';
  } catch {
    return true;
  }
}
/** Показываем ли эффекты сейчас: в режиме чайника — нет */
export const rollFxActive = () => rollFxEnabled() && !teapot();
export function setRollFxEnabled(on) {
  try {
    if (on) localStorage.removeItem('tv:rollfx');
    else localStorage.setItem('tv:rollfx', '0');
  } catch {
    /* хранилище недоступно */
  }
}

/** Какой эффект показать для выбора игрока (null — без эффекта) */
export function resolveFx(fx) {
  if (fx === 'none') return null;
  if (FX_IDS.includes(fx)) return fx;
  const theme = document.documentElement.dataset.theme || 'tavern';
  return THEME_FX[theme] || 'embers';
}

/** 'crit' — натуральная 20 на d20, 'fumble' — единица, '' — обычный бросок */
export function rollMood(msg) {
  const d20 = diceOfMessage(msg, 60).filter((d) => d.sides === 20 && !d.dropped);
  if (d20.some((d) => d.v === 20)) return 'crit';
  if (d20.some((d) => d.v === 1)) return 'fumble';
  return '';
}

const R = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const n2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x);
/** Частица: класс и числа для CSS (--x, --y, --dx…; единицы — в CSS) */
const P = (cls, vars, text = '') =>
  `<i class="p ${cls}" style="${Object.entries(vars)
    .map(([k, v]) => `--${k}:${n2(v)}`)
    .join(';')}">${text}</i>`;

// руны, снежинка и звёздочка — линиями SVG: не зависят от шрифтов (рунических глифов во многих системах нет)
const RUNES = [
  'M3 1V15M3 6L8 2M3 10L8 6',
  'M2 15V1L8 5V15',
  'M3 1V15M3 4L8 8L3 12',
  'M3 1V15M3 3L8 6M3 7L8 10',
  'M3 15V1L8 5L3 8L8 15',
  'M8 3L3 8L8 13',
  'M2 2L8 14M8 2L2 14',
  'M3 15V1L8 5L3 9',
  'M2 1V15M8 1V15M2 6L8 10',
  'M5 1V15M2 6L8 10',
  'M5 2L2 5L5 8M5 8L8 11L5 14',
  'M5 1V15M5 1L8 4M5 15L2 12',
  'M5 15V1M5 7L1 2M5 7L9 2',
  'M7 1L2 6L8 10L3 15',
  'M5 15V1M5 1L1 6M5 1L9 6',
  'M3 1V15M3 1L8 4.5L3 8L8 11.5L3 15',
  'M2 15V1L5 5L8 1V15',
  'M2 15V1L8 7M8 15V1L2 7',
  'M4 15V1L8 5',
  'M2 2V14L8 2V14Z',
  'M2 15L8 7L5 2L2 7L8 15',
];
const svg = (vb, d, cls = '') => `<svg viewBox="${vb}" class="${cls}" aria-hidden="true"><path d="${d}"/></svg>`;
const FLAKE = svg('-8 -8 16 16', 'M0-7V7M-6.1-3.5L6.1 3.5M-6.1 3.5L6.1-3.5M0-7L-1.8-8.6M0-7L1.8-8.6M0 7L-1.8 8.6M0 7L1.8 8.6M-6.1-3.5L-6.4-5.9M-6.1-3.5L-8.3-2.6M6.1 3.5L6.4 5.9M6.1 3.5L8.3 2.6M-6.1 3.5L-8.3 2.6M-6.1 3.5L-6.4 5.9M6.1-3.5L8.3-2.6M6.1-3.5L6.4-5.9');
const STAR = svg('-8 -8 16 16', 'M0-8C.7-2.2 2.2-.7 8 0 2.2.7.7 2.2 0 8-.7 2.2-2.2.7-8 0-2.2-.7-.7-2.2 0-8Z', 'fill');

/** Генераторы эффектов: b — {w, h, fx, fy (точка броска), n (сколько частиц), crit, fumble}; host — что добавить сообщению */
const GEN = {
  leaves(b) {
    let h = '<i class="rfx-flash"></i>';
    const colors = ['#7cb342', '#9ccc65', '#c0ca33', '#f9a825', '#ef6c00', '#b07a4f'];
    for (let i = 0; i < b.n * 1.3; i++) {
      const x = R(0, b.w);
      const y = R(0, b.h);
      const a = Math.atan2(y - b.h / 2, x - b.w / 2) + R(-0.5, 0.5);
      const d = R(30, 90);
      h += P('leaf', { x, y, dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.6 - 12, r: R(-320, 320), sw: R(-30, 30), t: R(1.3, 1.9), dl: R(0, 0.25), s: R(0.7, 1.3), c: pick(colors) });
    }
    return h;
  },
  sparks(b) {
    let h = '<i class="rfx-flash"></i>';
    for (let i = 0; i < b.n * 1.4; i++) h += P('spark', { x: b.fx, y: b.fy, a: R(0, 360), d: R(40, 115), l: R(8, 18), t: R(0.45, 0.85), dl: R(0, 0.12) });
    return h;
  },
  embers(b) {
    let h = '<i class="rfx-glow"></i>';
    for (let i = 0; i < b.n; i++) h += P('ember', { x: R(0, b.w), y: b.h - R(0, 10), dx: R(-28, 28), dy: -R(40, 115), t: R(1.2, 2.1), dl: R(0, 0.5), s: R(0.6, 1.3) });
    return h;
  },
  frost(b) {
    let h = '<i class="rfx-frost"></i>';
    for (let i = 0; i < b.n * 0.75; i++) h += P('flake', { x: R(0, b.w), y: R(-12, b.h * 0.45), dx: R(-14, 14), dy: R(25, 60), r: R(-200, 200), t: R(1.4, 2.2), dl: R(0, 0.4), s: R(0.7, 1.4) }, FLAKE);
    return h;
  },
  lightning(b) {
    // зигзаг сверху в число броска и короткая развилка
    const top = -Math.min(150, b.fy + 110);
    let x = b.fx + R(-50, 50);
    let y = top;
    const pts = [[x, y]];
    while (y < b.fy - 4) {
      y = Math.min(b.fy, y + R(14, 26));
      x += R(-16, 16);
      if (y >= b.fy - 4) x = b.fx;
      pts.push([x, y]);
    }
    const mid = pts[Math.floor(pts.length / 2)];
    const fork = [mid, [mid[0] + R(-34, 34), mid[1] + R(16, 28)], [mid[0] + R(-50, 50), mid[1] + R(34, 50)]];
    const H = b.fy - top + 8;
    const line = (ps) => ps.map(([px, py]) => `${Math.round(px)},${Math.round(py - top)}`).join(' ');
    let h = `<svg class="rfx-bolt" style="top:${Math.round(top)}px" width="${Math.round(b.w)}" height="${Math.round(H)}" viewBox="0 0 ${Math.round(b.w)} ${Math.round(H)}"><polyline points="${line(pts)}"/><polyline class="br" points="${line(fork)}"/></svg><i class="rfx-strike"></i>`;
    for (let i = 0; i < 8; i++) h += P('spark', { x: b.fx, y: b.fy, a: R(180, 360), d: R(20, 55), l: R(6, 12), t: R(0.35, 0.6), dl: 0.08 });
    b.host = 'rfx-shake';
    return h;
  },
  smoke(b) {
    let h = '';
    for (let i = 0; i < b.n * 0.65; i++) h += P('puff', { x: R(0, b.w), y: R(b.h * 0.3, b.h), dx: R(-24, 24), dy: -R(20, 55), s: R(0.8, 1.6), t: R(1.2, 1.9), dl: R(0, 0.3) });
    b.host = 'rfx-blurin';
    return h;
  },
  petals(b) {
    let h = '<i class="rfx-flash"></i>';
    const colors = ['#ff7aa8', '#ff94bb', '#f06292', '#ffb3cc'];
    for (let i = 0; i < b.n; i++) h += P('petal', { x: R(-30, b.w * 0.6), y: R(-20, b.h), dx: R(60, 160), dy: R(10, 50), r: R(90, 420), t: R(1.5, 2.3), dl: R(0, 0.5), s: R(0.7, 1.2), c: pick(colors) });
    return h;
  },
  stardust(b) {
    let h = '<i class="rfx-shimmer"></i>';
    const colors = ['#9b6dff', '#7c4dff', '#5c8dff', '#e0a43a', '#c56bff'];
    for (let i = 0; i < b.n * 1.2; i++) h += P('star', { x: R(0, b.w), y: R(-6, b.h + 6), r: R(40, 140), t: R(0.8, 1.4), dl: R(0, 0.7), s: R(0.6, 1.4), c: pick(colors) }, STAR);
    return h;
  },
  ink(b) {
    let h = '<i class="rfx-wash"></i>';
    const blob = () => `${Math.round(R(30, 70))}% ${Math.round(R(30, 70))}% ${Math.round(R(30, 70))}% ${Math.round(R(30, 70))}% / ${Math.round(R(30, 70))}% ${Math.round(R(30, 70))}% ${Math.round(R(30, 70))}% ${Math.round(R(30, 70))}%`;
    for (let i = 0; i < b.n * 0.45; i++) {
      const x = R(0, b.w);
      const y = R(0, b.h);
      const s = R(0.6, 1.4);
      const dl = R(0, 0.25);
      h += P('splat', { x, y, s, t: R(1.1, 1.6), dl, br: blob(), rot: R(0, 360) });
      // брызги вокруг кляксы
      for (let j = 0; j < 3; j++) {
        const a = R(0, Math.PI * 2);
        const d = R(14, 24) * s;
        h += P('splat dot', { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, s: R(0.12, 0.25), t: R(1, 1.4), dl: dl + 0.05, br: blob(), rot: 0 });
      }
    }
    for (let i = 0; i < b.n * 0.5; i++) h += P('drop', { x: b.fx, y: b.fy, dx: R(-80, 80), up: -R(15, 45), dy: R(5, 35), t: R(0.6, 1), dl: R(0, 0.1), s: R(0.5, 1.2) });
    return h;
  },
  splash(b) {
    let h = P('ring', { x: b.fx, y: b.fy, t: 0.9, dl: 0 }) + P('ring', { x: b.fx, y: b.fy, t: 0.9, dl: 0.18 });
    for (let i = 0; i < b.n; i++) h += P('drop', { x: b.fx, y: b.fy, dx: R(-90, 90), up: -R(25, 65), dy: R(10, 40), t: R(0.7, 1.1), dl: R(0, 0.1), s: R(0.6, 1.3) });
    return h;
  },
  runes(b) {
    let h = '<i class="rfx-sigil"></i>';
    const per = 2 * (b.w + b.h);
    for (let i = 0; i < b.n * 0.75; i++) {
      // по рамке сообщения
      let t = R(0, per);
      let x;
      let y;
      if (t < b.w) [x, y] = [t, 0];
      else if ((t -= b.w) < b.h) [x, y] = [b.w, t];
      else if ((t -= b.h) < b.w) [x, y] = [b.w - t, b.h];
      else [x, y] = [0, b.h - (t - b.w)];
      h += P('rune', { x, y, dy: -R(10, 30), t: R(1.1, 1.7), dl: R(0, 0.5), s: R(0.8, 1.3) }, svg('0 0 10 16', pick(RUNES)));
    }
    return h;
  },
  glitch(b) {
    let h = '';
    const colors = ['rgba(0,255,255,.55)', 'rgba(255,0,170,.5)', 'rgba(255,255,255,.4)'];
    for (let i = 0; i < 6; i++) h += P('gbar', { x: R(-20, 10), y: R(0, b.h), w: R(30, 100), hh: R(2, 9), t: R(0.35, 0.6), dl: R(0, 0.5), c: pick(colors) });
    for (let i = 0; i < b.n * 0.5; i++) h += P('px', { x: R(0, b.w), y: R(0, b.h), s: R(3, 10), t: R(0.2, 0.45), dl: R(0, 0.6), c: pick(colors) });
    b.host = 'rfx-jitter';
    return h;
  },
};

/**
 * Проиграть эффект над сообщением чата. wrap — обёртка сообщения (.msg-wrap) или любой блок;
 * fx — id эффекта; mood — 'crit' / 'fumble' / ''.
 */
export function playRollFx(wrap, fx, mood = '') {
  const gen = GEN[fx];
  if (!gen || !wrap?.isConnected) return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  const target = wrap.querySelector?.('.message') || wrap;
  const rect = target.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 8 || rect.bottom < 0 || rect.top > window.innerHeight) return false;
  // точка броска — число результата, иначе середина сообщения
  const num = target.querySelector('.rolled, .inlinerollresult');
  const nr = num?.getBoundingClientRect();
  const b = {
    w: rect.width,
    h: rect.height,
    fx: nr && nr.width ? nr.left - rect.left + nr.width / 2 : rect.width / 2,
    fy: nr && nr.height ? nr.top - rect.top + nr.height / 2 : rect.height / 2,
    n: Math.round(14 * (mood === 'crit' ? 1.7 : mood === 'fumble' ? 0.8 : 1)),
    host: '',
  };
  const el = document.createElement('div');
  el.className = `rfx rfx-${fx}${mood ? ' ' + mood : ''}`;
  el.setAttribute('aria-hidden', 'true');
  el.dataset.fx = fx;
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  el.innerHTML = gen(b) + (mood === 'crit' ? '<i class="rfx-crit"></i>' : '');
  document.body.appendChild(el);
  if (b.host) {
    wrap.classList.add(b.host);
    setTimeout(() => wrap.classList.remove(b.host), 800);
  }
  setTimeout(() => el.remove(), 2800);
  return true;
}
