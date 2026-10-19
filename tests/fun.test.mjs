// Итоги вечера, ловушки, выбор кубиков: чистая логика без браузера
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSummary, sessionStart, plural, diceIn } from '../server/game/summary.js';
import { cleanTrap, pointInObj, pathEntry, isTrapVictim, TRAP_DEFAULTS } from '../shared/traps.js';
import { cleanDiceStyle, ROLL_FX } from '../shared/diceStyle.js';
import { skinLook, DICE_SKINS } from '../client/src/game/dice3d/skins.js';

const members = new Map([
  ['a', { displayName: 'Аня', color: '#ff0000', role: 'player' }],
  ['b', { displayName: 'Боря', color: '#00ff00', role: 'player' }],
  ['g', { displayName: 'Мастер', color: '#0000ff', role: 'gm' }],
]);
const d20 = (v, dr) => ({ t: 'dice', sides: 20, dice: [dr ? { v, dr: true } : { v }] });
const roll = (id, ts, playerId, parts, total, extra = {}) => ({ id, ts, type: 'rollresult', playerId, who: members.get(playerId)?.displayName, roll: { total, parts, expression: '1d20' }, origRoll: '1d20', ...extra });

test('русские окончания', () => {
  assert.equal(plural(1, 'бросок', 'броска', 'бросков'), 'бросок');
  assert.equal(plural(3, 'бросок', 'броска', 'бросков'), 'броска');
  assert.equal(plural(11, 'бросок', 'броска', 'бросков'), 'бросков');
  assert.equal(plural(22, 'бросок', 'броска', 'бросков'), 'броска');
  assert.equal(plural(25, 'бросок', 'броска', 'бросков'), 'бросков');
  assert.equal(plural(101, 'бросок', 'броска', 'бросков'), 'бросок');
});

test('кубики сообщения: основной бросок, inline и группы', () => {
  const m = {
    roll: { parts: [d20(5), { t: 'group', items: [{ parts: [{ t: 'dice', sides: 6, dice: [{ v: 3 }, { v: 4 }] }] }] }] },
    inlinerolls: [{ parts: [d20(19, true)] }],
  };
  assert.deepEqual(
    diceIn(m).map((d) => `${d.sides}:${d.v}:${d.dropped}`),
    ['20:5:false', '6:3:false', '6:4:false', '20:19:true'],
  );
});

test('вечер начинается после перерыва дольше 4 часов', () => {
  const h = 3600000;
  assert.equal(sessionStart([100 * h, 99 * h, 97 * h, 90 * h, 89 * h]), 97 * h);
  assert.equal(sessionStart([5 * h, 4 * h]), 4 * h);
  assert.equal(sessionStart([]), null);
});

test('итоги: награды, тайные броски и шёпоты не считаются, момент вечера', () => {
  const msgs = [
    roll('1', 1, 'a', [d20(20)], 25),
    roll('2', 2, 'a', [d20(20)], 24),
    roll('3', 3, 'b', [d20(1)], 3),
    roll('4', 4, 'b', [d20(4)], 6),
    roll('5', 5, 'b', [d20(7)], 9),
    roll('6', 6, 'b', [d20(2)], 4),
    // помеха: отброшенная 20 не считается
    roll('7', 7, 'b', [{ t: 'dice', sides: 20, dice: [{ v: 20, dr: true }, { v: 3 }] }], 5),
    // тайный бросок мастера и шёпот — мимо статистики
    { id: '8', ts: 8, type: 'gmrollresult', toGM: true, playerId: 'g', roll: { total: 99, parts: [d20(20)] } },
    { id: '9', ts: 9, type: 'whisper', to: ['a'], playerId: 'b', content: 'тсс' },
    { id: '10', ts: 10, type: 'general', playerId: 'b', who: 'Боря', content: 'Ну вот, опять', reactions: { '😂': ['a', 'g'], '💀': ['b'] } },
    { id: '11', ts: 11, type: 'general', playerId: 'b', content: 'Ещё реплика' },
    { id: '12', ts: 12, type: 'general', playerId: 'b', content: 'И ещё' },
    { id: '13', ts: 13, type: 'system', playerId: '', content: 'служебное' },
    { id: '14', ts: 14, type: 'summary', playerId: 'g', summary: {} },
  ];
  const s = computeSummary(msgs, members);
  assert.equal(s.total.rolls, 7);
  assert.equal(s.total.nat20, 2);
  assert.equal(s.total.nat1, 1);
  assert.equal(s.total.messages, 3);
  assert.equal(s.from, 1);
  assert.equal(s.to, 12);
  const award = (id) => s.awards.find((a) => a.id === id);
  assert.equal(award('luck').who[0].name, 'Аня');
  assert.match(award('luck').text, /^2 натуральные двадцатки$/);
  assert.equal(award('cursed').who[0].name, 'Боря');
  assert.equal(award('caliber').who[0].name, 'Аня');
  assert.match(award('caliber').text, /^25/);
  // у Бори 5 бросков d20 подряд меньше 10 (1, 4, 7, 2, 3)
  assert.equal(award('streak').who[0].name, 'Боря');
  assert.match(award('streak').text, /^5 бросков/);
  // «Душа компании»: свою реакцию автор не считает
  assert.equal(award('soul').who[0].name, 'Боря');
  assert.match(award('soul').text, /^2 реакции/);
  assert.equal(award('teller').who[0].name, 'Боря');
  assert.equal(s.moment.text, 'Ну вот, опять');
  assert.equal(s.moment.count, 2);
  // «Золотая рука» — только при среднем выше 10,5: у Бори пять бросков, но средний 3,4, у Ани всего два
  assert.equal(award('golden'), undefined);
  assert.equal(s.players.find((p) => p.id === 'a').avg, 20);
});

test('итоги: «Золотая рука» за хороший средний на пяти бросках', () => {
  const msgs = [15, 12, 18, 9, 14].map((v, i) => roll(String(i), i, 'a', [d20(v)], v));
  const s = computeSummary(msgs, members);
  const g = s.awards.find((a) => a.id === 'golden');
  assert.equal(g.who[0].name, 'Аня');
  assert.equal(g.text, 'в среднем 13,6 на d20');
});

test('итоги: от лица персонажа — имя персонажа, игрок в подписи', () => {
  const s = computeSummary([roll('1', 1, 'a', [d20(20)], 21, { charId: 'c1', who: 'Тарен' })], members);
  assert.deepEqual(s.awards[0].who[0], { id: 'a', name: 'Тарен', player: 'Аня', color: '#ff0000' });
});

test('ловушка: настройка без мусора', () => {
  assert.equal(cleanTrap(null), null);
  assert.equal(cleanTrap([]), null);
  const t = cleanTrap({ name: '  ', trigger: 'all', fx: 'explode-fire', flash: 'blue', count: -4, message: 'Строка 1\nСтрока 2\u0007', roll: 'x'.repeat(200) });
  assert.equal(t.name, TRAP_DEFAULTS.name);
  assert.equal(t.trigger, 'players');
  assert.equal(t.fx, 'explode-fire');
  assert.equal(t.flash, '');
  assert.equal(t.count, 0);
  assert.equal(t.message, 'Строка 1\nСтрока 2');
  assert.equal(t.roll.length, 80);
  assert.equal(t.once, true);
  assert.equal(t.stop, true);
  assert.equal(cleanTrap({ fx: 'javascript:alert(1)' }).fx, '');
  // ходы мастера задевают ловушку, пока это явно не выключено
  assert.equal(cleanTrap({}).gmMoves, true);
  assert.equal(cleanTrap({ gmMoves: false }).gmMoves, false);
  assert.equal(TRAP_DEFAULTS.gmMoves, true);
  assert.match(TRAP_DEFAULTS.message, /\{name\}/);
});

test('ловушка: точка внутри фигуры с поворотом и формой', () => {
  const rect = { type: 'shape', shape: 'rect', x: 100, y: 100, w: 100, h: 50 };
  assert.equal(pointInObj(rect, 150, 125), true);
  assert.equal(pointInObj(rect, 150, 160), false);
  // повёрнутый на 90° прямоугольник 100×50 вокруг центра (150, 125): теперь 50 в ширину и 100 в высоту
  const rot = { ...rect, rot: 90 };
  assert.equal(pointInObj(rot, 150, 170), true);
  assert.equal(pointInObj(rot, 190, 125), false);
  const ell = { type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 100, h: 100 };
  assert.equal(pointInObj(ell, 50, 50), true);
  assert.equal(pointInObj(ell, 5, 5), false);
  const tri = { type: 'shape', shape: 'triangle', x: 0, y: 0, w: 100, h: 100 };
  assert.equal(pointInObj(tri, 50, 90), true);
  assert.equal(pointInObj(tri, 10, 10), false);
  // картинка — по прямоугольнику
  assert.equal(pointInObj({ type: 'image', x: 0, y: 0, w: 10, h: 10 }, 9, 9), true);
});

test('ловушка: где путь входит в область; начавшийся внутри путь — только новый вход', () => {
  const trap = { type: 'shape', shape: 'rect', x: 700, y: 280, w: 70, h: 70 };
  const hit = pathEntry(trap, [
    { x: 595, y: 315 },
    { x: 875, y: 315 },
  ]);
  assert.ok(hit);
  assert.ok(Math.abs(hit.x - 700) < 1, 'вход на левой границе: ' + hit.x);
  assert.ok(Math.abs(hit.dist - 105) < 1);
  assert.deepEqual(hit.dir, { x: 1, y: 0 });
  // мимо
  assert.equal(pathEntry(trap, [{ x: 595, y: 200 }, { x: 875, y: 200 }]), null);
  // путь с поворотом: сначала вниз мимо, потом вправо — в ловушку
  const turn = pathEntry(trap, [{ x: 600, y: 100 }, { x: 600, y: 320 }, { x: 900, y: 320 }]);
  assert.ok(turn && Math.abs(turn.x - 700) < 1 && Math.abs(turn.dist - 320) < 1);
  // стоял в ловушке и уходит — не срабатывает; ушёл и вернулся — срабатывает
  assert.equal(pathEntry(trap, [{ x: 735, y: 315 }, { x: 900, y: 315 }]), null);
  assert.ok(pathEntry(trap, [{ x: 735, y: 315 }, { x: 900, y: 315 }, { x: 600, y: 315 }]));
});

test('ловушка ловит токены на слое объектов и спрятанные на слое мастера', () => {
  assert.equal(isTrapVictim({ type: 'image', layer: 'objects' }), true);
  assert.equal(isTrapVictim({ type: 'shape', layer: 'objects' }), true);
  assert.equal(isTrapVictim({ type: 'image', layer: 'map' }), false);
  assert.equal(isTrapVictim({ type: 'image', layer: 'foreground' }), false);
  // спрятанный на слое мастера токен тоже может попасться (его ловят ловушки «на всех»)
  assert.equal(isTrapVictim({ type: 'shape', layer: 'gm' }), true);
  assert.equal(isTrapVictim({ type: 'text', layer: 'objects' }), false);
  assert.equal(isTrapVictim({ type: 'shape', layer: 'objects', trap: {} }), false);
});

test('выбор кубиков: мусор не проходит, неизвестный набор — цвет игрока', () => {
  assert.deepEqual(cleanDiceStyle(null), { skin: 'player', fx: 'auto' });
  assert.deepEqual(cleanDiceStyle({ skin: 'lava', fx: 'sparks' }), { skin: 'lava', fx: 'sparks' });
  assert.deepEqual(cleanDiceStyle({ skin: '<b>', fx: 'x'.repeat(40) }), { skin: 'player', fx: 'auto' });
  assert.ok(ROLL_FX.length >= 14);
  assert.equal(new Set(DICE_SKINS.map((s) => s.id)).size, DICE_SKINS.length);
  // неизвестный набор — как «цвет игрока»
  assert.equal(skinLook('нет-такого', '#336699').body, '#336699');
  // отброшенный кубик блёклый и без узора и свечения
  const lava = skinLook('lava', '#fff', true);
  assert.equal(lava.glow, null);
  assert.equal(lava.pattern, null);
  assert.notEqual(skinLook('lava', '#fff').key, lava.key);
  // светлое тело — тёмные цифры, тёмное — светлые
  assert.equal(skinLook('player', '#f0f0f0').ink, '#1d1813');
  assert.equal(skinLook('player', '#202020').ink, '#fbf5e6');
});
