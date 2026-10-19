// Многогранники кубиков и надписи на гранях (без three.js — проверяется тестами).
// Грани находятся сами: выпуклая оболочка по вершинам, вершины грани — против часовой стрелки снаружи.

const PHI = (1 + Math.sqrt(5)) / 2;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const centroid = (pts) => scale(pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]), 1 / pts.length);

/** Грани выпуклого многогранника: [{idx: [номера вершин против часовой снаружи], normal, center}] */
export function hullFaces(V, eps = 1e-6) {
  const faces = [];
  const seen = new Set();
  const c0 = centroid(V);
  for (let i = 0; i < V.length; i++)
    for (let j = i + 1; j < V.length; j++)
      for (let k = j + 1; k < V.length; k++) {
        let n = cross(sub(V[j], V[i]), sub(V[k], V[i]));
        if (len(n) < 1e-9) continue;
        n = norm(n);
        if (dot(n, sub(V[i], c0)) < 0) n = scale(n, -1);
        const d = dot(n, V[i]);
        const on = [];
        let ok = true;
        for (let m = 0; m < V.length; m++) {
          const s = dot(n, V[m]) - d;
          if (s > eps) {
            ok = false;
            break;
          }
          if (Math.abs(s) <= eps) on.push(m);
        }
        if (!ok) continue;
        const key = on.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const fc = centroid(on.map((m) => V[m]));
        const u = norm(sub(V[on[0]], fc));
        const w = cross(n, u);
        on.sort((a, b) => {
          const pa = sub(V[a], fc);
          const pb = sub(V[b], fc);
          return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u));
        });
        faces.push({ idx: on, normal: n, center: fc });
      }
  return faces;
}

/** Описанный радиус кубика каждого вида (в единицах сцены): примерно одинаковые на вид */
const RADIUS = { d4: 1.0, d6: 0.86, d8: 0.92, d10: 0.9, d12: 0.92, d20: 1.0 };

function rawVertices(kind) {
  switch (kind) {
    case 'd4':
      return [
        [1, 1, 1],
        [1, -1, -1],
        [-1, 1, -1],
        [-1, -1, 1],
      ];
    case 'd6': {
      const v = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
      return v;
    }
    case 'd8':
      return [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
    case 'd10': {
      // пятиугольный трапецоэдр: вершины пояса на высоте ±a, полюса на высоте h — грани-«воздушные змеи» плоские
      const a = 0.105;
      const c = Math.cos(Math.PI / 5);
      const h = (a * (1 + c)) / (1 - c);
      const v = [];
      for (let i = 0; i < 10; i++) {
        const b = (i * Math.PI) / 5;
        v.push([Math.cos(b), i % 2 ? a : -a, Math.sin(b)]);
      }
      v.push([0, h, 0], [0, -h, 0]);
      return v;
    }
    case 'd12': {
      const v = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
      const p = PHI;
      const q = 1 / PHI;
      for (const s of [-1, 1])
        for (const t of [-1, 1]) {
          v.push([0, s * q, t * p]);
          v.push([s * q, t * p, 0]);
          v.push([s * p, 0, t * q]);
        }
      return v;
    }
    case 'd20': {
      const v = [];
      for (const s of [-1, 1])
        for (const t of [-1, 1]) {
          v.push([0, s, t * PHI]);
          v.push([s, t * PHI, 0]);
          v.push([s * PHI, 0, t]);
        }
      return v;
    }
  }
  throw new Error('неизвестный кубик ' + kind);
}

const shapeCache = new Map();
/** Форма кубика: {kind, verts, faces} в единицах сцены */
export function diceShape(kind) {
  if (shapeCache.has(kind)) return shapeCache.get(kind);
  const raw = rawVertices(kind);
  const r = Math.max(...raw.map(len));
  const verts = raw.map((p) => scale(p, RADIUS[kind] / r));
  const faces = hullFaces(verts);
  // направление «верх» надписи: к самой дальней вершине грани (у d10 — к полюсу)
  for (const f of faces) {
    let best = f.idx[0];
    let bd = -1;
    for (const i of f.idx) {
      const d = len(sub(verts[i], f.center));
      if (d > bd + 1e-6) {
        bd = d;
        best = i;
      }
    }
    f.up = best;
  }
  const shape = { kind, verts, faces };
  shapeCache.set(kind, shape);
  return shape;
}

const FACES = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };

/**
 * Какой кубик показать для броска и какие надписи на гранях.
 * die: {sides: число | 'F', v: результат}. Возвращает [{kind, labels, want, sides}] — для d100 два кубика.
 * labels — надписи граней по порядку (для d4 — числа вершин), want — что должно оказаться сверху.
 */
export function diceSpecs(die) {
  const { sides, v } = die;
  if (sides === 'F') {
    const want = v > 0 ? '+' : v < 0 ? '−' : ' ';
    return [{ kind: 'd6', sides: 'F', labels: ['+', '+', '−', '−', ' ', ' '], want }];
  }
  const n = Number(sides);
  if (n === 100) {
    const t = Math.floor((v % 100) / 10) * 10;
    return [
      { kind: 'd10', sides: 100, labels: Array.from({ length: 10 }, (_, i) => String(i * 10).padStart(2, '0')), want: String(t).padStart(2, '0') },
      { kind: 'd10', sides: 10, labels: Array.from({ length: 10 }, (_, i) => String(i)), want: String(v % 10) },
    ];
  }
  if (n === 2 || n === 3) return [{ kind: 'd6', sides: n, labels: Array.from({ length: 6 }, (_, i) => String((i % n) + 1)), want: String(v) }];
  const kind = n <= 4 ? 'd4' : n <= 6 ? 'd6' : n <= 8 ? 'd8' : n <= 10 ? 'd10' : n <= 12 ? 'd12' : 'd20';
  const count = FACES[kind];
  let labels;
  if (n === count) labels = Array.from({ length: count }, (_, i) => String(i + 1));
  else {
    // необычный кубик (d5, d30…): ближайшая форма, на гранях — разные числа из его диапазона
    const pool = Array.from({ length: n }, (_, i) => i + 1).filter((x) => x !== v);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    labels = [String(v), ...pool.slice(0, count - 1).map(String)];
    while (labels.length < count) labels.push(String(v));
  }
  return [{ kind, sides: n, labels, want: String(v) }];
}

/**
 * Перенести надпись want на грань t (поменять местами с гранью, где она была).
 * Для d4 labels — числа вершин, t — верхняя вершина.
 */
export function relabel(labels, t, want) {
  const out = [...labels];
  if (out[t] === want) return out;
  const j = out.indexOf(want);
  if (j >= 0) [out[t], out[j]] = [out[j], out[t]];
  else out[t] = want;
  return out;
}

/** Повернуть вектор кватернионом [x, y, z, w] */
export function rotate(q, v) {
  const [qx, qy, qz, qw] = q;
  const ix = qw * v[0] + qy * v[2] - qz * v[1];
  const iy = qw * v[1] + qz * v[0] - qx * v[2];
  const iz = qw * v[2] + qx * v[1] - qy * v[0];
  const iw = -qx * v[0] - qy * v[1] - qz * v[2];
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

/**
 * Что сверху у лежащего кубика с поворотом q: {index, flat}.
 * Для d4 — верхняя вершина; flat — насколько ровно лежит (1 — идеально, меньше 0.9 — стоит на ребре).
 */
export function topOf(shape, q) {
  if (shape.kind === 'd4') {
    let top = 0;
    let ty = -Infinity;
    shape.verts.forEach((p, i) => {
      const y = rotate(q, p)[1];
      if (y > ty) {
        ty = y;
        top = i;
      }
    });
    let low = 1;
    for (const f of shape.faces) low = Math.min(low, rotate(q, f.normal)[1]);
    return { index: top, flat: -low };
  }
  let index = 0;
  let best = -Infinity;
  shape.faces.forEach((f, i) => {
    const y = rotate(q, f.normal)[1];
    if (y > best) {
      best = y;
      index = i;
    }
  });
  return { index, flat: best };
}
