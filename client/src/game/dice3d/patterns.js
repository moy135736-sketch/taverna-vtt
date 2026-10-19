// Узоры граней кубиков. Рисуются на холсте — для текстур объёмных кубиков, для плоских кубиков и для образцов в настройках.
// Узор каждой грани свой (зерно — по надписи), но повторяется от броска к броску. Светящиеся узоры (трещины лавы, звёзды)
// рисуются дважды одним и тем же зерном: на поверхности и в карте свечения — и совпадают точка в точку.
import { rgbOf, mix } from './skins.js';

/** Детерминированный генератор случайных чисел (mulberry32) */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const rgba = (c, a) => `rgba(${c.map((x) => Math.round(x)).join(',')},${a})`;

/** Ломаная со случайным изгибом от (x, y) в направлении ang */
function wander(ctx, r, x, y, ang, len, step, bend) {
  ctx.moveTo(x, y);
  for (let s = 0; s < len; s += step) {
    ang += (r() - 0.5) * bend;
    x += Math.cos(ang) * step;
    y += Math.sin(ang) * step;
    ctx.lineTo(x, y);
  }
  return [x, y, ang];
}

// ---------- светящиеся узоры: одинаковая последовательность случайных чисел для поверхности и свечения ----------

function cracks(ctx, r, S, color, glow) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const n = 5 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const x = r() * S;
    const y = r() * S;
    const ang = r() * Math.PI * 2;
    const len = S * (0.35 + r() * 0.5);
    const w = S * (0.012 + r() * 0.02);
    ctx.beginPath();
    const [ex, ey, ea] = wander(ctx, r, x, y, ang, len, S * 0.04, 1.4);
    // ответвление
    ctx.moveTo(ex, ey);
    wander(ctx, r, ex, ey, ea + (r() > 0.5 ? 1 : -1) * 0.9, len * 0.4, S * 0.04, 1.2);
    if (glow) {
      ctx.strokeStyle = rgba(color, 0.35);
      ctx.lineWidth = w * 4;
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(color, glow ? 1 : 0.95);
    ctx.lineWidth = w;
    ctx.stroke();
  }
}

function stars(ctx, r, S, glow) {
  const k = S / 128;
  const n = 70;
  for (let i = 0; i < n; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = (0.35 + r() * r() * 1.2) * k;
    const a = 0.35 + r() * 0.65;
    ctx.fillStyle = `rgba(255,255,255,${glow ? a * 0.9 : a})`;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  // несколько ярких звёзд с лучиками
  for (let i = 0; i < 5; i++) {
    const x = r() * S;
    const y = r() * S;
    const l = (3 + r() * 4) * k;
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 0.8 * k;
    ctx.beginPath();
    ctx.moveTo(x - l, y);
    ctx.lineTo(x + l, y);
    ctx.moveTo(x, y - l);
    ctx.lineTo(x, y + l);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 1.2 * k, 0, Math.PI * 2);
    ctx.fill();
  }
}

function bubbles(ctx, r, S, color, glow) {
  const n = 12;
  for (let i = 0; i < n; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = S * (0.02 + r() * r() * 0.08);
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, glow ? 0.22 : 0.14);
    ctx.fill();
    ctx.lineWidth = Math.max(1, S * 0.006);
    ctx.strokeStyle = rgba(color, glow ? 0.5 : 0.45);
    ctx.stroke();
    if (!glow) {
      ctx.beginPath();
      ctx.arc(x - rad * 0.35, y - rad * 0.35, rad * 0.25, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.fill();
    }
  }
}

// ---------- поверхность ----------

/** Тело грани: цвет набора и узор; S — размер холста, seed — зерно узора */
export function paintSurface(ctx, look, S, seed) {
  const body = rgbOf(look.body);
  const dark = mix(body, [0, 0, 0], 0.55);
  const light = mix(body, [255, 255, 255], 0.45);
  ctx.save();
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = rgba(body, look.opacity ?? 1);
  ctx.fillRect(0, 0, S, S);
  const r = rng(seed);
  const k = S / 128;
  switch (look.pattern) {
    case 'grain': {
      for (let y = 0; y < S; y += 2 * k) {
        ctx.strokeStyle = rgba(dark, 0.03 + r() * 0.06);
        ctx.lineWidth = k;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(S * 0.3, y + (r() - 0.5) * 3 * k, S * 0.7, y + (r() - 0.5) * 3 * k, S, y);
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(S * 0.35, S * 0.3, 0, S * 0.5, S * 0.5, S * 0.75);
      g.addColorStop(0, 'rgba(255,255,255,.18)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      break;
    }
    case 'paper': {
      for (let i = 0; i < 1100; i++) {
        ctx.fillStyle = r() > 0.5 ? rgba(dark, 0.05 + r() * 0.1) : rgba(light, 0.06 + r() * 0.1);
        ctx.fillRect(r() * S, r() * S, k * (0.6 + r()), k * (0.6 + r()));
      }
      ctx.lineCap = 'round';
      for (let i = 0; i < 14; i++) {
        ctx.strokeStyle = rgba(dark, 0.1 + r() * 0.12);
        ctx.lineWidth = 0.7 * k;
        ctx.beginPath();
        wander(ctx, r, r() * S, r() * S, r() * Math.PI * 2, S * 0.12, 2 * k, 0.8);
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S * 0.72);
      g.addColorStop(0, rgba(dark, 0));
      g.addColorStop(1, rgba(dark, 0.32));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      break;
    }
    case 'wood': {
      const cx = S * (r() > 0.5 ? -0.7 : 1.7);
      const cy = S * (r() * 1.6 - 0.3);
      const wob = r() * Math.PI * 2;
      for (let rad = S * 0.1; rad < S * 2.6; rad += k * (2.5 + r() * 4)) {
        ctx.strokeStyle = r() > 0.35 ? rgba(dark, 0.18 + r() * 0.2) : rgba(light, 0.08 + r() * 0.08);
        ctx.lineWidth = k * (0.8 + r() * 2.2);
        ctx.beginPath();
        for (let a = 0; a <= 64; a++) {
          const t = (a / 64) * Math.PI * 2;
          const rr = rad * (1 + 0.025 * Math.sin(t * 7 + wob) + 0.015 * Math.sin(t * 13 + rad * 0.05));
          const x = cx + Math.cos(t) * rr;
          const y = cy + Math.sin(t) * rr * 0.55;
          if (a) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      // поры
      for (let i = 0; i < 160; i++) {
        ctx.fillStyle = rgba(dark, 0.25);
        ctx.fillRect(r() * S, r() * S, k * (1 + r() * 3), k * 0.6);
      }
      break;
    }
    case 'marble': {
      for (let i = 0; i < 5; i++) {
        const g = ctx.createRadialGradient(r() * S, r() * S, 0, r() * S, r() * S, S * (0.3 + r() * 0.4));
        g.addColorStop(0, 'rgba(206,204,214,.35)');
        g.addColorStop(1, 'rgba(206,204,214,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < 4; i++) {
        const y = r() * S;
        const ang = (r() - 0.5) * 1.2;
        const len = S * (1 + r());
        const st = [-S * 0.1, y, ang];
        // мягкий ореол и тонкая жилка — одной и той же линией
        const save = r();
        for (const [w, a] of [
          [6 * k, 0.1],
          [1.5 * k, 0.75],
        ]) {
          const rr = rng(Math.floor(save * 1e9));
          ctx.strokeStyle = `rgba(70,70,84,${a})`;
          ctx.lineWidth = w * (i === 0 ? 1.3 : 0.7 + save * 0.5);
          ctx.beginPath();
          wander(ctx, rr, st[0], st[1], st[2], len, 4 * k, 0.9);
          ctx.stroke();
        }
      }
      break;
    }
    case 'bands': {
      const cx = S * (r() * 1.4 - 0.2);
      const cy = S * (r() > 0.5 ? -0.4 : 1.4);
      const ph = r() * 10;
      let i = 0;
      for (let rad = S * 0.05; rad < S * 2.2; rad += k * (2 + r() * 5), i++) {
        ctx.strokeStyle = i % 3 === 0 ? 'rgba(4,40,24,.55)' : i % 3 === 1 ? 'rgba(110,226,170,.28)' : 'rgba(18,96,62,.4)';
        ctx.lineWidth = k * (1.5 + r() * 3);
        ctx.beginPath();
        for (let a = 0; a <= 72; a++) {
          const t = (a / 72) * Math.PI * 2;
          const rr = rad + Math.sin(t * 5 + ph + rad * 0.03) * k * 3;
          const x = cx + Math.cos(t) * rr;
          const y = cy + Math.sin(t) * rr;
          if (a) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'sheen': {
      const g = ctx.createRadialGradient(S * 0.3, S * 0.25, 0, S * 0.3, S * 0.25, S * 0.6);
      g.addColorStop(0, 'rgba(255,255,255,.14)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = 'rgba(150,110,210,.12)';
      ctx.lineWidth = S * 0.16;
      ctx.beginPath();
      ctx.arc(S * (0.2 + r() * 0.6), S * 1.15, S * 0.8, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(80,190,200,.08)';
      ctx.lineWidth = S * 0.08;
      ctx.stroke();
      break;
    }
    case 'patina': {
      for (let i = 0; i < 9; i++) {
        const x = r() * S;
        const y = r() * S;
        const rad = S * (0.06 + r() * 0.2);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(84,170,146,.8)');
        g.addColorStop(0.6, 'rgba(84,170,146,.35)');
        g.addColorStop(1, 'rgba(84,170,146,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);
      }
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = r() > 0.6 ? 'rgba(60,24,8,.25)' : 'rgba(255,214,170,.18)';
        ctx.fillRect(r() * S, r() * S, k, k);
      }
      break;
    }
    case 'frost': {
      const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.15, S / 2, S / 2, S * 0.75);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(255,255,255,.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      ctx.lineCap = 'round';
      for (let i = 0; i < 12; i++) {
        // кристалл: ствол и веточки под 60°
        const side = Math.floor(r() * 4);
        const t = r() * S;
        const [x, y] = side === 0 ? [t, 0] : side === 1 ? [S, t] : side === 2 ? [t, S] : [0, t];
        const ang = Math.atan2(S / 2 - y, S / 2 - x) + (r() - 0.5) * 0.8;
        const len = S * (0.15 + r() * 0.25);
        ctx.strokeStyle = `rgba(255,255,255,${0.45 + r() * 0.35})`;
        ctx.lineWidth = k * (0.7 + r() * 1.2);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        for (let b = 1; b <= 3; b++) {
          const bx = x + Math.cos(ang) * len * (b / 4);
          const by = y + Math.sin(ang) * len * (b / 4);
          const bl = len * 0.3 * (1 - b / 5);
          for (const sgn of [-1, 1]) {
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + Math.cos(ang + (sgn * Math.PI) / 3) * bl, by + Math.sin(ang + (sgn * Math.PI) / 3) * bl);
          }
        }
        ctx.stroke();
      }
      break;
    }
    case 'cracks': {
      // корка остывшей лавы и раскалённые трещины
      for (let i = 0; i < 500; i++) {
        ctx.fillStyle = r() > 0.5 ? 'rgba(0,0,0,.25)' : 'rgba(120,60,40,.18)';
        ctx.fillRect(r() * S, r() * S, k * (1 + r() * 2), k * (1 + r() * 2));
      }
      cracks(ctx, r, S, rgbOf(look.glow || '#ff6a1a'), false);
      break;
    }
    case 'stars': {
      for (const [c, a] of [
        ['#6a3cc8', 0.45],
        ['#2a6fd0', 0.35],
      ]) {
        const x = r() * S;
        const y = r() * S;
        const g = ctx.createRadialGradient(x, y, 0, x, y, S * (0.35 + r() * 0.3));
        g.addColorStop(0, rgba(rgbOf(c), a));
        g.addColorStop(1, rgba(rgbOf(c), 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);
      }
      stars(ctx, r, S, false);
      break;
    }
    case 'bubbles': {
      bubbles(ctx, r, S, rgbOf(look.glow || '#b8ff3c'), false);
      break;
    }
    case 'swirl': {
      ctx.lineCap = 'round';
      for (let i = 0; i < 7; i++) {
        ctx.strokeStyle = i % 3 ? 'rgba(18,0,4,.45)' : 'rgba(230,50,70,.22)';
        ctx.lineWidth = k * (1.5 + r() * 5);
        ctx.beginPath();
        const x = r() * S;
        const y = r() * S;
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(r() * S, r() * S, r() * S, r() * S, r() * S, r() * S);
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(S * 0.3, S * 0.25, 0, S * 0.3, S * 0.25, S * 0.5);
      g.addColorStop(0, 'rgba(255,255,255,.16)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

/** Карта свечения (что светится само в темноте): false — у набора ничего не светится */
export function paintGlow(ctx, look, S, seed) {
  if (!look.glow) return false;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  const r = rng(seed);
  const glow = rgbOf(look.glow);
  // повторяем те же вызовы случайных чисел, что и на поверхности
  if (look.pattern === 'cracks') {
    for (let i = 0; i < 500; i++) {
      r();
      r();
      r();
      r();
      r();
    }
    cracks(ctx, r, S, glow, true);
  } else if (look.pattern === 'stars') {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) r();
    stars(ctx, r, S, true);
  } else if (look.pattern === 'bubbles') bubbles(ctx, r, S, glow, true);
  ctx.restore();
  return true;
}

/** Небольшой узор для образца в настройках: грань d20 (шестиугольник) с узором, рёбрами и числом */
export function paintSwatch(canvas, look, text = '20') {
  const S = canvas.width;
  const ctx = canvas.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = S;
  const tctx = tmp.getContext('2d');
  paintSurface(tctx, { ...look, opacity: 1 }, S, hash(look.key + text));
  ctx.clearRect(0, 0, S, S);
  const P = [
    [50, 4],
    [92, 27],
    [92, 73],
    [50, 96],
    [8, 73],
    [8, 27],
  ].map(([x, y]) => [(x / 100) * S, (y / 100) * S]);
  ctx.save();
  ctx.beginPath();
  P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(tmp, 0, 0);
  shade2d(ctx, look, S);
  ctx.restore();
  // внутренний треугольник — грани d20
  ctx.strokeStyle = look.edge;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = S * 0.025;
  ctx.beginPath();
  [
    [50, 22],
    [78, 68],
    [22, 68],
  ].forEach(([x, y], i) => (i ? ctx.lineTo((x / 100) * S, (y / 100) * S) : ctx.moveTo((x / 100) * S, (y / 100) * S)));
  ctx.closePath();
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = S * 0.04;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  ctx.font = `700 ${Math.round(S * 0.27)}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (look.glowInk) {
    ctx.shadowColor = look.glow;
    ctx.shadowBlur = S * 0.08;
  }
  ctx.fillStyle = look.ink;
  ctx.fillText(text, S / 2, S * 0.56);
}

/** Объём для плоского кубика: блик сверху слева, тень снизу справа; у металла — сильнее */
export function shade2d(ctx, look, S) {
  const metal = look.metal >= 0.5;
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, `rgba(255,255,255,${metal ? 0.5 : 0.22})`);
  g.addColorStop(0.45, 'rgba(255,255,255,0)');
  g.addColorStop(0.55, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${metal ? 0.42 : 0.25})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  if (metal) {
    // полоса отражения
    const h = ctx.createLinearGradient(0, S * 0.25, S, S * 0.75);
    h.addColorStop(0.35, 'rgba(255,255,255,0)');
    h.addColorStop(0.5, 'rgba(255,255,255,.35)');
    h.addColorStop(0.65, 'rgba(255,255,255,0)');
    ctx.fillStyle = h;
    ctx.fillRect(0, 0, S, S);
  }
}
