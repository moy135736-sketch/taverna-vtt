// DOM-представление объектов доски (токены, картинки, фигуры, рисунки, текст)
import { pathD, unitsToPx } from './geometry.js';
import { markerDefs, markerLook, markerEntries } from '../effects.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export const SHAPES = {
  rect: { name: 'Прямоугольник' },
  ellipse: { name: 'Эллипс' },
  triangle: { name: 'Треугольник', pts: [50, 0, 100, 100, 0, 100] },
  diamond: { name: 'Ромб', pts: [50, 0, 100, 50, 50, 100, 0, 50] },
  hexagon: { name: 'Шестиугольник', pts: [25, 0, 75, 0, 100, 50, 75, 100, 25, 100, 0, 50] },
  octagon: { name: 'Восьмиугольник', pts: [30, 0, 70, 0, 100, 30, 100, 70, 70, 100, 30, 100, 0, 70, 0, 30] },
  star: { name: 'Звезда', pts: [50, 0, 61, 35, 98, 35, 68, 57, 79, 91, 50, 70, 21, 91, 32, 57, 2, 35, 39, 35] },
  cone: { name: 'Конус', pts: [0, 50, 100, 0, 100, 100] },
  arrow: { name: 'Стрелка', pts: [0, 35, 60, 35, 60, 10, 100, 50, 60, 90, 60, 65, 0, 65] },
  cross: { name: 'Крест', pts: [35, 0, 65, 0, 65, 35, 100, 35, 100, 65, 65, 65, 65, 100, 35, 100, 35, 65, 0, 65, 0, 35, 35, 35] },
};


function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function isVideo(src) {
  return /\.(webm|mp4)(\?|#|$)/i.test(src || '');
}

export class ObjView {
  constructor(board, o) {
    this.board = board;
    this.id = o.id;
    this.el = document.createElement('div');
    this.el.className = 'obj';
    this.el.dataset.oid = o.id;
    this.body = document.createElement('div');
    this.body.className = 'obj-body';
    this.content = document.createElement('div');
    this.content.className = 'obj-content';
    this.body.appendChild(this.content);
    this.el.appendChild(this.body);
    this.ui = document.createElement('div');
    this.ui.className = 'tok-ui';
    this.el.appendChild(this.ui);
    this.aura = null;
    this.key = {};
    this.update(o);
  }

  destroy() {
    this.el.remove();
    this.aura?.remove();
    const v = this.content.querySelector('video');
    if (v) {
      v.pause();
      v.removeAttribute('src');
    }
  }

  update(o) {
    const prev = this.o;
    this.o = o;
    const b = this.board;
    const el = this.el;
    const isGM = b.store.isGM;
    el.style.transform = `translate(${o.x}px, ${o.y}px)`;
    if (prev && (prev.x !== o.x || prev.y !== o.y) && prev.pageId === o.pageId) this.animateMove(prev, o);
    el.style.width = Math.max(1, o.w) + 'px';
    el.style.height = Math.max(1, o.h) + 'px';
    el.style.zIndex = String(Math.round(o.z || 0));
    el.classList.toggle('ctl', b.store.canControlObj(o));
    el.classList.toggle('locked', !!o.locked);
    // ловушка — мастеру видна рамкой и значком (взведена — красная, разряжена — серая)
    el.classList.toggle('trap', !!o.trap && isGM);
    el.classList.toggle('trap-off', !!o.trap && isGM && o.trap.armed === false);
    el.dataset.type = o.type;
    if (o.type === 'pin') el.title = o.name || 'Метка';
    else if (el.title) el.removeAttribute('title');
    el.style.opacity = o.opacity !== undefined && o.opacity !== 1 ? String(o.opacity) : '';

    // поворот/отражение
    const sx = o.flipH ? -1 : 1,
      sy = o.flipV ? -1 : 1;
    this.body.style.transform = `rotate(${o.rot || 0}deg) scale(${sx}, ${sy})`;

    // содержимое
    const ck = JSON.stringify([o.type, o.src, o.sides?.[o.side || 0]?.src, o.shape, o.fill, o.stroke, o.strokeWidth, o.pts, o.closed, o.smooth, o.text, o.fontSize, o.color, o.fontFamily, o.frame, o.w, o.h, o.radius, o.type === 'pin' ? !!o.handoutId : 0]);
    if (ck !== this.key.content) {
      this.key.content = ck;
      this.renderContent(o);
    }

    // эффекты
    const fx = o.effects || {};
    const cls = ['obj-content'];
    for (const k of ['pulse', 'float', 'spin', 'shake', 'flicker', 'ghost', 'gray', 'burning', 'frozen', 'glow', 'invisible', 'bob']) if (fx[k]) cls.push('fx-' + k);
    this.content.className = cls.join(' ');
    this.content.style.setProperty('--glow', fx.glowColor || fx.glow === true ? fx.glowColor || '#ffd76a' : typeof fx.glow === 'string' ? fx.glow : '#ffd76a');
    if (fx.invisible && !b.store.canControlObj(o) && !isGM) el.style.visibility = 'hidden';
    else el.style.visibility = '';

    // оттенок
    let tint = this.body.querySelector('.obj-tint');
    if (o.tint && o.type === 'image') {
      if (!tint) {
        tint = document.createElement('div');
        tint.className = 'obj-tint';
        this.body.appendChild(tint);
      }
      tint.style.background = o.tint;
      const src = this.currentSrc(o);
      tint.style.maskImage = tint.style.webkitMaskImage = src && !isVideo(src) ? `url("${String(src).replace(/["\\\n\r]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ')}")` : 'none';
    } else if (tint) tint.remove();

    this.renderUI(o);
    this.renderAura(o);
  }

  /**
   * Перемещение показываем выбранным способом: плавно, по клеткам, телепортом или сквозь огонь —
   * у всех, и у того, кто тянул (он тянет призрак, а токен идёт после отпускания).
   * Если известен путь с поворотами — идём по нему, иначе по прямой.
   */
  animateMove(prev, o) {
    const b = this.board;
    this.moveAnim?.cancel();
    this.auraAnim?.cancel();
    this.moveAnim = this.auraAnim = null;
    clearTimeout(this.moveFxTimer);
    const path = b.takeMovePath?.(o.id, prev, o);
    if (b.isLocalMove?.(o.id)) return;
    const style = b.moveStyleOf?.(o) || 'instant';
    if (style === 'instant' || !this.el.animate || reducedMotion()) return;
    const cs = b.page?.cellSize || 70;
    const dx = o.x - prev.x,
      dy = o.y - prev.y;
    if (Math.hypot(dx, dy) < 1) return;
    const T = (x, y) => `translate(${x}px, ${y}px)`;
    // точки пути — левые верхние углы токена
    const pts = path ? path.map((p) => ({ x: p.x - o.w / 2, y: p.y - o.h / 2 })) : [{ x: prev.x, y: prev.y }];
    pts[0] = { x: prev.x, y: prev.y };
    if (path) pts[pts.length - 1] = { x: o.x, y: o.y };
    else pts.push({ x: o.x, y: o.y });
    const segLen = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const total = segLen.reduce((a, v) => a + v, 0) || 1;
    let frames, duration, easing;
    if (style === 'smooth') {
      duration = Math.max(180, Math.min(1800, (total / cs) * 120));
      easing = 'ease-in-out';
      let acc = 0;
      frames = pts.map((p, i) => {
        if (i) acc += segLen[i - 1];
        return { transform: T(p.x, p.y), offset: acc / total };
      });
    } else if (style === 'steps') {
      // шаги по клеткам вдоль каждого отрезка пути
      const counts = segLen.map((_, i) => Math.max(1, Math.round(Math.max(Math.abs(pts[i + 1].x - pts[i].x), Math.abs(pts[i + 1].y - pts[i].y)) / cs)));
      let n = counts.reduce((a, v) => a + v, 0);
      const k = n > 40 ? 40 / n : 1; // слишком длинный путь — шаги крупнее
      const steps = [];
      counts.forEach((c, i) => {
        const m = Math.max(1, Math.round(c * k));
        for (let j = 0; j < m; j++) steps.push([pts[i], pts[i + 1], j / m, (j + 1) / m]);
      });
      n = steps.length;
      const per = Math.max(90, Math.min(220, 2600 / n));
      duration = n * per;
      const hop = Math.min(cs * 0.18, 14);
      const lerp = (a, c, t) => ({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t });
      frames = [];
      steps.forEach(([a, c, t0, t1], i) => {
        const p0 = lerp(a, c, t0),
          pm = lerp(a, c, (t0 + t1) / 2);
        frames.push({ transform: T(p0.x, p0.y), offset: i / n, easing: 'ease-out' });
        frames.push({ transform: T(pm.x, pm.y - hop), offset: (i + 0.5) / n, easing: 'ease-in' });
      });
      frames.push({ transform: T(o.x, o.y), offset: 1 });
    } else {
      // телепорт и огонь: исчезает на старом месте, появляется на новом
      const fire = style === 'fire';
      duration = fire ? 1500 : 900;
      const out = fire ? 'brightness(1.8) sepia(1) saturate(5) hue-rotate(-25deg) contrast(1.2)' : 'brightness(2.6) saturate(0.3) blur(1px)';
      frames = [
        { transform: T(prev.x, prev.y), opacity: 1, filter: 'none' },
        { transform: T(prev.x, prev.y) + (fire ? '' : ' scale(0.2)'), opacity: 0, filter: out, offset: 0.42 },
        { transform: T(o.x, o.y) + (fire ? '' : ' scale(0.2)'), opacity: 0, filter: out, offset: 0.58 },
        { transform: T(o.x, o.y), opacity: 1, filter: 'none' },
      ];
      // искры или пламя — только если токен видно этому зрителю
      const visible = () => !this.el.classList.contains('unseen') && this.el.style.visibility !== 'hidden';
      const burst = (x, y) => visible() && b.fx?.spawn(fire ? { type: 'burn', color: 'fire', x, y } : { type: 'nova', color: 'magic', x, y });
      burst(prev.x + prev.w / 2, prev.y + prev.h / 2);
      this.moveFxTimer = setTimeout(() => burst(o.x + o.w / 2, o.y + o.h / 2), duration * 0.45);
    }
    const timing = easing ? { duration, easing } : { duration };
    this.moveAnim = this.el.animate(frames, timing);
    // аура едет вместе с токеном
    if (this.aura) {
      const rel = frames.map((f) => {
        const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(f.transform);
        const fr = { transform: m ? T(Number(m[1]) - o.x, Number(m[2]) - o.y) : 'none' };
        if (f.offset !== undefined) fr.offset = f.offset;
        if (f.opacity !== undefined) fr.opacity = f.opacity;
        if (f.easing) fr.easing = f.easing;
        return fr;
      });
      this.auraAnim = this.aura.animate(rel, timing);
    }
  }

  currentSrc(o) {
    if (Array.isArray(o.sides) && o.sides.length) return o.sides[(o.side || 0) % o.sides.length]?.src || o.src;
    return o.src;
  }

  renderContent(o) {
    const c = this.content;
    c.textContent = '';
    if (o.type === 'image') {
      const src = this.currentSrc(o);
      if (isVideo(src)) {
        const v = document.createElement('video');
        v.src = src;
        v.autoplay = true;
        v.loop = true;
        v.muted = true;
        v.playsInline = true;
        v.draggable = false;
        c.appendChild(v);
        v.play().catch(() => {});
      } else if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.draggable = false;
        img.decoding = 'async';
        img.alt = '';
        img.onerror = () => c.classList.add('broken');
        c.appendChild(img);
      } else {
        c.classList.add('broken');
      }
      c.dataset.frame = o.frame || '';
    } else if (o.type === 'shape') {
      const svg = svgEl('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', class: 'shape-svg' });
      const sw = o.strokeWidth ?? 3;
      const common = {
        fill: o.fill || 'transparent',
        stroke: o.stroke || 'none',
        'stroke-width': sw,
        'vector-effect': 'non-scaling-stroke',
        'stroke-linejoin': 'round',
      };
      let shapeEl;
      const shape = o.shape || 'rect';
      if (shape === 'rect') {
        const rx = Math.max(0, Math.min(50, ((o.radius || 0) / Math.max(1, Math.min(o.w, o.h))) * 100));
        shapeEl = svgEl('rect', { x: 0, y: 0, width: 100, height: 100, rx, ry: rx * (o.w / Math.max(1, o.h)), ...common });
      } else if (shape === 'ellipse') shapeEl = svgEl('ellipse', { cx: 50, cy: 50, rx: 50, ry: 50, ...common });
      else {
        const pts = SHAPES[shape]?.pts || SHAPES.triangle.pts;
        shapeEl = svgEl('polygon', { points: pts.join(' '), ...common });
      }
      svg.appendChild(shapeEl);
      c.appendChild(svg);
      if (o.text) {
        const t = document.createElement('div');
        t.className = 'shape-label';
        t.textContent = o.text;
        t.style.color = o.color || '#fff';
        t.style.fontSize = (o.fontSize || 18) + 'px';
        c.appendChild(t);
      }
    } else if (o.type === 'path') {
      const svg = svgEl('svg', { viewBox: `0 0 ${Math.max(1, o.w)} ${Math.max(1, o.h)}`, preserveAspectRatio: 'none', class: 'path-svg' });
      svg.style.overflow = 'visible';
      const p = svgEl('path', {
        d: pathD(o.pts || [], !!o.closed, o.smooth !== false),
        fill: o.closed && o.fill ? o.fill : 'none',
        stroke: o.stroke || '#000',
        'stroke-width': o.strokeWidth || 4,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'vector-effect': 'non-scaling-stroke',
      });
      svg.appendChild(p);
      c.appendChild(svg);
    } else if (o.type === 'pin') {
      // метка на карте: «капля» с остриём в нижней середине объекта
      const svg = svgEl('svg', { viewBox: '0 0 40 48', preserveAspectRatio: 'xMidYMax meet', class: 'pin-svg' });
      svg.appendChild(svgEl('path', { d: 'M20 46C20 46 4 28.5 4 17a16 16 0 0132 0c0 11.5-16 29-16 29z', fill: o.color || '#c9a24a', stroke: '#24190d', 'stroke-width': 2.2, 'stroke-linejoin': 'round' }));
      svg.appendChild(svgEl('circle', { cx: 20, cy: 17, r: 6.5, fill: o.handoutId ? '#24190d' : '#fff7e6', 'fill-opacity': 0.92 }));
      c.appendChild(svg);
    } else if (o.type === 'text') {
      const t = document.createElement('div');
      t.className = 'text-obj';
      t.textContent = o.text || '';
      t.style.color = o.color || '#000';
      t.style.fontSize = (o.fontSize || 24) + 'px';
      t.style.fontFamily = o.fontFamily || '';
      c.appendChild(t);
    }
  }

  renderUI(o) {
    const b = this.board;
    const s = b.store.settings;
    const ui = this.ui;
    const bars = Array.isArray(o.bars) ? o.bars.filter((x) => x && (x.value !== '' || x.max !== '')) : [];
    const markers = markerEntries(o);
    const showName = o.showName && o.name;
    const isDead = markers.some((m) => m.id === 'dead');
    // положение и размер баров: свои у токена или общие из настроек стола
    const barPos = o.barPosition || s.barPosition || 'top';
    const barStyle = o.barStyle || s.barStyle;
    // у маркеров со сроком на значке — сколько раундов осталось
    const tick = markers.some((m) => m.until !== undefined) ? b.store.state.tick || 0 : 0;
    const key = JSON.stringify([bars, markers, showName ? o.name : '', barPos, barStyle, s.showBarText, o.w, o.h, b.zoomBucket, tick, markers.length ? s.markers : null]);
    if (key === this.key.ui) return;
    this.key.ui = key;
    ui.textContent = '';
    ui.className = 'tok-ui bars-' + barPos + (barStyle === 'compact' ? ' bars-compact' : '');

    if (bars.length) {
      const wrap = document.createElement('div');
      wrap.className = 'tok-bars';
      for (const bar of bars) {
        const v = parseFloat(bar.value);
        const m = parseFloat(bar.max);
        const row = document.createElement('div');
        row.className = 'tok-bar';
        const fill = document.createElement('div');
        fill.className = 'tok-bar-fill';
        const pct = Number.isFinite(v) && Number.isFinite(m) && m > 0 ? Math.max(0, Math.min(1, v / m)) : Number.isFinite(v) ? 1 : 0;
        fill.style.width = pct * 100 + '%';
        fill.style.background = bar.color || '#3eaa49';
        row.appendChild(fill);
        const mode = bar.showText && bar.showText !== 'inherit' ? bar.showText : s.showBarText || 'hover';
        if (mode !== 'never') {
          const txt = document.createElement('span');
          txt.className = 'tok-bar-text' + (mode === 'hover' ? ' on-hover' : '');
          txt.textContent = `${bar.name ? bar.name + ' ' : ''}${bar.value}${bar.max !== '' && bar.max !== undefined ? ' / ' + bar.max : ''}`;
          row.appendChild(txt);
        }
        row.title = `${bar.name || 'Бар'}: ${bar.value}${bar.max !== '' ? ' / ' + bar.max : ''}`;
        row.dataset.barId = bar.id;
        wrap.appendChild(row);
      }
      ui.appendChild(wrap);
    }

    if (markers.length) {
      const mw = document.createElement('div');
      mw.className = 'tok-markers';
      const defs = markerDefs(b.store);
      for (const m of markers) {
        if (m.id === 'dead') continue;
        const def = defs.get(m.id);
        const look = markerLook(def, defs);
        const span = document.createElement('span');
        span.className = 'tok-marker';
        span.dataset.marker = m.id;
        const left = m.until !== undefined ? m.until - tick : null;
        span.title = (def?.name || m.id) + (m.n !== undefined ? ` — ${m.n}` : '') + (left !== null ? ` (осталось раундов: ${Math.max(0, left)})` : '');
        if (look.image) {
          const img = document.createElement('img');
          img.src = look.image;
          img.alt = '';
          img.draggable = false;
          span.appendChild(img);
        } else if (look.color) {
          span.classList.add('dot');
          span.style.background = look.color;
        } else span.textContent = look.emoji;
        if (m.n !== undefined && m.n !== null && m.n !== '') {
          const badge = document.createElement('b');
          badge.textContent = m.n;
          span.appendChild(badge);
        }
        if (left !== null) {
          const t = document.createElement('i');
          t.className = 'tok-marker-rounds';
          t.textContent = Math.max(0, left);
          span.appendChild(t);
        }
        mw.appendChild(span);
      }
      ui.appendChild(mw);
    }

    if (isDead) {
      const x = document.createElement('div');
      x.className = 'tok-dead';
      ui.appendChild(x);
    }

    if (showName) {
      const n = document.createElement('div');
      n.className = 'tok-name';
      n.textContent = o.name;
      ui.appendChild(n);
    }
  }

  renderAura(o) {
    const auras = Array.isArray(o.auras) ? o.auras.filter((a) => a && Number(a.radius) > 0) : [];
    if (!auras.length) {
      if (this.aura) {
        this.aura.remove();
        this.aura = null;
      }
      return;
    }
    const page = this.board.page;
    if (!page) return;
    if (!this.aura) {
      this.aura = document.createElement('div');
      this.aura.className = 'aura-group';
      this.board.layers.auras.appendChild(this.aura);
    }
    const key = JSON.stringify([auras, o.x, o.y, o.w, o.h, page.scale, page.cellSize, o.layer]);
    if (key === this.aura._key) return;
    this.aura._key = key;
    this.aura.textContent = '';
    this.aura.style.display = o.layer === 'gm' && !this.board.store.isGM ? 'none' : '';
    const cx = o.x + o.w / 2,
      cy = o.y + o.h / 2;
    for (const a of auras) {
      const r = unitsToPx(page, a.radius);
      const d = document.createElement('div');
      d.className = 'aura' + (a.square ? ' square' : '');
      const w = o.w + 2 * r,
        h = o.h + 2 * r;
      d.style.left = cx - w / 2 + 'px';
      d.style.top = cy - h / 2 + 'px';
      d.style.width = w + 'px';
      d.style.height = h + 'px';
      d.style.background = a.color || '#ffcc00';
      d.style.opacity = a.opacity ?? 0.3;
      if (o.layer === 'gm') d.style.outline = '1px dashed rgba(0,0,0,.4)';
      this.aura.appendChild(d);
    }
  }
}

// Стены динамического освещения (SVG поверх страницы)
export function renderWalls(svg, walls, { selected, isGM, activeLayer }) {
  svg.textContent = '';
  if (!isGM) return;
  for (const w of walls) {
    const pts = w.pts || [];
    if (pts.length < 4) continue;
    const g = svgEl('g', { 'data-oid': w.id, class: 'wall wall-' + (w.wallType || 'wall') + (w.open ? ' open' : '') + (selected.has(w.id) ? ' sel' : '') });
    const pl = svgEl('polyline', { points: pts.join(' '), class: 'wall-line' });
    const hit = svgEl('polyline', { points: pts.join(' '), class: 'wall-hit' });
    g.appendChild(hit);
    g.appendChild(pl);
    if (activeLayer === 'walls') {
      for (let i = 0; i < pts.length; i += 2) g.appendChild(svgEl('circle', { cx: pts[i], cy: pts[i + 1], r: 4, class: 'wall-node', 'data-node': i / 2 }));
    }
    svg.appendChild(g);
  }
}
