// Эффекты, меняющие сам токен: свет, зрение, размер, прозрачность, невидимость — применение и откат
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTokenChange, revertTokenChange, cleanTokenApplied, isTokenKey, durationText } from '../shared/effects.js';

const tok = (over = {}) => ({
  x: 100,
  y: 100,
  w: 70,
  h: 70,
  light: { enabled: false, bright: 20, dim: 20, color: '#ffe7b0', angle: 360 },
  vision: { enabled: false, range: 0, darkvision: 0 },
  effects: {},
  opacity: 1,
  ...over,
});

test('свет «не меньше 20» включает выключенный свет, откат выключает обратно', () => {
  const t = tok();
  const a = applyTokenChange(t, { key: 'light.bright', mode: 'max', value: '20' }, 20);
  assert.equal(t.light.enabled, true);
  assert.equal(t.light.bright, 20);
  assert.equal(a.enabled, false);
  revertTokenChange(t, a);
  assert.equal(t.light.enabled, false);
  assert.equal(t.light.bright, 20);
});

test('у включённого света «не меньше» берёт большее', () => {
  const t = tok({ light: { enabled: true, bright: 40, dim: 0 } });
  const a = applyTokenChange(t, { key: 'light.bright', mode: 'max' }, 20);
  assert.equal(t.light.bright, 40);
  assert.equal(a.prev, 40);
  assert.equal(a.enabled, undefined);
});

test('тёмное зрение включает зрение токена', () => {
  const t = tok();
  const a = applyTokenChange(t, { key: 'vision.darkvision', mode: 'max' }, 60);
  assert.equal(t.vision.enabled, true);
  assert.equal(t.vision.darkvision, 60);
  revertTokenChange(t, a);
  assert.equal(t.vision.enabled, false);
  assert.equal(t.vision.darkvision, 0);
});

test('размер ×2 растёт от центра, откат возвращает место и размер', () => {
  const t = tok();
  const a = applyTokenChange(t, { key: 'size', mode: 'mul' }, 2, 70);
  assert.deepEqual([t.x, t.y, t.w, t.h], [65, 65, 140, 140]);
  revertTokenChange(t, a);
  assert.deepEqual([t.x, t.y, t.w, t.h], [100, 100, 70, 70]);
});

test('размер в клетках: «сделать равным 3» и «прибавить 1»', () => {
  const t = tok();
  applyTokenChange(t, { key: 'size', mode: 'set' }, 3, 50);
  assert.equal(t.w, 150);
  applyTokenChange(t, { key: 'size', mode: 'add' }, 1, 50);
  assert.equal(t.w, 200);
});

test('токен, который передвинули после эффекта, откатывается на новом месте', () => {
  const t = tok();
  const a = applyTokenChange(t, { key: 'size', mode: 'mul' }, 2, 70);
  t.x += 300; // токен передвинули
  revertTokenChange(t, a);
  assert.deepEqual([t.x, t.y, t.w, t.h], [400, 100, 70, 70]);
});

test('размер, поменянный вручную, откат не трогает', () => {
  const t = tok();
  const a = applyTokenChange(t, { key: 'size', mode: 'mul' }, 2, 70);
  t.w = t.h = 210;
  revertTokenChange(t, a);
  assert.equal(t.w, 210);
});

test('невидимость: включить и вернуть', () => {
  const t = tok();
  const a = applyTokenChange(t, { key: 'invisible', mode: 'set' }, 1);
  assert.equal(t.effects.invisible, true);
  revertTokenChange(t, a);
  assert.equal(t.effects.invisible, false);
});

test('прозрачность: «не больше 0.6», числа ограничены', () => {
  const t = tok();
  const a = applyTokenChange(t, { key: 'opacity', mode: 'min' }, 0.6);
  assert.equal(t.opacity, 0.6);
  revertTokenChange(t, a);
  assert.equal(t.opacity, 1);
  applyTokenChange(t, { key: 'opacity', mode: 'add' }, 5);
  assert.equal(t.opacity, 1);
});

test('цвет света: только «сделать равным» и только цвет', () => {
  const t = tok();
  assert.equal(applyTokenChange(t, { key: 'light.color', mode: 'add' }, '#ff0000'), null);
  assert.equal(applyTokenChange(t, { key: 'light.color', mode: 'set' }, 'red; x'), null);
  const a = applyTokenChange(t, { key: 'light.color', mode: 'set' }, '#ff0000');
  assert.equal(t.light.color, '#ff0000');
  revertTokenChange(t, a);
  assert.equal(t.light.color, '#ffe7b0');
});

test('неизвестные поля и мусор от клиента', () => {
  assert.equal(isTokenKey('ac'), false);
  assert.equal(isTokenKey('Light.Bright'), true);
  assert.equal(applyTokenChange(tok(), { key: 'x', mode: 'set' }, 5), null);
  assert.equal(cleanTokenApplied({ tok: 'hp' }), null);
  assert.deepEqual(cleanTokenApplied({ tok: 'opacity', prev: 1, value: 0.5, extra: 'x' }), { tok: 'opacity', prev: 1, value: 0.5 });
  assert.equal(cleanTokenApplied({ tok: 'size', prev: { w: 'a' }, value: { w: 1, h: 2 } }), null);
  assert.equal(cleanTokenApplied({ tok: 'light.color', prev: { a: 1 }, value: '#fff' }).prev, null);
});

test('длительность словами', () => {
  assert.equal(durationText({ rounds: 10, conc: true }), '1 мин, концентрация');
  assert.equal(durationText({ rounds: 600 }), '1 ч');
  assert.equal(durationText({ rounds: 3 }), '3 р.');
  assert.equal(durationText({ duration: 'turnStart' }), 'до начала следующего хода');
  assert.equal(durationText({}), '');
});
