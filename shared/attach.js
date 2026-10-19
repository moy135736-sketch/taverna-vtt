// Сцепка объектов: «пассажир» (поле attachedTo) едет вместе с «транспортом» —
// повторяет его сдвиг, поворот и растяжение. Общий код сервера и клиента: сервер двигает
// пассажиров по-настоящему, клиент — заранее у себя, пока тянут транспорт, чтобы не было рывков.

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const r2 = (v) => Math.round(v * 100) / 100;
export const normDeg = (a) => r2((((num(a) % 360) + 360) % 360));

/** Все пассажиры объекта id, включая пассажиров пассажиров; без циклов. objs — любой перебираемый набор */
export function ridersOf(objs, id) {
  const byParent = new Map();
  for (const o of objs) {
    if (!o || !o.attachedTo) continue;
    let list = byParent.get(o.attachedTo);
    if (!list) byParent.set(o.attachedTo, (list = []));
    list.push(o);
  }
  const out = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const p = queue.shift();
    for (const r of byParent.get(p) || []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      queue.push(r.id);
    }
  }
  return out;
}

/** Цепочка «транспортов» объекта вверх (без самого объекта), с защитой от циклов */
export function carriersOf(get, o) {
  const out = [];
  const seen = new Set([o.id]);
  let cur = o.attachedTo ? get(o.attachedTo) : null;
  while (cur && !seen.has(cur.id)) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.attachedTo ? get(cur.attachedTo) : null;
  }
  return out;
}

/**
 * Как перенести пассажиров, когда транспорт перешёл из состояния a в b ({x, y, w, h, rot}).
 * Возвращает функцию «пассажир → правка {x, y[, rot]}» или null, если транспорт не сдвинулся.
 * Положение пассажира сохраняется относительно транспорта: в его системе координат,
 * с учётом поворота и изменения размера.
 */
export function carryTransform(a, b) {
  const aw = num(a.w, 1) || 1,
    ah = num(a.h, 1) || 1;
  const bw = num(b.w, aw) || aw,
    bh = num(b.h, ah) || ah;
  const acx = num(a.x) + aw / 2,
    acy = num(a.y) + ah / 2;
  const bcx = num(b.x) + bw / 2,
    bcy = num(b.y) + bh / 2;
  const dRot = num(b.rot) - num(a.rot);
  const sx = bw / aw,
    sy = bh / ah;
  if (acx === bcx && acy === bcy && dRot === 0 && sx === 1 && sy === 1) return null;
  const ra = (-num(a.rot) * Math.PI) / 180,
    rb = (num(b.rot) * Math.PI) / 180;
  const ca = Math.cos(ra),
    sa = Math.sin(ra),
    cb = Math.cos(rb),
    sb = Math.sin(rb);
  return (r) => {
    const rw = num(r.w),
      rh = num(r.h);
    const px = num(r.x) + rw / 2 - acx,
      py = num(r.y) + rh / 2 - acy;
    // в системе координат транспорта, с учётом растяжения
    const lx = (px * ca - py * sa) * sx,
      ly = (px * sa + py * ca) * sy;
    const nx = lx * cb - ly * sb,
      ny = lx * sb + ly * cb;
    const patch = { x: r2(bcx + nx - rw / 2), y: r2(bcy + ny - rh / 2) };
    if (dRot) patch.rot = normDeg(num(r.rot) + dRot);
    return patch;
  };
}

/** Изменилось ли положение, поворот или размер — то, за чем следуют пассажиры */
export function placementChanged(a, b) {
  return a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || num(a.rot) !== num(b.rot);
}
