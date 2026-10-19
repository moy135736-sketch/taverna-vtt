// Объёмные кубики поверх доски: three.js рисует, cannon-es катает.
// Бросок сначала просчитывается целиком, потом проигрывается; на грань, которая легла вверх,
// переносится надпись с результатом сервера — выпадает ровно то, что в чате.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { diceShape, diceSpecs, relabel, topOf } from './geometry.js';
import { skinLook, rgbOf, mix, toHex } from './skins.js';
import { paintSurface, paintGlow, hash } from './patterns.js';

const FPS = 60;
const PPU = 50; // пикселей на единицу сцены: кубик около 80 px на экране
const MAX_DICE = 12;
const MAX_STEPS = FPS * 7;
const HOLD_MS = 2600; // сколько кубики лежат после остановки
const FADE_MS = 450;
const TEX = 128; // текстура грани; у наборов с узором — вдвое больше
// цифры на гранях — рубленым шрифтом с цифрами одной высоты (у Alegreya цифры «старого стиля»)
const FONT = '"Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif';

/**
 * Перо для надписей грани. На узорных гранях цифры обведены цветом тела (чтобы читались поверх узора),
 * на металле — выгравированы (светлый край снизу). glowPass — рисуем в карту свечения.
 */
function inkPen(ctx, look, S, glowPass) {
  const halo = !glowPass && !!look.pattern && !look.glowInk;
  const engraved = !glowPass && look.metal >= 0.5;
  ctx.fillStyle = look.ink;
  ctx.strokeStyle = look.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const deco = (fn) => {
    if (halo) {
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = look.body;
      ctx.lineJoin = 'round';
      fn(true);
      ctx.restore();
    }
    ctx.save();
    if (engraved) {
      ctx.shadowColor = 'rgba(255,255,255,.55)';
      ctx.shadowOffsetY = S * 0.012;
    }
    fn(false);
    ctx.restore();
  };
  return {
    text(str, x, y) {
      deco((outline) => {
        if (outline) {
          ctx.lineWidth = S * 0.035;
          ctx.strokeText(str, x, y);
        } else ctx.fillText(str, x, y);
      });
    },
    line(x1, y1, x2, y2, w) {
      deco((outline) => {
        ctx.lineWidth = outline ? w + S * 0.035 : w;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      });
    },
  };
}

// ---------- геометрия для three ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Геометрия с группой на каждую грань и развёрткой: грань вписана в круг текстуры, «верх» надписи — к дальней вершине */
function buildGeometry(shape) {
  const pos = [];
  const nrm = [];
  const uvs = [];
  const geo = new THREE.BufferGeometry();
  const faceUv = [];
  let start = 0;
  shape.faces.forEach((f, fi) => {
    const P = f.idx.map((i) => shape.verts[i]);
    const up = unit(sub(shape.verts[f.up], f.center));
    const right = cross(up, f.normal);
    const R = Math.max(...P.map((p) => Math.hypot(...sub(p, f.center))));
    const uv = P.map((p) => {
      const d = sub(p, f.center);
      return [0.5 + dot(d, right) / (2 * R), 0.5 + dot(d, up) / (2 * R)];
    });
    faceUv.push(uv);
    for (let i = 1; i < P.length - 1; i++)
      for (const k of [0, i, i + 1]) {
        pos.push(...P[k]);
        nrm.push(...f.normal);
        uvs.push(...uv[k]);
      }
    const count = (P.length - 2) * 3;
    geo.addGroup(start, count, fi);
    start += count;
  });
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeBoundingSphere();
  return { geo, faceUv, edges: new THREE.EdgesGeometry(geo, 1) };
}

// размер надписи относительно грани
const LABEL_SIZE = { d6: 0.5, d8: 0.34, d10: 0.32, d12: 0.36, d20: 0.3 };

export class DiceTray {
  constructor(container) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dice3d idle';
    this.canvas.setAttribute('aria-hidden', 'true');
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = r;
    this.aniso = Math.min(8, r.capabilities.getMaxAnisotropy());
    // браузер рисует без видеокарты (программный WebGL) — объёмные кубики будут тормозить всю страницу
    try {
      const gl = r.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch {
      this.gpu = '';
    }
    this.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(this.gpu);
    this.slow = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(26, 1, 1, 400);
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x2c241d, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(-7, 22, -9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0008;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.ShadowMaterial({ opacity: 0.38 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.geos = new Map();
    this.mats = new Map();
    this.cshapes = new Map();
    this.group = null;
    this.timers = [];
    this.lost = false;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize() && this.anim?.settled && this.render()) : null;
    this.attach(container);
  }

  attach(container) {
    if (this.container !== container) {
      this.ro?.disconnect();
      container.appendChild(this.canvas);
      this.container = container;
      this.ro?.observe(container);
    }
    return this.resize();
  }

  resize() {
    const el = this.container;
    const w = el?.clientWidth || 0;
    const h = el?.clientHeight || 0;
    if (w < 80 || h < 80) return false;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.hw = w / 2 / PPU;
    this.hh = h / 2 / PPU;
    const cam = this.camera;
    cam.aspect = w / h;
    cam.position.set(0, this.hh / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)), 0);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    const sc = this.sun.shadow.camera;
    sc.left = -this.hw - 3;
    sc.right = this.hw + 3;
    sc.top = this.hh + 3;
    sc.bottom = -this.hh - 3;
    sc.updateProjectionMatrix();
    return true;
  }

  geometry(kind) {
    if (!this.geos.has(kind)) this.geos.set(kind, buildGeometry(diceShape(kind)));
    return this.geos.get(kind);
  }

  cannonShape(kind) {
    if (!this.cshapes.has(kind)) {
      const s = diceShape(kind);
      this.cshapes.set(kind, new CANNON.ConvexPolyhedron({ vertices: s.verts.map((v) => new CANNON.Vec3(...v)), faces: s.faces.map((f) => f.idx) }));
    }
    return this.cshapes.get(kind);
  }

  texture(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.aniso;
    return tex;
  }

  /**
   * Отражения для металла и камней (создаётся один раз). Камера смотрит сверху, поэтому прямо над кубиками —
   * приглушённый тёплый «потолок» (верхняя грань не выгорает в белое), а яркие окна — по сторонам, низко:
   * их ловят наклонные грани и рёбра.
   */
  envMap() {
    if (!this.env) {
      const scene = new THREE.Scene();
      const geo = new THREE.SphereGeometry(30, 32, 16);
      const col = [];
      const pos = geo.attributes.position;
      const zen = new THREE.Color('#b4a894');
      const hor = new THREE.Color('#9c9080');
      const nad = new THREE.Color('#5a5249');
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) / 30;
        const c = y >= 0 ? hor.clone().lerp(zen, Math.pow(y, 0.8)) : hor.clone().lerp(nad, Math.min(1, -y * 2));
        col.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));
      const panel = (w, h, x, y, z, k) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k * 0.95, k * 0.88), side: THREE.DoubleSide }));
        m.position.set(x, y, z);
        m.lookAt(0, 0, 0);
        scene.add(m);
      };
      panel(14, 6, 22, 9, -6, 5); // окно справа
      panel(10, 5, -18, 11, 14, 3.2); // слева сзади
      panel(16, 4, -4, 7, -24, 2.4); // длинная полоса спереди
      panel(8, 8, 4, 26, 6, 1.6); // мягкий свет сверху, чуть в стороне
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.env = pm.fromScene(scene, 0.03).texture;
      scene.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      pm.dispose();
    }
    return this.env;
  }

  /** Материал грани с надписью (кэшируется): узор набора, надпись, свечение, металл или стекло */
  material(key, draw, look) {
    const k = key + '|' + look.key;
    let m = this.mats.get(k);
    if (m) return m;
    const S = look.pattern || look.glow ? TEX * 2 : TEX;
    const seed = hash(k);
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    paintSurface(ctx, look, S, seed);
    draw(ctx, S, inkPen(ctx, look, S, false));
    const params = { map: this.texture(c), roughness: look.rough, metalness: look.metal, flatShading: true };
    if (look.glow) {
      const g = document.createElement('canvas');
      g.width = g.height = S;
      const gctx = g.getContext('2d');
      paintGlow(gctx, look, S, seed);
      if (look.glowInk) draw(gctx, S, inkPen(gctx, look, S, true));
      params.emissive = new THREE.Color(0xffffff);
      params.emissiveMap = this.texture(g);
      params.emissiveIntensity = 1.3;
    }
    const glass = look.opacity < 1;
    const polished = look.rough <= 0.25 && look.metal < 0.5;
    if (glass || polished || look.metal >= 0.3) {
      params.envMap = this.envMap();
      params.envMapIntensity = look.metal >= 0.5 ? 1 : glass ? 0.8 : 0.6;
    }
    if (glass) params.transparent = true;
    m = glass || polished ? new THREE.MeshPhysicalMaterial({ ...params, clearcoat: 1, clearcoatRoughness: 0.07 }) : new THREE.MeshStandardMaterial(params);
    this.mats.set(k, m);
    return m;
  }

  /** Внутренние грани прозрачного кубика (камень, лёд): видны сквозь лицевые */
  innerMat(look) {
    const k = 'inner|' + look.key;
    if (!this.mats.has(k)) {
      const body = rgbOf(look.body);
      const color = look.id === 'ice' ? mix(body, [255, 255, 255], 0.25) : mix(body, [0, 0, 0], 0.4);
      this.mats.set(k, new THREE.MeshStandardMaterial({ color: toHex(color), side: THREE.BackSide, roughness: 0.12, metalness: 0, flatShading: true, envMap: this.envMap(), envMapIntensity: 0.6 }));
    }
    return this.mats.get(k);
  }

  /** Надпись в центре грани; 6 и 9 подчёркнуты */
  labelMat(kind, text, look) {
    return this.material(
      `${kind}:${text}`,
      (ctx, S, pen) => {
        let size = S * (LABEL_SIZE[kind] || 0.3);
        if (text.length >= 2) size *= kind === 'd6' ? 0.78 : 0.86;
        if (text === '+' || text === '−') size *= 1.5;
        ctx.font = `700 ${Math.round(size)}px ${FONT}`;
        const y = S / 2 + size * 0.06;
        pen.text(text, S / 2, y);
        if (text === '6' || text === '9') {
          const w = size * 0.42;
          pen.line(S / 2 - w / 2, y + size * 0.46, S / 2 + w / 2, y + size * 0.46, Math.max(2, size * 0.07));
        }
      },
      look,
    );
  }

  /** Грань d4: у каждой вершины — её число, верхом к вершине */
  d4Mat(fi, nums, uv, look) {
    return this.material(
      `d4:${fi}:${nums.join(',')}`,
      (ctx, S, pen) => {
        const size = S * 0.21;
        ctx.font = `700 ${Math.round(size)}px ${FONT}`;
        nums.forEach((n, k) => {
          const dx = (uv[k][0] - 0.5) * S;
          const dy = -(uv[k][1] - 0.5) * S;
          ctx.save();
          ctx.translate(S / 2 + dx * 0.56, S / 2 + dy * 0.56);
          ctx.rotate(Math.atan2(dx, -dy));
          pen.text(String(n), 0, 0);
          ctx.restore();
        });
      },
      look,
    );
  }

  makeMesh(it, labels, look) {
    const { geo, faceUv, edges } = this.geometry(it.spec.kind);
    const shape = it.shape;
    const mats = shape.faces.map((f, fi) => (it.spec.kind === 'd4' ? this.d4Mat(fi, f.idx.map((vi) => labels[vi]), faceUv[fi], look) : this.labelMat(it.spec.kind, labels[fi], look)));
    const mesh = new THREE.Mesh(geo, mats);
    mesh.castShadow = true;
    if (look.opacity < 1) mesh.add(new THREE.Mesh(geo, this.innerMat(look)));
    mesh.add(new THREE.LineSegments(edges, this.edgeMat(look)));
    return mesh;
  }

  edgeMat(look) {
    const k = 'edge|' + look.key;
    if (!this.mats.has(k)) this.mats.set(k, new THREE.LineBasicMaterial({ color: look.edge, transparent: true, opacity: look.glow ? 0.95 : look.metal >= 0.5 ? 0.35 : 0.5 }));
    return this.mats.get(k);
  }

  // ---------- физика ----------
  simulate(items) {
    const n = items.length;
    let res = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -42, 0), allowSleep: true });
      world.solver.iterations = 12;
      const floorM = new CANNON.Material('floor');
      const wallM = new CANNON.Material('wall');
      const diceM = new CANNON.Material('dice');
      world.addContactMaterial(new CANNON.ContactMaterial(floorM, diceM, { friction: 0.3, restitution: 0.3 }));
      world.addContactMaterial(new CANNON.ContactMaterial(wallM, diceM, { friction: 0.05, restitution: 0.55 }));
      world.addContactMaterial(new CANNON.ContactMaterial(diceM, diceM, { friction: 0.1, restitution: 0.35 }));
      const plane = (m, pos, euler) => {
        const b = new CANNON.Body({ mass: 0, material: m, shape: new CANNON.Plane() });
        b.position.set(...pos);
        b.quaternion.setFromEuler(...euler);
        world.addBody(b);
      };
      const W = this.hw - 0.3;
      const H = this.hh - 0.3;
      plane(floorM, [0, 0, 0], [-Math.PI / 2, 0, 0]);
      plane(wallM, [-W, 0, 0], [0, Math.PI / 2, 0]);
      plane(wallM, [W, 0, 0], [0, -Math.PI / 2, 0]);
      plane(wallM, [0, 0, -H], [0, 0, 0]);
      plane(wallM, [0, 0, H], [0, Math.PI, 0]);

      // бросок из-за правого края, в сторону середины доски
      const rnd = (a, b) => a + Math.random() * (b - a);
      const z0 = rnd(-H * 0.35, H * 0.35);
      const bodies = items.map((it, i) => {
        const b = new CANNON.Body({ mass: 1, material: diceM, shape: this.cannonShape(it.spec.kind) });
        b.linearDamping = 0.08;
        b.angularDamping = 0.1;
        b.sleepSpeedLimit = 0.15;
        b.sleepTimeLimit = 0.2;
        const col = i % 4;
        const row = Math.floor(i / 4);
        b.position.set(W - 1.2 - row * 2 - Math.random() * 0.3, rnd(2.2, 3.4) + row * 0.5, Math.max(-H + 1, Math.min(H - 1, z0 + (col - 1.5) * 2)));
        b.quaternion.setFromEuler(rnd(0, Math.PI * 2), rnd(0, Math.PI * 2), rnd(0, Math.PI * 2));
        const speed = Math.min(26, rnd(13, 19) + this.hw * 0.25);
        b.velocity.set(-speed, rnd(0, 3), rnd(-4, 4) - z0 * 0.4);
        b.angularVelocity.set(rnd(-22, 22), rnd(-14, 14), rnd(-22, 22));
        world.addBody(b);
        return b;
      });

      const frames = [];
      let still = 0;
      for (let step = 0; step < MAX_STEPS; step++) {
        world.step(1 / FPS);
        const f = new Float32Array(n * 7);
        bodies.forEach((b, i) => {
          f.set([b.position.x, b.position.y, b.position.z, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w], i * 7);
        });
        frames.push(f);
        const moving = bodies.some((b) => b.sleepState !== CANNON.Body.SLEEPING && (b.velocity.lengthSquared() > 0.02 || b.angularVelocity.lengthSquared() > 0.05));
        still = moving ? 0 : still + 1;
        if (still > 10 && step > 40) break;
      }
      const final = bodies.map((b) => [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]);
      res = { frames, final, tries: attempt + 1 };
      // кубик на ребре или прислонился к другому — бросаем заново
      if (items.every((it, i) => topOf(it.shape, final[i]).flat > 0.94)) break;
    }
    return res;
  }

  // ---------- бросок ----------
  /**
   * dice: [{sides, v, dropped}] — как в сообщении чата; color — цвет игрока; skin — его набор кубиков;
   * onSettle(info) — кубики остановились (info.results[i].screen — где лежит кубик на экране)
   */
  roll(dice, color, skin = 'player', { onSettle } = {}) {
    if (this.lost) throw new Error('WebGL потерян');
    this.clear();
    if (!this.resize()) return null;
    const items = [];
    for (const d of dice)
      for (const spec of diceSpecs(d)) if (items.length < MAX_DICE) items.push({ spec, shape: diceShape(spec.kind), dropped: !!d.dropped });
    if (!items.length) return null;
    const t0 = performance.now();
    const sim = this.simulate(items);
    const simMs = Math.round(performance.now() - t0);
    const group = new THREE.Group();
    const used = new Set();
    items.forEach((it, i) => {
      const top = topOf(it.shape, sim.final[i]);
      it.labels = relabel(it.spec.labels, top.index, it.spec.want);
      it.shown = it.labels[top.index];
      const look = skinLook(skin, color, it.dropped);
      used.add(look.key);
      it.mesh = this.makeMesh(it, it.labels, look);
      group.add(it.mesh);
    });
    this.evictLooks(used);
    this.scene.add(group);
    this.group = group;
    const anim = { items, frames: sim.frames, start: performance.now(), settled: false };
    this.anim = anim;
    const info = {
      done: false,
      skin,
      simMs,
      tries: sim.tries,
      frames: sim.frames.length,
      results: items.map((it) => ({ kind: it.spec.kind, sides: it.spec.sides, want: it.spec.want, shown: it.shown, dropped: it.dropped })),
    };
    window.__dice3d = { rolls: (window.__dice3d?.rolls || 0) + 1, last: info };
    this.canvas.classList.remove('idle', 'fade');

    let frames = 0;
    let lastT = performance.now();
    let spent = 0;
    const tick = () => {
      if (this.anim !== anim) return;
      const now = performance.now();
      // кадры идут реже 20 в секунду — компьютер не тянет, дальше будут плоские кубики
      if (++frames > 1) spent += now - lastT;
      lastT = now;
      if (frames === 40 && spent / 39 > 50) this.slow = true;
      const t = (now - anim.start) / 1000;
      const fi = Math.min(anim.frames.length - 1, Math.floor(t * FPS));
      const f = anim.frames[fi];
      anim.items.forEach((it, i) => {
        it.mesh.position.set(f[i * 7], f[i * 7 + 1], f[i * 7 + 2]);
        it.mesh.quaternion.set(f[i * 7 + 3], f[i * 7 + 4], f[i * 7 + 5], f[i * 7 + 6]);
      });
      this.render();
      if (fi < anim.frames.length - 1) {
        this.raf = requestAnimationFrame(tick);
        return;
      }
      // остановились: держим результат, потом тают
      anim.settled = true;
      const box = this.canvas.getBoundingClientRect();
      anim.items.forEach((it, i) => {
        const v = it.mesh.position.clone().project(this.camera);
        info.results[i].screen = [Math.round(box.left + ((v.x + 1) / 2) * box.width), Math.round(box.top + ((1 - v.y) / 2) * box.height)];
      });
      info.done = true;
      try {
        onSettle?.(info);
      } catch (e) {
        console.warn('[кубики]', e);
      }
      this.timers.push(
        setTimeout(() => {
          if (this.anim !== anim) return;
          this.canvas.classList.add('fade');
          this.timers.push(setTimeout(() => this.anim === anim && this.clear(), FADE_MS + 50));
        }, HOLD_MS),
      );
    };
    this.raf = requestAnimationFrame(tick);
    return info;
  }

  /**
   * Текстуры граней копятся по наборам (у узорных — крупные). Держим наборы последних бросков,
   * остальные выгружаем из видеопамяти.
   */
  evictLooks(used, keep = 6) {
    this.lookUse = this.lookUse || new Map();
    const t = performance.now();
    for (const k of used) this.lookUse.set(k, t);
    if (this.lookUse.size <= keep) return;
    const old = [...this.lookUse.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.lookUse.size - keep);
    for (const [lk] of old) {
      if (used.has(lk)) continue;
      this.lookUse.delete(lk);
      for (const [mk, m] of this.mats) {
        if (!mk.endsWith('|' + lk)) continue;
        m.map?.dispose();
        m.emissiveMap?.dispose();
        m.dispose();
        this.mats.delete(mk);
      }
    }
  }

  render() {
    if (!this.lost) this.renderer.render(this.scene, this.camera);
  }

  clear() {
    cancelAnimationFrame(this.raf);
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.anim = null;
    if (this.group) {
      this.scene.remove(this.group);
      this.group = null;
    }
    this.canvas.classList.add('idle');
    this.canvas.classList.remove('fade');
    this.render();
  }

  dispose() {
    this.clear();
    this.ro?.disconnect();
    for (const m of this.mats.values()) {
      m.map?.dispose();
      m.emissiveMap?.dispose();
      m.dispose();
    }
    this.env?.dispose();
    this.env = null;
    for (const g of this.geos.values()) {
      g.geo.dispose();
      g.edges.dispose();
    }
    this.mats.clear();
    this.geos.clear();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
