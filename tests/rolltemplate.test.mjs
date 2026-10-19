// Шаблоны бросков Roll20: секции, хелперы, отрицания, allprops
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../client/src/game/sheet/rolltemplate.js';

function ctxOf(props, rolls = {}, computed = {}) {
  const list = Object.entries(props);
  return {
    props: new Map(list),
    order: list.map(([k]) => k),
    value: (k) => String(props[k]),
    keyHtml: (k) => k,
    rollOf: (k) => rolls[k] || null,
    computed,
    computedHtml: (k) => String(computed[k] ?? ''),
  };
}

test('простые секции и отрицания', () => {
  const src = '{{#name}}<b>{{name}}</b>{{/name}}{{^desc}}нет описания{{/desc}}';
  assert.equal(renderTemplate(src, ctxOf({ name: 'Удар' })), '<b>Удар</b>нет описания');
  assert.equal(renderTemplate(src, ctxOf({ name: 'Удар', desc: 'x' })), '<b>Удар</b>');
});

test('хелперы бросков', () => {
  const rolls = { r: { total: 20, crit: true, fumble: false }, d: { total: 3 } };
  const ctx = ctxOf({ r: '$[[0]]', d: '$[[1]]' }, rolls);
  assert.equal(renderTemplate('{{#rollWasCrit() r}}крит{{/rollWasCrit() r}}', ctx), 'крит');
  assert.equal(renderTemplate('{{#^rollWasFumble() r}}не провал{{/^rollWasFumble() r}}', ctx), 'не провал');
  assert.equal(renderTemplate('{{#rollTotal() d 3}}три{{/rollTotal() d 3}}', ctx), 'три');
  assert.equal(renderTemplate('{{#rollBetween() d 1 5}}ок{{/rollBetween() d 1 5}}', ctx), 'ок');
  assert.equal(renderTemplate('{{#^rollGreater() d 5}}мало{{/^rollGreater() d 5}}', ctx), 'мало');
});

test('хелпер для отсутствующего свойства не выводит ни одну ветку', () => {
  const ctx = ctxOf({ unconscious: '$[[0]]' }, { unconscious: { total: 0 } });
  const src = '{{#rollTotal() unconscious 0}}A{{#^rollGreater() ammo 0}}нет патронов{{/^rollGreater() ammo 0}}B{{/rollTotal() unconscious 0}}';
  assert.equal(renderTemplate(src, ctx), 'AB');
  const ctx2 = ctxOf({ unconscious: '$[[0]]', ammo: '$[[1]]' }, { unconscious: { total: 0 }, ammo: { total: 0 } });
  assert.equal(renderTemplate(src, ctx2), 'Aнет патроновB');
});

test('allprops и computed', () => {
  const ctx = ctxOf({ name: 'N', a: '1', b: '2' }, {}, { sl: 4 });
  assert.equal(renderTemplate('{{#allprops() name}}[{{key}}={{value}}]{{/allprops() name}}', ctx), '[a=1][b=2]');
  assert.equal(renderTemplate('SL {{computed::sl}}', ctx), 'SL 4');
});
