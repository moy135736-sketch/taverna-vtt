// Геометрия: сетка, привязка, расстояния, пересечения

export const SQRT3 = Math.sqrt(3);

/** Привязать точку к сетке. mode: 'corner' — к узлам, 'center' — к центрам клеток */
export function snapPoint(page, x, y, mode = 'corner') {
  const cs = page.cellSize || 70;
  if (page.gridType === 'hex' || page.gridType === 'hexr') {
    const c = hexCenter(page, x, y);
    return c;
  }
  if (mode === 'center') return { x: Math.floor(x / cs) * cs + cs / 2, y: Math.floor(y / cs) * cs + cs / 2 };
  if (mode === 'half') return { x: Math.round(x / (cs / 2)) * (cs / 2), y: Math.round(y / (cs / 2)) * (cs / 2) };
  return { x: Math.round(x / cs) * cs, y: Math.round(y / cs) * cs };
}

/** Привязать прямоугольник объекта (x,y,w,h) — для токенов */
export function snapRect(page, o, x, y) {
  const cs = page.cellSize || 70;
  if (page.gridType === 'hex' || page.gridType === 'hexr') {
    const c = hexCenter(page, x + o.w / 2, y + o.h / 2);
    return { x: c.x - o.w / 2, y: c.y - o.h / 2 };
  }
  const cellsW = o.w / cs;
  const cellsH = o.h / cs;
  // токены целых размеров привязываем к углам клеток, дробные — центром
  const sx = Math.abs(cellsW - Math.round(cellsW)) < 0.01 && cellsW >= 1 ? Math.round(x / cs) * cs : Math.round((x + o.w / 2 - cs / 2) / cs) * cs + cs / 2 - o.w / 2;
  const sy = Math.abs(cellsH - Math.round(cellsH)) < 0.01 && cellsH >= 1 ? Math.round(y / cs) * cs : Math.round((y + o.h / 2 - cs / 2) / cs) * cs + cs / 2 - o.h / 2;
  return { x: sx, y: sy };
}

// Гексы: hex — «остроконечные» сверху (столбцы смещены), hexr — плоские сверху
export function hexDims(page) {
  const cs = page.cellSize || 70;
  if (page.gridType === 'hexr') {
    // плоский верх: ширина = 2r, высота = sqrt3*r; cs — расстояние между центрами по горизонтали ≈ 1.5r
    const r = cs / SQRT3;
    return { r, w: 2 * r, h: SQRT3 * r, colStep: 1.5 * r, rowStep: SQRT3 * r, flat: true };
  }
  const r = cs / SQRT3;
  return { r, w: SQRT3 * r, h: 2 * r, colStep: SQRT3 * r, rowStep: 1.5 * r, flat: false };
}

export function hexCenter(page, x, y) {
  const d = hexDims(page);
  let best = null;
  if (d.flat) {
    const col = Math.round(x / d.colStep);
    for (let c = col - 1; c <= col + 1; c++) {
      const offY = c & 1 ? d.rowStep / 2 : 0;
      const row = Math.round((y - offY) / d.rowStep);
      for (let r = row - 1; r <= row + 1; r++) {
        const cx = c * d.colStep,
          cy = r * d.rowStep + offY;
        const dist = (cx - x) ** 2 + (cy - y) ** 2;
        if (!best || dist < best.d) best = { x: cx, y: cy, d: dist, col: c, row: r };
      }
    }
  } else {
    const row = Math.round(y / d.rowStep);
    for (let r = row - 1; r <= row + 1; r++) {
      const offX = r & 1 ? d.colStep / 2 : 0;
      const col = Math.round((x - offX) / d.colStep);
      for (let c = col - 1; c <= col + 1; c++) {
        const cx = c * d.colStep + offX,
          cy = r * d.rowStep;
        const dist = (cx - x) ** 2 + (cy - y) ** 2;
        if (!best || dist < best.d) best = { x: cx, y: cy, d: dist, col: c, row: r };
      }
    }
  }
  return best;
}

function offsetToCube(col, row, flat) {
  if (flat) {
    const x = col;
    const z = row - (col - (col & 1)) / 2;
    return { x, y: -x - z, z };
  }
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  return { x, y: -x - z, z };
}

/** Расстояние между точками в клетках с учётом правила диагоналей */
export function gridDistance(page, a, b) {
  const cs = page.cellSize || 70;
  if (page.gridType === 'hex' || page.gridType === 'hexr') {
    const ha = hexCenter(page, a.x, a.y);
    const hb = hexCenter(page, b.x, b.y);
    const flat = page.gridType === 'hexr';
    const ca = offsetToCube(ha.col, ha.row, flat);
    const cb = offsetToCube(hb.col, hb.row, flat);
    return Math.max(Math.abs(ca.x - cb.x), Math.abs(ca.y - cb.y), Math.abs(ca.z - cb.z));
  }
  const dx = Math.abs(b.x - a.x) / cs;
  const dy = Math.abs(b.y - a.y) / cs;
  switch (page.diagonal) {
    case 'euclid':
      return Math.sqrt(dx * dx + dy * dy);
    case 'manhattan':
      return Math.round(dx) + Math.round(dy);
    case 'pf': {
      const rx = Math.round(dx),
        ry = Math.round(dy);
      const diag = Math.min(rx, ry);
      return Math.max(rx, ry) + Math.floor(diag / 2);
    }
    default:
      return Math.max(Math.round(dx), Math.round(dy));
  }
}

export function formatDistance(page, cells) {
  const v = cells * (page.scale || 5);
  const r = Math.round(v * 10) / 10;
  return `${r} ${page.units || ''}`.trim();
}

/** Перевод расстояния (в единицах, напр. футах) в пиксели */
export function unitsToPx(page, units) {
  return ((Number(units) || 0) / (page.scale || 5)) * (page.cellSize || 70);
}

// Пересечение отрезков (p1-p2) и (p3-p4)
export function segIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t };
}

export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rotatePoint(px, py, cx, cy, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r),
    s = Math.sin(r);
  const dx = px - cx,
    dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** Точка внутри многоугольника (pts — [x,y,x,y...]) */
export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i],
      yi = pts[i + 1],
      xj = pts[j],
      yj = pts[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx,
    cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Упростить ломаную (Рамер — Дуглас — Пекер) */
export function simplify(points, eps = 1.5) {
  if (points.length <= 4) return points;
  const n = points.length / 2;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0,
      idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(points[i * 2], points[i * 2 + 1], points[a * 2], points[a * 2 + 1], points[b * 2], points[b * 2 + 1]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/** Путь SVG по точкам (сглаженный квадратичными кривыми) */
export function pathD(pts, closed = false, smooth = true) {
  if (pts.length < 4) return pts.length === 2 ? `M${pts[0]} ${pts[1]}l0.01 0` : '';
  let d = `M${r1(pts[0])} ${r1(pts[1])}`;
  if (!smooth || pts.length < 6) {
    for (let i = 2; i < pts.length; i += 2) d += `L${r1(pts[i])} ${r1(pts[i + 1])}`;
  } else {
    for (let i = 2; i < pts.length - 2; i += 2) {
      const mx = (pts[i] + pts[i + 2]) / 2,
        my = (pts[i + 1] + pts[i + 3]) / 2;
      d += `Q${r1(pts[i])} ${r1(pts[i + 1])} ${r1(mx)} ${r1(my)}`;
    }
    d += `L${r1(pts[pts.length - 2])} ${r1(pts[pts.length - 1])}`;
  }
  return closed ? d + 'Z' : d;
}

const r1 = (v) => Math.round(v * 10) / 10;
