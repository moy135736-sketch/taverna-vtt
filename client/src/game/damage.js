// Урон и лечение из чата: щелчок по числу броска → хиты выделенных токенов меняются сразу, с отменой.
import { toast, openContextMenu } from '../ui/components.jsx';
import { applyBarInput } from './contextMenu.js';
import { num, TEMP, hpBarOf, effectiveAmount, applyHp } from './hp.js';
import { tableEffects, tokenOfChar, effectsForMessage, applyEffect } from './effects.js';

const isTokenLike = (o) => o.type !== 'wall' && o.type !== 'pin' && o.type !== 'path' && o.type !== 'text';
const tokenName = (store, o) => o.name || (o.represents && store.col.char.get(o.represents)?.name) || 'токен';

function setBar(app, o, bar, value) {
  applyBarInput(app, o.id, bar.id, '=' + value);
}

/** Временные хиты: отдельная полоса токена или атрибут персонажа (hp_temp в листе D&D 5E) */
async function tempHp(app, o, hp) {
  const { store, net } = app;
  const bar = (o.bars || []).find((b) => b !== hp && (TEMP.test(b.name || '') || TEMP.test(b.link || '')));
  if (bar) {
    const v = num(bar.value);
    if (v === null || v <= 0) return null;
    return { value: v, set: (n) => setBar(app, o, bar, n) };
  }
  const ch = hp.link && o.represents && store.col.char.get(o.represents);
  if (!ch || !store.canControlChar(ch)) return null;
  try {
    await net.ensureAttrs(ch.id);
  } catch {
    return null;
  }
  const a = store.getAttr(ch.id, hp.link + '_temp') || store.getAttr(ch.id, 'hp_temp');
  const v = num(a?.current);
  if (v === null || v <= 0) return null;
  return { value: v, set: (n) => app.sheets.setAttrs(ch.id, { [a.name]: n }, { source: 'player' }) };
}

/** Число, всплывающее над токеном у всех за столом */
function floatOver(app, o, text, heal) {
  const { store, net } = app;
  const fx = { pageId: o.pageId, type: 'float', color: heal ? 'heal' : 'dmg', x: o.x + (o.w || 70) / 2, y: o.y, custom: { text } };
  app.board()?.fx?.spawn(fx);
  // токен на слое мастера игроки не видят — и число над ним не показываем
  if (o.layer !== 'objects' && o.layer !== 'foreground') return;
  if (!store.isGM && store.settings.playersCanUseFx === false) return;
  net.request('fx', fx);
}

/** Держит концентрацию и получил урон — напомнить о спасброске Телосложения (Сл — половина урона, не меньше 10) */
function concentrationCheck(app, o, damage) {
  if (!damage || !(o.markers || []).some((m) => (typeof m === 'string' ? m : m?.id) === 'concentration')) return;
  const dc = Math.min(30, Math.max(10, Math.floor(damage / 2)));
  const hidden = o.layer === 'gm';
  app.runMacro?.(`${hidden ? '/w gm ' : ''}&{template:default} {{name=Концентрация: ${tokenName(app.store, o)}}} {{Получен урон=${damage}}} {{Спасбросок Телосложения=Сл ${dc}}}`, {});
}

/**
 * Хиты одного токена: урон (heal = false) или лечение. Возвращает {line, undo} или {skip: причина}.
 * seen — общий набор, чтобы связанные с одним персонажем полосы не менялись дважды.
 */
export async function changeHp(app, o, value, heal, seen = new Set()) {
  const { store } = app;
  const name = tokenName(store, o);
  if (!store.canControlObj(o)) return { skip: `${name}: нет прав` };
  const hp = hpBarOf(o.bars, store.settings.hpBar);
  if (!hp) return { skip: `${name}: нет полосы хитов` };
  if (hp.editable === 'gm' && !store.isGM) return { skip: `${name}: хиты меняет мастер` };
  if (hp.link && o.represents) {
    const key = o.represents + '|' + hp.link.toLowerCase();
    if (seen.has(key)) return { dup: true };
    seen.add(key);
  }
  const cur = num(hp.value);
  if (cur === null) return { skip: `${name}: в полосе хитов не число` };
  const undo = [];
  const t = heal || !value ? null : await tempHp(app, o, hp);
  const r = applyHp({ cur, max: num(hp.max), temp: t?.value || 0, value, heal, allowNegative: !!store.settings.hpNegative });
  let note = '';
  if (t && r.temp !== t.value) {
    t.set(r.temp);
    undo.push(() => t.set(t.value));
    note = ` (временные ${t.value} → ${r.temp})`;
  }
  if (r.next !== cur) {
    setBar(app, o, hp, r.next);
    undo.push(() => setBar(app, o, hp, cur));
  }
  if (value) floatOver(app, o, (heal ? '+' : '−') + value, heal);
  if (!heal) concentrationCheck(app, o, value);
  return { line: `${name}: ${cur} → ${r.next}${note}`, undo };
}

/**
 * Изменить хиты выделенных токенов.
 * mode: 'dmg' — урон, 'half' — половина (округление вниз), 'double' — двойной, 'heal' — лечение
 */
export async function applyToSelected(app, amount, mode) {
  const { store } = app;
  const objs = store.selectedObjs().filter(isTokenLike);
  if (!objs.length) return toast('Сначала выделите токены на карте', 'error');
  const heal = mode === 'heal';
  const value = effectiveAmount(amount, mode);
  const done = [];
  const skipped = [];
  const undo = [];
  const seen = new Set(); // несколько токенов одного персонажа со связанной полосой — хиты общие, меняем один раз
  for (const o of objs) {
    const r = await changeHp(app, o, value, heal, seen);
    if (r.skip) skipped.push(r.skip);
    if (r.line) {
      done.push(r.line);
      undo.push(...r.undo);
    }
  }
  const head = heal ? `Лечение ${value}` : `Урон ${value}`;
  if (!done.length) return toast(`${head} не применён.\n${skipped.join('\n')}`, 'error', 6000);
  toast(`${head}\n${[...done, ...skipped].join('\n')}`, skipped.length ? 'info' : 'ok', 8000, {
    label: 'Отменить',
    onClick: () => {
      undo.reverse().forEach((f) => f());
      toast('Хиты возвращены', 'ok');
    },
  });
}

/** Число из броска, по которому щёлкнули в чате (null — не число или не больше нуля) */
export function rollValueOf(store, el) {
  const msg = store.messages.find((m) => m.id === el.dataset.mid);
  if (!msg) return null;
  let v = null;
  if (el.dataset.computed) v = num(el.textContent);
  else if (el.dataset.roll === 'main') v = typeof msg.roll?.total === 'number' ? msg.roll.total : null;
  else if (el.dataset.roll !== undefined && el.dataset.roll !== '') {
    const r = msg.inlinerolls?.[Number(el.dataset.roll)];
    if (r && r.type !== 'table' && typeof r.total === 'number') v = r.total;
  }
  if (v === null || !Number.isFinite(v)) return null;
  v = Math.floor(v);
  return v > 0 ? v : null;
}

/** Меню «урон / половина / двойной / лечение / наложить эффект» у числа в чате */
export function openDamageMenu(app, el, x, y) {
  const { store } = app;
  const v = rollValueOf(store, el);
  if (v === null) return false;
  const targets = store.selectedObjs().filter(isTokenLike);
  const names = targets.map((o) => tokenName(store, o));
  const who = names.length > 3 ? `${names.slice(0, 3).join(', ')} и ещё ${names.length - 3}` : names.join(', ');
  const items = [];
  if (!targets.length) {
    items.push({ label: `Выделите токены на карте, чтобы применить ${v}`, icon: 'info', disabled: true });
  } else {
    items.push({ label: `Кому: ${who}`, icon: 'target', disabled: true });
    items.push({ label: `Урон −${v}`, icon: 'sword', action: () => applyToSelected(app, v, 'dmg') });
    if (v > 1) items.push({ label: `Половина урона −${effectiveAmount(v, 'half')}`, icon: 'sword', action: () => applyToSelected(app, v, 'half') });
    items.push({ label: `Двойной урон −${effectiveAmount(v, 'double')}`, icon: 'sword', action: () => applyToSelected(app, v, 'double') });
    items.push({ label: `Лечение +${v}`, icon: 'heart', action: () => applyToSelected(app, v, 'heal') });
    // эффекты стола: наложить на выделенные, наложивший — персонаж из сообщения
    const effects = tableEffects(store);
    if (effects.length) {
      const msg = store.messages.find((m) => m.id === el.dataset.mid);
      const src = tokenOfChar(store, msg?.charId)?.id || null;
      const first = effectsForMessage(store, msg).map((d) => d.id);
      const sorted = [...effects].sort((a, b) => (first.includes(b.id) ? 1 : 0) - (first.includes(a.id) ? 1 : 0));
      items.push({
        label: 'Наложить эффект',
        icon: 'sparkles',
        children: sorted.slice(0, 30).map((d) => ({ label: d.name, action: () => applyEffect(app, d.id, targets, { src }) })),
      });
    }
  }
  openContextMenu(x, y, items);
  return true;
}
