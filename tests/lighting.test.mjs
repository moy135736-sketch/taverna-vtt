// Динамическое освещение: многоугольник видимости, стены и двери, проверка точек
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibilityPolygon, wallSegments, pointInPoly, movementBlocked } from '../client/src/game/board/lighting.js';

const page = { x: 0, y: 0, w: 1000, h: 1000 };
// вертикальная стена x=500 от y=0 до y=1000 с дверью посередине (y 450..550)
const walls = [
  { type: 'wall', wallType: 'wall', pts: [500, 0, 500, 450] },
  { type: 'wall', wallType: 'wall', pts: [500, 550, 500, 1000] },
  { type: 'wall', wallType: 'door', open: false, pts: [500, 450, 500, 550] },
];

test('закрытая дверь заслоняет обзор', () => {
  const poly = visibilityPolygon(200, 500, wallSegments(walls, 'sight'), page);
  assert.ok(pointInPoly(300, 300, poly), 'своя половина видна');
  assert.ok(!pointInPoly(700, 500, poly), 'за дверью не видно');
  assert.ok(!pointInPoly(900, 100, poly), 'за стеной не видно');
});

test('открытая дверь пропускает взгляд только через проём', () => {
  const open = walls.map((w) => (w.wallType === 'door' ? { ...w, open: true } : w));
  const poly = visibilityPolygon(200, 500, wallSegments(open, 'sight'), page);
  assert.ok(pointInPoly(700, 500, poly), 'напротив проёма видно');
  assert.ok(!pointInPoly(900, 100, poly), 'вбок за стену — нет');
});

test('окно не мешает взгляду, но мешает движению', () => {
  const win = [{ type: 'wall', wallType: 'window', pts: [500, 0, 500, 1000] }];
  const poly = visibilityPolygon(200, 500, wallSegments(win, 'sight'), page);
  assert.ok(pointInPoly(800, 500, poly));
  assert.ok(movementBlocked(wallSegments(win, 'move'), 200, 500, 800, 500));
});

test('pointInPoly: простой квадрат', () => {
  const sq = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.ok(pointInPoly(5, 5, sq));
  assert.ok(!pointInPoly(15, 5, sq));
  assert.ok(!pointInPoly(5, 5, [0, 0, 1, 1]), 'вырожденный многоугольник');
});
