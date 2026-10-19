// Объёмные кубики: формы граней, надписи, какая грань сверху
import test from 'node:test';
import assert from 'node:assert/strict';
import { diceShape, diceSpecs, relabel, topOf, rotate } from '../client/src/game/dice3d/geometry.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

test('многогранники: число граней, вершин в грани, плоские грани против часовой снаружи', () => {
  const want = { d4: [4, 3], d6: [6, 4], d8: [8, 3], d10: [10, 4], d12: [12, 5], d20: [20, 3] };
  for (const [kind, [faces, per]] of Object.entries(want)) {
    const s = diceShape(kind);
    assert.equal(s.faces.length, faces, kind + ': граней');
    for (const f of s.faces) {
      assert.equal(f.idx.length, per, kind + ': вершин в грани');
      const p = f.idx.map((i) => s.verts[i]);
      for (const q of p) assert.ok(Math.abs(dot(sub(q, p[0]), f.normal)) < 1e-9, kind + ': грань не плоская');
      // обход против часовой: векторное произведение соседних рёбер смотрит наружу
      for (let i = 0; i < p.length; i++) {
        const a = p[i];
        const b = p[(i + 1) % p.length];
        const c = p[(i + 2) % p.length];
        assert.ok(dot(cross(sub(b, a), sub(c, b)), f.normal) > 0, kind + ': обход грани');
      }
      assert.ok(dot(f.normal, f.center) > 0, kind + ': нормаль наружу');
    }
  }
});

test('надписи: обычные кубики, d100 из двух d10, Fate, d3 и необычные', () => {
  assert.deepEqual(diceSpecs({ sides: 20, v: 17 }), [{ kind: 'd20', sides: 20, labels: Array.from({ length: 20 }, (_, i) => String(i + 1)), want: '17' }]);
  const pct = diceSpecs({ sides: 100, v: 37 });
  assert.equal(pct.length, 2);
  assert.equal(pct[0].want, '30');
  assert.equal(pct[1].want, '7');
  assert.deepEqual(diceSpecs({ sides: 100, v: 100 }).map((d) => d.want), ['00', '0']);
  assert.deepEqual(diceSpecs({ sides: 100, v: 5 }).map((d) => d.want), ['00', '5']);
  assert.equal(diceSpecs({ sides: 'F', v: -1 })[0].want, '−');
  assert.equal(diceSpecs({ sides: 'F', v: 0 })[0].want, ' ');
  assert.deepEqual(diceSpecs({ sides: 3, v: 2 })[0].labels, ['1', '2', '3', '1', '2', '3']);
  const d30 = diceSpecs({ sides: 30, v: 27 })[0];
  assert.equal(d30.kind, 'd20');
  assert.equal(d30.labels.length, 20);
  assert.equal(new Set(d30.labels).size, 20);
  assert.ok(d30.labels.includes('27'));
  assert.ok(d30.labels.every((x) => Number(x) >= 1 && Number(x) <= 30));
  assert.equal(diceSpecs({ sides: 4, v: 3 })[0].kind, 'd4');
});

test('надпись результата переносится на верхнюю грань', () => {
  const labels = ['1', '2', '3', '4', '5', '6'];
  assert.deepEqual(relabel(labels, 0, '6'), ['6', '2', '3', '4', '5', '1']);
  assert.deepEqual(relabel(labels, 2, '3'), labels);
  // надписи меняются местами — набор граней остаётся прежним
  assert.deepEqual(relabel(['+', '+', '−', '−', ' ', ' '], 5, '+'), [' ', '+', '−', '−', ' ', '+']);
  assert.deepEqual(relabel(['1', '2'], 1, '9'), ['1', '9']);
});

test('какая грань сверху при повороте', () => {
  const id = [0, 0, 0, 1];
  const d6 = diceShape('d6');
  const top = topOf(d6, id);
  assert.ok(Math.abs(d6.faces[top.index].normal[1] - 1) < 1e-9);
  assert.ok(top.flat > 0.999);
  // поворот на 90° вокруг оси X: вверх смотрит грань, которая смотрела на −Z… проверяем через rotate
  const s = Math.SQRT1_2;
  const q = [s, 0, 0, s];
  const t2 = topOf(d6, q);
  assert.ok(rotate(q, d6.faces[t2.index].normal)[1] > 0.999);
  // d4: верхняя вершина, нижняя грань лежит ровно
  const d4 = diceShape('d4');
  const f = d4.faces[0];
  // повернуть так, чтобы грань 0 смотрела вниз: кватернион из нормали в (0,-1,0)
  const n = f.normal;
  const axis = cross(n, [0, -1, 0]);
  const al = Math.hypot(...axis);
  const ang = Math.acos(Math.max(-1, Math.min(1, -n[1])));
  const qq = [(axis[0] / al) * Math.sin(ang / 2), (axis[1] / al) * Math.sin(ang / 2), (axis[2] / al) * Math.sin(ang / 2), Math.cos(ang / 2)];
  const t4 = topOf(d4, qq);
  assert.ok(t4.flat > 0.999, 'd4 лежит на грани');
  assert.ok(!f.idx.includes(t4.index), 'верхняя вершина не на нижней грани');
});
