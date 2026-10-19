// Пример стола «Логово гоблинов»: карта со стенами и дверями, костёр, герой, гоблины, памятка.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { db, now } from './db.js';
import { newId } from '../shared/ids.js';
import { PAGE_DEFAULTS, TOKEN_DEFAULTS, GAME_STATE_DEFAULTS, newBar } from '../shared/defaults.js';
import { createGame } from './api/games.js';

const DIR = path.join(ROOT, 'server', 'demo');
const clone = (o) => JSON.parse(JSON.stringify(o));

const GUIDE = `## Добро пожаловать в «Таверну»!

Это пример стола: подземелье с гоблинами, готовое к игре.

**Мастеру**
- Пригласите игроков: вкладка **Настройки** справа → «копировать ссылку».
- Отдайте игроку героя: откройте «Тарен» в журнале → «Био и права» → «Управляют».
- Хобгоблин-вожак спрятан на **слое мастера** — перетащите его на слой токенов, когда придёт время.
- Включён **динамический свет**: игроки видят только то, что освещено и в поле зрения героя. Двери открываются щелчком по значку.
- Правая кнопка по токену — маркеры, бары, порядок ходов. Кружки над выделенным токеном — быстрое изменение HP.
- Линейка умеет рисовать области заклинаний: круг, конус, куб, луч.

- Метки на карте (значок капли): у костра — заметка для игроков, у сундука — подсказка только для вас.

**Игрокам**
- Двигайте своего героя мышью или пальцем; стены не пускают. Пробел во время перетаскивания — точка поворота пути.
- Выделите героя — внизу появится кнопка «Длинный-меч»: это атака с его листа D&D 5E. Щелчок по названию атаки в чате бросает урон.
- Броски: \`/r 1d20+5\`, в тексте — \`[[2d6+3]]\`, шёпот мастеру — \`/w gm текст\`.
- Кнопку броска из листа персонажа можно перетащить на панель внизу экрана.
- Голосовой чат — кнопка «Голос» вверху.

Справка по клавишам — значок «i» вверху справа.`;

const NOTE = `Нацарапано углём на клочке кожи:

*«Большой Грук велел не трогать сундук. Кто тронет — тому палкой!»*`;

/** Атрибуты, снятые с настоящего листа D&D 5E (scripts/… через его скрипты): [имя, текущее, макс] */
function sheetAttrs(file, extra = []) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    // строки повторяющихся секций показываем свёрнутыми, NPC — блоком характеристик, а не настройками
    const rows = new Set(list.map(([n]) => /^(repeating_[^_]+_[^_]+)_/i.exec(n)?.[1]).filter(Boolean));
    const flags = [...rows].map((r) => [r.startsWith('repeating_npcaction') ? `${r}_npc_options-flag` : `${r}_options-flag`, '0']);
    return [...list, ...flags, ...extra];
  } catch {
    return extra;
  }
}

export function createDemoGame(ownerId) {
  const layout = JSON.parse(fs.readFileSync(path.join(DIR, 'layout.json'), 'utf8'));
  const sheet = db.prepare(`SELECT id FROM sheets WHERE source='builtin' AND source_ref='DD5thEditionLegacy'`).get();
  const gameId = createGame({ name: 'Пример: Логово гоблинов', ownerId, sheetId: sheet?.id || null, description: 'Демонстрационный стол: карта, свет, токены и памятка' });
  const game = db.prepare(`SELECT * FROM games WHERE id=?`).get(gameId);
  const state = JSON.parse(game.state);
  const pageId = state.playerPageId;
  const cs = layout.cell;
  const t = now();
  const ins = db.prepare(`INSERT INTO entities(id, game_id, type, parent_id, data, updated_at) VALUES (?,?,?,?,?,?)`);
  const insA = db.prepare(`INSERT INTO attributes(id, game_id, char_id, name, current, max) VALUES (?,?,?,?,?,?)`);
  let z = 1;
  const obj = (data) => {
    const id = newId();
    ins.run(id, gameId, 'obj', pageId, JSON.stringify({ ...clone(TOKEN_DEFAULTS), z: z++, pageId, ...data }), t);
    return id;
  };
  const ent = (type, data) => {
    const id = newId();
    ins.run(id, gameId, type, null, JSON.stringify(data), t);
    return id;
  };
  const attrs = (charId, list) => {
    const byName = new Map();
    for (const [name, cur, max = ''] of list) byName.set(String(name).toLowerCase(), [name, cur, max ?? '']);
    for (const [name, cur, max] of byName.values()) insA.run(newId(), gameId, charId, name, JSON.stringify(cur), JSON.stringify(max));
  };
  const at = ([cx, cy], size = 1) => ({ x: cx * cs, y: cy * cs, w: cs * size, h: cs * size });

  db.transaction(() => {
    // сцена
    const page = {
      ...clone(PAGE_DEFAULTS),
      name: 'Логово гоблинов',
      width: layout.width,
      height: layout.height,
      cellSize: cs,
      gridOpacity: 0.12,
      bgColor: '#26221f',
      // полная темнота + режим исследователя: увиденное остаётся на карте приглушённым
      lighting: { ...clone(PAGE_DEFAULTS.lighting), enabled: true, darkness: 1, explorer: true },
      order: 0,
    };
    db.prepare(`UPDATE entities SET data=?, updated_at=? WHERE id=? AND game_id=?`).run(JSON.stringify(page), t, pageId, gameId);

    // карта, стены, двери, костёр
    obj({ type: 'image', src: layout.map, name: 'Карта', layer: 'map', locked: true, x: 0, y: 0, w: layout.width * cs, h: layout.height * cs });
    for (const pts of layout.walls) obj({ type: 'wall', layer: 'walls', wallType: 'wall', pts, x: 0, y: 0, w: 0, h: 0 });
    for (const pts of layout.doors) obj({ type: 'wall', layer: 'walls', wallType: 'door', open: false, pts, x: 0, y: 0, w: 0, h: 0 });
    const [fx, fy] = layout.fire;
    obj({ type: 'shape', shape: 'ellipse', name: 'Костёр', layer: 'walls', fill: '', stroke: '', strokeWidth: 0, x: fx - cs / 4, y: fy - cs / 4, w: cs / 2, h: cs / 2, light: { enabled: true, bright: 15, dim: 15, color: '#ffa850', angle: 360, dir: 0, intensity: 1 } });

    // герой
    const hero = ent('char', {
      name: 'Тарен',
      avatar: '/demo/paladin.png',
      bio: 'Паладин ордена Рассвета. Отправился в логово гоблинов, чтобы вернуть украденную реликвию.',
      gmnotes: '',
      controlledBy: [],
      inJournals: ['all'],
      abilities: [{ id: newId(), name: 'Длинный-меч', action: '%{Тарен|repeating_attack_$0_attack}', istokenaction: true }],
      defaultToken: null,
      folder: 'Герои',
      archived: false,
      tags: [],
      createdAt: t,
    });
    // паладин 3 уровня: сила 16, кольчуга и щит (КД 18), 24 из 28 хитов, длинный меч
    attrs(hero, sheetAttrs('hero-attrs.json', [['hp', '24', '28']]));
    obj({
      ...at(layout.spots.hero),
      type: 'image',
      src: '/demo/paladin.png',
      name: 'Тарен',
      showName: true,
      represents: hero,
      bars: [newBar(2, { name: 'HP', color: '#d63a3a', link: 'hp', value: 24, max: 28 })],
      vision: { enabled: true, range: 0, darkvision: 0, angle: 360 },
      light: { enabled: true, bright: 20, dim: 20, color: '#ffb060', angle: 360, dir: 0, intensity: 0.9 },
    });

    // гоблины (один персонаж — несколько токенов со своими HP)
    const gob = ent('char', {
      name: 'Гоблин',
      avatar: '/demo/goblin.png',
      bio: 'Маленький злобный гуманоид. КД 15, 7 хитов, скимитар +4 (1d6+2).',
      gmnotes: 'Трусливы: при потере половины отряда бегут к вожаку.',
      controlledBy: [],
      inJournals: [],
      abilities: [
        { id: newId(), name: 'Скимитар', action: '%{Гоблин|repeating_npcaction_$0_npc_action}', istokenaction: true },
        { id: newId(), name: 'Лук', action: '%{Гоблин|repeating_npcaction_$1_npc_action}', istokenaction: true },
      ],
      defaultToken: null,
      folder: 'Противники',
      archived: false,
      tags: [],
      createdAt: t,
    });
    attrs(gob, sheetAttrs('goblin-attrs.json', [['npc_options-flag', '0']]));
    layout.spots.goblins.forEach((p, i) =>
      obj({ ...at(p), type: 'image', src: '/demo/goblin.png', name: i ? `Гоблин ${i + 1}` : 'Гоблин', showName: true, represents: gob, bars: [newBar(2, { name: 'HP', color: '#d63a3a', value: 7, max: 7, visibility: 'gm' })] }),
    );

    // вожак — спрятан на слое мастера
    const boss = ent('char', {
      name: 'Хобгоблин Грук',
      avatar: '/demo/hobgoblin.png',
      bio: 'Вожак шайки. КД 18, 26 хитов, длинный меч +3 (1d8+1, +2d6 при преимуществе).',
      gmnotes: 'Сидит в логове у сундука. Сдаётся, если хиты падают ниже 8.',
      controlledBy: [],
      inJournals: [],
      abilities: [{ id: newId(), name: 'Длинный-меч', action: '%{Хобгоблин Грук|repeating_npcaction_$0_npc_action}', istokenaction: true }],
      defaultToken: null,
      folder: 'Противники',
      archived: false,
      tags: [],
      createdAt: t,
    });
    attrs(boss, sheetAttrs('boss-attrs.json', [['npc_options-flag', '0']]));
    obj({ ...at(layout.spots.boss), type: 'image', src: '/demo/hobgoblin.png', name: 'Грук', showName: true, layer: 'gm', represents: boss, bars: [newBar(2, { name: 'HP', color: '#d63a3a', value: 26, max: 26, visibility: 'gm' })] });

    // памятка и записка
    ent('handout', { name: 'Памятка: с чего начать', avatar: '', notes: GUIDE, gmnotes: '', inJournals: ['all'], controlledBy: [], folder: '', archived: false });
    const note = ent('handout', { name: 'Записка гоблинов', avatar: '', notes: NOTE, gmnotes: 'Покажите игрокам, когда они обыщут казарму.', inJournals: [], controlledBy: [], folder: 'Находки', archived: false });

    // метки на карте: одна для игроков у костра, другая — подсказка мастеру у сундука
    const pin = (cx, cy, data) => obj({ type: 'pin', showName: true, handoutId: '', color: '#c9a24a', bars: [], x: Math.round(cx * cs - cs * 0.3), y: Math.round(cy * cs - cs * 0.6), w: Math.round(cs * 0.6), h: Math.round(cs * 0.6), ...data });
    pin(7.2, 3.4, { name: 'Кострище', notes: 'Угли ещё тёплые — гоблины ушли совсем недавно. В золе что-то блестит.' });
    pin(layout.spots.treasure[0] + 0.5, layout.spots.treasure[1], { name: 'Сундук Грука', layer: 'gm', color: '#b23a48', handoutId: note, notes: 'Заперт. Внутри: 120 зм, зелье лечения и записка (материал «Записка гоблинов»).' });

    // таблица и макрос
    ent('rtable', {
      name: 'находка',
      showPlayers: true,
      items: [
        { id: newId(), name: 'Мешочек с 2d6 серебряными', weight: 3 },
        { id: newId(), name: 'Ржавый кинжал', weight: 3 },
        { id: newId(), name: 'Зелье лечения', weight: 1 },
        { id: newId(), name: 'Карта с отметкой «сундук»', weight: 1 },
      ],
    });
    ent('macro', { name: 'находка', action: '/r 1t[находка]', visibleTo: 'all', istokenaction: false, ownerId });

    db.prepare(`UPDATE games SET state=? WHERE id=?`).run(JSON.stringify({ ...GAME_STATE_DEFAULTS, ...state, playerPageId: pageId }), gameId);
  })();
  return gameId;
}
