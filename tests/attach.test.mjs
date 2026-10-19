// Сцепка объектов: кто чей пассажир, перенос при сдвиге, повороте и растяжении транспорта
import test from 'node:test';
import assert from 'node:assert/strict';
import { ridersOf, carriersOf, carryTransform, placementChanged, normDeg } from '../shared/attach.js';

const o = (id, extra) => ({ id, x: 0, y: 0, w: 70, h: 70, rot: 0, attachedTo: '', ...extra });

test('пассажиры: прямые и пассажиры пассажиров, без циклов', () => {
  const objs = [o('car'), o('a', { attachedTo: 'car' }), o('b', { attachedTo: 'a' }), o('c'), o('x', { attachedTo: 'y' }), o('y', { attachedTo: 'x' })];
  assert.deepEqual(ridersOf(objs, 'car').map((r) => r.id), ['a', 'b']);
  assert.deepEqual(ridersOf(objs, 'a').map((r) => r.id), ['b']);
  assert.deepEqual(ridersOf(objs, 'c'), []);
  // цикл не зацикливает
  assert.deepEqual(ridersOf(objs, 'x').map((r) => r.id), ['y']);
  const map = new Map(objs.map((q) => [q.id, q]));
  assert.deepEqual(carriersOf((id) => map.get(id), map.get('b')).map((q) => q.id), ['a', 'car']);
  assert.deepEqual(carriersOf((id) => map.get(id), map.get('x')).map((q) => q.id), ['y']);
});

test('сдвиг транспорта: пассажир сдвигается на столько же', () => {
  const t = carryTransform({ x: 100, y: 100, w: 140, h: 70 }, { x: 170, y: 30, w: 140, h: 70 });
  assert.deepEqual(t(o('p', { x: 120, y: 110 })), { x: 190, y: 40 });
  // ничего не изменилось — переносить нечего
  assert.equal(carryTransform({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4, rot: 0 }), null);
});

test('поворот транспорта: пассажир обходит его центр и поворачивается сам', () => {
  // транспорт 200×100 с центром (100, 50); пассажир 20×20 справа от центра
  const a = { x: 0, y: 0, w: 200, h: 100, rot: 0 };
  const b = { ...a, rot: 90 };
  const t = carryTransform(a, b);
  const p = t(o('p', { x: 150, y: 40, w: 20, h: 20, rot: 10 }));
  // центр пассажира (160, 50) → поворот на 90° по часовой (ось y вниз): (100, 110)
  assert.deepEqual(p, { x: 90, y: 100, rot: 100 });
  // обратный поворот возвращает назад
  const back = carryTransform(b, a)({ ...p, w: 20, h: 20 });
  assert.deepEqual(back, { x: 150, y: 40, rot: 10 });
  // 359 → 0 — это поворот на 1° по часовой; угол пассажира остаётся в пределах 0…360
  assert.equal(carryTransform({ ...a, rot: 359 }, { ...a, rot: 0 })(o('q', { rot: 5 })).rot, 6);
  assert.equal(normDeg(-90), 270);
});

test('растяжение транспорта: пассажир остаётся в той же части', () => {
  // транспорт растянули вправо вдвое: левый край на месте
  const t = carryTransform({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 200, h: 100 });
  // пассажир в правой четверти (центр 75) → центр 150
  assert.deepEqual(t(o('p', { x: 65, y: 40, w: 20, h: 20 })), { x: 140, y: 40 });
});

test('сдвиг транспорта по частям = сдвиг целиком (сервер считает по шагам, клиент — от начала)', () => {
  const s0 = { x: 0, y: 0, w: 100, h: 60, rot: 0 };
  const s1 = { x: 35, y: -20, w: 100, h: 60, rot: 30 };
  const s2 = { x: 70, y: 10, w: 120, h: 60, rot: 75 };
  let r = o('p', { x: 80, y: 10, w: 30, h: 30, rot: 0 });
  r = { ...r, ...carryTransform(s0, s1)(r) };
  r = { ...r, ...carryTransform(s1, s2)(r) };
  const direct = carryTransform(s0, s2)(o('p', { x: 80, y: 10, w: 30, h: 30, rot: 0 }));
  assert.ok(Math.abs(r.x - direct.x) < 0.05 && Math.abs(r.y - direct.y) < 0.05, JSON.stringify([r, direct]));
  assert.equal(r.rot, direct.rot);
});

test('что считается перемещением транспорта', () => {
  const a = { x: 1, y: 2, w: 3, h: 4, rot: 0 };
  assert.equal(placementChanged(a, { ...a }), false);
  assert.equal(placementChanged(a, { ...a, rot: undefined }), false);
  assert.equal(placementChanged(a, { ...a, x: 5 }), true);
  assert.equal(placementChanged(a, { ...a, h: 9 }), true);
  assert.equal(placementChanged(a, { ...a, rot: 15 }), true);
});
