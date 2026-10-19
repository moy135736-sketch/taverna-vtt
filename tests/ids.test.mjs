// Идентификаторы: уникальность при массовом создании в одну миллисекунду
import test from 'node:test';
import assert from 'node:assert/strict';
import { newId, generateRowID, randomCode } from '../shared/ids.js';

test('newId: 200 000 подряд — без повторов, в том числе без учёта регистра', () => {
  const N = 200000;
  const seen = new Set();
  let prev = '';
  for (let i = 0; i < N; i++) {
    const id = newId();
    assert.equal(id.length, 20);
    assert.ok(id.startsWith('-'), id);
    assert.ok(!id.includes('_'), id);
    seen.add(id.toLowerCase());
    if (prev) assert.ok(id > prev, `порядок: ${prev} → ${id}`);
    prev = id;
  }
  assert.equal(seen.size, N);
});

test('generateRowID: годится для имён атрибутов', () => {
  for (let i = 0; i < 1000; i++) assert.match(generateRowID(), /^-[0-9A-Za-z-]{19}$/);
});

test('randomCode: 8 символов без похожих букв', () => {
  for (let i = 0; i < 200; i++) assert.match(randomCode(), /^[A-HJ-NP-Z2-9]{8}$/);
});
