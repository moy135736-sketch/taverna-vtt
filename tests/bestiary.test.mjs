// Бестиарий: разбор Markdown SRD 5.2.1 и JSON в духе Open5e, действия → броски, персонаж и токен из монстра,
// ссылки на GitHub, загрузка через сервер
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseSrdMarkdown,
  parseBestiary,
  fromOpen5e,
  parseAction,
  actionMacro,
  traitMacro,
  gmOnly,
  initiativeMacro,
  saveMacro,
  monsterAbilities,
  monsterAttrs,
  monsterToken,
  monsterCharacter,
  tokenImage,
  initials,
  githubRawUrls,
  uniqueIds,
  crValue,
  pbOfCr,
  typeKey,
} from '../shared/bestiary.js';
import { nameRu, TYPES_RU } from '../client/src/game/bestiary/namesRu.js';
import { fetchGithubText, BESTIARY_MAX_BYTES } from '../server/api/bestiary.js';

const GOBLIN_MD = `# Monsters A–Z

## Goblins

### Goblin Warrior

_Small Fey (Goblinoid), Chaotic Neutral_

**AC** 15 **Initiative** +2 (12) <br>
**HP** 10 (3d6) <br>
**Speed** 30 ft. <br>

<table>
  <tbody>
    <tr>
      <td><strong>STR</strong></td><td>8</td><td>−1</td><td>−1</td>
      <td><strong>DEX</strong></td><td>15</td><td>+2</td><td>+2</td>
      <td><strong>CON</strong></td><td>10</td><td>+0</td><td>+0</td>
    </tr>
    <tr>
      <td><strong>INT</strong></td><td>10</td><td>+0</td><td>+0</td>
      <td><strong>WIS</strong></td><td>8</td><td>−1</td><td>−1</td>
      <td><strong>CHA</strong></td><td>8</td><td>−1</td><td>−1</td>
    </tr>
  </tbody>
</table>

**Skills** Stealth +6<br>
**Gear** Leather Armor, Scimitar, Shield, Shortbow<br>
**Senses** Darkvision 60 ft.; Passive Perception 9<br>
**Languages** Common, Goblin<br>
**CR** 1/4 (XP 50; PB +2)

#### Actions

<hr>

**_Scimitar._** _Melee Attack Roll:_ +4, reach 5 ft. _Hit:_ 5 (1d6 + 2) Slashing damage, plus 2 (1d4) Slashing damage if the attack roll had Advantage.

**_Shortbow._** _Ranged Attack Roll:_ +4, range 80/320 ft. _Hit:_ 5 (1d6 + 2) Piercing damage, plus 2 (1d4) Piercing damage if the attack roll had Advantage.

#### Bonus Actions

<hr>

**_Nimble Escape._** The goblin takes the Disengage or Hide action.

### Goblin Boss

_Small Fey (Goblinoid), Chaotic Neutral_

**AC** 17 **Initiative** +2 (12) <br>
**HP** 21 (6d6) <br>
**CR** 1 (XP 200; PB +2)
`;

const builtin = JSON.parse(fs.readFileSync(new URL('../client/public/srd/monsters.json', import.meta.url), 'utf8'));
const byName = (n) => builtin.monsters.find((m) => m.name === n);

test('Markdown SRD 5.2.1: гоблин целиком', () => {
  const [g, boss] = parseSrdMarkdown(GOBLIN_MD);
  assert.equal(g.name, 'Goblin Warrior');
  assert.equal(g.id, 'goblin-warrior');
  assert.equal(g.group, 'Goblins');
  assert.equal(g.size, 'Small');
  assert.equal(g.type, 'Fey (Goblinoid)');
  assert.equal(g.alignment, 'Chaotic Neutral');
  assert.equal(g.ac, 15);
  assert.equal(g.init, 2);
  assert.equal(g.hp, 10);
  assert.equal(g.hpFormula, '3d6');
  assert.equal(g.speed, '30 ft.');
  assert.deepEqual(g.abil.str, [8, -1, -1]);
  assert.deepEqual(g.abil.dex, [15, 2, 2]);
  assert.deepEqual(g.abil.cha, [8, -1, -1]);
  assert.equal(g.skills, 'Stealth +6');
  assert.equal(g.senses, 'Darkvision 60 ft.; Passive Perception 9');
  assert.equal(g.cr, '1/4');
  assert.equal(g.xp, 50);
  assert.equal(g.pb, 2);
  assert.deepEqual(
    g.actions.map((a) => a.name),
    ['Scimitar', 'Shortbow'],
  );
  assert.match(g.actions[0].text, /^_Melee Attack Roll:_ \+4, reach 5 ft\./);
  assert.deepEqual(g.bonus, [{ name: 'Nimble Escape', text: 'The goblin takes the Disengage or Hide action.' }]);
  assert.equal(boss.name, 'Goblin Boss');
  assert.equal(boss.ac, 17);
  assert.equal(boss.cr, '1');
  assert.equal(boss.xp, 200);
});

test('атака: бонус, досягаемость, урон и урон с условием', () => {
  const a = parseAction(byName('Goblin Warrior').actions[0].text);
  assert.deepEqual(a.attack, { kind: 'Melee', bonus: 4, reach: 'reach 5 ft' });
  assert.equal(a.save, null);
  assert.deepEqual(a.damage, [
    { dice: '1d6+2', type: 'Slashing', avg: 5 },
    { dice: '1d4', type: 'Slashing', avg: 2, cond: 'if the attack roll had Advantage' },
  ]);
  const both = parseAction('_Melee or Ranged Attack Roll:_ +5, reach 5 ft. or range 20/60 ft. _Hit:_ 6 (1d6 + 3) Piercing damage.');
  assert.equal(both.attack.kind, 'Melee or Ranged');
  assert.equal(both.attack.reach, 'reach 5 ft. or range 20/60 ft');
  assert.deepEqual(both.damage, [{ dice: '1d6+3', type: 'Piercing', avg: 6 }]);
});

test('старый SRD 5.1 (2014), как в JSON Open5e: атаки «to hit» и спасбросок «on a failed save»', () => {
  const a = parseAction('Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.');
  assert.deepEqual(a.attack, { kind: 'Melee', bonus: 4, reach: 'reach 5 ft., one target' });
  assert.deepEqual(a.damage, [{ dice: '1d6+2', type: 'Slashing', avg: 5 }]);
  const two = parseAction('Melee Weapon Attack: +6 to hit, reach 5 ft., one target. Hit: 7 (1d8 + 3) piercing damage plus 7 (2d6) poison damage.');
  assert.deepEqual(
    two.damage.map((d) => [d.dice, d.type]),
    [
      ['1d8+3', 'Piercing'],
      ['2d6', 'Poison'],
    ],
  );
  const spell = parseAction('Ranged Spell Attack: +5 to hit, range 120 ft., one target. Hit: 10 (3d6) fire damage.');
  assert.equal(spell.attack.kind, 'Ranged');
  assert.equal(spell.damage[0].dice, '3d6');
  const breath = parseAction('The dragon exhales fire in a 60-foot cone. Each creature in that area must make a DC 21 Dexterity saving throw, taking 63 (18d6) fire damage on a failed save, or half as much damage on a successful one.');
  assert.deepEqual(breath.save, { ability: 'dex', dc: 21, target: '' });
  assert.deepEqual(breath.damage, [{ dice: '18d6', type: 'Fire', avg: 63 }]);
  assert.equal(breath.success, 'Half damage.');
  assert.match(actionMacro({ name: 'Fire Breath', text: 'Each creature must make a DC 21 Dexterity saving throw, taking 63 (18d6) fire damage on a failed save, or half as much damage on a successful one.' }, {}), /\{\{При провале=\[\[18d6\]\] Fire/);
  // «10 extra damage» без типа — не урон
  assert.deepEqual(parseAction('The target takes 10 extra damage.').damage, []);
});

test('спасбросок: Сл, провал и успех', () => {
  const breath = byName('Adult Red Dragon').actions.find((e) => /Fire Breath/.test(e.name));
  const a = parseAction(breath.text);
  assert.equal(a.attack, null);
  assert.equal(a.save.ability, 'dex');
  assert.equal(a.save.dc, 21);
  assert.match(a.save.target, /Cone/);
  assert.deepEqual(a.damage, [{ dice: '17d6', type: 'Fire', avg: 59 }]);
  assert.equal(a.success, 'Half damage.');
  const m = actionMacro(breath, byName('Adult Red Dragon'));
  assert.match(m, /\{\{Спасбросок=Ловкость, Сл 21/);
  assert.match(m, /\{\{При провале=\[\[17d6\]\] Fire/);
  assert.match(m, /\{\{При успехе=Half damage\.\}\}/);
});

test('карточка действия: шаблон default, безопасный текст', () => {
  const g = byName('Goblin Warrior');
  const m = actionMacro(g.actions[0], g);
  assert.equal(m, '&{template:default} {{name=Scimitar}} {{Атака=[[1d20+4]] — reach 5 ft}} {{Урон=[[1d6+2]] Slashing}} {{Ещё урон=[[1d4]] Slashing — if the attack roll had Advantage}}');
  // «}}» и «[[» из чужого файла не ломают шаблон
  const evil = actionMacro({ name: 'Bad }} name', text: 'Does [[1d100]] things }} and more' }, g);
  assert.ok(!/\[\[1d100\]\]/.test(evil));
  assert.ok(!/Bad \}\} name/.test(evil));
  assert.equal(traitMacro({ name: 'Pack }} Tactics', text: 'Line one\nline [[two]]' }), '&{template:default} {{name=Pack } } Tactics}} {{Описание=Line one; line [ [two] ]}}');
});

test('инициатива, спасбросок с выбором, только мастеру', () => {
  const g = byName('Goblin Warrior');
  assert.equal(initiativeMacro(g), '/r 1d20+2 [Инициатива] &{tracker}');
  assert.equal(initiativeMacro({ init: -1 }), '/r 1d20-1 [Инициатива] &{tracker}');
  assert.match(saveMacro(g), /\?\{Спасбросок\|Сила \(−1\),-1\|Ловкость \(\+2\),2\|/);
  assert.equal(gmOnly('/r 1d20+2 &{tracker}'), '/gr 1d20+2 &{tracker}');
  assert.equal(gmOnly('/roll 1d20'), '/gr 1d20');
  assert.equal(gmOnly('&{template:default} {{name=X}}'), '/w gm &{template:default} {{name=X}}');
  assert.equal(gmOnly('/w gm hi'), '/w gm hi');
  assert.equal(gmOnly('/gr 1d4'), '/gr 1d4');
});

test('кнопки токена: ссылки на места статблока', () => {
  let n = 0;
  const abs = monsterAbilities(byName('Adult Red Dragon'), () => 'id' + n++);
  assert.deepEqual(abs.slice(0, 2).map((a) => a.ref), ['init', 'save']);
  assert.ok(abs.every((a) => a.istokenaction && a.id && a.action));
  assert.ok(abs.some((a) => a.ref === 'legendary:0' && /\(легенд\.\)$/.test(a.name)));
  const refs = abs.map((a) => a.ref);
  assert.equal(new Set(refs).size, refs.length);
});

test('атрибуты для листа D&D 2024', () => {
  const at = Object.fromEntries(monsterAttrs(byName('Goblin Warrior')).map((a) => [a.name, a]));
  assert.deepEqual(at.hp, { name: 'hp', current: 10, max: 10 });
  assert.equal(at.ac.current, 15);
  assert.equal(at.dexterity.current, 15);
  assert.equal(at.strength.current, 8);
  assert.equal(at.dexterity_save_prof.current, '0');
  assert.equal(at.initiative_misc.current, 0);
  assert.equal(at.speed.current, 30);
  // Stealth +6 при Ловкости +2 и БМ +2 — экспертиза
  assert.equal(at.stealth_prof.current, '2');
  assert.equal(at.initiative_bonus.current, 2);
  assert.equal(at.npc, undefined);
  const dragon = Object.fromEntries(monsterAttrs(byName('Adult Red Dragon')).map((a) => [a.name, a]));
  assert.equal(dragon.dexterity_save_prof.current, '1');
  assert.equal(dragon.pb_custom.current, 6);
  assert.equal(dragon.perception_prof?.current, '2');
});

test('токен: размер в клетках, полоса хитов, картинка с инициалами', () => {
  assert.equal(initials('Goblin Warrior'), 'GW');
  assert.equal(initials('Owlbear'), 'Ow');
  assert.equal(initials('Swarm of Bats'), 'SB');
  const t = monsterToken(byName('Adult Red Dragon'));
  assert.equal(t.cells, 3);
  assert.equal(t.bars[0].link, 'hp');
  assert.equal(t.bars[0].max, byName('Adult Red Dragon').hp);
  assert.equal(monsterToken(byName('Goblin Warrior')).cells, 1);
  assert.equal(monsterToken({ ...byName('Goblin Warrior'), size: 'Tiny' }).cells, 0.5);
  const svg = decodeURIComponent(tokenImage({ name: 'A<b>"&', type: 'Dragon' }).split(',')[1]);
  assert.match(svg, /^<svg /);
  assert.ok(!svg.includes('<b>'));
});

test('персонаж из монстра: папка, статблок, источник', () => {
  let n = 0;
  const ch = monsterCharacter(byName('Goblin Warrior'), () => 'x' + n++, { source: 'SRD 5.2.1', nameRu: 'Гоблин-воин' });
  assert.equal(ch.folder, 'Монстры');
  assert.equal(ch.statblock.source, 'SRD 5.2.1');
  assert.equal(ch.statblock.nameRu, 'Гоблин-воин');
  assert.equal(ch.statblock.id, 'goblin-warrior');
  assert.match(ch.bio, /Гоблин-воин/);
  assert.equal(ch.defaultToken.name, 'Goblin Warrior');
  assert.ok(JSON.stringify(ch).length < 60000);
});

test('JSON в духе Open5e: объект, массив, results; мусор отбрасывается', () => {
  const ogre = {
    name: 'Ogre',
    size: 'large',
    type: 'giant',
    alignment: 'chaotic evil',
    armor_class: 11,
    armor_desc: 'hide armor',
    hit_points: 68,
    hit_dice: '8d10+24',
    speed: { walk: 40, fly: 10, hover: true },
    strength: 19,
    dexterity: 8,
    constitution: 16,
    intelligence: 5,
    wisdom: 7,
    charisma: 7,
    wisdom_save: 0,
    skills: { perception: 2, sleight_of_hand: 1 },
    damage_resistances: ['Cold'],
    condition_immunities: 'Charmed',
    challenge_rating: '2',
    actions: [{ name: 'Greatclub.', desc: 'Melee Attack Roll: +6, reach 5 ft. Hit: 13 (2d8 + 4) Bludgeoning damage.' }],
    special_abilities: [{ name: 'Big', desc: 'It is big.' }],
  };
  const m = fromOpen5e(ogre, 'ogre-x');
  assert.equal(m.id, 'ogre-x');
  assert.equal(m.size, 'Large');
  assert.equal(m.type, 'Giant');
  assert.equal(m.ac, 11);
  assert.equal(m.acNote, 'hide armor');
  assert.equal(m.speed, '40 ft., Fly 10 ft. (hover)');
  assert.deepEqual(m.abil.str, [19, 4, 4]);
  assert.deepEqual(m.abil.wis, [7, -2, 0]);
  assert.equal(m.init, -1);
  assert.equal(m.skills, 'Perception +2, Sleight of hand +1');
  // как в gist «dnd_srd_5_2_1__monsters.json»: сверху «_info», Внимательность — полем perception
  const gist = { _info: 'Source file for all monsters based on D&D SRD 5.2.1', aboleth: { name: 'Aboleth', slug: 'aboleth', group: null, size: 'Large', type: 'aberration', armor_class: 17, initiative: 7, hit_points: 150, hit_dice: '20d10 + 40', speed: { walk: 10, swim: 40 }, strength: 21, dexterity: 9, dexterity_save: 3, wisdom: 15, perception: 10, challenge_rating: '10', actions: [{ name: 'Tentacle', desc: 'Melee Attack Roll: +9, reach 15 ft. Hit: 12 (2d6 + 5) Bludgeoning damage.', damage_dice: '2d6' }] } };
  const [ab] = parseBestiary(JSON.stringify(gist));
  assert.equal(ab.name, 'Aboleth');
  assert.equal(ab.init, 7);
  assert.equal(ab.skills, 'Perception +10');
  assert.deepEqual(ab.abil.dex, [9, -1, 3]);
  assert.equal(ab.hpFormula, '20d10 + 40');
  assert.equal(ab.speed, '10 ft., Swim 40 ft.');
  assert.equal(parseAction(ab.actions[0].text).damage[0].dice, '2d6+5');
  assert.equal(m.immunities, 'Charmed');
  assert.equal(m.actions[0].name, 'Greatclub');
  assert.equal(m.xp, 450);
  for (const text of [JSON.stringify({ ogre }), JSON.stringify([ogre]), JSON.stringify({ results: [ogre] })]) {
    const list = parseBestiary(text);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Ogre');
  }
  assert.deepEqual(parseBestiary(JSON.stringify({ a: { name: 'not a monster' }, b: 5 })), []);
  assert.throws(() => parseBestiary('{ broken'), /JSON/);
  // поля из чужого файла приводятся к своим и обрезаются
  const [weird] = parseBestiary(JSON.stringify([{ ...ogre, name: 'X'.repeat(500), size: 'Colossal', hit_points: -5, evil: '<script>' }]));
  assert.equal(weird.name.length, 120);
  assert.equal(weird.size, 'Medium');
  assert.equal(weird.hp, 1);
  assert.equal(weird.evil, undefined);
});

test('встроенный бестиарий: 330 монстров SRD 5.2.1, разбирается заново без потерь', () => {
  assert.equal(builtin.source, 'SRD 5.2.1');
  assert.equal(builtin.license, 'CC BY 4.0');
  assert.equal(builtin.monsters.length, 330);
  const again = parseBestiary(JSON.stringify(builtin));
  assert.equal(again.length, 330);
  assert.deepEqual(again[0], builtin.monsters[0]);
  for (const m of builtin.monsters) {
    assert.ok(m.name && m.hp >= 1 && m.ac > 0, m.name);
    assert.ok(TYPES_RU[typeKey(m.type)], 'тип ' + m.type);
    assert.ok(nameRu(m.name), 'русское имя ' + m.name);
    assert.equal(m.pb, pbOfCr(m.cr), 'БМ ' + m.name);
  }
  const attacks = builtin.monsters.flatMap((m) => m.actions).filter((e) => parseAction(e.text).attack).length;
  assert.ok(attacks > 400, 'атак ' + attacks);
});

test('русские имена и опасность', () => {
  assert.equal(nameRu('Goblin Warrior'), 'Гоблин-воин');
  assert.equal(nameRu('Adult Red Dragon'), 'Взрослый красный дракон');
  assert.equal(nameRu('Red Dragon Wyrmling'), 'Вирмлинг красного дракона');
  assert.equal(nameRu('Nobody Knows'), '');
  assert.equal(crValue('1/4'), 0.25);
  assert.equal(crValue('1/8'), 0.125);
  assert.equal(crValue('17'), 17);
  assert.equal(pbOfCr('1/2'), 2);
  assert.equal(pbOfCr('5'), 3);
  assert.equal(pbOfCr('30'), 9);
});

test('ссылки GitHub → файлы для скачивания', () => {
  assert.deepEqual(githubRawUrls('https://gist.github.com/krisimmig/f4b7d2a30cadd2d94107f5533ba9c85c'), ['https://gist.githubusercontent.com/krisimmig/f4b7d2a30cadd2d94107f5533ba9c85c/raw']);
  assert.deepEqual(githubRawUrls(' https://gist.github.com/krisimmig/f4b7d2a30cadd2d94107f5533ba9c85c#file-monsters-json '), ['https://gist.githubusercontent.com/krisimmig/f4b7d2a30cadd2d94107f5533ba9c85c/raw']);
  assert.deepEqual(githubRawUrls('https://gist.github.com/u/abc123/raw/def/m.json'), ['https://gist.githubusercontent.com/u/abc123/raw/def/m.json']);
  assert.deepEqual(githubRawUrls('https://github.com/downfallx/dnd-5e-srd-markdown'), [
    'https://raw.githubusercontent.com/downfallx/dnd-5e-srd-markdown/HEAD/monsters-A-Z.md',
    'https://raw.githubusercontent.com/downfallx/dnd-5e-srd-markdown/HEAD/animals.md',
  ]);
  assert.deepEqual(githubRawUrls('https://github.com/a/b/blob/main/dir/m.json'), ['https://raw.githubusercontent.com/a/b/main/dir/m.json']);
  assert.deepEqual(githubRawUrls('https://raw.githubusercontent.com/a/b/HEAD/x.md'), ['https://raw.githubusercontent.com/a/b/HEAD/x.md']);
  assert.deepEqual(githubRawUrls(''), []);
});

test('одинаковые id получают номера', () => {
  assert.deepEqual(
    uniqueIds([{ id: 'bat' }, { id: 'bat' }, { id: 'cat' }, { id: 'bat' }]).map((m) => m.id),
    ['bat', 'bat-2', 'cat', 'bat-3'],
  );
});

// --- загрузка через сервер: только GitHub, перенаправления — тоже только туда ---
const resp = (status, body = '', headers = {}) => new Response(status >= 300 && status < 400 ? null : body, { status, headers });

test('сервер: только raw.githubusercontent.com и gist.githubusercontent.com', async () => {
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(u);
    return resp(200, 'ok');
  };
  assert.equal(await fetchGithubText('https://raw.githubusercontent.com/a/b/HEAD/x.md', { fetchImpl }), 'ok');
  await assert.rejects(fetchGithubText('https://example.com/x.json', { fetchImpl }), /только файлы/);
  await assert.rejects(fetchGithubText('http://raw.githubusercontent.com/a/b/HEAD/x.md', { fetchImpl }), /только файлы/);
  await assert.rejects(fetchGithubText('http://127.0.0.1:3000/api', { fetchImpl }), /только файлы/);
  await assert.rejects(fetchGithubText('not a url', { fetchImpl }), /Неверная ссылка/);
  assert.equal(calls.length, 1);
});

test('сервер: перенаправления внутри GitHub, наружу — нет; 404 и размер', async () => {
  const route = {
    'https://gist.githubusercontent.com/u/1/raw': resp(302, '', { location: '/u/1/raw/abc/m.json' }),
    'https://gist.githubusercontent.com/u/1/raw/abc/m.json': resp(200, '{"a":1}'),
    'https://gist.githubusercontent.com/u/2/raw': resp(301, '', { location: 'https://evil.example/x' }),
    'https://raw.githubusercontent.com/a/b/HEAD/none.md': resp(404, 'nope'),
    'https://raw.githubusercontent.com/a/b/HEAD/big.md': resp(200, 'x', { 'content-length': String(BESTIARY_MAX_BYTES + 1) }),
  };
  const fetchImpl = async (u) => route[u] || resp(500);
  assert.equal(await fetchGithubText('https://gist.githubusercontent.com/u/1/raw', { fetchImpl }), '{"a":1}');
  await assert.rejects(fetchGithubText('https://gist.githubusercontent.com/u/2/raw', { fetchImpl }), /только файлы/);
  await assert.rejects(fetchGithubText('https://raw.githubusercontent.com/a/b/HEAD/none.md', { fetchImpl }), /404/);
  await assert.rejects(fetchGithubText('https://raw.githubusercontent.com/a/b/HEAD/big.md', { fetchImpl }), /слишком большой/);
  // бесконечные перенаправления
  const loop = async () => resp(302, '', { location: 'https://raw.githubusercontent.com/a/b/HEAD/loop' });
  await assert.rejects(fetchGithubText('https://raw.githubusercontent.com/a/b/HEAD/loop', { fetchImpl: loop }), /перенаправлений/);
});
