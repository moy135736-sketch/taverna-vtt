// Эффекты по ходам (выполняет браузер мастера, ровно один раз на ход — сервер это сторожит):
//   • сроки «до начала / до конца следующего хода цели»;
//   • «каждый ход»: урон или лечение формулой, спасбросок, чтобы закончить эффект, сообщение в чат.
import { markerDefs, markerEntries, markerEntry, removeMarker, safeAttrRefs } from './effects.js';
import { changeHp } from './damage.js';

const tokName = (store, o) => o?.name || (o?.represents && store.col.char.get(o.represents)?.name) || 'токен без имени';
// текст в шаблоне: без скобок, которые сломают {{свойство=…}}
const clean = (s) => String(s ?? '').replace(/[{}[\]|]/g, '').trim();
// формула: ссылки @{атрибут} остаются, убираем только то, что закроет свойство шаблона или inline-бросок
const cleanFormula = (s) => String(s ?? '').replace(/\{\{|\}\}|\[\[|\]\]/g, '').trim();

/** Следить за ходами; возвращает отписку */
export function watchTurnEffects(app) {
  const { store, net } = app;
  let last = store.state.lastTurn?.seq || 0;
  let busy = Promise.resolve();
  const check = () => {
    const lt = store.state.lastTurn;
    if (!store.isGM || !lt || lt.seq === last) return;
    last = lt.seq;
    if (store.state.turnFxDone === lt.seq) return;
    busy = busy.then(async () => {
      const r = await net.request('effects:turn', { seq: lt.seq });
      if (r?.ok) await runTurn(app, r.lastTurn || lt);
    });
  };
  return store.on('game', check);
}

async function runTurn(app, lt) {
  try {
    if (lt.ended) await turnPhase(app, lt.ended, 'end', lt.seq);
    if (lt.started) await turnPhase(app, lt.started, 'start', lt.seq);
  } catch (e) {
    console.error('[эффекты хода]', e);
  }
}

async function turnPhase(app, tokenId, phase, seq) {
  const { store } = app;
  const defs = markerDefs(store);
  let o = store.col.obj.get(tokenId);
  if (!o) return;
  // 1) сроки «до начала/конца следующего хода»: наложенный в этот же ход доживает до следующего
  const limit = phase === 'start' ? seq : seq - 1;
  for (const e of markerEntries(o)) {
    if (!e.ends || e.ends.when !== phase || !(e.ends.seq < limit)) continue;
    const cur = store.col.obj.get(tokenId);
    if (!cur || !markerEntry(cur, e.id)) continue;
    if (await removeMarker(app, cur, e.id)) app.runMacro?.(`/w gm Закончился эффект «${defs.get(e.id)?.name || e.id}» у «${tokName(store, cur)}»`, {});
  }
  // 2) «каждый ход»
  o = store.col.obj.get(tokenId);
  if (!o) return;
  for (const e of markerEntries(o)) {
    const def = defs.get(e.id);
    const t = def?.turn;
    if (!t || (t.when || 'start') !== phase || (!t.hp && !t.save?.roll && !t.text)) continue;
    await runTurnEffect(app, tokenId, e, def);
  }
}

/** Один эффект в начале или конце хода: бросок в чат, хиты, спасбросок */
async function runTurnEffect(app, tokenId, e, def) {
  const { store, net } = app;
  const o = store.col.obj.get(tokenId);
  if (!o) return;
  const t = def.turn;
  const ch = o.represents ? store.col.char.get(o.represents) : null;
  const hidden = o.layer === 'gm' || !!o.effects?.invisible;
  const level = Number(e.n) > 0 ? Number(e.n) : 1;
  const sub = (f) => safeAttrRefs(cleanFormula(f).replace(/@\{\s*(маркер|marker)\s*\}/gi, String(level)));
  const rows = [];
  let hpKey = null,
    heal = false;
  if (t.hp) {
    const f = sub(t.hp);
    heal = /^\+/.test(f);
    hpKey = heal ? 'Лечение' : 'Урон';
    rows.push(`{{${hpKey}=[[${f.replace(/^[+-]\s*/, '')}]]}}`);
  }
  const dc = Number(t.save?.dc) || 10;
  if (t.save?.roll) rows.push(`{{Спасбросок=[[${sub(t.save.roll)}]]}}`, `{{Сл=${dc}}}`);
  if (t.text) rows.push(`{{Эффект=${clean(t.text)}}}`);
  const text = `&{noerror}${hidden ? '/w gm ' : ''}&{template:default} {{name=${clean(def.name)}: ${clean(tokName(store, o))}}} ${rows.join(' ')}`;
  const res = await app.macro.run(text, ch ? { charId: ch.id, defer: true } : { as: { type: 'player' }, defer: true });
  const r = res?.[0];
  if (!r || r.error) return;
  if (r.rollId) await net.request('roll:finish', { rollId: r.rollId, computed: {} });
  const results = r.results || {};
  // хиты
  if (hpKey) {
    const v = Math.floor(Number(results[hpKey]?.result));
    if (Number.isFinite(v) && v > 0) await changeHp(app, store.col.obj.get(tokenId) || o, v, heal);
  }
  // спасбросок удался — эффект кончается
  if (t.save?.roll) {
    const total = Number(results['Спасбросок']?.result);
    if (Number.isFinite(total) && total >= dc) {
      const cur = store.col.obj.get(tokenId);
      if (cur && (await removeMarker(app, cur, e.id))) app.runMacro?.(`${hidden ? '/w gm ' : ''}/desc «${def.name}» у «${tokName(store, cur)}» закончился: спасбросок ${total} против ${dc}`, {});
    }
  }
}
