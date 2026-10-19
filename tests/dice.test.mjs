import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollExpression, processInlineRolls, findInlineRolls, parseRoll, critClass, partsToText } from '../shared/dice.js';

// Детерминированный генератор: отдаёт значения из списка по кругу
function seq(values) {
  let i = 0;
  return (sides) => {
    const v = values[i++ % values.length];
    if (v > sides) return sides;
    return v;
  };
}

test('простые броски и математика', () => {
  assert.equal(rollExpression('1d20+5', { rng: seq([12]) }).total, 17);
  assert.equal(rollExpression('2d6+3', { rng: seq([4, 2]) }).total, 9);
  assert.equal(rollExpression('5+3*2', {}).total, 11);
  assert.equal(rollExpression('(5+3)*2', {}).total, 16);
  assert.equal(rollExpression('2**3', {}).total, 8);
  assert.equal(rollExpression('7%3', {}).total, 1);
  assert.equal(rollExpression('-7%3', {}).total, -1);
  assert.equal(rollExpression('floor(7/2)', {}).total, 3);
  assert.equal(rollExpression('ceil(7/2)', {}).total, 4);
  assert.equal(rollExpression('round(2.5)', {}).total, 3);
  assert.equal(rollExpression('abs(-4)', {}).total, 4);
  assert.equal(rollExpression('5/2', {}).total, 2.5);
  assert.equal(rollExpression('d20', { rng: seq([7]) }).total, 7);
  assert.equal(rollExpression('0d20+3', {}).total, 3);
  assert.equal(rollExpression('1+-2', {}).total, -1);
});

test('метки', () => {
  const r = rollExpression('1d20+5[STR] + 2[PROF]', { rng: seq([10]) });
  assert.equal(r.total, 17);
  assert.match(partsToText(r.parts), /\[STR\]/);
  const r2 = rollExpression('[Огонь] 2d6', { rng: seq([3, 4]) });
  assert.equal(r2.total, 7);
});

test('keep/drop', () => {
  assert.equal(rollExpression('2d20kh1', { rng: seq([5, 15]) }).total, 15);
  assert.equal(rollExpression('2d20kl1', { rng: seq([5, 15]) }).total, 5);
  assert.equal(rollExpression('4d6d1', { rng: seq([1, 4, 5, 6]) }).total, 15);
  assert.equal(rollExpression('4d6dh1', { rng: seq([1, 4, 5, 6]) }).total, 10);
  assert.equal(rollExpression('4d6k3', { rng: seq([1, 4, 5, 6]) }).total, 15);
});

test('взрывы, перебросы', () => {
  // 6 взрывается, затем 3
  assert.equal(rollExpression('1d6!', { rng: seq([6, 3]) }).total, 9);
  assert.equal(rollExpression('1d6!!', { rng: seq([6, 6, 2]) }).total, 14);
  assert.equal(rollExpression('1d6!p', { rng: seq([6, 6, 2]) }).total, 6 + 5 + 1);
  assert.equal(rollExpression('1d6!>5', { rng: seq([5, 2]) }).total, 7);
  assert.equal(rollExpression('2d8r1', { rng: seq([1, 1, 5, 3]) }).total, 8);
  assert.equal(rollExpression('1d8r<2', { rng: seq([2, 1, 7]) }).total, 7);
  assert.equal(rollExpression('1d10ro<2', { rng: seq([1, 1]) }).total, 1);
});

test('успехи и провалы', () => {
  const r = rollExpression('5d10>8', { rng: seq([9, 10, 3, 8, 1]) });
  assert.equal(r.total, 3);
  assert.equal(r.type, 'success');
  assert.equal(rollExpression('5d10>8f1', { rng: seq([9, 10, 3, 8, 1]) }).total, 2);
  assert.equal(rollExpression('3d6<3', { rng: seq([1, 3, 5]) }).total, 2);
});

test('криты', () => {
  assert.equal(rollExpression('1d20', { rng: seq([20]) }).crit, true);
  assert.equal(rollExpression('1d20', { rng: seq([1]) }).fumble, true);
  assert.equal(rollExpression('1d20cs>19', { rng: seq([19]) }).crit, true);
  assert.equal(rollExpression('1d100cs<5cf>96', { rng: seq([3]) }).crit, true);
  assert.equal(rollExpression('1d100cs<5cf>96', { rng: seq([97]) }).fumble, true);
  assert.equal(critClass(rollExpression('2d20', { rng: seq([20, 1]) })), 'importantroll');
});

test('групповые броски', () => {
  assert.equal(rollExpression('{1d20+5, 1d20+5}kh1', { rng: seq([3, 12]) }).total, 17);
  assert.equal(rollExpression('{4d6+3d8}k4', { rng: seq([1, 2, 3, 4, 8, 7, 6]) }).total, 25);
  assert.equal(rollExpression('{3d20+5}>21', { rng: seq([10, 5, 2]) }).total, 1);
  assert.equal(rollExpression('{1d6, 1d6, 1d6}>4', { rng: seq([5, 2, 6]) }).total, 2);
});

test('сортировка и совпадения', () => {
  const r = rollExpression('5d6sd', { rng: seq([1, 5, 3, 6, 2]) });
  assert.deepEqual(r.parts[0].dice.map((d) => d.v), [6, 5, 3, 2, 1]);
  assert.equal(rollExpression('6d6mt', { rng: seq([1, 1, 3, 3, 3, 6]) }).total, 2);
});

test('fudge и вычисляемые кубики', () => {
  const r = rollExpression('4dF', { rng: seq([1, 2, 3, 2]) });
  assert.equal(r.total, -1 + 0 + 1 + 0);
  assert.equal(rollExpression('(1+1)d6', { rng: seq([3, 4]) }).total, 7);
  assert.equal(rollExpression('1d(2*3)', { rng: seq([6]) }).total, 6);
});

test('таблицы', () => {
  const tables = (name) => (name === 'Погода' ? [{ name: 'Солнце', weight: 1 }, { name: 'Дождь', weight: 1 }] : null);
  const r = rollExpression('1t[Погода]', { rng: seq([2]), tables });
  assert.equal(r.tableText, 'Дождь');
});

test('комментарий после броска', () => {
  const r = rollExpression('1d20+5 Атака мечом', { rng: seq([10]), allowTrailing: true });
  assert.equal(r.total, 15);
  assert.equal(r.comment, 'Атака мечом');
  const r2 = rollExpression('1d20+5 \\ +5 Инициатива', { rng: seq([10]), allowTrailing: true });
  assert.equal(r2.total, 15);
  assert.equal(r2.comment, '+5 Инициатива');
});

test('inline-броски и вложенность', () => {
  const roots = findInlineRolls('a [[1d20[STR]]] b [[ [[1d4]]d6 ]] c');
  assert.equal(roots.length, 2);
  assert.equal(roots[1].children.length, 1);
  const { text, rolls } = processInlineRolls('{{r1=[[1d20+[[2]][DEX] &{tracker}]]}} {{mod=[[[[3]][DEX]]]}}', { rng: seq([10]) });
  assert.equal(text, '{{r1=$[[1]]}} {{mod=$[[3]]}}');
  assert.equal(rolls[1].total, 12);
  assert.equal(rolls[1].tracker, '=');
  assert.equal(rolls[3].total, 3);
  const n = processInlineRolls('[[ [[1d4]]d6 ]]', { rng: seq([2, 3, 4]) });
  assert.equal(n.rolls.length, 2);
  assert.equal(n.rolls[1].total, 7);
});

test('ошибки разбора', () => {
  assert.throws(() => parseRoll('1d20+', { allowEmpty: false }), /RollError|Неожиданный/);
  assert.throws(() => parseRoll('1d20 + бонус', { allowEmpty: false }), /RollError|Неожиданный/);
  assert.throws(() => parseRoll(''));
  assert.throws(() => rollExpression('abc'));
});

test('5e: преимущество через атрибуты', () => {
  const t = '{{r1=[[1d20+[[3]][STR]]]}} {{always=1}} {{r2=[[1d20+[[3]][STR]]]}}';
  const { text, rolls } = processInlineRolls(t, { rng: seq([5, 18]) });
  assert.equal(text, '{{r1=$[[1]]}} {{always=1}} {{r2=$[[3]]}}');
  assert.equal(rolls[1].total, 8);
  assert.equal(rolls[3].total, 21);
});

test('пустой inline-бросок равен нулю', () => {
  const { text, rolls } = processInlineRolls('a [[ ]] b [[ [метка] ]]', { rng: seq([1]) });
  assert.equal(text, 'a $[[0]] b $[[1]]');
  assert.equal(rolls[0].total, 0);
  assert.equal(rolls[1].total, 0);
});

test('пустой атрибут в формуле считается нулём, d0 даёт 0', () => {
  const roll = (e) => rollExpression(e, {});
  assert.equal(roll('floor(/2)').total, 0);
  assert.equal(roll('*2+3').total, 3);
  assert.equal(roll('(+0)+4').total, 4);
  assert.equal(roll('1d20+', { rng: seq([7]) }).total >= 1, true);
  assert.equal(roll('1d0').total, 0);
  assert.equal(roll('3d0+2').total, 2);
  assert.equal(roll('d0!').total, 0);
  assert.equal(rollExpression('2d6 урон', { allowTrailing: true, rng: seq([3, 4]) }).total, 7);
});
