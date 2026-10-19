// Шаблоны областей действия (AoE) для линейки: круг, конус, куб, луч.
// Используются при измерении и могут оставаться на карте как обычные фигуры.
import { pointInPoly, distToSegment } from './geometry.js';

export const TEMPLATE_SHAPES = {
  line: 'Линейка',
  circle: 'Круг',
  cone: 'Конус',
  square: 'Куб',
  beam: 'Луч',
};

export const isTemplate = (shape) => !!shape && shape !== 'line' && !!TEMPLATE_SHAPES[shape];

/**
 * Геометрия шаблона в мировых координатах.
 * a — точка начала (центр круга, вершина конуса, угол куба, начало луча), b — курсор.
 * opts: { angle — угол конуса в градусах, width — ширина луча в единицах сцены, snap — округлять длину до клетки }
 */
export function templateGeometry(page, shape, a, b, opts = {}) {
  const cs = page.cellSize || 70;
  const scale = page.scale || 5;
  const pxPerUnit = cs / scale;
  const dx = b.x - a.x,
    dy = b.y - a.y;
  let L = Math.hypot(dx, dy);
  const roundLen = (px) => (opts.snap ? Math.max(1, Math.round(px / cs)) * cs : px);
  const theta = Math.atan2(dy, dx);
  const dir = (t) => ({ x: Math.cos(t), y: Math.sin(t) });
  const units = (px) => Math.round((px / pxPerUnit) * 10) / 10;
  if (L < 2) return null;

  if (shape === 'circle') {
    L = roundLen(L);
    return {
      shape,
      name: 'Круг',
      size: `радиус ${units(L)} ${page.units || ''}`.trim(),
      circle: { cx: a.x, cy: a.y, r: L },
      bbox: { x: a.x - L, y: a.y - L, w: 2 * L, h: 2 * L },
      contains: (x, y) => Math.hypot(x - a.x, y - a.y) <= L + 0.5,
      keep: { type: 'shape', shape: 'ellipse', x: a.x - L, y: a.y - L, w: 2 * L, h: 2 * L, rot: 0 },
    };
  }
  if (shape === 'cone') {
    L = roundLen(L);
    const angle = Math.max(10, Math.min(170, Number(opts.angle) || 53.13));
    const half = (angle * Math.PI) / 360;
    const H = 2 * L * Math.tan(half);
    const end = { x: a.x + L * Math.cos(theta), y: a.y + L * Math.sin(theta) };
    const n = dir(theta + Math.PI / 2);
    const p1 = { x: end.x + (n.x * H) / 2, y: end.y + (n.y * H) / 2 };
    const p2 = { x: end.x - (n.x * H) / 2, y: end.y - (n.y * H) / 2 };
    const pts = [a.x, a.y, p1.x, p1.y, p2.x, p2.y];
    const c = { x: a.x + (L / 2) * Math.cos(theta), y: a.y + (L / 2) * Math.sin(theta) };
    return {
      shape,
      name: 'Конус',
      size: `${units(L)} ${page.units || ''}`.trim(),
      poly: pts,
      bbox: bboxOf(pts),
      contains: (x, y) => pointInPoly(x, y, pts),
      keep: { type: 'shape', shape: 'cone', x: c.x - L / 2, y: c.y - H / 2, w: L, h: H, rot: (theta * 180) / Math.PI },
    };
  }
  if (shape === 'square') {
    let s = Math.max(Math.abs(dx), Math.abs(dy));
    s = roundLen(s);
    const x0 = dx >= 0 ? a.x : a.x - s;
    const y0 = dy >= 0 ? a.y : a.y - s;
    const pts = [x0, y0, x0 + s, y0, x0 + s, y0 + s, x0, y0 + s];
    return {
      shape,
      name: 'Куб',
      size: `${units(s)} ${page.units || ''}`.trim(),
      poly: pts,
      bbox: { x: x0, y: y0, w: s, h: s },
      contains: (x, y) => x >= x0 - 0.5 && x <= x0 + s + 0.5 && y >= y0 - 0.5 && y <= y0 + s + 0.5,
      keep: { type: 'shape', shape: 'rect', x: x0, y: y0, w: s, h: s, rot: 0 },
    };
  }
  if (shape === 'beam') {
    L = roundLen(L);
    const w = Math.max(2, (Number(opts.width) || scale) * pxPerUnit);
    const end = { x: a.x + L * Math.cos(theta), y: a.y + L * Math.sin(theta) };
    const n = dir(theta + Math.PI / 2);
    const hw = w / 2;
    const pts = [a.x + n.x * hw, a.y + n.y * hw, end.x + n.x * hw, end.y + n.y * hw, end.x - n.x * hw, end.y - n.y * hw, a.x - n.x * hw, a.y - n.y * hw];
    const mid = { x: (a.x + end.x) / 2, y: (a.y + end.y) / 2 };
    return {
      shape,
      name: 'Луч',
      size: `${units(L)} × ${units(w)} ${page.units || ''}`.trim(),
      poly: pts,
      bbox: bboxOf(pts),
      contains: (x, y) => {
        const t = ((x - a.x) * Math.cos(theta) + (y - a.y) * Math.sin(theta)) / L;
        return t >= 0 && t <= 1 && distToSegment(x, y, a.x, a.y, end.x, end.y) <= hw + 0.5;
      },
      keep: { type: 'shape', shape: 'rect', x: mid.x - L / 2, y: mid.y - hw, w: L, h: w, rot: (theta * 180) / Math.PI },
    };
  }
  return null;
}

/** Клетки квадратной сетки, центры которых попадают в шаблон */
export function templateCells(page, t, limit = 3000) {
  if (!t || (page.gridType && page.gridType !== 'square')) return [];
  const cs = page.cellSize || 70;
  const b = t.bbox;
  const out = [];
  const i0 = Math.floor(b.x / cs),
    i1 = Math.ceil((b.x + b.w) / cs),
    j0 = Math.floor(b.y / cs),
    j1 = Math.ceil((b.y + b.h) / cs);
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      if (t.contains((i + 0.5) * cs, (j + 0.5) * cs)) {
        out.push({ x: i * cs, y: j * cs });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function bboxOf(pts) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
