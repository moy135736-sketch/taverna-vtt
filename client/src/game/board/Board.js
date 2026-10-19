// Виртуальная доска: камера, слои, объекты, инструменты, выделение, туман и эффекты
import { ObjView, renderWalls, SHAPES } from './objview.js';
import { FogRenderer, wallSegments, movementBlocked } from './lighting.js';
import { FxEngine } from './fx.js';
import { snapPoint, snapRect, gridDistance, formatDistance, rotatePoint, rectsIntersect, simplify, pathD, hexDims, distToSegment } from './geometry.js';
import { TOKEN_DEFAULTS, newBar } from '@shared/defaults.js';
import { templateGeometry, templateCells, isTemplate } from './templates.js';
import { newId } from '@shared/ids.js';
import { ridersOf, carryTransform, carriersOf } from '@shared/attach.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const LAYERS = ['map', 'objects', 'foreground', 'gm', 'walls'];
const clone = (o) => JSON.parse(JSON.stringify(o));

function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export class Board {
  constructor(root, store, net, hooks = {}) {
    this.root = root;
    this.store = store;
    this.net = net;
    this.hooks = hooks;
    this.views = new Map();
    this.cam = { x: 40, y: 40, z: 1 };
    this.zoomBucket = 1;
    this.dragging = null;
    this.keys = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.clipboard = null;
    this.remoteRulers = new Map();
    this.touches = new Map();
    this.pinch = null;
    this.unsub = [];
    this.build();
    this.bind();
    this.loadPage();
  }

  // -------------------------------------------------------------------
  // Построение DOM
  // -------------------------------------------------------------------

  build() {
    const r = this.root;
    r.classList.add('board');
    r.tabIndex = 0;
    this.world = document.createElement('div');
    this.world.className = 'board-world';
    r.appendChild(this.world);
    this.pageBg = document.createElement('div');
    this.pageBg.className = 'page-bg';
    this.world.appendChild(this.pageBg);
    this.layers = {};
    const mk = (name) => {
      const d = document.createElement('div');
      d.className = 'layer layer-' + name;
      this.world.appendChild(d);
      this.layers[name] = d;
      return d;
    };
    mk('map');
    this.gridSvg = svg('svg', { class: 'grid-svg' });
    this.world.appendChild(this.gridSvg);
    mk('auras');
    mk('objects');
    mk('foreground');
    mk('gm');
    this.wallsSvg = svg('svg', { class: 'walls-svg' });
    this.world.appendChild(this.wallsSvg);
    mk('walls');
    this.pingLayer = document.createElement('div');
    this.pingLayer.className = 'ping-layer';
    this.world.appendChild(this.pingLayer);

    this.fxCanvas = document.createElement('canvas');
    this.fxCanvas.className = 'fx-canvas';
    r.appendChild(this.fxCanvas);
    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.className = 'fog-canvas';
    r.appendChild(this.fogCanvas);
    this.doorLayer = document.createElement('div');
    this.doorLayer.className = 'door-layer';
    r.appendChild(this.doorLayer);
    this.bubbleLayer = document.createElement('div');
    this.bubbleLayer.className = 'bubble-layer';
    this.bubbleEls = new Map();
    this.overlay = svg('svg', { class: 'overlay-svg' });
    r.appendChild(this.overlay);
    r.appendChild(this.bubbleLayer);
    this.banner = document.createElement('div');
    this.banner.className = 'board-banner';
    this.banner.hidden = true;
    r.appendChild(this.banner);

    this.fog = new FogRenderer(this, this.fogCanvas);
    this.fx = new FxEngine(this, this.fxCanvas);
    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(r);
    this.onResize();
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._sharpT);
    this.resizeObs.disconnect();
    for (const u of this.unsub) u();
    window.removeEventListener('keydown', this._kd);
    window.removeEventListener('keyup', this._ku);
    for (const v of this.views.values()) v.destroy();
    this.root.textContent = '';
  }

  onResize() {
    const w = this.root.clientWidth,
      h = this.root.clientHeight;
    this.W = w;
    this.H = h;
    this.fog.resize(w, h);
    this.fx.resize(w, h);
    this.overlay.setAttribute('width', w);
    this.overlay.setAttribute('height', h);
    this.dirtyFog();
    this.renderOverlay();
  }

  get page() {
    return this.store.page;
  }

  pageObjects() {
    return this.store.objsOnPage(this.store.ui.pageId);
  }

  // -------------------------------------------------------------------
  // Подписки
  // -------------------------------------------------------------------

  bind() {
    const s = this.store;
    this.unsub.push(
      s.on('col:obj', (o, id, old) => this.onObj(o, id, old)),
      s.on('col:page', (p, id) => id === s.ui.pageId && this.onPageData()),
      s.on('page', () => this.loadPage()),
      s.on('snapshot', () => this.loadPage()),
      s.on('selection', () => this.renderOverlay()),
      s.on('layer', () => this.applyLayerState()),
      s.on('tool', () => this.applyLayerState()),
      s.on('game', () => this.refreshAllUI()),
      s.on('col:char', () => this.refreshAllUI()),
      s.on('ui:viewAsPlayer', () => this.dirtyFog()),
    );
    this.unsub.push(
      this.net.on('fx', (fx) => fx.pageId === s.ui.pageId && this.fx.spawn(fx)),
      this.net.on('ping:map', (p) => this.onRemotePing(p)),
      this.net.on('ruler', (r) => this.onRemoteRuler(r)),
    );

    const r = this.root;
    r.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    r.addEventListener('pointermove', (e) => this.onPointerMove(e));
    r.addEventListener('pointerup', (e) => this.onPointerUp(e));
    r.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    r.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    r.addEventListener('dblclick', (e) => this.onDblClick(e));
    r.addEventListener('contextmenu', (e) => e.preventDefault());
    r.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    r.addEventListener('drop', (e) => this.onDrop(e));
    this._kd = (e) => this.onKeyDown(e);
    this._ku = (e) => this.keys.delete(e.key);
    window.addEventListener('keydown', this._kd);
    window.addEventListener('keyup', this._ku);
  }

  // -------------------------------------------------------------------
  // Страница
  // -------------------------------------------------------------------

  loadPage() {
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    this.fog.invalidateWalls();
    this.fog.seenKey = '';
    const page = this.page;
    if (!page) return;
    this.restoreCamera();
    this.onPageData();
    for (const o of this.pageObjects()) this.ensureView(o);
    this.renderWalls();
    this.applyLayerState();
    this.applyCamera();
  }

  onPageData() {
    const p = this.page;
    if (!p) return;
    const w = p.width * p.cellSize,
      h = p.height * p.cellSize;
    this.pageBg.style.width = w + 'px';
    this.pageBg.style.height = h + 'px';
    this.pageBg.style.background = p.bgColor || '#fff';
    this.renderGrid();
    this.fx.setWeather(p.weather);
    this.root.classList.toggle('lighting-on', !!p.lighting?.enabled);
    const s = this.store;
    const active = s.isGM ? s.ui.layer : 'objects';
    this.wallsSvg.style.display = s.isGM && (active === 'walls' || p.lighting?.enabled) ? '' : 'none';
    this.dirtyFog();
    this.renderWalls();
    for (const v of this.views.values()) v.renderAura(v.o);
  }

  renderGrid() {
    const p = this.page;
    const g = this.gridSvg;
    g.textContent = '';
    const W = p.width * p.cellSize,
      H = p.height * p.cellSize;
    g.setAttribute('width', W);
    g.setAttribute('height', H);
    g.style.width = W + 'px';
    g.style.height = H + 'px';
    if (p.gridType === 'none' || !p.gridOpacity) return;
    const defs = svg('defs', {}, g);
    const cs = p.cellSize;
    const stroke = p.gridColor || '#000';
    const sw = p.gridWidth || 1;
    let pat;
    if (p.gridType === 'hex' || p.gridType === 'hexr') {
      const d = hexDims(p);
      if (d.flat) {
        const pw = d.colStep * 2,
          ph = d.rowStep;
        pat = svg('pattern', { id: 'gridpat', width: pw, height: ph, patternUnits: 'userSpaceOnUse' }, defs);
        const r = d.r;
        const hex = (cx, cy) => {
          let s = '';
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i;
            s += `${i ? 'L' : 'M'}${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
          }
          return s + 'Z';
        };
        svg('path', { d: hex(0, 0) + hex(d.colStep, ph / 2) + hex(0, ph) + hex(pw, 0) + hex(pw, ph), fill: 'none', stroke, 'stroke-width': sw }, pat);
      } else {
        const pw = d.colStep,
          ph = d.rowStep * 2;
        pat = svg('pattern', { id: 'gridpat', width: pw, height: ph, patternUnits: 'userSpaceOnUse' }, defs);
        const r = d.r;
        const hex = (cx, cy) => {
          let s = '';
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i + Math.PI / 6;
            s += `${i ? 'L' : 'M'}${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
          }
          return s + 'Z';
        };
        svg('path', { d: hex(0, 0) + hex(pw, 0) + hex(pw / 2, ph / 2) + hex(0, ph) + hex(pw, ph), fill: 'none', stroke, 'stroke-width': sw }, pat);
      }
    } else {
      pat = svg('pattern', { id: 'gridpat', width: cs, height: cs, patternUnits: 'userSpaceOnUse' }, defs);
      svg('path', { d: `M ${cs} 0 L 0 0 0 ${cs}`, fill: 'none', stroke, 'stroke-width': sw }, pat);
    }
    svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#gridpat)', opacity: p.gridOpacity }, g);
  }

  applyLayerState() {
    const s = this.store;
    const active = s.isGM ? s.ui.layer : 'objects';
    for (const l of LAYERS) {
      this.layers[l].classList.toggle('active', l === active && s.ui.tool === 'select');
    }
    this.root.dataset.tool = s.ui.tool;
    this.root.dataset.layer = active;
    this.root.classList.toggle('is-gm', s.isGM);
    this.wallsSvg.classList.toggle('active', s.isGM && active === 'walls' && s.ui.tool === 'select');
    this.wallsSvg.style.display = s.isGM && (active === 'walls' || this.page?.lighting?.enabled) ? '' : 'none';
    this.renderWalls();
    this.renderOverlay();
    this.cancelTool();
  }

  refreshAllUI() {
    for (const v of this.views.values()) {
      v.key.ui = null;
      v.update(this.store.col.obj.get(v.id) || v.o);
    }
    this.renderOverlay();
    this.renderDoors();
    this.dirtyFog();
  }

  // -------------------------------------------------------------------
  // Объекты
  // -------------------------------------------------------------------

  ensureView(o) {
    if (o.type === 'wall') return null;
    if (o.layer === 'walls' && !this.store.isGM) {
      const old = this.views.get(o.id);
      if (old) {
        old.destroy();
        this.views.delete(o.id);
      }
      return null;
    }
    let v = this.views.get(o.id);
    const layerEl = this.layers[o.layer] || this.layers.objects;
    if (!v) {
      v = new ObjView(this, o);
      this.views.set(o.id, v);
      // при динамическом свете новый чужой токен скрыт, пока расчёт видимости не скажет иное
      if (this.page?.lighting?.enabled && !this.store.isGM && o.layer === 'objects' && !this.store.canControlObj(o)) v.el.classList.add('unseen');
      layerEl.appendChild(v.el);
    } else {
      if (v.el.parentNode !== layerEl) layerEl.appendChild(v.el);
      v.update(o);
    }
    return v;
  }

  onObj(o, id, old) {
    const pid = this.store.ui.pageId;
    const onPage = o && o.pageId === pid;
    const wasOnPage = old && old.pageId === pid;
    if (!onPage && !wasOnPage) return;
    const wall = (o && o.type === 'wall') || (old && old.type === 'wall');
    if (wall) {
      this.fog.invalidateWalls();
      this.renderWalls();
      this.dirtyFog();
      if (this.store.ui.selected.has(id)) this.renderOverlay();
      return;
    }
    if (!onPage) {
      const v = this.views.get(id);
      if (v) {
        v.destroy();
        this.views.delete(id);
      }
    } else this.ensureView(o);
    if ((o && (o.light?.enabled || o.vision?.enabled)) || (old && (old.light?.enabled || old.vision?.enabled))) this.dirtyFog();
    else if (this.page?.lighting?.enabled) this.dirtyFog();
    if (this.store.ui.selected.has(id)) this.renderOverlay();
    this.hooks.onObjChanged?.(o, old);
  }

  renderWalls() {
    const s = this.store;
    const walls = this.pageObjects().filter((o) => o.type === 'wall');
    renderWalls(this.wallsSvg, walls, { selected: s.ui.selected, isGM: s.isGM, activeLayer: s.isGM ? s.ui.layer : 'objects' });
    const p = this.page;
    if (p) {
      this.wallsSvg.setAttribute('width', p.width * p.cellSize);
      this.wallsSvg.setAttribute('height', p.height * p.cellSize);
    }
    this.renderDoors();
  }

  /**
   * Токены вне поля зрения игрока прячутся целиком (класс unseen).
   * Мастеру в режиме «глазами игроков» такие токены показываются полупрозрачными.
   */
  applyUnseen(set, gm = false) {
    const cls = gm ? 'unseen-gm' : 'unseen';
    const other = gm ? 'unseen' : 'unseen-gm';
    const next = set || new Set();
    for (const [id, v] of this.views) {
      const u = next.has(id);
      v.el.classList.remove(other);
      if (u !== v.el.classList.contains(cls)) v.el.classList.toggle(cls, u);
      if (v.aura) v.aura.classList.toggle('unseen', u && !gm);
    }
    this.unseen = next;
    this.renderDoors();
  }

  // Двери: кнопки открытия для игроков (и мастера)
  renderDoors() {
    const layer = this.doorLayer;
    // кнопки дверей не пересоздаются на каждом кадре движения карты — переставляются те же
    const old = this._doorBtns || (this._doorBtns = new Map());
    const keep = new Set();
    const done = () => {
      for (const [id, b] of old)
        if (!keep.has(id)) {
          b.remove();
          old.delete(id);
        }
    };
    const p = this.page;
    if (!p?.lighting?.enabled) return done();
    const doors = this.pageObjects().filter((o) => o.type === 'wall' && o.wallType === 'door');
    // игрок видит только двери в поле зрения (проверяем точки по обе стороны двери)
    const seenAt = this.store.isGM ? null : this.fog.seenAt;
    for (const d of doors) {
      const pts = d.pts || [];
      if (pts.length < 4) continue;
      const mx = (pts[0] + pts[pts.length - 2]) / 2,
        my = (pts[1] + pts[pts.length - 1]) / 2;
      if (!this.store.isGM) {
        if (!seenAt) continue;
        const dx = pts[pts.length - 2] - pts[0],
          dy = pts[pts.length - 1] - pts[1];
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * 12,
          ny = (dx / len) * 12;
        if (!seenAt(mx + nx, my + ny) && !seenAt(mx - nx, my - ny)) continue;
      }
      const s = this.worldToScreen(mx, my);
      if (s.x < -20 || s.y < -20 || s.x > this.W + 20 || s.y > this.H + 20) continue;
      let b = old.get(d.id);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        const id = d.id;
        b.onpointerdown = (e) => e.stopPropagation();
        b.onclick = (e) => {
          e.stopPropagation();
          const cur = this.store.col.obj.get(id);
          if (!cur || (cur.locked && !this.store.isGM)) return;
          this.net.request('door', { id }).then((r) => r?.error && this.hooks.error?.(r.error));
        };
        old.set(d.id, b);
        layer.appendChild(b);
      }
      keep.add(d.id);
      const state = (d.open ? 'o' : 'c') + (d.locked ? 'l' : '');
      if (b._state !== state) {
        b._state = state;
        b.className = 'door-btn' + (d.open ? ' open' : '') + (d.locked ? ' locked' : '');
        b.title = d.locked ? 'Дверь заперта' : d.open ? 'Закрыть дверь' : 'Открыть дверь';
        b.innerHTML = d.open
          ? '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 21V3h7l6 3v15" fill="none" stroke="currentColor" stroke-width="2"/></svg>'
          : '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 21V3h12v18M14 12h.01" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
      }
      // переставляем сдвигом (без пересчёта раскладки)
      b.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -50%)`;
    }
    done();
  }

  // -------------------------------------------------------------------
  // Камера
  // -------------------------------------------------------------------

  camKey() {
    return `cam:${this.store.gameId}:${this.store.ui.pageId}`;
  }

  restoreCamera() {
    try {
      const c = JSON.parse(localStorage.getItem(this.camKey()) || 'null');
      if (c && Number.isFinite(c.z)) {
        this.cam = c;
        return;
      }
    } catch {
      /* ignore */
    }
    this.fitPage();
  }

  fitPage() {
    const p = this.page;
    if (!p) return;
    const W = this.W || 800,
      H = this.H || 600;
    const pw = p.width * p.cellSize,
      ph = p.height * p.cellSize;
    const z = Math.max(0.1, Math.min(1.5, Math.min((W - 60) / pw, (H - 60) / ph)));
    this.cam = { z, x: (W - pw * z) / 2, y: (H - ph * z) / 2 };
    this.applyCamera();
  }

  applyCamera() {
    const c = this.cam;
    this.world.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
    // масштаб в переменных CSS (толщина стен, высота полос) — только когда он изменился: эти переменные
    // пересчитывают стиль всей доски, а при сдвиге карты масштаб прежний
    if (this._cssZ !== c.z) {
      this._cssZ = c.z;
      this.root.style.setProperty('--z', c.z);
      this.root.style.setProperty('--iz', 1 / c.z);
    }
    const bucket = c.z < 0.35 ? 0 : c.z < 0.8 ? 1 : 2;
    if (bucket !== this.zoomBucket) {
      this.zoomBucket = bucket;
      this.root.dataset.zoom = bucket;
    }
    this.renderOverlay();
    this.renderDoors();
    this.dirtyFog();
    this.fx.kick();
    // камера движется — доска отдельным слоем на видеокарте (плавно); замерла — рисуется как есть (чётко)
    if (this.world.style.willChange !== 'transform') this.world.style.willChange = 'transform';
    clearTimeout(this._sharpT);
    this._sharpT = setTimeout(() => this.sharpen(), 220);
    clearTimeout(this._camSave);
    this._camSave = setTimeout(() => {
      try {
        localStorage.setItem(this.camKey(), JSON.stringify(this.cam));
      } catch {
        /* ignore */
      }
    }, 400);
    this.hooks.onCamera?.(c);
  }

  /** Чёткость после приближения. Отдельный слой доски (will-change: transform) браузер рисует
   *  один раз и потом лишь растягивает: при сильном приближении надписи, значки и линии мылятся
   *  и становятся пиксельными. Когда камера замерла, слой снимаем — доска рисуется в своём масштабе. */
  sharpen() {
    if (this.destroyed) return;
    this._rasterZ = this.cam.z;
    this.world.style.willChange = 'auto';
  }

  zoomAt(sx, sy, factor) {
    const c = this.cam;
    const z = Math.max(0.08, Math.min(8, c.z * factor));
    const wx = (sx - c.x) / c.z,
      wy = (sy - c.y) / c.z;
    this.cam = { z, x: sx - wx * z, y: sy - wy * z };
    this.applyCamera();
  }

  zoomBy(f) {
    this.zoomAt(this.W / 2, this.H / 2, f);
  }

  centerOn(wx, wy, z) {
    const zz = z || this.cam.z;
    this.cam = { z: zz, x: this.W / 2 - wx * zz, y: this.H / 2 - wy * zz };
    this.applyCamera();
  }

  /** Плавный пролёт камеры к точке (кинотрюк мастера); щелчок или колесо прерывают пролёт */
  flyTo(wx, wy, z, ms = 1400) {
    cancelAnimationFrame(this._flyRaf);
    const z1 = Math.max(0.08, Math.min(8, z || this.cam.z));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !this.W) return this.centerOn(wx, wy, z1);
    const c0 = this.screenToWorld(this.W / 2, this.H / 2);
    const z0 = this.cam.z;
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const fly = { stop: false };
    this._fly = fly;
    const step = (now) => {
      if (fly.stop || this.destroyed) return;
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      const zz = z0 * Math.pow(z1 / z0, e);
      const cx = c0.x + (wx - c0.x) * e;
      const cy = c0.y + (wy - c0.y) * e;
      this.cam = { z: zz, x: this.W / 2 - cx * zz, y: this.H / 2 - cy * zz };
      this.applyCamera();
      if (t < 1) this._flyRaf = requestAnimationFrame(step);
    };
    this._flyRaf = requestAnimationFrame(step);
  }

  stopFly() {
    if (this._fly) this._fly.stop = true;
    cancelAnimationFrame(this._flyRaf);
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.cam.x) / this.cam.z, y: (sy - this.cam.y) / this.cam.z };
  }

  worldToScreen(wx, wy) {
    return { x: wx * this.cam.z + this.cam.x, y: wy * this.cam.z + this.cam.y };
  }

  evPos(e) {
    const r = this.root.getBoundingClientRect();
    const sx = e.clientX - r.left,
      sy = e.clientY - r.top;
    const w = this.screenToWorld(sx, sy);
    return { sx, sy, x: w.x, y: w.y };
  }

  dirtyFog() {
    if (this._fogRAF) return;
    this._fogRAF = requestAnimationFrame(() => {
      this._fogRAF = null;
      this.fog.render();
    });
  }

  shake(px = 6) {
    this.root.animate(
      [{ transform: 'translate(0,0)' }, { transform: `translate(${px}px,${-px / 2}px)` }, { transform: `translate(${-px}px,${px / 2}px)` }, { transform: 'translate(0,0)' }],
      { duration: 300 },
    );
  }

  // -------------------------------------------------------------------
  // Ввод
  // -------------------------------------------------------------------

  activeLayer() {
    return this.store.isGM ? this.store.ui.layer : 'objects';
  }

  hitObject(e) {
    const t = e.target.closest?.('[data-oid]');
    if (!t || !this.root.contains(t)) return null;
    const o = this.store.col.obj.get(t.dataset.oid);
    if (!o) return null;
    if (o.type === 'wall') return this.store.isGM && this.activeLayer() === 'walls' ? o : null;
    if (o.layer !== this.activeLayer()) return null;
    if (!this.store.canControlObj(o)) return null;
    return o;
  }

  // ---------------- сенсорные жесты: щипок — масштаб, два пальца — сдвиг ----------------

  touchDown(e, pos) {
    this.touches.set(e.pointerId, { x: pos.sx, y: pos.sy });
    if (this.touches.size !== 2) return this.touches.size > 2;
    // второй палец: отменяем начатое действие одним пальцем и начинаем щипок
    clearTimeout(this.pingTimer);
    if (this.dragging?.kind === 'move' && this.dragging.moved) this.endMove(this.dragging, pos, e);
    this.dragging = null;
    const [a, b] = [...this.touches.values()];
    this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam0: { ...this.cam } };
    this.renderOverlay();
    return true;
  }

  touchMove(e, pos) {
    if (!this.touches.has(e.pointerId)) return false;
    this.touches.set(e.pointerId, { x: pos.sx, y: pos.sy });
    if (!this.pinch || this.touches.size < 2) return false;
    const [a, b] = [...this.touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const { cam0, d0, m0 } = this.pinch;
    const z = Math.max(0.08, Math.min(8, (cam0.z * d) / d0));
    const wx = (m0.x - cam0.x) / cam0.z,
      wy = (m0.y - cam0.y) / cam0.z;
    this.cam = { z, x: m.x - wx * z, y: m.y - wy * z };
    this.applyCamera();
    return true;
  }

  touchUp(e) {
    this.touches.delete(e.pointerId);
    if (this.pinch) {
      if (this.touches.size < 2) this.pinch = null;
      this.dragging = null;
      return true;
    }
    return false;
  }

  onPointerDown(e) {
    this.stopFly();
    this.root.focus({ preventScroll: true });
    const pos = this.evPos(e);
    if (e.pointerType === 'touch' && this.touchDown(e, pos)) return;
    this.hooks.closePopups?.();
    const tool = this.store.ui.tool;

    // целеуказание
    if (this.targetPick) {
      e.preventDefault();
      const t = e.target.closest?.('[data-oid]');
      const o = t && this.store.col.obj.get(t.dataset.oid);
      if (o && o.type !== 'wall') this.finishTargetPick(o.id);
      return;
    }

    // подгонка карты под сетку: обвести квадрат из нескольких клеток
    if (this.alignMode && e.button === 0) {
      e.preventDefault();
      this.dragging = { kind: 'align', start: { x: pos.x, y: pos.y }, cur: pos };
      try {
        this.root.setPointerCapture(e.pointerId);
      } catch {
        /* синтетическое событие */
      }
      return;
    }
    if (e.button === 1 || (e.button === 0 && (this.keys.has(' ') || tool === 'pan'))) return this.startPan(e, pos);
    if (e.button === 2) {
      this.rightDown = { ...pos, t: performance.now(), e };
      if (this.dragging?.kind === 'ruler') {
        if (!isTemplate(this.dragging.shape)) this.dragging.waypoints.push(this.dragging.cur);
        return;
      }
      if (this.polyDraft) return this.finishPoly();
      this.startPan(e, pos, true);
      return;
    }
    if (e.button !== 0) return;

    // ручки выделения
    const handle = e.target.closest?.('[data-handle]');
    if (handle) return this.startTransform(e, pos, handle.dataset.handle);

    switch (tool) {
      case 'select':
        return this.selectDown(e, pos);
      case 'ruler':
        return this.startRuler(e, pos);
      case 'draw':
      case 'line':
      case 'rect':
      case 'ellipse':
      case 'shape':
      case 'fog':
        return this.startDrawLike(e, pos, tool);
      case 'poly':
        return this.polyClick(pos);
      case 'wall':
        return this.wallClick(e, pos);
      case 'text':
        return this.placeText(pos);
      case 'light':
        return this.placeLight(pos);
      case 'pin':
        return this.placePin(pos);
      case 'fx':
        return this.startFx(e, pos);
    }
  }

  onPointerMove(e) {
    const pos = this.evPos(e);
    if (e.pointerType === 'touch' && this.touchMove(e, pos)) return;
    this.lastPos = pos;
    const d = this.dragging;
    if (!d) {
      if (this.polyDraft || this.wallDraft) this.renderOverlay(pos);
      return;
    }
    d.cur = pos;
    switch (d.kind) {
      case 'pan': {
        const dx = e.clientX - d.cx,
          dy = e.clientY - d.cy;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        this.cam = { ...this.cam, x: d.camX + dx, y: d.camY + dy };
        this.applyCamera();
        break;
      }
      case 'move':
        this.dragMove(pos, e);
        break;
      case 'marquee':
        if (Math.abs(pos.sx - d.sx) + Math.abs(pos.sy - d.sy) > 4) {
          d.moved = true;
          clearTimeout(this.pingTimer);
        }
        this.renderOverlay();
        break;
      case 'resize':
      case 'rotate':
        this.dragTransform(pos, e);
        break;
      case 'ruler':
        this.renderOverlay();
        this.broadcastRuler();
        break;
      case 'draw':
        if (d.tool === 'draw' || (d.tool === 'fog' && d.shape === 'brush')) {
          const last = d.pts.length - 2;
          if (Math.hypot(pos.x - d.pts[last], pos.y - d.pts[last + 1]) > 2 / this.cam.z) d.pts.push(pos.x, pos.y);
        }
        this.renderOverlay();
        break;
      case 'fx':
      case 'align':
        this.renderOverlay();
        break;
    }
  }

  onPointerUp(e) {
    if (e.pointerType === 'touch' && this.touchUp(e)) return;
    const d = this.dragging;
    clearTimeout(this.pingTimer);
    if (e.button === 2 && this.rightDown) {
      const rd = this.rightDown;
      this.rightDown = null;
      if (d?.kind === 'pan' && d.right) {
        this.dragging = null;
        if (!d.moved) this.contextMenuAt(rd.e);
        return;
      }
    }
    if (!d) return;
    const pos = this.evPos(e);
    this.dragging = null;
    try {
      this.root.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    switch (d.kind) {
      case 'move':
        this.endMove(d, pos, e);
        break;
      case 'marquee':
        this.endMarquee(d, pos, e);
        break;
      case 'resize':
      case 'rotate':
        this.endTransform(d);
        break;
      case 'ruler':
        this.net.socket?.emit('ruler', { pageId: this.store.ui.pageId, clear: true });
        if (isTemplate(d.shape) && this.store.ui.rulerKeep) this.keepTemplate(d, e);
        break;
      case 'draw':
        this.endDrawLike(d, pos, e);
        break;
      case 'fx':
        this.endFx(d, pos);
        break;
      case 'align':
        this.finishAlign(d, pos);
        break;
    }
    this.renderOverlay();
  }

  startPan(e, pos, right = false) {
    e.preventDefault();
    this.dragging = { kind: 'pan', cx: e.clientX, cy: e.clientY, camX: this.cam.x, camY: this.cam.y, right, moved: false };
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  onWheel(e) {
    this.stopFly();
    e.preventDefault();
    const pos = this.evPos(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    if (e.shiftKey && !e.ctrlKey) {
      this.cam = { ...this.cam, x: this.cam.x - delta };
      this.applyCamera();
      return;
    }
    this.zoomAt(pos.sx, pos.sy, Math.exp(-delta * 0.0016));
  }

  onDblClick(e) {
    if (this.polyDraft) return this.finishPoly();
    if (this.wallDraft) return this.finishWall();
    const t = e.target.closest?.('[data-oid]');
    if (!t) return;
    const o = this.store.col.obj.get(t.dataset.oid);
    if (!o) return;
    if (o.type === 'wall') {
      if (o.wallType === 'door') this.net.update('obj', o.id, { open: !o.open });
      return;
    }
    if (o.type === 'pin') {
      if (this.store.isGM) this.hooks.openPinSettings?.(o.id);
      return;
    }
    if (!this.store.canControlObj(o) && !(o.represents && this.store.col.char.has(o.represents))) return;
    if (o.represents && this.store.col.char.has(o.represents)) this.hooks.openCharacter?.(o.represents);
    else if (this.store.canControlObj(o)) this.hooks.openTokenSettings?.(o.id);
  }

  // ---------------- выделение и перемещение ----------------

  selectDown(e, pos) {
    const s = this.store;
    // метку на карте открывает любой, кто её видит (мастер — двойным щелчком или через меню)
    const pinEl = e.target.closest?.('.obj[data-type="pin"]');
    if (pinEl && !s.isGM) {
      const pin = s.col.obj.get(pinEl.dataset.oid);
      if (pin) {
        e.preventDefault();
        this.hooks.openPin?.(pin);
        return;
      }
    }
    const o = this.hitObject(e);
    if (!o && e.pointerType === 'touch') {
      s.setSelection([]);
      this.startPan(e, pos);
      this.pingTimer = setTimeout(() => {
        if (this.dragging?.kind === 'pan' && !this.dragging.moved) {
          this.dragging = null;
          this.ping(pos.x, pos.y, false);
        }
      }, 600);
      return;
    }
    if (!o) {
      if (!e.shiftKey) s.setSelection([]);
      this.dragging = { kind: 'marquee', sx: pos.sx, sy: pos.sy, wx: pos.x, wy: pos.y, add: e.shiftKey, moved: false };
      this.root.setPointerCapture?.(e.pointerId);
      // долгое нажатие — пинг
      this.pingTimer = setTimeout(() => {
        if (this.dragging?.kind === 'marquee' && !this.dragging.moved) {
          this.dragging = null;
          this.ping(pos.x, pos.y, e.shiftKey && s.isGM);
          this.renderOverlay();
        }
      }, 550);
      return;
    }
    if (o.type === 'wall') {
      s.setSelection(e.shiftKey ? [...s.ui.selected, o.id] : [o.id]);
      this.renderWalls();
      const node = e.target.closest?.('[data-node]');
      if (node) {
        this.dragging = { kind: 'move', items: [], wallNode: { id: o.id, idx: Number(node.dataset.node) }, start: pos, moved: false };
        this.root.setPointerCapture?.(e.pointerId);
      } else {
        this.dragging = { kind: 'move', items: [{ id: o.id, x: 0, y: 0, pts: [...o.pts] }], start: pos, moved: false, wall: true };
        this.root.setPointerCapture?.(e.pointerId);
      }
      return;
    }
    let sel = new Set(s.ui.selected);
    if (e.shiftKey) {
      if (sel.has(o.id)) sel.delete(o.id);
      else sel.add(o.id);
    } else if (!sel.has(o.id)) sel = new Set([o.id]);
    s.setSelection([...sel]);
    if (!sel.has(o.id)) return;
    const movable = [...sel].map((id) => s.col.obj.get(id)).filter((x) => x && s.canControlObj(x) && (!x.locked || s.isGM) && x.type !== 'wall');
    // пассажиры, чей транспорт тоже выделен, едут вместе с ним, а не сами по себе
    const items = this.movableRoots(movable).map((x) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, rot: x.rot || 0 }));
    const primary = items.some((it) => it.id === o.id) ? o.id : carriersOf((id) => s.col.obj.get(id), o).find((c) => items.some((it) => it.id === c.id))?.id || o.id;
    // токены с особым способом перемещения стоят на месте, пока их тянут: под курсором — полупрозрачный
    // призрак, а после отпускания токен идёт выбранной анимацией у всех, включая того, кто тянул
    const quiet = items.filter((it) => this.moveStyleOf(s.col.obj.get(it.id)) !== 'instant').map((it) => it.id);
    // seq — номер перетаскивания: по нему сервер собирает весь путь и проверяет ловушки, когда токен отпустят
    this.dragging = { kind: 'move', items, primary, start: pos, moved: false, clickedId: o.id, shift: e.shiftKey, waypoints: [], carry: this.startCarry(items), quiet, seq: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) };
    this.root.setPointerCapture?.(e.pointerId);
  }

  /** Как другие увидят перемещение: способ самого токена, его транспорта или общий из настроек стола */
  moveStyleOf(o) {
    const s = this.store;
    let style = o?.moveStyle;
    if (!style && o?.attachedTo) style = s.col.obj.get(o.attachedTo)?.moveStyle;
    return style || s.settings.moveStyle || 'instant';
  }

  /** Объект сейчас тянут здесь же — показывать ему анимацию перемещения не нужно */
  isLocalMove(id) {
    const d = this.dragging;
    if (!d) return false;
    if (d.kind === 'move') {
      if (this.ghostIds(d).has(id)) return false;
      return !!(d.items?.some((it) => it.id === id) || d.carry?.ids.includes(id));
    }
    if (d.kind === 'rotate' || d.kind === 'resize') return d.id === id || !!d.carry?.ids.includes(id);
    return false;
  }

  /** Перетаскивание отменили (Esc): всё возвращается на место */
  abortMove(d) {
    const s = this.store;
    for (const it of d.items || []) {
      if (d.quiet?.includes(it.id)) continue; // стоял на месте, тянули только призрак
      // вернулся туда, откуда начали, — хода не было, ловушки не проверяются
      if (s.col.obj.get(it.id)) this.net.update('obj', it.id, { x: it.x, y: it.y }, { drag: d.seq, dragEnd: true });
    }
    this.dropGhosts(d, true);
    this.predictCarry(d.carry);
    this.broadcastMove(d, true);
    this.endCarry(d.carry);
  }

  // ---------------- призраки: куда пойдёт токен с анимацией перемещения ----------------

  /** Токены, которые тянутся призраком: «тихие» и пассажиры на них */
  ghostIds(d) {
    if (d.ghostIdSet) return d.ghostIdSet;
    const ids = new Set(d.quiet || []);
    for (const g of d.carry?.groups || []) if (ids.has(g.id)) for (const r of g.riders) ids.add(r.id);
    d.ghostIdSet = ids;
    return ids;
  }

  /** Поставить призраки на место «начало + сдвиг» (создаются при первом сдвиге) */
  moveGhosts(d, dx, dy) {
    const ids = this.ghostIds(d);
    if (!ids.size) return;
    if (!d.ghosts) {
      d.ghosts = [];
      for (const id of ids) {
        const v = this.views.get(id);
        const o = this.store.col.obj.get(id);
        if (!v || !o || !v.el.parentNode) continue;
        const el = v.el.cloneNode(true);
        el.removeAttribute('data-oid');
        el.classList.add('move-ghost');
        el.classList.remove('ctl');
        el.style.opacity = String(0.55 * (o.opacity ?? 1));
        el.setAttribute('aria-hidden', 'true');
        for (const vid of el.querySelectorAll('video')) vid.muted = true;
        v.el.parentNode.appendChild(el);
        d.ghosts.push({ el, x: o.x, y: o.y });
      }
    }
    for (const g of d.ghosts) g.el.style.transform = `translate(${g.x + dx}px, ${g.y + dy}px)`;
  }

  /** Убрать призраки: после отпускания тают, при отмене — сразу */
  dropGhosts(d, now = false) {
    for (const g of d.ghosts || []) {
      if (now || !g.el.animate) {
        g.el.remove();
        continue;
      }
      const gone = () => g.el.remove();
      g.el.animate([{ opacity: g.el.style.opacity }, { opacity: 0 }], { duration: 260, easing: 'ease-out' }).finished.then(gone, gone);
    }
    d.ghosts = null;
  }

  // ---------------- сцепка: пассажиры едут вместе с транспортом ----------------

  /** Без тех, кого и так повезёт другой объект из этого же набора */
  movableRoots(objs) {
    const ids = new Set(objs.map((x) => x.id));
    const get = (id) => this.store.col.obj.get(id);
    return objs.filter((x) => !carriersOf(get, x).some((c) => ids.has(c.id)));
  }

  /** Запомнить пассажиров перетаскиваемых объектов; их ответы от сервера откладываются до конца */
  startCarry(items) {
    const groups = [];
    const all = [...this.store.col.obj.values()];
    for (const it of items) {
      const riders = ridersOf(all, it.id).filter((r) => r.type !== 'wall' && r.pageId === this.store.ui.pageId);
      if (!riders.length) continue;
      groups.push({ id: it.id, base: { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot || 0 }, riders: riders.map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot || 0 })) });
    }
    const ids = groups.flatMap((g) => g.riders.map((r) => r.id));
    if (ids.length) this.net.hold('obj', ids);
    return { groups, ids };
  }

  /** Показать пассажиров там, где их поставит сервер (сразу, без ожидания ответа) */
  predictCarry(carry) {
    if (!carry?.groups.length) return;
    const s = this.store;
    for (const g of carry.groups) {
      const p = s.col.obj.get(g.id);
      if (!p) continue;
      const t = carryTransform(g.base, p);
      for (const r of g.riders) {
        const cur = s.col.obj.get(r.id);
        if (!cur) continue;
        s.localUpsert('obj', { ...cur, ...(t ? t(r) : { x: r.x, y: r.y, rot: r.rot }) });
      }
    }
  }

  /** Конец перетаскивания: когда сервер подтвердит итог, принимаем его версию пассажиров */
  endCarry(carry, sends) {
    if (!carry?.ids.length) return;
    Promise.all(sends || []).finally(() => this.net.release('obj', carry.ids));
  }

  /** Центр основного перетаскиваемого токена в начале и сейчас */
  moveCenters(d) {
    const prim = d.items?.find((i) => i.id === d.primary) || d.items?.[0];
    if (!prim) return null;
    const a = { x: prim.x + prim.w / 2, y: prim.y + prim.h / 2 };
    return { a, b: { x: a.x + (d.dx || 0), y: a.y + (d.dy || 0) } };
  }

  /** Путь перетаскивания: начало → точки (пробел или обход угла) → текущее положение */
  movePath(d) {
    const c = this.moveCenters(d);
    return c ? [c.a, ...(d.waypoints || []), c.b] : [];
  }

  /** Показать путь токена всем (если линейка общая и это не выдаёт скрытое) */
  broadcastMove(d, clear = false) {
    const s = this.store;
    const page = this.page;
    if (!s.settings.shareRuler || !page || d.items?.length !== 1) return;
    const o = s.col.obj.get(d.primary);
    if (!o || o.layer !== 'objects' || o.effects?.invisible) return;
    // мастер не выдаёт перемещения при тумане или динамическом свете
    if (s.isGM && (page.fog?.enabled || page.lighting?.enabled)) return;
    if (clear) {
      if (d.shared) this.net.socket?.emit('ruler', { pageId: s.ui.pageId, clear: true });
      return;
    }
    const now = performance.now();
    if (now - (this._rulerSent || 0) < 80) return;
    this._rulerSent = now;
    d.shared = true;
    const label = o.showName && o.name && o.showNameToPlayers !== false ? o.name : '';
    this.net.socket?.emit('ruler', { pageId: s.ui.pageId, pts: this.movePath(d), label });
  }

  dragMove(pos, e) {
    const d = this.dragging;
    const page = this.page;
    let dx = pos.x - d.start.x,
      dy = pos.y - d.start.y;
    if (!d.moved && Math.hypot(dx * this.cam.z, dy * this.cam.z) < 4) return;
    d.moved = true;
    if (d.wallNode) {
      const w = this.store.col.obj.get(d.wallNode.id);
      if (!w) return;
      const pts = [...w.pts];
      let p = { x: pos.x, y: pos.y };
      if (page.snap && !e.altKey) p = snapPoint(page, p.x, p.y, 'half');
      pts[d.wallNode.idx * 2] = p.x;
      pts[d.wallNode.idx * 2 + 1] = p.y;
      this.net.update('obj', w.id, { pts }, { throttle: 80 });
      return;
    }
    if (d.wall) {
      const it = d.items[0];
      if (page.snap && !e.altKey) {
        const cs = page.cellSize / 2;
        dx = Math.round(dx / cs) * cs;
        dy = Math.round(dy / cs) * cs;
      }
      const pts = it.pts.map((v, i) => v + (i % 2 ? dy : dx));
      this.net.update('obj', it.id, { pts }, { throttle: 80 });
      return;
    }
    const prim = d.items.find((i) => i.id === d.primary) || d.items[0];
    if (!prim) return;
    if (page.snap && !e.altKey) {
      const sp = snapRect(page, prim, prim.x + dx, prim.y + dy);
      dx = sp.x - prim.x;
      dy = sp.y - prim.y;
    }
    // стены мешают движению игроков; путь можно вести вокруг углов — точка поворота ставится сама
    const lighting = page.lighting || {};
    if (!this.store.isGM && lighting.enabled && lighting.restrictMovement) {
      if (!d.segs)
        d.segs = wallSegments(
          this.pageObjects().filter((o) => o.type === 'wall'),
          'move',
        );
      const segs = d.segs;
      const cx = prim.x + prim.w / 2,
        cy = prim.y + prim.h / 2;
      const wp = d.waypoints || (d.waypoints = []);
      const from = wp.length ? wp[wp.length - 1] : { x: cx, y: cy };
      const tx = cx + dx,
        ty = cy + dy;
      if (movementBlocked(segs, from.x, from.y, tx, ty)) {
        const ok = d.lastOk;
        const okP = ok ? { x: cx + ok.dx, y: cy + ok.dy } : null;
        if (okP && (okP.x !== from.x || okP.y !== from.y) && !movementBlocked(segs, okP.x, okP.y, tx, ty)) {
          wp.push(okP);
          d.lastOk = { dx, dy };
        } else if (ok) {
          dx = ok.dx;
          dy = ok.dy;
        } else return;
      } else d.lastOk = { dx, dy };
    }
    d.dx = dx;
    d.dy = dy;
    for (const it of d.items) {
      if (d.quiet?.includes(it.id)) continue;
      this.net.update('obj', it.id, { x: it.x + dx, y: it.y + dy }, { throttle: 60, drag: d.seq });
    }
    this.moveGhosts(d, dx, dy);
    this.predictCarry(d.carry);
    this.broadcastMove(d);
    this.renderOverlay();
  }

  /** Пробел во время перетаскивания токена — точка поворота пути (как в Roll20) */
  addMoveWaypoint() {
    const d = this.dragging;
    if (d?.kind !== 'move' || !d.moved || d.wall || d.wallNode) return;
    const c = this.moveCenters(d);
    if (!c) return;
    const wp = d.waypoints || (d.waypoints = []);
    const last = wp[wp.length - 1] || c.a;
    if (last.x === c.b.x && last.y === c.b.y) return;
    wp.push(c.b);
    this.renderOverlay();
  }

  endMove(d, pos, e) {
    const s = this.store;
    this.broadcastMove(d, true);
    if (!d.moved) {
      this.dropGhosts(d, true);
      this.endCarry(d.carry);
      if (d.clickedId && !d.shift && s.ui.selected.size > 1) s.setSelection([d.clickedId]);
      return;
    }
    if (d.wallNode || d.wall) {
      const id = d.wallNode ? d.wallNode.id : d.items[0].id;
      const w = s.col.obj.get(id);
      if (w) this.net.update('obj', id, { pts: w.pts });
      return;
    }
    const undo = [];
    const sends = [];
    const path = this.movePath(d);
    const prim = d.items.find((i) => i.id === d.primary) || d.items[0];
    // путь со всеми поворотами — по нему пойдёт анимация (у каждого токена — со своим сдвигом от основного)
    const shifted = (it) => {
      if (path.length < 3 || !prim) return null;
      const ox = it.x + it.w / 2 - (prim.x + prim.w / 2),
        oy = it.y + it.h / 2 - (prim.y + prim.h / 2);
      return path.map((p) => ({ x: p.x + ox, y: p.y + oy }));
    };
    // весь путь каждого токена от начала перетаскивания — по нему сервер проверит ловушки
    const routeOf = (it) => {
      if (path.length < 2 || !prim) return null;
      const ox = it.x + it.w / 2 - (prim.x + prim.w / 2),
        oy = it.y + it.h / 2 - (prim.y + prim.h / 2);
      return path.map((p) => ({ x: p.x + ox, y: p.y + oy }));
    };
    for (const it of d.items) {
      const o = s.col.obj.get(it.id);
      if (!o) continue;
      const quiet = d.quiet?.includes(it.id);
      const to = quiet ? { x: it.x + (d.dx || 0), y: it.y + (d.dy || 0) } : { x: o.x, y: o.y };
      undo.push({ t: 'update', id: it.id, before: { x: it.x, y: it.y }, after: to });
      const mv = quiet ? shifted(it) : null;
      sends.push(this.net.update('obj', it.id, to, { ...(mv ? { mv } : {}), drag: d.seq, dragEnd: true, route: routeOf(it) }));
      // пассажиры «тихого» транспорта едут с ним сразу и тем же путём
      if (quiet && mv) {
        for (const g of d.carry?.groups || []) {
          if (g.id !== it.id) continue;
          for (const r of g.riders) s.movePaths.set(r.id, mv.map((p) => ({ x: p.x + r.x + r.w / 2 - (it.x + it.w / 2), y: p.y + r.y + r.h / 2 - (it.y + it.h / 2) })));
        }
      }
    }
    this.predictCarry(d.carry);
    this.dropGhosts(d);
    this.endCarry(d.carry, sends);
    this.pushUndo(undo);
  }

  /** Путь, по которому только что ушёл токен (центры), — если он ведёт из старого места в новое */
  takeMovePath(id, prev, o) {
    const p = this.store.movePaths.get(id);
    if (!p) return null;
    this.store.movePaths.delete(id);
    const near = (a, x, y) => a && Math.abs(a.x - x) < 1.5 && Math.abs(a.y - y) < 1.5;
    if (p.length < 3 || !near(p[0], prev.x + prev.w / 2, prev.y + prev.h / 2) || !near(p[p.length - 1], o.x + o.w / 2, o.y + o.h / 2)) return null;
    return p;
  }

  endMarquee(d, pos, e) {
    if (!d.moved) return;
    const r = {
      x: Math.min(d.wx, pos.x),
      y: Math.min(d.wy, pos.y),
      w: Math.abs(pos.x - d.wx),
      h: Math.abs(pos.y - d.wy),
    };
    const s = this.store;
    const layer = this.activeLayer();
    const ids = this.pageObjects()
      .filter((o) => {
        if (layer === 'walls') {
          // на слое стен — и стены (по точкам), и источники света (картинки этого слоя)
          if (o.type !== 'wall') return o.layer === 'walls' && s.canControlObj(o) && rectsIntersect(r, o);
          const pts = o.pts || [];
          for (let i = 0; i < pts.length; i += 2) if (pts[i] >= r.x && pts[i] <= r.x + r.w && pts[i + 1] >= r.y && pts[i + 1] <= r.y + r.h) return true;
          return false;
        }
        return o.layer === layer && o.type !== 'wall' && s.canControlObj(o) && rectsIntersect(r, o);
      })
      .map((o) => o.id);
    s.setSelection(d.add ? [...new Set([...s.ui.selected, ...ids])] : ids);
    if (layer === 'walls') this.renderWalls();
  }

  // ---------------- масштаб и поворот ----------------

  startTransform(e, pos, handle) {
    e.stopPropagation();
    const ids = [...this.store.ui.selected];
    if (ids.length !== 1) return;
    const o = this.store.col.obj.get(ids[0]);
    if (!o || !this.store.canControlObj(o) || (o.locked && !this.store.isGM)) return;
    this.dragging = { kind: handle === 'rot' ? 'rotate' : 'resize', handle, id: o.id, start: pos, orig: { ...o }, moved: false, carry: this.startCarry([o]) };
    this.root.setPointerCapture?.(e.pointerId);
  }

  dragTransform(pos, e) {
    const d = this.dragging;
    const o0 = d.orig;
    const page = this.page;
    d.moved = true;
    const cx = o0.x + o0.w / 2,
      cy = o0.y + o0.h / 2;
    if (d.kind === 'rotate') {
      let ang = (Math.atan2(pos.y - cy, pos.x - cx) * 180) / Math.PI + 90;
      if (e.shiftKey || (page.snap && !e.altKey)) ang = Math.round(ang / 15) * 15;
      ang = ((ang % 360) + 360) % 360;
      this.net.update('obj', d.id, { rot: Math.round(ang * 10) / 10 }, { throttle: 60 });
      this.predictCarry(d.carry);
      this.renderOverlay();
      return;
    }
    // точка в локальных координатах (без поворота)
    const lp = rotatePoint(pos.x, pos.y, cx, cy, -(o0.rot || 0));
    let x1 = o0.x,
      y1 = o0.y,
      x2 = o0.x + o0.w,
      y2 = o0.y + o0.h;
    const h = d.handle;
    if (h.includes('w')) x1 = lp.x;
    if (h.includes('e')) x2 = lp.x;
    if (h.includes('n')) y1 = lp.y;
    if (h.includes('s')) y2 = lp.y;
    const cs = page.cellSize;
    const snap = page.snap && !e.altKey && o0.type !== 'path' && o0.type !== 'text';
    if (snap) {
      const q = cs / 2;
      const rs = (v) => Math.round(v / q) * q;
      if (h.includes('w')) x1 = rs(x1);
      if (h.includes('e')) x2 = rs(x2);
      if (h.includes('n')) y1 = rs(y1);
      if (h.includes('s')) y2 = rs(y2);
    }
    let w = Math.max(snap ? cs / 2 : 8, Math.abs(x2 - x1)),
      hh = Math.max(snap ? cs / 2 : 8, Math.abs(y2 - y1));
    if (e.shiftKey && o0.w && o0.h) {
      const ratio = o0.w / o0.h;
      if (h.length === 2) {
        if (w / hh > ratio) hh = w / ratio;
        else w = hh * ratio;
      }
    }
    let nx = Math.min(x1, x2),
      ny = Math.min(y1, y2);
    if (h.includes('w')) nx = x2 - w;
    if (h.includes('n')) ny = y2 - hh;
    if (!h.includes('w') && !h.includes('e')) {
      nx = o0.x;
      w = o0.w;
    }
    if (!h.includes('n') && !h.includes('s')) {
      ny = o0.y;
      hh = o0.h;
    }
    // компенсация смещения центра при повороте
    if (o0.rot) {
      const ncx = nx + w / 2,
        ncy = ny + hh / 2;
      const rc = rotatePoint(ncx, ncy, cx, cy, o0.rot);
      nx = rc.x - w / 2;
      ny = rc.y - hh / 2;
    }
    const patch = { x: nx, y: ny, w, h: hh };
    if (o0.type === 'path' && o0.pts) {
      const sx = w / (o0.w || 1),
        sy = hh / (o0.h || 1);
      patch.pts = o0.pts.map((v, i) => (i % 2 ? v * sy : v * sx));
    }
    this.net.update('obj', d.id, patch, { throttle: 60 });
    this.predictCarry(d.carry);
    this.renderOverlay();
  }

  endTransform(d) {
    const o = d.moved && this.store.col.obj.get(d.id);
    if (!o) return this.endCarry(d.carry);
    const patch = d.kind === 'rotate' ? { rot: o.rot } : { x: o.x, y: o.y, w: o.w, h: o.h, ...(o.pts ? { pts: o.pts } : {}) };
    const before = {};
    for (const k of Object.keys(patch)) before[k] = d.orig[k];
    this.pushUndo([{ t: 'update', id: d.id, before, after: patch }]);
    this.endCarry(d.carry, [this.net.update('obj', d.id, patch)]);
  }

  // ---------------- линейка ----------------

  startRuler(e, pos) {
    const page = this.page;
    const ui = this.store.ui;
    const shape = isTemplate(ui.rulerShape) ? ui.rulerShape : 'line';
    let p = { x: pos.x, y: pos.y };
    // шаблоны областей начинаются от узла сетки (как в правилах D&D), линейка — от центра клетки
    if (page.snap && !e.altKey) p = snapPoint(page, p.x, p.y, shape === 'line' ? 'center' : 'corner');
    this.dragging = { kind: 'ruler', start: p, waypoints: [], cur: pos, shape };
    this.root.setPointerCapture?.(e.pointerId);
  }

  templateOpts(alt) {
    const ui = this.store.ui;
    return { angle: ui.coneAngle || 53.13, width: ui.beamWidth || this.page?.scale || 5, snap: !!this.page?.snap && !alt };
  }

  rulerPoints(d) {
    const page = this.page;
    if (d.shape && d.shape !== 'line') return [d.start, { x: d.cur.x, y: d.cur.y }];
    let end = { x: d.cur.x, y: d.cur.y };
    if (page.snap && !this.keys.has('Alt')) end = snapPoint(page, end.x, end.y, 'center');
    return [d.start, ...d.waypoints.map((w) => (page.snap ? snapPoint(page, w.x, w.y, 'center') : w)), end];
  }

  broadcastRuler() {
    if (!this.store.settings.shareRuler) return;
    const now = performance.now();
    if (now - (this._rulerSent || 0) < 80) return;
    this._rulerSent = now;
    const d = this.dragging;
    const pts = this.rulerPoints(d);
    const msg = { pageId: this.store.ui.pageId, pts };
    if (isTemplate(d.shape)) Object.assign(msg, { shape: d.shape, ...this.templateOpts(this.keys.has('Alt')) });
    this.net.socket?.emit('ruler', msg);
  }

  onRemoteRuler(r) {
    if (r.pageId !== this.store.ui.pageId) return;
    if (r.clear) this.remoteRulers.delete(r.by);
    else this.remoteRulers.set(r.by, { pts: r.pts, color: r.color, shape: r.shape, label: r.label, opts: { angle: r.angle, width: r.width, snap: !!r.snap }, t: performance.now() });
    clearTimeout(this._rrTimer);
    this._rrTimer = setTimeout(() => {
      this.remoteRulers.clear();
      this.renderOverlay();
    }, 6000);
    this.renderOverlay();
  }

  // ---------------- пинги ----------------

  ping(x, y, pull = false) {
    this.showPing(x, y, this.store.members.get(this.store.me.id)?.color || '#e3bd63');
    this.net.socket?.emit('ping:map', { pageId: this.store.ui.pageId, x, y, pull });
  }

  onRemotePing(p) {
    if (p.pageId !== this.store.ui.pageId) return;
    this.showPing(p.x, p.y, p.color || '#e3bd63');
    if (p.pull) this.centerOn(p.x, p.y);
  }

  showPing(x, y, color) {
    const el = document.createElement('div');
    el.className = 'ping';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.setProperty('--c', color);
    el.innerHTML = '<i></i><i></i><i></i>';
    this.pingLayer.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  // ---------------- рисование, фигуры, туман ----------------

  startDrawLike(e, pos, tool) {
    const ui = this.store.ui;
    const page = this.page;
    let p = { x: pos.x, y: pos.y };
    const shape = tool === 'fog' ? ui.fogShape || 'rect' : tool === 'shape' ? ui.shapeType || 'rect' : tool;
    if (page.snap && !e.altKey && tool !== 'draw' && !(tool === 'fog' && shape === 'brush')) p = snapPoint(page, p.x, p.y, 'corner');
    if (tool === 'fog' && shape === 'poly') return this.polyClick(pos, 'fog');
    this.dragging = { kind: 'draw', tool, shape, start: p, pts: [p.x, p.y], cur: pos };
    this.root.setPointerCapture?.(e.pointerId);
  }

  endDrawLike(d, pos, e) {
    const page = this.page;
    const ui = this.store.ui;
    let end = { x: pos.x, y: pos.y };
    if (page.snap && !e.altKey && d.tool !== 'draw' && !(d.tool === 'fog' && d.shape === 'brush')) end = snapPoint(page, end.x, end.y, 'corner');
    const x = Math.min(d.start.x, end.x),
      y = Math.min(d.start.y, end.y);
    let w = Math.abs(end.x - d.start.x),
      h = Math.abs(end.y - d.start.y);

    if (d.tool === 'fog') {
      const mode = ui.fogMode || 'reveal';
      let op;
      if (d.shape === 'brush') op = { mode, shape: 'brush', pts: simplify(d.pts, 2), r: (ui.fogBrush || 1) * (page.cellSize / 2) };
      else {
        if (w < 4 || h < 4) return;
        op = { mode, shape: d.shape === 'ellipse' ? 'ellipse' : 'rect', x, y, w, h };
      }
      this.fogOp(op);
      return;
    }
    if (d.tool === 'draw') {
      const pts = simplify(d.pts, 1.2 / this.cam.z);
      this.createPath(pts, { closed: false });
      return;
    }
    if (d.tool === 'line') {
      this.createPath([d.start.x, d.start.y, end.x, end.y], { closed: false, smooth: false });
      return;
    }
    if (w < 6 && h < 6) {
      w = h = page.cellSize;
    }
    if (d.tool === 'rect' || d.tool === 'ellipse' || d.tool === 'shape') {
      const shape = d.tool === 'shape' ? ui.shapeType || 'rect' : d.tool;
      this.createObj({
        type: 'shape',
        shape,
        x,
        y,
        w,
        h,
        fill: ui.fillColor ?? (d.tool === 'shape' ? '#c0392b88' : ''),
        stroke: ui.strokeColor || '#000000',
        strokeWidth: ui.strokeWidth || 3,
        layer: this.activeLayer() === 'walls' ? 'objects' : this.activeLayer(),
      });
    }
  }

  fogOp(op) {
    const page = this.page;
    const full = { ...op, id: newId() };
    const next = { ...page, fogOps: [...(page.fogOps || []), full] };
    this.store.localUpsert('page', next);
    this.net.request('fog', { pageId: page.id, op: full }).then((r) => r?.error && this.hooks.error?.(r.error));
    this.pushUndo([{ t: 'fog', pageId: page.id, op: full }]);
  }

  /** «Скрыть всё» / «Открыть всё» с возможностью отмены */
  fogReset(mode) {
    const page = this.page;
    if (!page) return;
    this.pushUndo([{ t: 'fogSet', pageId: page.id, before: page.fogOps || [], mode }]);
    return this.net.request('fog', { pageId: page.id, reset: mode });
  }

  createPath(pts, { closed, smooth = true }) {
    if (pts.length < 2) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
    const ui = this.store.ui;
    const rel = pts.map((v, i) => (i % 2 ? v - minY : v - minX));
    this.createObj({
      type: 'path',
      x: minX,
      y: minY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY),
      pts: rel,
      closed,
      smooth,
      stroke: ui.strokeColor || '#000000',
      strokeWidth: ui.strokeWidth || 4,
      fill: closed ? ui.fillColor || '' : '',
      layer: this.activeLayer() === 'walls' ? 'objects' : this.activeLayer(),
    });
  }

  polyClick(pos, kind) {
    const page = this.page;
    let p = { x: pos.x, y: pos.y };
    if (page.snap && !this.keys.has('Alt')) p = snapPoint(page, p.x, p.y, 'half');
    if (!this.polyDraft) this.polyDraft = { pts: [], kind: kind || (this.store.ui.tool === 'fog' ? 'fog' : 'poly') };
    const pts = this.polyDraft.pts;
    if (pts.length >= 4 && Math.hypot(pts[0] - p.x, pts[1] - p.y) < 10 / this.cam.z) return this.finishPoly();
    pts.push(p.x, p.y);
    this.renderOverlay(pos);
  }

  finishPoly() {
    const d = this.polyDraft;
    this.polyDraft = null;
    if (!d || d.pts.length < 6) return this.renderOverlay();
    if (d.kind === 'fog') this.fogOp({ mode: this.store.ui.fogMode || 'reveal', shape: 'poly', pts: d.pts });
    else this.createPath(d.pts, { closed: true, smooth: false });
    this.renderOverlay();
  }

  wallClick(e, pos) {
    const page = this.page;
    let p = { x: pos.x, y: pos.y };
    if (page.snap && !e.altKey) p = snapPoint(page, p.x, p.y, 'half');
    if (!this.wallDraft) this.wallDraft = { pts: [] };
    const pts = this.wallDraft.pts;
    if (pts.length >= 2 && Math.hypot(pts[pts.length - 2] - p.x, pts[pts.length - 1] - p.y) < 3) return this.finishWall();
    pts.push(p.x, p.y);
    this.renderOverlay(pos);
  }

  finishWall() {
    const d = this.wallDraft;
    this.wallDraft = null;
    if (!d || d.pts.length < 4) return this.renderOverlay();
    const ui = this.store.ui;
    const type = ui.wallType || 'wall';
    if (type === 'door' && d.pts.length > 4) {
      // каждая дверь — отдельный отрезок
      for (let i = 0; i + 3 < d.pts.length; i += 2) this.createObj({ type: 'wall', layer: 'walls', wallType: 'door', pts: d.pts.slice(i, i + 4), open: false, x: 0, y: 0, w: 0, h: 0 });
    } else this.createObj({ type: 'wall', layer: 'walls', wallType: type, pts: d.pts, open: false, x: 0, y: 0, w: 0, h: 0 });
    this.renderOverlay();
  }

  async placeText(pos) {
    const text = await this.hooks.prompt?.({ title: 'Текст на карте', label: 'Что написать?', multiline: true });
    if (!text) return;
    const ui = this.store.ui;
    const size = ui.fontSize || 28;
    const lines = text.split('\n');
    const w = Math.max(40, Math.max(...lines.map((l) => l.length)) * size * 0.55);
    this.createObj({ type: 'text', text, x: pos.x, y: pos.y, w, h: lines.length * size * 1.3, fontSize: size, color: ui.strokeColor || '#000000', layer: this.activeLayer() === 'walls' ? 'objects' : this.activeLayer() });
  }

  /** Метка на карте: остриё — в точке щелчка; после создания открываются её настройки */
  async placePin(pos) {
    const page = this.page;
    const size = Math.round(page.cellSize * 0.6);
    const layer = this.activeLayer() === 'gm' ? 'gm' : 'objects';
    const r = await this.createObj({
      type: 'pin',
      name: 'Метка',
      showName: true,
      notes: '',
      handoutId: '',
      color: '#c9a24a',
      layer,
      x: Math.round(pos.x - size / 2),
      y: Math.round(pos.y - size),
      w: size,
      h: size,
      bars: [],
    });
    if (r?.id) this.hooks.openPinSettings?.(r.id);
    this.store.setTool('select');
  }

  placeLight(pos) {
    const page = this.page;
    const cs = page.cellSize;
    let p = { x: pos.x, y: pos.y };
    if (page.snap) p = snapPoint(page, p.x, p.y, 'center');
    this.createObj({
      type: 'image',
      src: LIGHT_ICON,
      name: 'Источник света',
      x: p.x - cs / 4,
      y: p.y - cs / 4,
      w: cs / 2,
      h: cs / 2,
      layer: 'walls',
      light: { enabled: true, bright: 20, dim: 20, color: '#ffe7b0', angle: 360, dir: 0, intensity: 1 },
    });
  }

  // ---------------- эффекты ----------------

  startFx(e, pos) {
    this.dragging = { kind: 'fx', start: { x: pos.x, y: pos.y }, cur: pos };
    this.root.setPointerCapture?.(e.pointerId);
  }

  endFx(d, pos) {
    const ui = this.store.ui;
    const fx = { pageId: this.store.ui.pageId, type: ui.fxType || 'burst', color: ui.fxColor || 'fire', x: d.start.x, y: d.start.y };
    const moved = Math.hypot(pos.x - d.start.x, pos.y - d.start.y) * this.cam.z > 10;
    if (moved) {
      fx.x2 = pos.x;
      fx.y2 = pos.y;
    }
    if (ui.fxCustom && ui.fxType === 'custom') fx.custom = ui.fxCustom;
    this.fx.spawn(fx);
    this.net.request('fx', fx).then((r) => r?.error && this.hooks.error?.(r.error));
  }

  // ---------------- создание объектов ----------------

  createObj(data, { select = true, undo = true } = {}) {
    const page = this.page;
    if (!page) return null;
    const o = { ...clone(TOKEN_DEFAULTS), ...data, id: data.id || newId(), pageId: page.id };
    if (!this.store.isGM) o.layer = 'objects';
    o.z = this.maxZ(o.layer) + 1;
    this.net.create('obj', o).then((r) => r?.error && this.hooks.error?.(r.error));
    if (select && o.type !== 'wall') this.store.setSelection([o.id]);
    if (undo) this.pushUndo([{ t: 'create', id: o.id, data: o }]);
    return o;
  }

  maxZ(layer) {
    let z = 0;
    for (const o of this.pageObjects()) if (o.layer === layer && (o.z || 0) > z) z = o.z || 0;
    return z;
  }

  /** Создать токен персонажа в точке. layer — куда (по умолчанию активный слой мастера), select — выделить */
  async tokenFromCharacter(charId, wx, wy, { layer: wantLayer = null, select = true } = {}) {
    const s = this.store;
    const ch = s.col.char.get(charId);
    const page = this.page;
    if (!ch || !page) return;
    const cs = page.cellSize;
    let t = ch.defaultToken ? clone(ch.defaultToken) : null;
    // токен монстра из бестиария знает свой размер в клетках (Large — 2×2, Tiny — пол-клетки)
    if (t && t.cells && !t.w && !t.h) t.w = t.h = Math.max(8, Math.round(cs * Number(t.cells)));
    if (t) delete t.cells;
    const isPC = (ch.controlledBy || []).length > 0;
    if (!t) {
      t = { type: 'image', src: ch.avatar || '', w: cs, h: cs, name: ch.name, showName: true, bars: [] };
      try {
        const attrs = await this.net.ensureAttrs(ch.id);
        const hpName = ['hp', 'HP', 'hit_points', 'hitpoints', 'health', 'wounds', 'Wounds', 'hp_current'].find((n) => attrs.has(n.toLowerCase()));
        if (hpName) {
          const a = attrs.get(hpName.toLowerCase());
          t.bars.push(newBar(2, { name: 'HP', link: isPC ? a.name : '', value: a.current, max: a.max, color: '#d63a3a' }));
        }
      } catch {
        /* нет доступа к атрибутам */
      }
    }
    delete t.id;
    delete t.pageId;
    delete t.attachedTo;
    t.represents = ch.id;
    if (!t.src) t.src = ch.avatar || '';
    if (!t.type) t.type = 'image';
    t.w = t.w || cs;
    t.h = t.h || cs;
    if (!isPC) {
      // NPC: у каждой копии свои бары и номер
      const same = this.pageObjects().filter((o) => o.represents === ch.id).length;
      if (same > 0) t.name = `${ch.name} ${same + 1}`;
      if (Array.isArray(t.bars)) {
        const attrs = s.attrMap(ch.id);
        t.bars = t.bars.map((b) => {
          if (b.link && attrs?.has(b.link.toLowerCase())) {
            const a = attrs.get(b.link.toLowerCase());
            return { ...b, id: 'b' + Math.random().toString(36).slice(2, 9), link: '', value: a.current, max: a.max };
          }
          return { ...b, id: 'b' + Math.random().toString(36).slice(2, 9), link: b.keepLink ? b.link : '' };
        });
      }
    }
    let x = wx - t.w / 2,
      y = wy - t.h / 2;
    if (page.snap) ({ x, y } = snapRect(page, t, x, y));
    const active = this.activeLayer();
    const layer = !s.isGM ? 'objects' : ['objects', 'foreground', 'gm'].includes(wantLayer) ? wantLayer : ['map', 'objects', 'foreground', 'gm'].includes(active) ? (active === 'map' ? 'objects' : active) : 'objects';
    return this.createObj({ ...t, x, y, layer }, { select });
  }

  async onDrop(e) {
    e.preventDefault();
    const pos = this.evPos(e);
    const raw = e.dataTransfer.getData('application/x-taverna');
    if (raw) {
      let d;
      try {
        d = JSON.parse(raw);
      } catch {
        return;
      }
      if (d.kind === 'char') return this.tokenFromCharacter(d.id, pos.x, pos.y);
      if (d.kind === 'asset') return this.placeImage(d, pos);
      if (d.kind === 'macro' || d.kind === 'sheetroll') return this.dropActionOnToken(e, d);
      if (d.kind === 'handout') return;
      return;
    }
    const files = [...(e.dataTransfer.files || [])].filter((f) => /^(image|video)\//.test(f.type));
    if (files.length) {
      const assets = await this.hooks.upload?.(files);
      let i = 0;
      for (const a of assets || []) {
        this.placeImage({ url: a.url, name: a.name, width: a.width, height: a.height, kind: a.kind }, { x: pos.x + i * 20, y: pos.y + i * 20 });
        i++;
      }
      return;
    }
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (url && /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|webm|mp4)(\?\S*)?$/i.test(url.trim())) this.placeImage({ url: url.trim(), name: '' }, pos);
  }

  /** Макрос или кнопку листа бросили на токен — это становится макросом токена */
  dropActionOnToken(e, d) {
    const s = this.store;
    const el = e.target.closest?.('[data-oid]');
    const o = el && this.root.contains(el) ? s.col.obj.get(el.dataset.oid) : null;
    if (!o || o.type === 'wall' || o.type === 'pin' || !s.canControlObj(o)) return this.hooks.error?.('Отпустите макрос прямо на токене — он станет кнопкой этого токена');
    let act = null;
    if (d.kind === 'macro') {
      const m = s.col.macro.get(d.id);
      if (m) act = { name: m.name, action: '#' + m.name };
    } else if (d.charId && d.ref) act = { name: d.label || d.ref, action: `%{${d.charId}|${d.ref}}` };
    if (!act) return;
    const list = Array.isArray(o.actions) ? o.actions : [];
    if (list.some((a) => a.action === act.action)) return this.hooks.notify?.(`У токена «${o.name || 'без имени'}» уже есть «${act.name}»`);
    this.net.update('obj', o.id, { actions: [...list, { id: newId(), ...act }] }).then((r) => {
      if (r?.error) this.hooks.error?.(r.error);
      else {
        s.setSelection([o.id]);
        this.hooks.notify?.(`«${act.name}» — теперь кнопка токена «${o.name || 'без имени'}»`);
      }
    });
  }

  placeImage(a, pos) {
    const page = this.page;
    const s = this.store;
    const cs = page.cellSize;
    const layer = this.activeLayer();
    let w = cs,
      h = cs;
    const nat = (iw, ih) => {
      if (layer === 'map' && iw && ih) {
        // карту растягиваем по размеру исходника, привязывая к клеткам
        w = iw;
        h = ih;
      } else if (iw && ih) {
        const r = iw / ih;
        if (r >= 1) h = cs / r;
        else w = cs * r;
      }
    };
    nat(a.width, a.height);
    let x = pos.x - w / 2,
      y = pos.y - h / 2;
    if (page.snap && layer !== 'map') ({ x, y } = snapRect(page, { w, h }, x, y));
    if (layer === 'map') {
      x = Math.max(0, Math.round(x / cs) * cs);
      y = Math.max(0, Math.round(y / cs) * cs);
    }
    return this.createObj({ type: 'image', src: a.url, name: a.name || '', x, y, w, h, layer: s.isGM ? (layer === 'walls' ? 'map' : layer) : 'objects' });
  }

  // ---------------- клавиатура ----------------

  onKeyDown(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (e.target.closest?.('.fwin, .modal, .sidebar, .mk-hud')) return;
    this.keys.add(e.key);
    const s = this.store;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (this.targetPick) return this.finishTargetPick(null);
      if (this.alignMode) return this.stopAlign();
      this.cancelTool();
      s.setSelection([]);
      this.renderWalls();
      return;
    }
    if (e.key === 'Enter') {
      if (this.polyDraft) return this.finishPoly();
      if (this.wallDraft) return this.finishWall();
    }
    if (e.key === ' ' && this.dragging?.kind === 'ruler') {
      e.preventDefault();
      if (!isTemplate(this.dragging.shape)) this.dragging.waypoints.push(this.dragging.cur);
      return;
    }
    if (e.key === ' ' && this.dragging?.kind === 'move') {
      e.preventDefault();
      return this.addMoveWaypoint();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      return this.deleteSelected();
    }
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? this.redo() : this.undo();
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      return this.redo();
    }
    if (ctrl && e.key.toLowerCase() === 'c') return this.copy();
    if (ctrl && e.key.toLowerCase() === 'v') return this.paste();
    if (ctrl && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.copy();
      return this.paste(true);
    }
    if (ctrl && e.key.toLowerCase() === 'a' && s.isGM) {
      e.preventDefault();
      const layer = this.activeLayer();
      s.setSelection(this.pageObjects().filter((o) => o.layer === layer).map((o) => o.id));
      return;
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const page = this.page;
      const step = e.shiftKey ? 1 : page.cellSize;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      // стены не пускают игроков и при движении стрелками
      const lighting = page.lighting || {};
      const segs = !s.isGM && lighting.enabled && lighting.restrictMovement ? wallSegments(this.pageObjects().filter((o) => o.type === 'wall'), 'move') : null;
      const movable = s.selectedObjs().filter((o) => s.canControlObj(o) && o.type !== 'wall' && (!o.locked || s.isGM));
      for (const o of this.movableRoots(movable)) {
        if (segs) {
          const cx = o.x + o.w / 2,
            cy = o.y + o.h / 2;
          if (movementBlocked(segs, cx, cy, cx + dx, cy + dy)) continue;
        }
        this.net.update('obj', o.id, { x: o.x + dx, y: o.y + dy });
      }
      return;
    }
    if (!ctrl && !e.altKey) {
      const map = { v: 'select', h: 'pan', r: 'ruler', d: 'draw' };
      const k = e.key.toLowerCase();
      if (map[k]) s.setTool(map[k]);
    }
  }

  cancelTool() {
    this.polyDraft = null;
    this.wallDraft = null;
    const d = this.dragging;
    if (d && d.kind !== 'pan') {
      this.dragging = null;
      if (d.kind === 'move' && !d.wall && !d.wallNode) this.abortMove(d);
      else if ((d.kind === 'rotate' || d.kind === 'resize') && d.carry) this.endCarry(d.carry);
    }
    this.renderOverlay();
  }

  deleteSelected() {
    const s = this.store;
    const undo = [];
    for (const id of [...s.ui.selected]) {
      const o = s.col.obj.get(id);
      if (!o) continue;
      if (!s.isGM && o.ownerId !== s.me.id) continue;
      undo.push({ t: 'delete', id, data: clone(o) });
      this.net.remove('obj', id);
    }
    s.setSelection([]);
    this.pushUndo(undo);
    this.renderWalls();
  }

  copy() {
    const objs = this.store.selectedObjs().filter((o) => this.store.canControlObj(o));
    if (objs.length) this.clipboard = clone(objs);
  }

  paste(inPlace = false) {
    if (!this.clipboard?.length) return;
    const page = this.page;
    const cs = page.cellSize;
    const base = this.lastPos && !inPlace ? this.lastPos : null;
    const minX = Math.min(...this.clipboard.map((o) => o.x)),
      minY = Math.min(...this.clipboard.map((o) => o.y));
    const ids = [];
    // новые id заранее: сцепка внутри вставляемого набора сохраняется, транспорт создаётся раньше пассажиров
    const idMap = new Map(this.clipboard.map((o) => [o.id, newId()]));
    const depth = (o) => {
      let n = 0;
      for (let q = o; q?.attachedTo && idMap.has(q.attachedTo) && n < 50; q = this.clipboard.find((x) => x.id === q.attachedTo)) n++;
      return n;
    };
    const ordered = [...this.clipboard].sort((a, b) => depth(a) - depth(b));
    for (const o of ordered) {
      const c = clone(o);
      c.attachedTo = idMap.get(o.attachedTo) || '';
      c.id = idMap.get(o.id);
      if (base) {
        c.x = o.x - minX + base.x;
        c.y = o.y - minY + base.y;
        if (page.snap) Object.assign(c, snapRect(page, c, c.x, c.y));
      } else {
        c.x += cs;
        c.y += cs;
      }
      if (c.type === 'wall') {
        const dx = base ? base.x - minX : cs,
          dy = base ? base.y - minY : cs;
        c.pts = c.pts.map((v, i) => v + (i % 2 ? dy : dx));
      }
      if (Array.isArray(c.bars)) c.bars = c.bars.map((b) => ({ ...b }));
      const created = this.createObj(c, { select: false });
      if (created) ids.push(created.id);
    }
    this.store.setSelection(ids);
  }

  // ---------------- отмена ----------------

  pushUndo(actions) {
    if (!actions.length) return;
    this.undoStack.push(actions);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return;
    this.applyUndo(a, true);
    this.redoStack.push(a);
  }

  redo() {
    const a = this.redoStack.pop();
    if (!a) return;
    this.applyUndo(a, false);
    this.undoStack.push(a);
  }

  applyUndo(actions, reverse) {
    const list = reverse ? [...actions].reverse() : actions;
    for (const act of list) {
      if (act.t === 'update') this.net.update('obj', act.id, reverse ? act.before : act.after);
      else if (act.t === 'create') {
        if (reverse) this.net.remove('obj', act.id);
        else this.net.create('obj', act.data);
      } else if (act.t === 'delete') {
        if (reverse) this.net.create('obj', act.data);
        else this.net.remove('obj', act.id);
      } else if (act.t === 'fog') {
        this.net.request('fog', reverse ? { pageId: act.pageId, removeId: act.op.id } : { pageId: act.pageId, op: act.op });
      } else if (act.t === 'fogSet') {
        this.net.request('fog', reverse ? { pageId: act.pageId, setOps: act.before } : { pageId: act.pageId, reset: act.mode });
      }
    }
  }

  // ---------------- контекстное меню ----------------

  contextMenuAt(e) {
    const t = e.target.closest?.('[data-oid]');
    const s = this.store;
    let o = t ? s.col.obj.get(t.dataset.oid) : null;
    if (o && !s.canControlObj(o)) o = null;
    if (o && o.type !== 'wall' && o.layer !== this.activeLayer() && !s.ui.selected.has(o.id)) o = s.isGM ? o : null;
    if (o && !s.ui.selected.has(o.id)) s.setSelection([o.id]);
    const pos = this.evPos(e);
    this.hooks.contextMenu?.(e.clientX, e.clientY, o ? s.selectedObjs() : [], pos);
  }

  // ---------------- выбор цели ----------------

  // ---------------- подгонка карты под сетку ----------------

  startGridAlign(objId) {
    const o = this.store.col.obj.get(objId);
    if (!o || !this.store.isGM) return;
    this.alignMode = { id: objId };
    this.banner.hidden = false;
    this.banner.textContent = 'Обведите на карте квадрат из нескольких клеток её сетки (например, 3×3) — от угла до угла. Esc — отмена';
    this.root.classList.add('targeting');
  }

  stopAlign() {
    this.alignMode = null;
    this.banner.hidden = true;
    this.root.classList.remove('targeting');
    if (this.dragging?.kind === 'align') this.dragging = null;
    this.renderOverlay();
  }

  async finishAlign(d, pos) {
    const mode = this.alignMode;
    this.stopAlign();
    const o = mode && this.store.col.obj.get(mode.id);
    const page = this.page;
    if (!o || !page) return;
    const r = { x: Math.min(d.start.x, pos.x), y: Math.min(d.start.y, pos.y), w: Math.abs(pos.x - d.start.x), h: Math.abs(pos.y - d.start.y) };
    if (r.w < 8 || r.h < 8) return this.hooks.error?.('Выделите область побольше — несколько клеток карты');
    const ans = await this.hooks.prompt?.({ title: 'Подогнать карту под сетку', label: 'Сколько клеток карты внутри выделения (по ширине)?', value: '3' });
    const n = Number(String(ans || '').replace(',', '.'));
    if (!(n > 0)) return;
    const cs = page.cellSize;
    // клетки карты могут быть чуть неквадратными — масштабируем по каждой оси отдельно
    const nh = Math.max(1, Math.round((r.h / r.w) * n));
    const kx = (n * cs) / r.w,
      ky = (nh * cs) / r.h;
    const gx = Math.round(r.x / cs) * cs,
      gy = Math.round(r.y / cs) * cs;
    const patch = { x: gx - (r.x - o.x) * kx, y: gy - (r.y - o.y) * ky, w: o.w * kx, h: o.h * ky };
    // если карта уехала за левый/верхний край сцены — сдвигаем на целое число клеток (сетка остаётся совмещённой)
    if (patch.x < 0) patch.x += Math.ceil(-patch.x / cs) * cs;
    if (patch.y < 0) patch.y += Math.ceil(-patch.y / cs) * cs;
    const before = { x: o.x, y: o.y, w: o.w, h: o.h };
    this.net.update('obj', o.id, patch);
    this.pushUndo([{ t: 'update', id: o.id, before, after: patch }]);
    // сцена должна вмещать карту
    const needW = Math.ceil((patch.x + patch.w) / cs),
      needH = Math.ceil((patch.y + patch.h) / cs);
    if (needW > page.width || needH > page.height) this.net.update('page', page.id, { width: Math.min(500, Math.max(page.width, needW)), height: Math.min(500, Math.max(page.height, needH)) });
  }

  pickTarget(label, text) {
    return new Promise((resolve) => {
      if (this.targetPick) this.finishTargetPick(null);
      this.targetPick = { resolve };
      this.banner.hidden = false;
      this.banner.textContent = text || `Выберите цель${label ? ': ' + label : ''} — щёлкните по токену (Esc — отмена)`;
      this.root.classList.add('targeting');
    });
  }

  finishTargetPick(id) {
    const tp = this.targetPick;
    this.targetPick = null;
    this.banner.hidden = true;
    this.root.classList.remove('targeting');
    tp?.resolve(id);
  }

  // -------------------------------------------------------------------
  // Оверлей (экранные координаты): выделение, ручки, линейка, черновики
  // -------------------------------------------------------------------

  renderOverlay(hover) {
    if (this._ovRAF) {
      this._ovHover = hover || this._ovHover;
      return;
    }
    this._ovHover = hover;
    this._ovRAF = requestAnimationFrame(() => {
      this._ovRAF = null;
      this._renderOverlay(this._ovHover);
    });
  }

  _renderOverlay(hover) {
    const g = this.overlay;
    g.textContent = '';
    const s = this.store;
    const z = this.cam.z;
    const W2S = (x, y) => this.worldToScreen(x, y);
    const turnTok = s.state.turnorder?.[0]?.tokenId;

    // подсветка текущего хода
    if (turnTok) {
      const o = s.col.obj.get(turnTok);
      if (o && o.pageId === s.ui.pageId && (s.isGM || o.layer !== 'gm')) {
        const c = W2S(o.x + o.w / 2, o.y + o.h / 2);
        svg('circle', { cx: c.x, cy: c.y, r: (Math.max(o.w, o.h) * z) / 2 + 8, class: 'turn-ring' }, g);
      }
    }

    // выделение
    const sel = s.selectedObjs().filter((o) => o.pageId === s.ui.pageId);
    for (const o of sel) {
      if (o.type === 'wall') continue;
      const cx = o.x + o.w / 2,
        cy = o.y + o.h / 2;
      const corners = [
        [o.x, o.y],
        [o.x + o.w, o.y],
        [o.x + o.w, o.y + o.h],
        [o.x, o.y + o.h],
      ].map(([x, y]) => rotatePoint(x, y, cx, cy, o.rot || 0));
      const sc = corners.map((p) => W2S(p.x, p.y));
      svg('polygon', { points: sc.map((p) => `${p.x},${p.y}`).join(' '), class: 'sel-box' }, g);
      if (sel.length === 1 && s.canControlObj(o) && (!o.locked || s.isGM) && s.ui.tool === 'select') {
        const hs = [
          ['nw', o.x, o.y],
          ['n', cx, o.y],
          ['ne', o.x + o.w, o.y],
          ['e', o.x + o.w, cy],
          ['se', o.x + o.w, o.y + o.h],
          ['s', cx, o.y + o.h],
          ['sw', o.x, o.y + o.h],
          ['w', o.x, cy],
        ];
        for (const [name, x, y] of hs) {
          const p = rotatePoint(x, y, cx, cy, o.rot || 0);
          const sp = W2S(p.x, p.y);
          svg('rect', { x: sp.x - 5, y: sp.y - 5, width: 10, height: 10, class: 'handle h-' + name, 'data-handle': name }, g);
        }
        const top = rotatePoint(cx, o.y - 26 / z, cx, cy, o.rot || 0);
        const topEdge = rotatePoint(cx, o.y, cx, cy, o.rot || 0);
        const tp = W2S(top.x, top.y),
          te = W2S(topEdge.x, topEdge.y);
        svg('line', { x1: te.x, y1: te.y, x2: tp.x, y2: tp.y, class: 'rot-line' }, g);
        svg('circle', { cx: tp.x, cy: tp.y, r: 7, class: 'handle rot', 'data-handle': 'rot' }, g);
      }
    }

    // сцепка выделенных: пунктир от пассажира к транспорту
    if (sel.length) {
      const pairs = new Map();
      const visible = (o) => o && o.pageId === s.ui.pageId && (s.isGM || o.layer !== 'gm');
      for (const o of sel) {
        if (o.type === 'wall') continue;
        const p = o.attachedTo && s.col.obj.get(o.attachedTo);
        if (visible(p)) pairs.set(o.id, [o, p]);
        for (const r of s.objsOnPage()) if (r.attachedTo === o.id && visible(r)) pairs.set(r.id, [r, o]);
      }
      for (const [r, p] of pairs.values()) {
        const a = W2S(r.x + r.w / 2, r.y + r.h / 2),
          b = W2S(p.x + p.w / 2, p.y + p.h / 2);
        svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'attach-link' }, g);
        svg('circle', { cx: a.x, cy: a.y, r: 3.5, class: 'attach-dot' }, g);
      }
    }

    const d = this.dragging;
    // рамка выделения
    if (d?.kind === 'marquee' && d.moved && d.cur) {
      svg('rect', { x: Math.min(d.sx, d.cur.sx), y: Math.min(d.sy, d.cur.sy), width: Math.abs(d.cur.sx - d.sx), height: Math.abs(d.cur.sy - d.sy), class: 'marquee' }, g);
    }
    // путь перемещения токена (с точками поворота)
    if (d?.kind === 'move' && d.moved && d.items?.length === 1 && d.dx !== undefined) {
      this.drawRuler(g, this.movePath(d), s.members.get(s.me.id)?.color || '#e3bd63');
    }
    const myColor = s.members.get(s.me.id)?.color || '#e3bd63';
    if (d?.kind === 'ruler' && d.cur) {
      if (isTemplate(d.shape)) this.drawTemplate(g, d.shape, d.start, d.cur, myColor, null, this.templateOpts(this.keys.has('Alt')));
      else this.drawRuler(g, this.rulerPoints(d), myColor);
    }
    for (const [by, r] of this.remoteRulers) {
      if (!(r.pts?.length >= 2)) continue;
      if (isTemplate(r.shape)) this.drawTemplate(g, r.shape, r.pts[0], r.pts[r.pts.length - 1], r.color || '#5b8fc7', s.memberName(by), r.opts);
      else this.drawRuler(g, r.pts, r.color || '#5b8fc7', r.label || s.memberName(by));
    }

    // черновики рисования
    if (d?.kind === 'draw' && d.cur) {
      const ui = s.ui;
      if (d.tool === 'draw' || (d.tool === 'fog' && d.shape === 'brush')) {
        const pts = d.pts.map((v, i) => (i % 2 ? v * z + this.cam.y : v * z + this.cam.x));
        const isFog = d.tool === 'fog';
        svg('path', { d: pathD(pts, false, true), class: isFog ? 'draft-fog-brush' : 'draft-path', stroke: isFog ? undefined : ui.strokeColor || '#000', 'stroke-width': isFog ? (ui.fogBrush || 1) * (this.page.cellSize / 2) * 2 * z : (ui.strokeWidth || 4) * z }, g);
      } else {
        const a = W2S(d.start.x, d.start.y),
          b = { x: d.cur.sx, y: d.cur.sy };
        if (d.tool === 'line') svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'draft-path', stroke: ui.strokeColor || '#000', 'stroke-width': (ui.strokeWidth || 4) * z }, g);
        else {
          const x = Math.min(a.x, b.x),
            y = Math.min(a.y, b.y),
            w = Math.abs(b.x - a.x),
            h = Math.abs(b.y - a.y);
          const cls = d.tool === 'fog' ? 'draft-fog ' + (ui.fogMode === 'hide' ? 'hide' : 'reveal') : 'draft-shape';
          if (d.shape === 'ellipse') svg('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, class: cls }, g);
          else svg('rect', { x, y, width: w, height: h, class: cls }, g);
          if (d.tool !== 'fog' && this.page) {
            const cells = `${Math.round(Math.abs(d.cur.x - d.start.x) / this.page.cellSize)}×${Math.round(Math.abs(d.cur.y - d.start.y) / this.page.cellSize)}`;
            const t = svg('text', { x: b.x + 12, y: b.y + 18, class: 'ruler-text' }, g);
            t.textContent = cells;
          }
        }
      }
    }
    if (d?.kind === 'align' && d.cur) {
      const a = W2S(d.start.x, d.start.y);
      const x = Math.min(a.x, d.cur.sx),
        y = Math.min(a.y, d.cur.sy);
      svg('rect', { x, y, width: Math.abs(d.cur.sx - a.x), height: Math.abs(d.cur.sy - a.y), class: 'draft-shape' }, g);
    }
    if (d?.kind === 'fx' && d.cur) {
      const a = W2S(d.start.x, d.start.y);
      svg('line', { x1: a.x, y1: a.y, x2: d.cur.sx, y2: d.cur.sy, class: 'draft-fx' }, g);
    }
    const drawDraft = (draft, cls, closed) => {
      if (!draft) return;
      const pts = [...draft.pts];
      const hv = hover || this.lastPos;
      if (hv) pts.push(hv.x, hv.y);
      const sp = [];
      for (let i = 0; i < pts.length; i += 2) {
        const p = W2S(pts[i], pts[i + 1]);
        sp.push(`${p.x},${p.y}`);
      }
      svg(closed ? 'polygon' : 'polyline', { points: sp.join(' '), class: cls }, g);
      for (let i = 0; i < draft.pts.length; i += 2) {
        const p = W2S(draft.pts[i], draft.pts[i + 1]);
        svg('circle', { cx: p.x, cy: p.y, r: 4, class: 'draft-node' }, g);
      }
    };
    drawDraft(this.polyDraft, this.polyDraft?.kind === 'fog' ? 'draft-fog ' + (s.ui.fogMode === 'hide' ? 'hide' : 'reveal') : 'draft-shape', true);
    drawDraft(this.wallDraft, 'draft-wall wall-' + (s.ui.wallType || 'wall'), false);
    this.renderBubbles();
  }

  /** Кружки значений баров над выделенным токеном (как в Roll20): щёлкнуть и ввести 12, +5, -3 */
  renderBubbles() {
    const s = this.store;
    const layer = this.bubbleLayer;
    const sel = s.selectedObjs().filter((o) => o.pageId === s.ui.pageId && o.type !== 'wall');
    const o = sel.length === 1 ? sel[0] : null;
    const d = this.dragging;
    const bars = o && Array.isArray(o.bars) && s.canControlObj(o) && s.ui.tool === 'select' && !(d && d.moved && d.kind !== 'pan') ? o.bars.filter((b) => s.isGM || b.editable !== 'gm').slice(0, 6) : [];
    const want = new Set();
    const z = this.cam.z;
    const anchor = o ? this.worldToScreen(o.x + o.w, o.y) : null;
    bars.forEach((b, idx) => {
      const key = o.id + ':' + (b.id || idx);
      want.add(key);
      let el = this.bubbleEls.get(key);
      if (!el) {
        el = document.createElement('input');
        el.className = 'bar-bubble';
        el.inputMode = 'decimal';
        el.setAttribute('aria-label', `${b.name || 'Бар ' + (idx + 1)}: новое значение`);
        el.onpointerdown = (e) => e.stopPropagation();
        el.onfocus = () => {
          el._editing = true;
          el.select();
        };
        const commit = () => {
          const v = el.value.trim();
          el._editing = false;
          if (v !== '' && v !== String(el._shown)) this.hooks.setBar?.(el._obj, el._bar, v);
          else el.value = el._shown;
        };
        el.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            commit();
            el._skipBlur = true;
            el.blur();
          } else if (e.key === 'Escape') {
            el.value = el._shown;
            el._skipBlur = true;
            el.blur();
          }
        };
        el.onblur = () => {
          if (el._skipBlur) {
            el._skipBlur = false;
            el._editing = false;
            return;
          }
          commit();
        };
        layer.appendChild(el);
        this.bubbleEls.set(key, el);
      }
      el._obj = o.id;
      el._bar = b.id;
      const shown = b.value === undefined || b.value === null ? '' : String(b.value);
      el._shown = shown;
      if (!el._editing && el.value !== shown) el.value = shown;
      el.title = `${b.name || 'Бар ' + (idx + 1)}: ${shown}${b.max !== '' && b.max !== undefined ? ' / ' + b.max : ''} — введите число, +5 или -3`;
      el.style.setProperty('--c', b.color || '#888');
      // справа налево над правым верхним углом токена
      el.style.left = anchor.x - 30 - idx * 40 + 'px';
      el.style.top = anchor.y - 40 - 12 * Math.min(1, z) + 'px';
    });
    for (const [key, el] of this.bubbleEls) {
      if (want.has(key) || el._editing) continue;
      el.remove();
      this.bubbleEls.delete(key);
    }
  }

  /** Шаблон области: подсветка клеток, контур и подпись */
  drawTemplate(g, shape, a, b, color, who, opts = {}) {
    const page = this.page;
    if (!page) return;
    const t = templateGeometry(page, shape, a, b, opts);
    if (!t) return;
    const z = this.cam.z;
    const cs = page.cellSize || 70;
    for (const c of templateCells(page, t)) {
      const p = this.worldToScreen(c.x, c.y);
      svg('rect', { x: p.x, y: p.y, width: cs * z, height: cs * z, class: 'tpl-cell', fill: color }, g);
    }
    if (t.circle) {
      const c = this.worldToScreen(t.circle.cx, t.circle.cy);
      svg('circle', { cx: c.x, cy: c.y, r: t.circle.r * z, class: 'tpl-shape', stroke: color, fill: color }, g);
    } else {
      const sp = [];
      for (let i = 0; i < t.poly.length; i += 2) {
        const p = this.worldToScreen(t.poly[i], t.poly[i + 1]);
        sp.push(`${p.x},${p.y}`);
      }
      svg('polygon', { points: sp.join(' '), class: 'tpl-shape', stroke: color, fill: color }, g);
    }
    const o = this.worldToScreen(a.x, a.y);
    svg('circle', { cx: o.x, cy: o.y, r: 4, fill: color, class: 'ruler-node' }, g);
    const end = this.worldToScreen(b.x, b.y);
    const label = `${t.name} ${t.size}` + (who ? ` · ${who}` : '');
    const bg = svg('rect', { x: end.x + 10, y: end.y - 26, height: 24, rx: 4, class: 'ruler-bg' }, g);
    const tx = svg('text', { x: end.x + 18, y: end.y - 9, class: 'ruler-text' }, g);
    tx.textContent = label;
    bg.setAttribute('width', label.length * 8 + 16);
  }

  /** Оставить шаблон на карте полупрозрачной фигурой */
  keepTemplate(d, e) {
    const page = this.page;
    if (!page || !d.cur) return;
    const t = templateGeometry(page, d.shape, d.start, d.cur, this.templateOpts(e?.altKey));
    if (!t) return;
    const color = this.store.members.get(this.store.me.id)?.color || '#e3bd63';
    const solid = /^#[0-9a-f]{6}$/i.test(color) ? color : '#e3bd63';
    this.createObj({
      ...t.keep,
      name: `${t.name} ${t.size}`,
      showName: false,
      fill: solid + '40',
      stroke: solid,
      strokeWidth: 2,
      layer: this.activeLayer() === 'walls' || this.activeLayer() === 'map' ? 'objects' : this.activeLayer(),
      bars: [],
    });
  }

  drawRuler(g, pts, color, who) {
    const page = this.page;
    if (!page || pts.length < 2) return;
    let total = 0;
    const sp = pts.map((p) => this.worldToScreen(p.x, p.y));
    for (let i = 1; i < pts.length; i++) total += gridDistance(page, pts[i - 1], pts[i]);
    svg('polyline', { points: sp.map((p) => `${p.x},${p.y}`).join(' '), class: 'ruler-line', stroke: color }, g);
    for (const p of sp) svg('circle', { cx: p.x, cy: p.y, r: 4, fill: color, class: 'ruler-node' }, g);
    const last = sp[sp.length - 1];
    const label = formatDistance(page, total) + (who ? ` · ${who}` : '');
    const bg = svg('rect', { x: last.x + 10, y: last.y - 26, height: 24, rx: 4, class: 'ruler-bg' }, g);
    const t = svg('text', { x: last.x + 18, y: last.y - 9, class: 'ruler-text' }, g);
    t.textContent = label;
    bg.setAttribute('width', label.length * 8 + 16);
  }
}

const LIGHT_ICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#ffd76a" fill-opacity=".35" stroke="#b8860b" stroke-width="2"/><path d="M24 40h16M26 46h12M32 12a14 14 0 00-8 25.5c1.4 1.1 2 2.6 2 4.5h12c0-1.9.6-3.4 2-4.5A14 14 0 0032 12z" fill="#fff3b0" stroke="#7a5a00" stroke-width="2.5" stroke-linejoin="round"/></svg>',
  );

export { SHAPES };
