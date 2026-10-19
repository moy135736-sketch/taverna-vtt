// Туман войны (ручной) и динамическое освещение (стены, обзор, источники света)
import { unitsToPx, segIntersect } from './geometry.js';

/** Отрезки стен: sight — для обзора/света, move — для движения */
export function wallSegments(walls, kind = 'sight') {
  const segs = [];
  for (const w of walls) {
    const t = w.wallType || 'wall';
    if (t === 'door' && w.open) continue;
    if (kind === 'sight' && (t === 'window' || t === 'terrain')) continue;
    if (kind === 'move' && t === 'oneway') continue;
    const p = w.pts || [];
    for (let i = 0; i + 3 < p.length; i += 2) segs.push([p[i], p[i + 1], p[i + 2], p[i + 3]]);
  }
  return segs;
}

/**
 * Многоугольник видимости из точки (ox, oy).
 * bounds — {x,y,w,h} — внешняя граница (страница или квадрат радиуса).
 * Возвращает плоский массив [x,y,x,y,...]
 */
export function visibilityPolygon(ox, oy, segs, bounds) {
  const bx1 = bounds.x,
    by1 = bounds.y,
    bx2 = bounds.x + bounds.w,
    by2 = bounds.y + bounds.h;
  const all = [];
  for (const s of segs) {
    // отсекаем отрезки вне границ
    if (Math.max(s[0], s[2]) < bx1 || Math.min(s[0], s[2]) > bx2 || Math.max(s[1], s[3]) < by1 || Math.min(s[1], s[3]) > by2) continue;
    all.push(s);
  }
  all.push([bx1, by1, bx2, by1], [bx2, by1, bx2, by2], [bx2, by2, bx1, by2], [bx1, by2, bx1, by1]);

  const angles = [];
  const eps = 0.00015;
  for (const s of all) {
    for (const [px, py] of [
      [s[0], s[1]],
      [s[2], s[3]],
    ]) {
      const a = Math.atan2(py - oy, px - ox);
      angles.push(a - eps, a, a + eps);
    }
  }
  angles.sort((a, b) => a - b);
  const out = [];
  let lastA = null;
  for (const a of angles) {
    if (lastA !== null && a - lastA < 1e-7) continue;
    lastA = a;
    const dx = Math.cos(a),
      dy = Math.sin(a);
    let best = Infinity;
    for (const s of all) {
      const sx = s[2] - s[0],
        sy = s[3] - s[1];
      const den = dx * sy - dy * sx;
      if (Math.abs(den) < 1e-12) continue;
      const ax = s[0] - ox,
        ay = s[1] - oy;
      const t = (ax * sy - ay * sx) / den;
      const u = (ax * dy - ay * dx) / den;
      if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) best = t;
    }
    if (best < Infinity) out.push(ox + dx * best, oy + dy * best);
  }
  return out;
}

/** Есть ли стена на пути движения */
export function movementBlocked(segs, x1, y1, x2, y2) {
  for (const s of segs) if (segIntersect(x1, y1, x2, y2, s[0], s[1], s[2], s[3])) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Рендер тумана/освещения на холсте в экранных координатах
// ---------------------------------------------------------------------------

export class FogRenderer {
  constructor(board, canvas) {
    this.board = board;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.light = document.createElement('canvas');
    this.vis = document.createElement('canvas');
    this.manual = document.createElement('canvas');
    this.tint = document.createElement('canvas');
    this.cache = new Map(); // key -> polygon
    this.wallsVersion = 0;
    this.explored = null; // холст в мировых координатах (режим исследователя)
    this.exploredKey = '';
  }

  resize(w, h) {
    for (const c of [this.canvas, this.light, this.vis, this.manual, this.tint]) {
      c.width = w;
      c.height = h;
    }
  }

  invalidateWalls() {
    this.wallsVersion++;
    this.cache.clear();
  }

  polygonFor(key, x, y, segs, bounds) {
    const k = `${key}|${Math.round(x)}|${Math.round(y)}|${this.wallsVersion}|${bounds.w}`;
    let p = this.cache.get(k);
    if (!p) {
      p = visibilityPolygon(x, y, segs, bounds);
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(k, p);
    }
    return p;
  }

  render() {
    const b = this.board;
    const page = b.page;
    const ctx = this.ctx;
    const W = this.canvas.width,
      H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // доска скрыта или ещё не получила размер
    if (!page || !W || !H) return;
    const store = b.store;
    const isGM = store.isGM;
    const asPlayer = isGM && store.ui.gmViewAsPlayer;
    const cam = b.cam;
    const pw = page.width * page.cellSize,
      ph = page.height * page.cellSize;

    const lighting = page.lighting || {};
    if (lighting.enabled && (!isGM || asPlayer)) {
      this.renderLighting(page, pw, ph, asPlayer ? 0.65 : lighting.darkness ?? 1);
    } else if (this.seenAt || this.seenKey) {
      this.seenAt = null;
      this.seenKey = '';
      b.applyUnseen(null);
    }

    const fog = page.fog || {};
    if (fog.enabled) {
      const m = this.manual.getContext('2d');
      m.setTransform(1, 0, 0, 1, 0, 0);
      m.globalCompositeOperation = 'source-over';
      m.clearRect(0, 0, W, H);
      m.fillStyle = '#000';
      m.fillRect(0, 0, W, H);
      m.setTransform(cam.z, 0, 0, cam.z, cam.x, cam.y);
      for (const op of page.fogOps || []) {
        m.globalCompositeOperation = op.mode === 'hide' ? 'source-over' : 'destination-out';
        m.fillStyle = '#000';
        m.strokeStyle = '#000';
        this.drawFogShape(m, op, pw, ph);
      }
      m.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = isGM && !asPlayer ? fog.gmOpacity ?? 0.45 : 1;
      ctx.drawImage(this.manual, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  drawFogShape(m, op, pw, ph) {
    m.beginPath();
    if (op.shape === 'all') {
      m.rect(-100000, -100000, 200000, 200000);
      m.fill();
    } else if (op.shape === 'rect') {
      m.rect(op.x, op.y, op.w, op.h);
      m.fill();
    } else if (op.shape === 'ellipse') {
      m.ellipse(op.x + op.w / 2, op.y + op.h / 2, Math.abs(op.w / 2), Math.abs(op.h / 2), 0, 0, Math.PI * 2);
      m.fill();
    } else if (op.shape === 'poly' && op.pts?.length >= 6) {
      m.moveTo(op.pts[0], op.pts[1]);
      for (let i = 2; i < op.pts.length; i += 2) m.lineTo(op.pts[i], op.pts[i + 1]);
      m.closePath();
      m.fill();
    } else if (op.shape === 'brush' && op.pts?.length >= 2) {
      m.lineCap = 'round';
      m.lineJoin = 'round';
      m.lineWidth = op.r * 2 || 70;
      m.moveTo(op.pts[0], op.pts[1]);
      if (op.pts.length === 2) m.lineTo(op.pts[0] + 0.1, op.pts[1]);
      for (let i = 2; i < op.pts.length; i += 2) m.lineTo(op.pts[i], op.pts[i + 1]);
      m.stroke();
    }
  }

  renderLighting(page, pw, ph, darkness) {
    const b = this.board;
    const store = b.store;
    const cam = b.cam;
    const W = this.canvas.width,
      H = this.canvas.height;
    const ctx = this.ctx;
    const lighting = page.lighting || {};
    const objs = b.pageObjects();
    const walls = objs.filter((o) => o.type === 'wall');
    const segs = wallSegments(walls, 'sight');
    const pageBounds = { x: -2, y: -2, w: pw + 4, h: ph + 4 };

    // Кто смотрит: у каждого игрока — только его токены со зрением (мастер «глазами игрока» —
    // выбранного игрока или всех сразу). Токен с «общим обзором» дает обзор всем.
    const isGM = store.isGM;
    const who = viewerOf(store);
    const party = !!lighting.sharedVision;
    const viewers = objs.filter((o) => o.vision?.enabled && o.layer !== 'gm' && givesVision(store, o, who, party));

    // Источники света
    const lights = objs.filter((o) => o.light?.enabled && (Number(o.light.bright) > 0 || Number(o.light.dim) > 0));

    const L = this.light.getContext('2d');
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.globalCompositeOperation = 'source-over';
    L.clearRect(0, 0, W, H);
    L.setTransform(cam.z, 0, 0, cam.z, cam.x, cam.y);

    if (lighting.daylight) {
      L.fillStyle = `rgba(255,255,255,${Math.max(0, Math.min(1, lighting.daylightLevel ?? 1))})`;
      L.fillRect(-10, -10, pw + 20, ph + 20);
    }
    L.globalCompositeOperation = 'lighter';
    const lInfo = [];
    const vInfo = [];
    for (const li of lights) {
      const cx = li.x + li.w / 2,
        cy = li.y + li.h / 2;
      const bright = unitsToPx(page, li.light.bright || 0);
      const dim = unitsToPx(page, li.light.dim || 0);
      const R = bright + dim;
      if (R <= 0) continue;
      const poly = this.polygonFor('L' + li.id, cx, cy, segs, { x: cx - R - 2, y: cy - R - 2, w: 2 * R + 4, h: 2 * R + 4 });
      lInfo.push({ cx, cy, R, poly, rot: li.rot || 0, angle: li.light.angle ?? 360, dir: li.light.dir || 0 });
      L.save();
      clipPoly(L, poly);
      if ((li.light.angle ?? 360) < 360) clipCone(L, cx, cy, R, li.rot || 0, li.light.angle, li.light.dir || 0);
      const g = L.createRadialGradient(cx, cy, 0, cx, cy, R);
      const intensity = Math.max(0.1, Math.min(1, li.light.intensity ?? 1));
      const bstop = R > 0 ? bright / R : 0;
      g.addColorStop(0, `rgba(255,255,255,${intensity})`);
      if (bstop > 0) g.addColorStop(Math.min(0.999, bstop), `rgba(255,255,255,${intensity})`);
      g.addColorStop(Math.min(1, bstop + 0.001), `rgba(255,255,255,${0.5 * intensity})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      L.fillStyle = g;
      L.beginPath();
      L.arc(cx, cy, R, 0, Math.PI * 2);
      L.fill();
      L.restore();
    }

    // Обзор
    const V = this.vis.getContext('2d');
    V.setTransform(1, 0, 0, 1, 0, 0);
    V.globalCompositeOperation = 'source-over';
    V.clearRect(0, 0, W, H);
    V.setTransform(cam.z, 0, 0, cam.z, cam.x, cam.y);
    V.fillStyle = '#fff';
    for (const v of viewers) {
      const cx = v.x + v.w / 2,
        cy = v.y + v.h / 2;
      const range = unitsToPx(page, v.vision.range || 0);
      const bounds = range > 0 ? { x: cx - range - 2, y: cy - range - 2, w: 2 * range + 4, h: 2 * range + 4 } : pageBounds;
      const poly = this.polygonFor('V' + v.id, cx, cy, segs, bounds);
      vInfo.push({ cx, cy, range, poly, rot: v.rot || 0, angle: v.vision.angle ?? 360, dv: unitsToPx(page, v.vision.darkvision || 0), self: Math.max(v.w, v.h) * 0.6 });
      V.save();
      clipPoly(V, poly);
      if ((v.vision.angle ?? 360) < 360) clipCone(V, cx, cy, range || Math.max(pw, ph) * 2, v.rot || 0, v.vision.angle, 0);
      V.beginPath();
      if (range > 0) V.arc(cx, cy, range, 0, Math.PI * 2);
      else V.rect(-10, -10, pw + 20, ph + 20);
      V.fill();
      V.restore();
      // тёмное зрение — «тусклый свет» вокруг смотрящего
      const dv = unitsToPx(page, v.vision.darkvision || 0);
      L.save();
      L.globalCompositeOperation = 'lighter';
      clipPoly(L, poly);
      if (dv > 0) {
        L.fillStyle = 'rgba(255,255,255,0.55)';
        L.beginPath();
        L.arc(cx, cy, dv, 0, Math.PI * 2);
        L.fill();
      }
      // свой токен виден всегда
      L.fillStyle = 'rgba(255,255,255,0.9)';
      L.beginPath();
      L.arc(cx, cy, Math.max(v.w, v.h) * 0.6, 0, Math.PI * 2);
      L.fill();
      L.restore();
    }

    // какие токены игрок не видит (вне обзора или в темноте) — их прячем целиком,
    // даже если карта под ними проступает (неполная темнота, режим исследователя)
    this.updateSeen(objs, vInfo, lInfo, lighting, isGM);

    // видимое = обзор × освещённость
    V.setTransform(1, 0, 0, 1, 0, 0);
    V.globalCompositeOperation = 'destination-in';
    V.drawImage(this.light, 0, 0);
    V.globalCompositeOperation = 'source-over';

    // Режим исследователя: запоминаем увиденное в мировых координатах
    let exploredDrawn = false;
    if (lighting.explorer) {
      this.updateExplored(page, pw, ph);
      if (this.explored) exploredDrawn = true;
    }

    ctx.save();
    ctx.globalAlpha = darkness;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    if (exploredDrawn) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 0.45;
      const sc = this.exploredScale;
      ctx.setTransform(cam.z / sc, 0, 0, cam.z / sc, cam.x, cam.y);
      ctx.drawImage(this.explored, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(this.vis, 0, 0);
    ctx.restore();

    // цветной свет: лёгкий оттенок в освещённых и видимых местах (тёплый факел, холодная магия)
    const colored = lights.filter((li) => {
      const c = String(li.light.color || '').toLowerCase();
      return /^#[0-9a-f]{6}$/.test(c) && c !== '#ffffff';
    });
    if (colored.length) {
      const T = this.tint.getContext('2d');
      T.setTransform(1, 0, 0, 1, 0, 0);
      T.globalCompositeOperation = 'source-over';
      T.clearRect(0, 0, W, H);
      T.setTransform(cam.z, 0, 0, cam.z, cam.x, cam.y);
      T.globalCompositeOperation = 'lighter';
      for (const li of colored) {
        const cx = li.x + li.w / 2,
          cy = li.y + li.h / 2;
        const R = unitsToPx(page, li.light.bright || 0) + unitsToPx(page, li.light.dim || 0);
        if (R <= 0) continue;
        const poly = this.polygonFor('L' + li.id, cx, cy, segs, { x: cx - R - 2, y: cy - R - 2, w: 2 * R + 4, h: 2 * R + 4 });
        const [r, g, bb] = hexRgb(li.light.color);
        const a = 0.28 * Math.max(0.1, Math.min(1, li.light.intensity ?? 1));
        T.save();
        clipPoly(T, poly);
        if ((li.light.angle ?? 360) < 360) clipCone(T, cx, cy, R, li.rot || 0, li.light.angle, li.light.dir || 0);
        const grad = T.createRadialGradient(cx, cy, 0, cx, cy, R);
        grad.addColorStop(0, `rgba(${r},${g},${bb},${a})`);
        grad.addColorStop(1, `rgba(${r},${g},${bb},0)`);
        T.fillStyle = grad;
        T.beginPath();
        T.arc(cx, cy, R, 0, Math.PI * 2);
        T.fill();
        T.restore();
      }
      // только там, что видно игроку
      T.setTransform(1, 0, 0, 1, 0, 0);
      T.globalCompositeOperation = 'destination-in';
      T.drawImage(this.vis, 0, 0);
      T.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.tint, 0, 0);
    }
  }

  /**
   * Видимость точек и токенов для игрока: точка видна, если она в обзоре одного из его токенов
   * и освещена (дневной свет, источник света, тёмное зрение или рядом со смотрящим).
   * Набор скрытых токенов пересчитывается только при изменении стен, света или позиций.
   */
  updateSeen(objs, viewers, lights, lighting, isGM) {
    const store = this.board.store;
    const day = !!lighting.daylight && (lighting.daylightLevel ?? 1) > 0.05;
    const seenAt = (x, y) => {
      for (const v of viewers) {
        const d = Math.hypot(x - v.cx, y - v.cy);
        if (v.range > 0 && d > v.range) continue;
        if (!inCone(v.cx, v.cy, x, y, v.rot, v.angle, 0)) continue;
        if (!pointInPoly(x, y, v.poly)) continue;
        if (day || d <= v.self || d <= v.dv) return true;
        for (const L of lights) {
          if (Math.hypot(x - L.cx, y - L.cy) > L.R) continue;
          if (!inCone(L.cx, L.cy, x, y, L.rot, L.angle, L.dir)) continue;
          if (pointInPoly(x, y, L.poly)) return true;
        }
      }
      return false;
    };
    // свои токены видны всегда, остальные — только если их видно
    const who = viewerOf(store);
    const party = !!lighting.sharedVision;
    const mine = (o) => givesVision(store, o, who, party, true);
    const cand = objs.filter((o) => o.type !== 'wall' && o.layer === 'objects');
    const key = [
      this.wallsVersion,
      day,
      isGM,
      viewers.map((v) => `${Math.round(v.cx)},${Math.round(v.cy)},${v.range},${v.angle},${v.rot},${v.dv},${v.poly.length}`).join(';'),
      lights.map((l) => `${Math.round(l.cx)},${Math.round(l.cy)},${Math.round(l.R)},${l.angle},${l.rot},${l.dir}`).join(';'),
      cand.map((o) => `${o.id}:${Math.round(o.x)},${Math.round(o.y)},${Math.round(o.w)},${Math.round(o.h)},${mine(o) ? 1 : 0}`).join(';'),
    ].join('|');
    this.seenAt = seenAt;
    if (key === this.seenKey) return;
    this.seenKey = key;
    const unseen = new Set();
    for (const o of cand) {
      if (mine(o)) continue;
      const cx = o.x + o.w / 2,
        cy = o.y + o.h / 2,
        ox = o.w * 0.3,
        oy = o.h * 0.3;
      const pts = [cx, cy, cx - ox, cy - oy, cx + ox, cy - oy, cx - ox, cy + oy, cx + ox, cy + oy];
      let seen = false;
      for (let i = 0; i < pts.length && !seen; i += 2) seen = seenAt(pts[i], pts[i + 1]);
      if (!seen) unseen.add(o.id);
    }
    this.board.applyUnseen(unseen, isGM);
  }

  updateExplored(page, pw, ph) {
    const b = this.board;
    const key = page.id + ':' + b.store.me.id;
    const sc = Math.min(0.25, 2048 / Math.max(pw, ph));
    if (!this.explored || this.exploredKey !== key) {
      this.explored = document.createElement('canvas');
      this.explored.width = Math.max(1, Math.ceil(pw * sc));
      this.explored.height = Math.max(1, Math.ceil(ph * sc));
      this.exploredKey = key;
      this.exploredScale = sc;
      try {
        const saved = localStorage.getItem('explored:' + key);
        if (saved) {
          const img = new Image();
          img.onload = () => {
            this.explored.getContext('2d').drawImage(img, 0, 0);
            b.dirtyFog();
          };
          img.src = saved;
        }
      } catch {
        /* ignore */
      }
    }
    // переносим текущую видимость (экран → мир)
    const E = this.explored.getContext('2d');
    const cam = b.cam;
    E.save();
    E.setTransform(sc / cam.z, 0, 0, sc / cam.z, (-cam.x * sc) / cam.z, (-cam.y * sc) / cam.z);
    E.drawImage(this.vis, 0, 0);
    E.restore();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem('explored:' + key, this.explored.toDataURL('image/png'));
      } catch {
        /* ignore */
      }
    }, 2000);
  }

  resetExplored() {
    if (this.explored) this.explored.getContext('2d').clearRect(0, 0, this.explored.width, this.explored.height);
    try {
      localStorage.removeItem('explored:' + this.exploredKey);
    } catch {
      /* ignore */
    }
  }
}

function hexRgb(h) {
  const n = parseInt(String(h).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Чьими глазами смотрим: id игрока; у мастера в режиме «глазами игроков» — выбранный игрок или true (все) */
function viewerOf(store) {
  if (!store.isGM) return store.me.id;
  const v = store.ui.gmViewAsPlayer;
  return typeof v === 'string' && v ? v : true;
}

/**
 * Смотрит ли этот игрок глазами токена. Обзор дают только свои токены — созданные игроком
 * или отданные именно ему (сам токен или его анкета); управление «всем игрокам» обзора не дает,
 * иначе все видели бы одно и то же. Исключения: «общий обзор» у токена и «общий обзор отряда» на сцене.
 */
export function givesVision(store, o, who, party, forHiding = false) {
  if (!forHiding && o.vision?.shared) return true;
  if (who === true || party) return isPlayerToken(store, o);
  if (o.ownerId === who) return true;
  if ((o.controlledBy || []).includes(who)) return true;
  if (o.represents) {
    const ch = store.col.char.get(o.represents);
    if ((ch?.controlledBy || []).includes(who)) return true;
  }
  return false;
}

function isPlayerToken(store, o) {
  if (o.represents) {
    const ch = store.col.char.get(o.represents);
    const c = ch?.controlledBy || [];
    if (c.length) return true;
  }
  return (o.controlledBy || []).length > 0;
}

/** Точка внутри многоугольника (плоский массив [x,y,x,y,...]) */
export function pointInPoly(x, y, poly) {
  let inside = false;
  const n = poly.length;
  if (n < 6) return false;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = poly[i],
      yi = poly[i + 1],
      xj = poly[j],
      yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Попадает ли точка в конус (как clipCone: угол поворота токена + направление, 0° — вверх) */
function inCone(cx, cy, x, y, rotDeg, angleDeg, dirDeg) {
  if ((angleDeg ?? 360) >= 360) return true;
  const a = ((rotDeg + (dirDeg || 0) - 90) * Math.PI) / 180;
  let d = Math.atan2(y - cy, x - cx) - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs(d) <= (angleDeg * Math.PI) / 360;
}

function clipPoly(ctx, poly) {
  ctx.beginPath();
  if (poly.length >= 6) {
    ctx.moveTo(poly[0], poly[1]);
    for (let i = 2; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1]);
    ctx.closePath();
  }
  ctx.clip();
}

function clipCone(ctx, cx, cy, R, rotDeg, angleDeg, dirDeg) {
  const a = ((rotDeg + (dirDeg || 0) - 90) * Math.PI) / 180;
  const half = ((angleDeg || 360) * Math.PI) / 360;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R * 1.5, a - half, a + half);
  ctx.closePath();
  ctx.clip();
}
