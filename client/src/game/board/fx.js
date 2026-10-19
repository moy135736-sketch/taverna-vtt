// Спецэффекты (частицы) и погода. Рисуются на отдельном холсте.
import { teapot } from '../../ui/teapot.js';

export const FX_COLORS = {
  fire: { name: 'Огонь', c: ['#fff3b0', '#ffb000', '#ff5a00', '#a01800'], add: true },
  frost: { name: 'Холод', c: ['#ffffff', '#c9f3ff', '#7fd4ff', '#3b8fd9'], add: true },
  acid: { name: 'Кислота', c: ['#efffc0', '#b8ff3a', '#5ed12a', '#2a7a10'], add: true },
  blood: { name: 'Кровь', c: ['#ff4b4b', '#c40018', '#8a0010', '#4a0008'], add: false },
  charm: { name: 'Очарование', c: ['#ffffff', '#ffb3ec', '#ff5fcf', '#b0228f'], add: true },
  death: { name: 'Смерть', c: ['#b58bd6', '#5d2a7a', '#2a0d3a', '#000000'], add: false },
  holy: { name: 'Свет', c: ['#ffffff', '#fff7c2', '#ffe066', '#e0b030'], add: true },
  magic: { name: 'Магия', c: ['#ffffff', '#d4b8ff', '#9a5cff', '#4b1fb0'], add: true },
  slime: { name: 'Слизь', c: ['#e6ffb0', '#8fe03a', '#4fa020', '#24600a'], add: false },
  smoke: { name: 'Дым', c: ['#d0d0d0', '#9a9a9a', '#6a6a6a', '#3a3a3a'], add: false },
  water: { name: 'Вода', c: ['#ffffff', '#a8dcff', '#3fa7ff', '#1060c0'], add: true },
  lightning: { name: 'Молния', c: ['#ffffff', '#eaf6ff', '#9fd2ff', '#5aa0ff'], add: true },
};

export const FX_TYPES = {
  burst: { name: 'Вспышка' },
  explode: { name: 'Взрыв' },
  nova: { name: 'Волна' },
  bubbling: { name: 'Пузыри' },
  burn: { name: 'Пламя' },
  glow: { name: 'Сияние' },
  splatter: { name: 'Брызги' },
  heal: { name: 'Исцеление' },
  missile: { name: 'Снаряд', line: true },
  beam: { name: 'Луч', line: true },
  breath: { name: 'Дыхание (конус)', line: true },
  bolt: { name: 'Молния', line: true },
};

export const WEATHER = {
  none: 'Ясно',
  rain: 'Дождь',
  storm: 'Гроза',
  snow: 'Снег',
  fog: 'Туман',
  embers: 'Искры',
  leaves: 'Листопад',
  ash: 'Пепел',
  sand: 'Песчаная буря',
  stars: 'Светлячки',
};

const rand = (a, b) => a + Math.random() * (b - a);

function hexToRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class FxEngine {
  constructor(board, canvas) {
    this.board = board;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.parts = [];
    this.lines = []; // молнии/лучи
    this.texts = []; // числа урона и лечения над токенами
    this.weather = { type: 'none', parts: [], flash: 0 };
    this.running = false;
    this.last = 0;
    this.custom = null;
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.weather.parts = [];
  }

  setWeather(w) {
    const type = w?.type || 'none';
    if (type !== this.weather.type || w?.intensity !== this.weather.intensity) {
      this.weather = { type, intensity: w?.intensity ?? 0.5, wind: w?.wind ?? 0.3, color: w?.color || '', parts: [], flash: 0 };
    }
    this.kick();
  }

  kick() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Число над токеном: урон — красное, лечение — зелёное; всплывает и тает */
  floatText(x, y, text, kind) {
    const t = String(text ?? '').slice(0, 12);
    if (!t || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.texts.push({ x, y, text: t, heal: kind === 'heal', age: 0, life: 1.9 });
    if (this.texts.length > 30) this.texts.shift();
    this.kick();
  }

  /** Запустить эффект в мировых координатах */
  spawn({ type = 'burst', color = 'fire', x, y, x2, y2, custom }) {
    if (type === 'float') return this.floatText(x, y, custom?.text, color);
    const pal = FX_COLORS[color] || FX_COLORS.fire;
    // в режиме чайника — половина частиц: эффект тот же, рисовать вдвое меньше
    const lite = teapot();
    const P = (o) => (lite && Math.random() < 0.5 ? 0 : this.parts.push({ age: 0, ...o, pal, add: pal.add }));
    const R = this.board.page?.cellSize || 70;
    const dirTo = x2 !== undefined && y2 !== undefined ? Math.atan2(y2 - y, x2 - x) : -Math.PI / 2;
    const dist = x2 !== undefined && y2 !== undefined ? Math.hypot(x2 - x, y2 - y) : R * 3;
    if (custom) {
      const c = custom;
      for (let i = 0; i < (c.count || 60); i++) {
        const a = ((c.angle ?? 0) + rand(-(c.spread ?? 360) / 2, (c.spread ?? 360) / 2)) * (Math.PI / 180);
        const sp = rand(c.speedMin ?? 40, c.speedMax ?? 200);
        P({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(c.lifeMin ?? 0.4, c.lifeMax ?? 1.2), size: rand(c.sizeMin ?? 4, c.sizeMax ?? 14), g: c.gravity ?? 0, drag: c.drag ?? 1.5, delay: rand(0, c.duration ?? 0.2) });
      }
      this.kick();
      return;
    }
    switch (type) {
      case 'burst':
        for (let i = 0; i < 70; i++) {
          const a = rand(0, Math.PI * 2),
            sp = rand(60, 260);
          P({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.35, 0.9), size: rand(5, 14), drag: 2.4 });
        }
        break;
      case 'explode':
        for (let i = 0; i < 160; i++) {
          const a = rand(0, Math.PI * 2),
            sp = rand(80, 420);
          P({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.5, 1.4), size: rand(8, 26), drag: 2.2, grow: 1.6 });
        }
        for (let i = 0; i < 40; i++) {
          const a = rand(0, Math.PI * 2),
            sp = rand(20, 90);
          this.parts.push({ age: 0, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30, life: rand(1.2, 2.4), size: rand(20, 40), grow: 2, pal: FX_COLORS.smoke, add: false, delay: 0.25, drag: 1 });
        }
        this.board.shake?.(8);
        break;
      case 'nova':
        for (let i = 0; i < 120; i++) {
          const a = (i / 120) * Math.PI * 2,
            sp = 330;
          P({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.8, size: 10, drag: 1.4 });
        }
        break;
      case 'bubbling':
        for (let i = 0; i < 50; i++) P({ x: x + rand(-R / 2, R / 2), y: y + rand(-R / 3, R / 3), vx: rand(-10, 10), vy: rand(-90, -30), life: rand(0.8, 2), size: rand(4, 10), delay: rand(0, 1.2), ring: true, drag: 0.3 });
        break;
      case 'burn':
        for (let i = 0; i < 110; i++) P({ x: x + rand(-R / 2, R / 2), y: y + rand(-R / 4, R / 2), vx: rand(-15, 15), vy: rand(-140, -60), life: rand(0.5, 1.3), size: rand(8, 20), delay: rand(0, 1.6), drag: 0.6, shrink: true });
        break;
      case 'glow':
        for (let i = 0; i < 40; i++) {
          const a = rand(0, Math.PI * 2),
            r = rand(0, R * 0.7);
          P({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, vx: 0, vy: rand(-20, -5), life: rand(1, 2.2), size: rand(14, 30), delay: rand(0, 0.8), drag: 0 });
        }
        break;
      case 'splatter':
        for (let i = 0; i < 60; i++) {
          const a = rand(0, Math.PI * 2),
            sp = rand(60, 300);
          P({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, life: rand(0.5, 1.1), size: rand(3, 9), g: 600, drag: 0.5, stay: true });
        }
        break;
      case 'heal':
        for (let i = 0; i < 70; i++) P({ x: x + rand(-R / 2, R / 2), y: y + rand(-R / 2, R / 2), vx: rand(-8, 8), vy: rand(-80, -30), life: rand(0.8, 1.6), size: rand(3, 8), delay: rand(0, 1), star: true, drag: 0.2 });
        break;
      case 'missile': {
        const n = 8;
        for (let k = 0; k < n; k++) {
          const t0 = k * 0.03;
          this.parts.push({ age: 0, x, y, tx: x2 ?? x, ty: y2 ?? y - R * 3, missile: true, dur: Math.max(0.35, dist / 900), life: Math.max(0.35, dist / 900) + 0.3, size: 12 - k, pal, add: pal.add, delay: t0 });
        }
        break;
      }
      case 'beam': {
        const steps = Math.max(20, Math.round(dist / 6));
        for (let i = 0; i < steps; i++) {
          const t = i / steps;
          P({ x: x + Math.cos(dirTo) * dist * t, y: y + Math.sin(dirTo) * dist * t, vx: rand(-20, 20), vy: rand(-20, 20), life: rand(0.4, 0.9), size: rand(6, 14), delay: t * 0.15, drag: 2 });
        }
        break;
      }
      case 'breath':
        for (let i = 0; i < 220; i++) {
          const a = dirTo + rand(-0.47, 0.47),
            sp = rand(dist * 0.8, dist * 2.2);
          P({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.5, 0.9), size: rand(8, 22), grow: 1.8, delay: rand(0, 0.5), drag: 1.2 });
        }
        break;
      case 'bolt': {
        this.lines.push({ x, y, x2: x2 ?? x, y2: y2 ?? y - R * 4, age: 0, life: 0.6, pal, seed: Math.random() });
        for (let i = 0; i < 30; i++) {
          const a = rand(0, Math.PI * 2),
            sp = rand(40, 180);
          P({ x: x2 ?? x, y: y2 ?? y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.2, 0.6), size: rand(3, 8), drag: 2, delay: 0.05 });
        }
        break;
      }
    }
    this.kick();
  }

  frame(t) {
    // кадров в секунду: одна погода — 30 (её хватает глазу; экран игрового ноутбука даёт 144),
    // в режиме чайника погода — 20, спецэффекты — 30; обычные спецэффекты — сколько даёт экран
    const busy = this.parts.length || this.lines.length || this.texts.length;
    const fps = teapot() ? (busy ? 30 : 20) : busy ? 0 : 30;
    if (fps && t - this.last < 1000 / fps - 3) {
      requestAnimationFrame((tt) => this.frame(tt));
      return;
    }
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const ctx = this.ctx;
    const W = this.canvas.width,
      H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cam = this.board.cam;

    // частицы
    if (this.parts.length || this.lines.length) {
      ctx.setTransform(cam.z, 0, 0, cam.z, cam.x, cam.y);
      const alive = [];
      for (const p of this.parts) {
        if (p.delay > 0) {
          p.delay -= dt;
          alive.push(p);
          continue;
        }
        p.age += dt;
        if (p.age >= p.life) continue;
        alive.push(p);
        const k = p.age / p.life;
        if (p.missile) {
          const tt = Math.min(1, p.age / p.dur);
          const e = tt * tt * (3 - 2 * tt);
          p.x = p.x0 ?? (p.x0 = p.x);
          const cx = p.x0 + (p.tx - p.x0) * e;
          p.y0 = p.y0 ?? p.y;
          const cy = p.y0 + (p.ty - p.y0) * e - Math.sin(tt * Math.PI) * 30;
          drawDot(ctx, cx, cy, p.size * (tt >= 1 ? 2.5 * (1 - (p.age - p.dur) / 0.3) : 1), p.pal, 0, 1, p.add);
          continue;
        }
        p.vx *= Math.max(0, 1 - (p.drag || 0) * dt);
        p.vy *= Math.max(0, 1 - (p.drag || 0) * dt);
        p.vy += (p.g || 0) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        let size = p.size * (p.grow ? 1 + (p.grow - 1) * k : 1);
        if (p.shrink) size *= 1 - k * 0.7;
        const alpha = p.stay ? (k < 0.8 ? 1 : (1 - k) / 0.2) : 1 - k * k;
        if (p.ring) {
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = p.pal.c[1];
          ctx.globalAlpha = alpha * 0.9;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
          ctx.stroke();
        } else drawDot(ctx, p.x, p.y, size, p.pal, k, alpha, p.add, p.star);
      }
      this.parts = alive;
      const lines = [];
      for (const l of this.lines) {
        l.age += dt;
        if (l.age >= l.life) continue;
        lines.push(l);
        drawBolt(ctx, l);
      }
      this.lines = lines;
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // числа над токенами — в экранных координатах, чтобы читались при любом масштабе
    if (this.texts.length) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const alive = [];
      for (const t of this.texts) {
        t.age += dt;
        if (t.age >= t.life) continue;
        alive.push(t);
        const k = t.age / t.life;
        const sx = cam.x + t.x * cam.z;
        const sy = cam.y + t.y * cam.z - 8 - (still ? 0 : k * 44);
        const pop = still ? 1 : k < 0.1 ? 0.6 + (k / 0.1) * 0.55 : k < 0.2 ? 1.15 - ((k - 0.1) / 0.1) * 0.15 : 1;
        ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
        ctx.font = `700 ${Math.round(28 * pop)}px Alegreya, Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(18, 15, 12, 0.85)';
        ctx.strokeText(t.text, sx, sy);
        ctx.fillStyle = t.heal ? '#86e08f' : '#ff6a5c';
        ctx.fillText(t.text, sx, sy);
      }
      this.texts = alive;
      ctx.globalAlpha = 1;
    }

    // погода (в экранных координатах)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawWeather(ctx, W, H, dt);

    if (this.parts.length || this.lines.length || this.texts.length || this.weather.type !== 'none') requestAnimationFrame((tt) => this.frame(tt));
    else {
      ctx.clearRect(0, 0, W, H);
      this.running = false;
    }
  }

  drawWeather(ctx, W, H, dt) {
    const w = this.weather;
    if (w.type === 'none') return;
    const I = Math.max(0.05, Math.min(1, w.intensity ?? 0.5));
    const wind = (w.wind ?? 0.3) * 2 - 0.6;
    const area = (W * H) / (1280 * 720);
    const want = {
      rain: 380,
      storm: 600,
      snow: 260,
      fog: 14,
      embers: 90,
      leaves: 40,
      ash: 160,
      sand: 400,
      stars: 60,
    }[w.type];
    const target = Math.round((want || 100) * I * area * (teapot() ? 0.45 : 1));
    const parts = w.parts;
    while (parts.length < target) parts.push(this.newWeatherPart(w.type, W, H, true));
    if (parts.length > target) parts.length = target;
    ctx.save();
    if (w.type === 'storm' || w.type === 'rain') {
      ctx.fillStyle = `rgba(20,30,50,${0.12 * I + (w.type === 'storm' ? 0.12 : 0)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (w.type === 'sand') {
      ctx.fillStyle = `rgba(190,150,80,${0.18 * I})`;
      ctx.fillRect(0, 0, W, H);
    }
    for (const p of parts) {
      p.x += (p.vx + wind * p.wf) * dt;
      p.y += p.vy * dt;
      p.t += dt;
      if (p.y > H + 40 || p.x < -80 || p.x > W + 80 || p.y < -80) Object.assign(p, this.newWeatherPart(w.type, W, H, false));
    }
    // дождь и снег — одним путём на все капли и снежинки (а не отдельной отрисовкой каждой)
    if (w.type === 'rain' || w.type === 'storm') {
      ctx.strokeStyle = 'rgba(190,210,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of parts) {
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (p.vx + wind * p.wf) * 0.03, p.y - p.vy * 0.03);
      }
      ctx.stroke();
    } else if (w.type === 'snow') {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      for (const p of parts) {
        const x = p.x + Math.sin(p.t * p.f) * 8;
        ctx.moveTo(x + p.s, p.y);
        ctx.arc(x, p.y, p.s, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    for (const p of parts) {
      switch (w.type) {
        case 'fog': {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.s);
          const col = w.color ? hexToRgb(w.color) : [220, 225, 230];
          g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${0.22 * I})`);
          g.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
          ctx.fillStyle = g;
          ctx.fillRect(p.x - p.s, p.y - p.s, p.s * 2, p.s * 2);
          break;
        }
        case 'embers':
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = `rgba(255,${120 + Math.floor(p.f * 60)},40,${0.5 + 0.5 * Math.sin(p.t * 6 + p.f * 10)})`;
          ctx.beginPath();
          ctx.arc(p.x + Math.sin(p.t * 2 + p.f) * 10, p.y, p.s, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
          break;
        case 'leaves':
          ctx.save();
          ctx.translate(p.x + Math.sin(p.t * 1.5 + p.f) * 20, p.y);
          ctx.rotate(p.t * p.f);
          ctx.fillStyle = ['#b5651d', '#d4a017', '#8b4513', '#a0522d'][Math.floor(p.f * 4) % 4];
          ctx.beginPath();
          ctx.ellipse(0, 0, p.s * 1.6, p.s * 0.7, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        case 'ash':
          ctx.fillStyle = 'rgba(120,120,120,0.6)';
          ctx.fillRect(p.x + Math.sin(p.t + p.f) * 6, p.y, p.s, p.s);
          break;
        case 'sand':
          ctx.fillStyle = 'rgba(230,190,120,0.55)';
          ctx.fillRect(p.x, p.y, p.s * 3, p.s * 0.6);
          break;
        case 'stars':
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = `rgba(220,255,140,${0.4 + 0.6 * Math.abs(Math.sin(p.t * 2 + p.f * 9))})`;
          ctx.beginPath();
          ctx.arc(p.x + Math.sin(p.t + p.f * 5) * 15, p.y + Math.cos(p.t * 0.7 + p.f) * 15, p.s, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
          break;
      }
    }
    if (w.type === 'storm') {
      w.flash = Math.max(0, w.flash - dt * 3);
      if (Math.random() < dt * 0.15 * I) w.flash = 1;
      if (w.flash > 0) {
        ctx.fillStyle = `rgba(230,240,255,${w.flash * 0.55})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
    ctx.restore();
  }

  newWeatherPart(type, W, H, initial) {
    const p = { x: rand(-40, W + 40), y: initial ? rand(-H * 0.1, H) : -20, t: rand(0, 10), f: Math.random(), wf: 1 };
    switch (type) {
      case 'rain':
      case 'storm':
        return { ...p, vx: -60, vy: rand(700, 1000), s: 1, wf: 300 };
      case 'snow':
        return { ...p, vx: 0, vy: rand(30, 80), s: rand(1.2, 3.2), wf: 60, f: rand(0.5, 2) };
      case 'fog':
        return { ...p, x: initial ? rand(-200, W) : -250, y: rand(0, H), vx: rand(8, 25), vy: 0, s: rand(180, 380), wf: 30 };
      case 'embers':
        return { ...p, y: initial ? rand(0, H) : H + 20, vx: 0, vy: rand(-70, -25), s: rand(1, 2.6), wf: 40 };
      case 'leaves':
        return { ...p, vx: 20, vy: rand(30, 70), s: rand(3, 6), wf: 80, f: rand(0.5, 2.5) };
      case 'ash':
        return { ...p, vx: 0, vy: rand(15, 40), s: rand(1, 3), wf: 50 };
      case 'sand':
        return { ...p, x: initial ? rand(0, W) : -30, y: rand(0, H), vx: rand(400, 700), vy: rand(-10, 30), s: rand(1, 2.5), wf: 200 };
      case 'stars':
        return { ...p, y: rand(0, H), vx: rand(-10, 10), vy: rand(-8, 8), s: rand(1.2, 2.5), wf: 5 };
    }
    return { ...p, vx: 0, vy: 50, s: 2 };
  }
}

function drawDot(ctx, x, y, size, pal, k, alpha, add, star) {
  const ci = Math.max(0, Math.min(pal.c.length - 1, Math.floor((Number.isFinite(k) ? k : 0) * pal.c.length)));
  ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  if (star) {
    ctx.fillStyle = pal.c[0];
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 4);
      ctx.rect(-size / 6, -size, size / 3, size * 2);
    }
    ctx.fill();
    ctx.restore();
    return;
  }
  const g = ctx.createRadialGradient(x, y, 0, x, y, size);
  g.addColorStop(0, pal.c[Math.max(0, ci - 1)] || pal.c[0]);
  g.addColorStop(0.4, pal.c[ci]);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
}

function drawBolt(ctx, l) {
  const k = l.age / l.life;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = (1 - k) * (0.6 + 0.4 * Math.random());
  const segs = 14;
  const dx = l.x2 - l.x,
    dy = l.y2 - l.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len,
    ny = dx / len;
  for (const [w, col] of [
    [10, l.pal.c[3]],
    [4, l.pal.c[1]],
    [1.5, l.pal.c[0]],
  ]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(l.x, l.y);
    let seed = l.seed;
    for (let i = 1; i < segs; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      const off = ((seed / 233280) * 2 - 1) * len * 0.07 * (Math.random() * 0.6 + 0.7);
      const t = i / segs;
      ctx.lineTo(l.x + dx * t + nx * off, l.y + dy * t + ny * off);
    }
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
