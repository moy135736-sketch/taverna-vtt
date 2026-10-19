// Контекстное меню токенов и карты
import { MARKERS, LAYER_NAMES, MOVE_STYLES } from '@shared/defaults.js';
import { carriersOf } from '@shared/attach.js';
import { toast, promptDialog } from '../ui/components.jsx';
import { markerDefs, markerLook, markerEntry, toggleMarker } from './effects.js';
import { TRAP_DEFAULTS } from '@shared/traps.js';

const BAR_POSITIONS = [
  ['', 'Как в настройках стола'],
  ['above', 'Над токеном'],
  ['top', 'Сверху на токене'],
  ['bottom', 'Снизу на токене'],
  ['below', 'Под токеном'],
];

const objName = (o) => o.name || (o.type === 'text' ? 'текст' : o.type === 'shape' ? 'фигура' : o.type === 'path' ? 'рисунок' : 'токен без имени');

/** Прицепить объекты к транспорту: сервер проверит права и круговые сцепки */
async function attachTo(app, objs, carrier) {
  const { store, net } = app;
  const get = (id) => store.col.obj.get(id);
  const riders = objs.filter((x) => x.id !== carrier.id && store.canControlObj(x) && !carriersOf(get, carrier).some((c) => c.id === x.id));
  if (!riders.length) return toast('Нечего прицеплять: выделите токены, которыми вы управляете', 'error');
  const res = await Promise.all(riders.map((x) => net.update('obj', x.id, { attachedTo: carrier.id })));
  const err = res.find((r) => r?.error);
  if (err) return toast(err.error, 'error');
  toast(riders.length === 1 ? `«${objName(riders[0])}» едет на «${objName(carrier)}»` : `${riders.length} объекта едут на «${objName(carrier)}»`, 'ok');
}

/** Пункты сцепки для выделенного: прицепить к другому, «везёт остальных», отцепить */
function attachItems(app, objs) {
  const { store, net } = app;
  const board = app.board();
  const mine = objs.filter((x) => store.canControlObj(x) && x.type !== 'wall' && x.type !== 'pin');
  const children = [];
  if (mine.length) {
    children.push({
      label: 'Прицепить к токену…',
      action: async () => {
        const id = await board?.pickTarget('', `Щёлкните по токену, на котором поедут выделенные (${mine.length}) — Esc, чтобы отменить`);
        const carrier = id && store.col.obj.get(id);
        if (carrier) attachTo(app, mine, carrier);
      },
    });
  }
  if (objs.length > 1) {
    for (const c of objs.slice(0, 8)) {
      if (c.type === 'wall' || c.type === 'pin') continue;
      children.push({ label: `«${objName(c)}» везёт остальных`, action: () => attachTo(app, mine, c) });
    }
  }
  const attached = mine.filter((x) => x.attachedTo);
  if (attached.length) {
    children.push('-', {
      label: attached.length === 1 ? 'Отцепить' : `Отцепить (${attached.length})`,
      action: () => attached.forEach((x) => net.update('obj', x.id, { attachedTo: '' })),
    });
  }
  const ids = new Set(objs.map((x) => x.id));
  const riders = store.objsOnPage().filter((r) => ids.has(r.attachedTo) && store.canControlObj(r));
  if (riders.length) {
    children.push({ label: `Высадить пассажиров (${riders.length})`, action: () => riders.forEach((r) => net.update('obj', r.id, { attachedTo: '' })) });
  }
  if (!children.length) return null;
  return { label: 'Сцепка', icon: 'link', children };
}

/** Кому мастер отдал токен; управляющие через анкету показаны отдельно */
function giveItems(app, objs) {
  const { store, net } = app;
  const o = objs[0];
  const players = [...store.members.values()].filter((m) => m.role !== 'gm');
  const viaChar = (x, uid) => {
    const ch = x.represents && store.col.char.get(x.represents);
    const c = ch?.controlledBy || [];
    return c.includes(uid) || c.includes('all');
  };
  const toggle = (uid) => {
    const on = (o.controlledBy || []).includes(uid);
    for (const x of objs) {
      const cur = new Set(x.controlledBy || []);
      if (on) cur.delete(uid);
      else cur.add(uid);
      net.update('obj', x.id, { controlledBy: [...cur] });
    }
    const who = uid === 'all' ? 'всем игрокам' : store.memberName(uid);
    toast(on ? `Токен больше не управляется: ${who}` : `Токен отдан: ${who}`, 'ok');
  };
  const children = [
    { label: 'Все игроки', checked: (o.controlledBy || []).includes('all'), action: () => toggle('all') },
    ...players.map((m) => {
      const through = viaChar(o, m.id) && !(o.controlledBy || []).includes(m.id);
      return { label: m.displayName + (through ? ' (через анкету)' : ''), checked: (o.controlledBy || []).includes(m.id) || through, disabled: through, action: () => toggle(m.id) };
    }),
  ];
  if (!players.length) children.push({ label: 'Игроков пока нет — пригласите их кодом стола', disabled: true });
  return { label: 'Отдать игроку', icon: 'user', children };
}

/**
 * Новое значение бара из ввода: «12», «+5», «-3», «12/20» (значение/максимум).
 * Связанный с анкетой бар меняем через атрибут (сработают скрипты листа).
 */
export function applyBarInput(app, objId, barId, text) {
  const { store, net } = app;
  const o = store.col.obj.get(objId);
  if (!o || !Array.isArray(o.bars)) return;
  const i = o.bars.findIndex((b) => b.id === barId);
  if (i < 0) return;
  const b = o.bars[i];
  let t = String(text ?? '').trim();
  if (!t) return;
  let max;
  const slash = /^([^/]*)\/(.*)$/.exec(t);
  if (slash) {
    t = slash[1].trim();
    max = slash[2].trim();
  }
  let nv = t;
  if (/^[+-]\s*\d/.test(t) && b.value !== '' && !isNaN(Number(b.value))) nv = String(Number(b.value) + Number(t.replace(/\s+/g, '')));
  else if (/^=/.test(t)) nv = t.slice(1).trim();
  const ch = o.represents && store.col.char.get(o.represents);
  if (b.link && ch && store.canControlChar(ch)) {
    const vals = {};
    if (nv !== '') vals[b.link] = nv;
    if (max !== undefined && max !== '') vals[b.link + '_max'] = max;
    app.sheets.setAttrs(ch.id, vals, { source: 'player' });
  } else {
    net.update('obj', o.id, { bars: o.bars.map((x, j) => (j === i ? { ...x, ...(nv !== '' ? { value: nv } : {}), ...(max !== undefined && max !== '' ? { max } : {}) } : x)) });
  }
}

/** Новая ловушка в клетке под курсором: невидимая игрокам фигура на слое мастера */
async function placeTrap(app, pos) {
  const { store, net } = app;
  const page = store.page;
  if (!page) return;
  const cs = page.cellSize || 70;
  const snap = page.snap !== false && page.gridType !== 'none';
  const x = snap ? Math.floor(pos.x / cs) * cs : pos.x - cs / 2;
  const y = snap ? Math.floor(pos.y / cs) * cs : pos.y - cs / 2;
  const r = await net.create('obj', { type: 'shape', shape: 'rect', pageId: page.id, layer: 'gm', x, y, w: cs, h: cs, fill: '#b23a4833', stroke: '#b23a48', strokeWidth: 2, name: 'Ловушка', trap: { ...TRAP_DEFAULTS } });
  if (r?.error) return;
  app.openTrap(r.id, { fresh: true });
}

export function tokenContextMenu(app, objs, pos) {
  const { store, net } = app;
  const board = app.board();
  const gm = store.isGM;
  if (!objs.length) {
    const items = [{ label: 'Пинг сюда', icon: 'ping', action: () => board?.ping(pos.x, pos.y) }];
    if (gm) items.push({ label: 'Пинг и переместить всех сюда', icon: 'target', action: () => board?.ping(pos.x, pos.y, true) });
    if (gm) items.push({ label: 'Поставить ловушку здесь…', icon: 'alert', action: () => placeTrap(app, pos) });
    if (board?.clipboard?.length) items.push({ label: 'Вставить', icon: 'copy', action: () => board.paste() });
    return items;
  }
  const o = objs[0];
  const single = objs.length === 1;
  const upd = (patch) => objs.forEach((x) => net.update('obj', x.id, patch));
  const items = [];
  if (o.type === 'wall') {
    if (o.wallType === 'door') items.push({ label: o.open ? 'Закрыть дверь' : 'Открыть дверь', icon: 'door', action: () => net.update('obj', o.id, { open: !o.open }) });
    items.push({ label: 'Свойства стены', icon: 'cog', action: () => app.openTokenSettings(o.id) });
    items.push('-', { label: 'Удалить', icon: 'trash', danger: true, action: () => board.deleteSelected() });
    return items;
  }
  if (o.type === 'pin' && single) {
    items.push({ label: 'Открыть метку', icon: 'ping', action: () => app.openPin(o) });
    if (gm) {
      items.push({ label: 'Настройки метки', icon: 'cog', action: () => app.openPinSettings(o.id) });
      items.push({
        label: o.layer === 'gm' ? 'Показать игрокам' : 'Спрятать от игроков',
        icon: o.layer === 'gm' ? 'eye' : 'eyeOff',
        action: () => net.update('obj', o.id, { layer: o.layer === 'gm' ? 'objects' : 'gm' }),
      });
      items.push('-', { label: 'Удалить', icon: 'trash', danger: true, action: () => board.deleteSelected() });
    }
    return items;
  }
  if (single) {
    items.push({ label: 'Настройки токена', icon: 'cog', action: () => app.openTokenSettings(o.id) });
    if (o.represents && store.col.char.has(o.represents)) items.push({ label: 'Открыть анкету', icon: 'scroll', action: () => app.openCharacter(o.represents) });
    if (store.canControlObj(o) && o.type !== 'path') items.push({ label: 'Макросы токена…', icon: 'bolt', action: () => app.openTokenSettings(o.id, 'actions') });
  }
  if (gm && single && (o.type === 'shape' || o.type === 'image')) items.push({ label: o.trap ? `Ловушка «${o.trap.name}»…` : 'Сделать ловушкой…', icon: 'alert', action: () => app.openTrap(o.id) });
  if (gm && objs.every((x) => x.type !== 'pin')) items.push(giveItems(app, objs));
  {
    // свои маркеры — первыми: их мастер завёл для этой игры
    const defs = markerDefs(store);
    const custom = (store.settings.markers || []).filter((m) => m && m.id);
    const list = [...custom, ...MARKERS.filter((m) => !custom.some((c) => c.id === m.id))];
    const children = list.map((m) => {
      const look = markerLook(m, defs);
      return {
        label: `${look.emoji ? look.emoji + ' ' : look.image ? '◆ ' : '● '}${m.name}`,
        checked: !!markerEntry(o, m.id),
        action: () => toggleMarker(app, objs, m.id),
      };
    });
    if (gm) children.push('-', { label: 'Свой маркер или эффект…', icon: 'plus', action: () => app.editMarker?.(null) });
    items.push({ label: 'Маркеры состояния', icon: 'flag', children });
  }
  items.push({
    label: 'Порядок ходов',
    icon: 'clock',
    action: () => {
      objs.forEach((x) => net.request('turn', { t: 'add', tokenId: x.id, pr: 0 }));
      app.openTurnTracker();
    },
  });
  if (single && o.type !== 'path') {
    items.push({
      label: 'Изменить бар…',
      icon: 'heart',
      disabled: !(o.bars || []).length,
      children: (o.bars || []).map((b, i) => ({
        label: `${b.name || 'bar' + (i + 1)}: ${b.value}${b.max !== '' ? '/' + b.max : ''}`,
        action: async () => {
          const v = await promptDialog({ title: `Новое значение: ${b.name || 'bar' + (i + 1)}`, label: 'Число, +5 / -3 для изменения, 12/20 — значение и максимум', value: '' });
          if (v === null || v.trim() === '') return;
          applyBarInput(app, o.id, b.id, v);
        },
      })),
    });
  }
  const attach = attachItems(app, objs);
  if (attach) items.push(attach);
  if (objs.every((x) => x.type === 'image' || x.type === 'shape')) {
    items.push({
      label: 'Перемещение',
      icon: 'move',
      children: [
        { label: 'Как в настройках стола', checked: !o.moveStyle, action: () => upd({ moveStyle: '' }) },
        ...Object.entries(MOVE_STYLES).map(([k, n]) => ({ label: n, checked: o.moveStyle === k, action: () => upd({ moveStyle: k }) })),
      ],
    });
  }
  if (objs.some((x) => (x.bars || []).length)) {
    items.push({
      label: 'Положение баров',
      icon: 'heart',
      children: BAR_POSITIONS.map(([v, label]) => ({ label, checked: (o.barPosition || '') === v, action: () => upd({ barPosition: v }) })),
    });
  }
  items.push('-');
  if (gm) {
    items.push({
      label: 'Слой',
      icon: 'layers',
      children: ['map', 'objects', 'foreground', 'gm', 'walls'].map((l) => ({ label: LAYER_NAMES[l], checked: o.layer === l, action: () => upd({ layer: l }) })),
    });
  }
  items.push({
    label: 'Порядок',
    icon: 'layers',
    children: [
      { label: 'На передний план', action: () => objs.forEach((x) => net.update('obj', x.id, { z: board.maxZ(x.layer) + 1 })) },
      { label: 'На задний план', action: () => objs.forEach((x) => net.update('obj', x.id, { z: Math.min(...store.objsOnPage().filter((y) => y.layer === x.layer).map((y) => y.z || 0)) - 1 })) },
    ],
  });
  items.push({
    label: 'Размер',
    icon: 'move',
    children: [0.5, 1, 2, 3, 4].map((n) => ({
      label: `${n}×${n} клеток`,
      action: () => {
        const cs = store.page?.cellSize || 70;
        upd({ w: cs * n, h: cs * n });
      },
    })),
  });
  if (gm && single && o.type === 'image') {
    items.push({ label: 'Подогнать под сетку…', icon: 'grid', action: () => board?.startGridAlign(o.id) });
  }
  if (single && Array.isArray(o.sides) && o.sides.length > 1) {
    items.push({ label: 'Следующая сторона', icon: 'refresh', action: () => net.update('obj', o.id, { side: ((o.side || 0) + 1) % o.sides.length }) });
  }
  items.push({ label: o.flipH ? 'Убрать отражение' : 'Отразить по горизонтали', icon: 'refresh', action: () => upd({ flipH: !o.flipH }) });
  if (gm) items.push({ label: o.locked ? 'Открепить' : 'Закрепить', icon: o.locked ? 'unlock' : 'lock', action: () => upd({ locked: !o.locked }) });
  items.push({ label: 'Копировать ID', icon: 'copy', disabled: !single, action: () => navigator.clipboard?.writeText(o.id).then(() => toast('ID: ' + o.id, 'ok')) });
  items.push({
    label: 'Дублировать',
    icon: 'copy',
    action: () => {
      board.copy();
      board.paste(true);
    },
  });
  if (gm || objs.every((x) => x.ownerId === store.me.id)) items.push('-', { label: 'Удалить', icon: 'trash', danger: true, action: () => board.deleteSelected() });
  return items;
}
