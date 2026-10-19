// Маркеры состояний и их эффекты — в духе Dynamic Active Effects из Foundry.
// Свой маркер (настройки стола → markers) может:
//   • менять атрибуты персонажа или полосы токена — числом или формулой (13 + @{dexterity_mod}, 2d4+4,
//     @{маркер} — число на маркере), дописывать к текстовым полям (+1d4 к global_attack);
//   • менять сам токен: свет, тёмное зрение, размер, прозрачность, невидимость (это делает сервер);
//   • длиться N раундов (минут, часов), до начала или конца следующего хода цели, с концентрацией
//     наложившего (кончилась концентрация — кончился и эффект);
//   • действовать каждый ход: урон или лечение формулой, спасбросок, чтобы закончить, сообщение.
// Число на маркере — уровень (стопки, истощение…); изменения с пометкой «× уровень» умножаются на него.
//
// Как это устроено: список маркеров токена и изменения самого токена меняет сервер одним действием
// (кто первый — тот и добавил или снял). Атрибуты листа меняет клиент через движок листа, чтобы сработали
// его скрипты: после добавления — применяет, после снятия — откатывает ровно то, что сервер вернул как снятое.
// Сроки и эффекты «каждый ход» выполняет мастер (его браузер), один раз на ход.
import { MARKERS } from '@shared/defaults.js';
import { lc } from '@shared/attrs.js';
import { isTokenKey, TOKEN_KEYS, durationText } from '@shared/effects.js';
import { rollExpression } from '@shared/dice.js';
import { toast } from '../ui/components.jsx';

export const CHANGE_MODES = [
  ['add', 'прибавить'],
  ['set', 'сделать равным'],
  ['mul', 'умножить на'],
  ['max', 'не меньше'],
  ['min', 'не больше'],
  ['append', 'дописать к тексту'],
];

/** Все маркеры стола: встроенные и свои (свои с тем же id перекрывают встроенные) */
export function markerDefs(store) {
  const map = new Map(MARKERS.map((m) => [m.id, m]));
  for (const m of store.settings.markers || []) if (m && m.id) map.set(m.id, m);
  return map;
}

/** Свои маркеры-эффекты стола (настраиваемые мастером) */
export const tableEffects = (store) => (store.settings.markers || []).filter((m) => m && m.id && m.name);

/** Как нарисовать маркер: своя картинка, значок встроенного маркера или цветная точка */
export function markerLook(def, defs, depth = 0) {
  if (!def) return { emoji: '•' };
  if (def.image) return { image: def.image };
  if (def.icon && defs && depth < 3) {
    const b = defs.get(def.icon);
    if (b && b !== def) return markerLook(b, defs, depth + 1);
  }
  if (def.color) return { color: def.color };
  return { emoji: def.emoji || '•' };
}

export const markerEntries = (o) => (Array.isArray(o?.markers) ? o.markers : []).map((m) => (typeof m === 'string' ? { id: m } : m));
export const markerEntry = (o, id) => markerEntries(o).find((m) => m.id === id) || null;
/** Сколько раундов осталось (null — бессрочно) */
export const roundsLeft = (store, e) => (e?.until === undefined || e?.until === null ? null : e.until - (store.state.tick || 0));

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const r3 = (v) => Math.round(v * 1000) / 1000;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
const isPlain = (raw) => /^-?\d+(?:[.,]\d+)?$/.test(String(raw).trim());

/** Описание изменений для подсказок: «ac +2, speed ×2» */
export function describeChanges(def) {
  const ch = Array.isArray(def?.changes) ? def.changes.filter((c) => c && String(c.key || '').trim()) : [];
  return ch
    .map((c) => {
      let v = String(c.value ?? '').trim();
      const lvl = c.perLevel ? ' × уровень' : '';
      const k = String(c.key).trim();
      const tk = TOKEN_KEYS[k.toLowerCase()];
      // сам токен — словами: «невидимость», «яркий свет не меньше 20 фт», «размер ×2»
      if (tk?.kind === 'bool') return Number(v) || c.mode !== 'set' ? tk.short : `${tk.short}: нет`;
      const label = tk?.short || k;
      if (tk?.unit && c.mode !== 'mul' && isPlain(v)) v = `${v} ${tk.unit}`;
      if (c.mode === 'set') return `${label} = ${v}${lvl}`;
      if (c.mode === 'mul') return `${label} ×${v}${lvl}`;
      if (c.mode === 'max') return `${label} не меньше ${v}${lvl}`;
      if (c.mode === 'min') return `${label} не больше ${v}${lvl}`;
      if (c.mode === 'append') return `${label} ${/^[+-]/.test(v) ? v : '+' + v}`;
      return `${label} ${/^-/.test(v) ? v : '+' + v}${lvl}`;
    })
    .join(', ');
}

/** Что эффект делает каждый ход — словами */
export function describeTurn(def) {
  const t = def?.turn;
  if (!t || (!t.hp && !t.save?.roll && !t.text)) return '';
  const when = t.when === 'end' ? 'в конце хода' : 'в начале хода';
  const parts = [];
  if (t.hp) {
    const s = String(t.hp).trim();
    parts.push(/^\+/.test(s) ? `лечение ${s.slice(1).trim()}` : `урон ${s.replace(/^-/, '').trim()}`);
  }
  if (t.save?.roll) parts.push(`спасбросок ${t.save.roll} против ${t.save.dc || 10} — при успехе эффект кончается`);
  if (t.text) parts.push(`«${t.text}»`);
  return `${when}: ${parts.join('; ')}`;
}

/** Полное описание эффекта для подсказок: что меняет, сколько длится, что делает каждый ход */
export function describeEffect(def) {
  return [describeChanges(def), durationText(def), describeTurn(def)].filter(Boolean).join('; ');
}

function attrValue(store, charId, key) {
  const max = /_max$/i.test(key);
  const base = max ? key.slice(0, -4) : key;
  const a = store.getAttr(charId, base);
  if (!a) return undefined;
  return max ? a.max : a.current;
}

/**
 * Подготовить значение эффекта: число, формула с атрибутами (@{dexterity_mod}), кубиками (2d4+4)
 * и числом на маркере (@{маркер}). Возвращает {value, text, dice}: dice — в формуле есть кубики,
 * их бросит сервер (value — запасной бросок здесь, если сервер не ответит).
 */
export async function prepareFormula(app, raw, { charId = null, level = null } = {}) {
  let s = String(raw ?? '').trim();
  if (!s) return { value: null };
  if (isPlain(s)) return { value: Number(s.replace(',', '.')) };
  s = safeAttrRefs(s.replace(/@\{\s*(маркер|marker)\s*\}/gi, String(num(level) ?? 1)));
  if (/@\{/.test(s)) {
    if (charId && app.macro) {
      try {
        const r = await app.macro.expandOnly('&{noerror}' + s, { charId });
        if (r.text !== null && r.text !== undefined) s = r.text;
      } catch {
        /* формула останется с пустыми атрибутами */
      }
    }
    s = s.replace(/@\{[^}]*\}/g, '0');
  }
  s = s.trim();
  if (isPlain(s)) return { value: Number(s.replace(',', '.')), text: s };
  try {
    const r = rollExpression(s);
    if (typeof r.total === 'number' && Number.isFinite(r.total)) return { value: r3(r.total), dice: (r.dice || []).length > 0, text: s };
  } catch {
    /* не формула */
  }
  return { value: null, text: s };
}

/** @{атрибут} → (@{атрибут}+0): пустой или отсутствующий атрибут даёт 0, а не сломанную формулу «13 + » */
export const safeAttrRefs = (s) => String(s ?? '').replace(/@\{[^{}]+\}/g, (m) => `(${m}+0)`);

const clean = (s) => String(s ?? '').replace(/[{}[\]|]/g, '').trim();
// подписи к броскам в чате: поля листа «D&D 2024» и похожих — по-русски
const ATTR_LABELS = {
  ac: 'КД',
  speed: 'Скорость',
  hp: 'Хиты',
  hp_max: 'Максимум хитов',
  hp_temp: 'Временные хиты',
  global_attack: 'К атакам',
  global_save: 'К спасброскам',
  global_damage: 'К урону',
  global_check: 'К проверкам',
  initiative_bonus: 'К инициативе',
};
const changeLabel = (key) => {
  const k = String(key).trim().toLowerCase();
  const bar = /^bar(\d+)$/.exec(k);
  return TOKEN_KEYS[k]?.label || ATTR_LABELS[k] || (bar ? `Полоса ${bar[1]}` : String(key));
};

/**
 * Кубики эффекта — одним сообщением в чат, бросает сервер (все видят, что выпало, и подделать нельзя).
 * items: [{label, text, value}] — value заменяется выпавшим. Скрытый токен — шёпотом мастеру.
 */
async function rollOnServer(app, o, def, items) {
  const { store, net } = app;
  if (!items.length || !app.macro) return false;
  const used = new Set();
  for (const it of items) {
    const base = clean(it.label) || 'Бросок';
    let l = base;
    for (let i = 2; used.has(l); i++) l = `${base} (${i})`;
    used.add(l);
    it.key = l;
  }
  const hidden = o.layer === 'gm' || !!o.effects?.invisible;
  const rows = items.map((it) => `{{${it.key}=[[${it.text}]]}}`).join(' ');
  const text = `&{noerror}${hidden ? '/w gm ' : ''}&{template:default} {{name=${clean(def?.name || 'Эффект')}: ${clean(tokName(store, o))}}} ${rows}`;
  try {
    const res = await app.macro.run(text, { as: { type: 'player' }, defer: true, selected: [] });
    const r = res?.[0];
    if (!r || r.error || !r.results) return false;
    for (const it of items) {
      const v = Number(r.results[it.key]?.result);
      if (Number.isFinite(v)) it.value = r3(v);
    }
    if (r.rollId) await net.request('roll:finish', { rollId: r.rollId, computed: {} });
    return true;
  } catch (e) {
    console.warn('[эффект] бросок на сервере не удался', e);
    return false;
  }
}

/** Дописать кусок к текстовому полю (формуле листа): «» + «1d4» → «1d4», «2» + «1d4» → «2+1d4» */
function appendText(cur, piece) {
  const c = String(cur ?? '').trim();
  const p = String(piece ?? '').trim();
  if (!c) return p.replace(/^\+/, '');
  return /^[+-]/.test(p) ? c + p : c + '+' + p;
}
/** Убрать дописанное — если оно ещё там */
function unappendText(cur, piece) {
  const c = String(cur ?? '');
  const p = String(piece ?? '').trim();
  for (const cand of [/^[+-]/.test(p) ? p : '+' + p, p.replace(/^\+/, '')]) {
    const i = c.lastIndexOf(cand);
    if (i >= 0) return (c.slice(0, i) + c.slice(i + cand.length)).trim().replace(/^\+/, '');
  }
  return null;
}

/**
 * Что поменяет эффект маркера на этом токене.
 * Возвращает attrs: {charId: {атрибут: значение}} — записать в лист; applied — что запомнить для отката;
 * tokVals — посчитанные формулы для изменений самого токена (их применит сервер); rolls — брошенные кубики.
 */
export async function planChanges(app, o, def, level) {
  const { store, net } = app;
  const out = { attrs: {}, applied: [], tokVals: {} };
  const changes = Array.isArray(def?.changes) ? def.changes.slice(0, 12) : [];
  if (!changes.some((c) => c && String(c.key || '').trim())) return out;
  const ch = o.represents ? store.col.char.get(o.represents) : null;
  const canChar = !!ch && store.canControlChar(ch);
  if (canChar) {
    try {
      await net.ensureAttrs(ch.id);
    } catch {
      /* атрибуты недоступны — изменения листа пропустим */
    }
  }
  // 1) формулы: подставить атрибуты и число на маркере; кубики — одним броском на сервере
  const vals = new Map();
  const toRoll = [];
  for (let idx = 0; idx < changes.length; idx++) {
    const c = changes[idx];
    if (!c || !String(c.key || '').trim() || c.mode === 'append') continue;
    const key = String(c.key).trim();
    const raw = String(c.value ?? '').trim();
    // сам токен: число и цвет сервер возьмёт из описания эффекта
    if (isTokenKey(key) && (!raw || isPlain(raw) || /^#[0-9a-f]{3,8}$/i.test(raw))) continue;
    const f = await prepareFormula(app, raw, { charId: canChar ? ch.id : null, level });
    vals.set(idx, f.value);
    if (f.dice) toRoll.push({ idx, label: changeLabel(key), text: f.text, value: f.value });
  }
  if (toRoll.length) {
    await rollOnServer(app, o, def, toRoll);
    for (const it of toRoll) vals.set(it.idx, it.value);
  }
  // 2) что поменять
  const pending = new Map(); // одно и то же поле в нескольких изменениях — складываем по очереди
  const bars = (o.bars || []).map((b) => ({ ...b }));
  for (let idx = 0; idx < changes.length; idx++) {
    const c = changes[idx];
    if (!c || !String(c.key || '').trim()) continue;
    let key = String(c.key).trim();
    const mode = CHANGE_MODES.some(([m]) => m === c.mode) ? c.mode : 'add';
    const raw = String(c.value ?? '').trim();
    if (isTokenKey(key)) {
      if (vals.has(idx) && vals.get(idx) !== null) out.tokVals[idx] = vals.get(idx);
      continue;
    }
    const k = c.perLevel ? (num(level) ?? 1) : 1;
    const v = mode === 'append' ? null : vals.get(idx) ?? null;
    const calc = (cur) => {
      const cn = num(cur);
      if (mode === 'append') return raw ? appendText(cur, raw) : null;
      if (mode === 'add') return v === null || (cn === null && cur !== undefined && cur !== '') ? null : r3((cn ?? 0) + v * k);
      if (mode === 'set') return v === null ? (raw ? raw : null) : r3(v * k);
      if (v === null || cn === null) return null;
      if (mode === 'mul') return r3(cn * v * k);
      if (mode === 'max') return Math.max(cn, r3(v * k));
      return Math.min(cn, r3(v * k));
    };
    const barM = /^bar(\d{1,2})$/i.exec(key);
    if (barM) {
      const bi = Number(barM[1]) - 1;
      const b = bars[bi];
      if (!b) continue;
      if (!b.link) {
        if (mode === 'append') continue;
        // полоса самого токена: её меняет сервер вместе со списком маркеров
        const nv = calc(b.value);
        if (nv === null) continue;
        if (mode === 'add') out.applied.push({ bar: bi, mode: 'add', delta: r3(v * k) });
        else out.applied.push({ bar: bi, mode: 'set', value: String(nv) });
        b.value = String(nv);
        continue;
      }
      key = b.link; // полоса связана с листом — меняем атрибут
    }
    if (!canChar) continue;
    const lk = lc(key);
    const cur = pending.has(lk) ? pending.get(lk) : attrValue(store, ch.id, key);
    const nv = calc(cur);
    if (nv === null) continue;
    if (mode === 'add') out.applied.push({ charId: ch.id, key, mode: 'add', delta: r3(v * k) });
    else if (mode === 'append') out.applied.push({ charId: ch.id, key, mode: 'append', value: raw });
    else out.applied.push({ charId: ch.id, key, mode: 'set', value: String(nv), prev: String(cur ?? '') });
    pending.set(lk, nv);
    (out.attrs[ch.id] ||= {})[key] = nv;
  }
  return out;
}

function writeAttrs(app, attrs) {
  for (const [charId, vals] of Object.entries(attrs || {})) if (Object.keys(vals).length) app.sheets.setAttrs(charId, vals, { source: 'player' });
}

/** Можно ли откатить то, что эффект поменял в листах (нужны права на этих персонажей) */
export function canUndoEffect(store, e) {
  return (e?.applied || []).every((a) => a.charId === undefined || !a.charId || store.canControlChar(store.col.char.get(a.charId)));
}

/** Откатить изменения листов (полосы и сам токен сервер уже вернул сам) */
export async function revertApplied(app, applied) {
  const { store, net } = app;
  const byChar = new Map();
  for (const a of applied || []) {
    if (!a.charId || !a.key) continue;
    if (!byChar.has(a.charId)) byChar.set(a.charId, []);
    byChar.get(a.charId).push(a);
  }
  for (const [charId, list] of byChar) {
    const ch = store.col.char.get(charId);
    if (!ch || !store.canControlChar(ch)) continue;
    try {
      await net.ensureAttrs(charId);
    } catch {
      continue;
    }
    const vals = {};
    const pending = new Map();
    for (const a of [...list].reverse()) {
      const lk = lc(a.key);
      const cur = pending.has(lk) ? pending.get(lk) : attrValue(store, charId, a.key);
      let nv;
      if (a.mode === 'add') {
        const cn = num(cur);
        if (cn === null) continue;
        nv = r3(cn - (Number(a.delta) || 0));
      } else if (a.mode === 'append') {
        nv = unappendText(cur, a.value);
        if (nv === null) continue;
      } else {
        // вернуть прежнее, только если значение с тех пор не меняли вручную
        if (String(cur ?? '') !== String(a.value)) continue;
        nv = a.prev ?? '';
      }
      pending.set(lk, nv);
      vals[a.key] = nv;
    }
    if (Object.keys(vals).length) app.sheets.setAttrs(charId, vals, { source: 'player' });
  }
}

const fail = (r) => {
  if (r?.error) toast(r.error, 'error');
  return !!r?.error;
};
const tokName = (store, o) => o?.name || (o?.represents && store.col.char.get(o.represents)?.name) || 'токен без имени';

/**
 * Поставить маркер (с его эффектом) на токен; уже стоящий не трогаем.
 * src — токен того, кто наложил (для концентрации); n — число на маркере.
 */
export async function addMarker(app, o, id, { n, src } = {}) {
  const { store, net } = app;
  if (markerEntry(o, id)) return false;
  const def = markerDefs(store).get(id);
  const entry = { id };
  if (n !== undefined && n !== null && n !== '') entry.n = n;
  const rounds = Math.floor(Number(def?.rounds) || 0);
  if (rounds > 0) entry.until = (store.state.tick || 0) + rounds;
  if (def?.duration === 'turnStart' || def?.duration === 'turnEnd') entry.ends = { when: def.duration === 'turnStart' ? 'start' : 'end', seq: store.state.turnSeq || 0 };
  const srcObj = src ? store.col.obj.get(src) : null;
  if (srcObj) entry.src = srcObj.id;
  // концентрация держится, пока у наложившего стоит маркер «Концентрация»
  if (def?.conc && srcObj) entry.conc = true;
  const plan = await planChanges(app, o, def, entry.n);
  if (plan.applied.length) entry.applied = plan.applied;
  if (Object.keys(plan.tokVals).length) entry.tokVals = plan.tokVals;
  const r = await net.request('marker', { t: 'add', objId: o.id, markerId: id, entry });
  if (fail(r) || r.exists) return false;
  writeAttrs(app, plan.attrs);
  // заклинание с концентрацией: у наложившего появляется маркер «Концентрация»
  const caster = entry.conc ? store.col.obj.get(srcObj.id) : null;
  if (caster && !markerEntry(caster, 'concentration') && store.canControlObj(caster)) await addMarker(app, caster, 'concentration');
  return true;
}

/** Снять маркер; изменения листа откатывает тот, кто снял */
export async function removeMarker(app, o, id) {
  const { store, net } = app;
  const e = markerEntry(o, id);
  if (!e) return false;
  if (!canUndoEffect(store, e)) {
    toast('Этот эффект поменял лист персонажа — снять его может мастер', 'error');
    return false;
  }
  const r = await net.request('marker', { t: 'remove', objId: o.id, markerId: id });
  if (fail(r) || !r.removed) return false;
  await revertApplied(app, r.removed.applied);
  return true;
}

/** Поставить или снять маркер у всех выделенных (как у первого) */
export async function toggleMarker(app, objs, id) {
  const on = !!markerEntry(objs[0], id);
  for (const o of objs) {
    if (on) await removeMarker(app, o, id);
    else await addMarker(app, o, id);
  }
}

/** Число на маркере; эффект «× уровень» пересчитывается */
export async function setMarkerLevel(app, o, id, n) {
  const { store, net } = app;
  const e = markerEntry(o, id);
  if (!e) return false;
  const value = n === '' || n === null || n === undefined ? null : num(n) ?? String(n).slice(0, 8);
  const def = markerDefs(store).get(id);
  const perLevel = (def?.changes || []).some((c) => c && c.perLevel && String(c.key || '').trim());
  if (!perLevel) return !fail(await net.request('marker', { t: 'update', objId: o.id, markerId: id, patch: { n: value } }));
  if (!canUndoEffect(store, e)) {
    toast('Этот эффект поменял лист персонажа — менять его уровень может мастер', 'error');
    return false;
  }
  await revertApplied(app, e.applied);
  const fresh = store.col.obj.get(o.id) || o;
  const plan = await planChanges(app, { ...fresh, bars: barsWithout(fresh, e.applied) }, def, value);
  const r = await net.request('marker', { t: 'update', objId: o.id, markerId: id, patch: { n: value, applied: plan.applied, tokVals: plan.tokVals } });
  if (fail(r)) return false;
  writeAttrs(app, plan.attrs);
  return true;
}

/** Полосы токена без изменений этого эффекта — чтобы пересчитать его от исходных значений */
function barsWithout(o, applied) {
  const bars = (o.bars || []).map((b) => ({ ...b }));
  for (const a of applied || []) {
    if (a.bar === undefined || !bars[a.bar] || bars[a.bar].link) continue;
    const b = bars[a.bar];
    if (a.mode === 'add') {
      const v = num(b.value);
      if (v !== null) b.value = String(r3(v - a.delta));
    } else if (String(b.value) === a.value && a.prev !== undefined) b.value = a.prev;
  }
  return bars;
}

/** Сколько раундов ещё длится маркер (пусто — бессрочно) */
export async function setMarkerRounds(app, o, id, left) {
  const { store, net } = app;
  const l = num(left);
  const until = l === null ? null : (store.state.tick || 0) + Math.max(0, Math.floor(l));
  const r = await net.request('marker', { t: 'update', objId: o.id, markerId: id, patch: { until } });
  if (fail(r)) return false;
  if (until !== null && until <= (store.state.tick || 0)) expireMarkers(app);
  return true;
}

const expiring = new Set();

/** Мастер: эффекты, у которых вышел срок, снимаются, а изменения листа откатываются */
export async function expireMarkers(app) {
  const { store, net } = app;
  if (!store.isGM) return;
  const tick = store.state.tick || 0;
  const defs = markerDefs(store);
  for (const o of [...store.col.obj.values()]) {
    for (const e of markerEntries(o)) {
      if (e.until === undefined || e.until === null || e.until > tick) continue;
      const key = `${o.id}:${e.id}:${e.until}`;
      if (expiring.has(key)) continue;
      expiring.add(key);
      try {
        const r = await net.request('marker', { t: 'expire', objId: o.id, markerId: e.id, until: e.until });
        if (r?.removed) {
          await revertApplied(app, r.removed.applied);
          const name = defs.get(e.id)?.name || e.id;
          app.runMacro?.(`/w gm Закончился эффект «${name}» у «${tokName(store, o)}»${e.conc ? ' (концентрация)' : ''}`, {});
        }
      } finally {
        expiring.delete(key);
      }
    }
  }
}

/** Есть ли у токенов эффекты с вышедшим сроком (например, кончилась чья-то концентрация) */
export function hasExpired(store) {
  const tick = store.state.tick || 0;
  for (const o of store.col.obj.values()) for (const e of markerEntries(o)) if (e.until !== undefined && e.until !== null && e.until <= tick) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Наложить эффект на цели: из чата, макросом /effect, из меню броска

/** Эффект стола по названию, другому названию (alias) или id */
export function findEffect(store, name) {
  const n = norm(name);
  if (!n) return null;
  const list = tableEffects(store);
  return (
    list.find((d) => d.id === name) ||
    list.find((d) => norm(d.name) === n) ||
    list.find((d) =>
      String(d.alias || '')
        .split(/[,;]/)
        .some((a) => norm(a) === n),
    ) ||
    null
  );
}

/** Токен персонажа на текущей сцене — «кто наложил» для сообщений из листа */
export function tokenOfChar(store, charId) {
  if (!charId) return null;
  const pid = store.ui.pageId;
  return [...store.col.obj.values()].find((o) => o.represents === charId && o.pageId === pid && o.type !== 'wall') || null;
}

const isTokenLike = (o) => o && o.type !== 'wall' && o.type !== 'pin' && o.type !== 'path' && o.type !== 'text';

/**
 * Наложить (или снять) эффект на токены. Своими токенами игрок управляет сам, на чужие эффект
 * накладывает мастер за столом (запрос идёт ему).
 */
export async function applyEffect(app, effectId, targets, { src = null, remove = false, quiet = false } = {}) {
  const { store, net } = app;
  const def = markerDefs(store).get(effectId);
  const list = (targets || []).filter(isTokenLike);
  if (!def) return toast('Нет такого эффекта за этим столом', 'error');
  if (!list.length) return toast('Сначала выделите токены на карте', 'error');
  const mine = list.filter((o) => store.canControlObj(o));
  const others = list.filter((o) => !store.canControlObj(o));
  const done = [];
  for (const o of mine) {
    const cur = store.col.obj.get(o.id) || o;
    const ok = remove ? await removeMarker(app, cur, effectId) : await addMarker(app, cur, effectId, { src });
    if (ok) done.push(tokName(store, cur));
  }
  if (others.length) {
    const r = await net.request('effect:ask', { effectId, targets: others.map((o) => o.id), src: src || undefined, remove });
    if (r?.error) toast(r.error, 'error');
    else if (!quiet) toast(`Мастер ${remove ? 'снимет' : 'наложит'} «${def.name}»: ${others.map((o) => tokName(store, o)).join(', ')}`, 'ok');
  }
  if (done.length && !quiet) toast(`«${def.name}» ${remove ? 'снят' : 'наложен'}: ${done.join(', ')}`, 'ok');
  return done.length;
}

/** Мастер выполняет просьбу игрока наложить эффект на чужие токены */
export async function handleEffectAsk(app, req) {
  const { store } = app;
  if (!store.isGM) return;
  const def = markerDefs(store).get(req.effectId);
  if (!def) return;
  const targets = (req.targets || []).map((id) => store.col.obj.get(id)).filter(isTokenLike);
  const names = [];
  for (const o of targets) {
    const ok = req.remove ? await removeMarker(app, o, def.id) : await addMarker(app, o, def.id, { src: req.src });
    if (ok) names.push(tokName(store, o));
  }
  const who = store.members.get(req.from)?.displayName || 'Игрок';
  if (names.length) app.runMacro?.(`/w gm ${who} ${req.remove ? 'снимает' : 'накладывает'} «${def.name}»: ${names.join(', ')}`, {});
}

/**
 * Команда макроса: /effect Название [--target] [--remove]
 * Без --target — на выделенные токены, наложивший — токен персонажа, от чьего имени макрос (если есть);
 * с --target — щёлкнуть по цели, наложивший — выделенный токен (как @{target} в Roll20).
 */
export async function effectCommand(app, args, { selected = [], charId = null, pickTarget } = {}) {
  const { store } = app;
  let s = String(args || '').trim();
  const flags = new Set();
  s = s.replace(/\s--(target|remove|цель|снять)(?=\s|$)/gi, (m, f) => {
    flags.add({ цель: 'target', снять: 'remove' }[f.toLowerCase()] || f.toLowerCase());
    return '';
  });
  const def = findEffect(store, s.trim());
  if (!def) return toast(`Нет эффекта «${s.trim()}» за этим столом`, 'error');
  const sel = selected.map((id) => store.col.obj.get(id)).filter(isTokenLike);
  let targets = sel;
  let src = null;
  if (flags.has('target')) {
    const id = await pickTarget?.(def.name);
    if (!id) return;
    targets = [store.col.obj.get(id)].filter(Boolean);
    src = sel[0]?.id || tokenOfChar(store, charId)?.id || null;
  } else src = tokenOfChar(store, charId)?.id || null;
  return applyEffect(app, def.id, targets, { src, remove: flags.has('remove') });
}

/** Эффекты стола, подходящие к сообщению чата по названию заклинания или приёма */
export function effectsForMessage(store, msg) {
  if (!msg || msg.type === 'system') return [];
  const list = tableEffects(store);
  if (!list.length) return [];
  const names = new Set();
  const content = String(msg.content || '');
  if (msg.template) {
    const re = /\{\{\s*(name|title|rname|spell|spellname|spell_name|roll_name)\s*=([^}]*)\}\}/gi;
    let m;
    while ((m = re.exec(content))) names.add(norm(m[2].replace(/\[\[[^\]]*\]\]/g, '')));
  }
  if (!names.size) return [];
  return list.filter((d) => names.has(norm(d.name)) || String(d.alias || '').split(/[,;]/).some((a) => a.trim() && names.has(norm(a))));
}
