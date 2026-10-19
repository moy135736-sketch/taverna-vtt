// Хиты: какая полоса токена — хиты, урон с временными хитами, лечение до максимума
import test from 'node:test';
import assert from 'node:assert/strict';
import { hpBarOf, applyHp, effectiveAmount, num } from '../client/src/game/hp.js';

const bar = (id, extra) => ({ id, name: '', value: '', max: '', link: '', ...extra });

test('полоса хитов: связь с атрибутом, название, как в листе 5E', () => {
  // игрок: первая полоса связана с hp
  assert.equal(hpBarOf([bar('a', { link: 'hp', value: '12', max: '20' }), bar('b', { link: 'npc_ac', value: '15' })]).id, 'a');
  // связь важнее порядка
  assert.equal(hpBarOf([bar('a', { link: 'speed', value: '30', max: '30' }), bar('b', { link: 'HP', value: '7', max: '7' })]).id, 'b');
  // по названию, в том числе по-русски
  assert.equal(hpBarOf([bar('a', { value: '3' }), bar('b', { name: 'Хиты', value: '9', max: '9' })]).id, 'b');
  assert.equal(hpBarOf([bar('a', { name: 'Раны', value: '11', max: '13' })]).id, 'a');
  // NPC из листа D&D 5E: bar1 — хиты без связи, bar2 — КД (связь npc_ac)
  assert.equal(hpBarOf([bar('a', { value: '7', max: '7' }), bar('b', { link: 'npc_ac', value: '15', max: '' })]).id, 'a');
  // КД с максимумом не путается с хитами
  assert.equal(hpBarOf([bar('a', { link: 'ac', value: '15', max: '15' }), bar('b', { value: '22', max: '30' })]).id, 'b');
  // временные хиты — не основная полоса
  assert.equal(hpBarOf([bar('t', { name: 'Врем. хиты', value: '5', max: '5' }), bar('h', { value: '10', max: '10' })]).id, 'h');
  // одна полоса с числом
  assert.equal(hpBarOf([bar('a', { value: '4' })]).id, 'a');
  // нечем определить
  assert.equal(hpBarOf([bar('a', { value: 'жив' }), bar('b', { value: '' })]), null);
  assert.equal(hpBarOf([]), null);
  assert.equal(hpBarOf(undefined), null);
});

test('полоса хитов по настройке стола', () => {
  const bars = [bar('a', { link: 'hp', value: '1', max: '1' }), bar('b', { value: '2' }), bar('c', { value: '3' })];
  assert.equal(hpBarOf(bars, '3').id, 'c');
  assert.equal(hpBarOf(bars, '2').id, 'b');
  assert.equal(hpBarOf(bars, '4'), null);
  assert.equal(hpBarOf(bars, 'auto').id, 'a');
});

test('сколько применить: половина вниз, двойной', () => {
  assert.equal(effectiveAmount(17, 'dmg'), 17);
  assert.equal(effectiveAmount(17, 'half'), 8);
  assert.equal(effectiveAmount(1, 'half'), 0);
  assert.equal(effectiveAmount(17, 'double'), 34);
  assert.equal(effectiveAmount(17, 'heal'), 17);
  assert.equal(effectiveAmount(-3, 'dmg'), 0);
});

test('урон: не ниже нуля, временные хиты первыми', () => {
  assert.deepEqual(applyHp({ cur: 7, max: 7, value: 5 }), { next: 2, temp: 0 });
  assert.deepEqual(applyHp({ cur: 7, max: 7, value: 12 }), { next: 0, temp: 0 });
  assert.deepEqual(applyHp({ cur: 7, max: 7, value: 12, allowNegative: true }), { next: -5, temp: 0 });
  // уже в минусе (отметили вручную) — урон не «поднимает» до нуля
  assert.deepEqual(applyHp({ cur: -2, max: 7, value: 3 }), { next: -2, temp: 0 });
  assert.deepEqual(applyHp({ cur: 20, max: 30, temp: 5, value: 3 }), { next: 20, temp: 2 });
  assert.deepEqual(applyHp({ cur: 20, max: 30, temp: 5, value: 9 }), { next: 16, temp: 0 });
  assert.deepEqual(applyHp({ cur: 20, max: null, temp: 0, value: 0 }), { next: 20, temp: 0 });
});

test('лечение: не выше максимума, сверх максимума не уменьшает', () => {
  assert.deepEqual(applyHp({ cur: 3, max: 10, value: 4, heal: true }), { next: 7, temp: 0 });
  assert.deepEqual(applyHp({ cur: 8, max: 10, value: 4, heal: true }), { next: 10, temp: 0 });
  assert.deepEqual(applyHp({ cur: 12, max: 10, value: 4, heal: true }), { next: 12, temp: 0 });
  assert.deepEqual(applyHp({ cur: 3, max: null, value: 4, heal: true }), { next: 7, temp: 0 });
  // временные хиты лечение не трогает
  assert.deepEqual(applyHp({ cur: 3, max: 10, temp: 5, value: 4, heal: true }), { next: 7, temp: 5 });
});

test('числа из полос', () => {
  assert.equal(num('12'), 12);
  assert.equal(num(' 7 '), 7);
  assert.equal(num('−3'), -3);
  assert.equal(num('2,5'), 2.5);
  assert.equal(num(''), null);
  assert.equal(num('жив'), null);
  assert.equal(num(undefined), null);
});
