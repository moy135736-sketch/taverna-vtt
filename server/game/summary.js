// Итоги вечера: статистика бросков и разговоров за игровой вечер и шуточные награды.
// Считаются только сообщения, которые видели все (без шёпотов и бросков для мастера).

/** Перерыв дольше этого — значит, начался новый вечер */
export const SESSION_GAP = 4 * 3600 * 1000;

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const nw = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;

/** Кубики сообщения: [{sides, v, dropped}] — основной бросок и inline-броски */
export function diceIn(msg) {
  const out = [];
  const walk = (parts) => {
    for (const p of parts || []) {
      if (p?.t === 'dice' && Array.isArray(p.dice)) {
        for (const d of p.dice) if (typeof d?.v === 'number') out.push({ sides: Number(p.sides) || 0, v: d.v, dropped: !!d.dr });
      } else if (p?.t === 'group') for (const it of p.items || []) walk(it?.parts);
    }
  };
  if (msg.roll) walk(msg.roll.parts);
  for (const r of msg.inlinerolls || []) walk(r?.parts);
  return out;
}

const stripTags = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Самый большой итог броска в сообщении и его подпись */
function bestRoll(msg) {
  let best = null;
  const consider = (r, label) => {
    if (!r || r.type === 'table' || typeof r.total !== 'number' || !Number.isFinite(r.total)) return;
    if (!best || r.total > best.total) best = { total: r.total, label };
  };
  const tplName = msg.template ? stripTags(/\{\{\s*(?:name|title|rname)\s*=\s*([^}]*)\}\}/i.exec(msg.content || '')?.[1] || '') : '';
  if (msg.roll) consider(msg.roll, msg.origRoll || msg.roll.expression || '');
  for (const r of msg.inlinerolls || []) consider(r, tplName || r?.expression || '');
  if (best) best.label = String(best.label).slice(0, 48);
  return best;
}

const isPublic = (m) => !m.toGM && !(Array.isArray(m.to) && m.to.length);

/**
 * messages — сообщения вечера по времени; members — Map(id → {displayName, color, role}).
 * Возвращает данные карточки итогов (их рисует клиент).
 */
export function computeSummary(messages, members, { scope = 'session' } = {}) {
  const players = new Map();
  const P = (id) => {
    if (!players.has(id)) {
      const m = members.get(id);
      players.set(id, {
        id,
        name: m?.displayName || 'Гость',
        color: m?.color || '#888888',
        gm: m?.role === 'gm',
        rolls: 0,
        dice: 0,
        d20: 0,
        d20sum: 0,
        nat20: 0,
        nat1: 0,
        streak: 0,
        bestStreak: 0,
        best: null,
        talk: 0,
        reactionsGot: 0,
        chars: new Map(),
      });
    }
    return players.get(id);
  };
  let from = null;
  let to = null;
  let moment = null;
  const emojiCount = new Map();
  const total = { rolls: 0, dice: 0, nat20: 0, nat1: 0, messages: 0, reactions: 0 };

  for (const m of messages) {
    if (!m || m.type === 'system' || m.type === 'summary' || !m.playerId || !isPublic(m)) continue;
    if (!members.has(m.playerId)) continue;
    from = from === null ? m.ts : Math.min(from, m.ts);
    to = to === null ? m.ts : Math.max(to, m.ts);
    const p = P(m.playerId);
    if (m.charId && m.who) p.chars.set(m.who, (p.chars.get(m.who) || 0) + 1);
    const dice = diceIn(m);
    if (dice.length) {
      p.rolls++;
      total.rolls++;
      p.dice += dice.length;
      total.dice += dice.length;
      for (const d of dice) {
        if (d.sides !== 20 || d.dropped) continue;
        p.d20++;
        p.d20sum += d.v;
        if (d.v === 20) {
          p.nat20++;
          total.nat20++;
        }
        if (d.v === 1) {
          p.nat1++;
          total.nat1++;
        }
        // полоса неудач: d20 меньше 10 подряд
        p.streak = d.v < 10 ? p.streak + 1 : 0;
        p.bestStreak = Math.max(p.bestStreak, p.streak);
      }
      const b = bestRoll(m);
      if (b && (!p.best || b.total > p.best.total)) p.best = b;
    } else if (['general', 'emote', 'ooc', 'desc'].includes(m.type) && String(m.content || '').trim()) {
      p.talk++;
      total.messages++;
    }
    // реакции от других
    if (m.reactions && typeof m.reactions === 'object') {
      let got = 0;
      const shown = [];
      for (const [e, users] of Object.entries(m.reactions)) {
        if (!Array.isArray(users)) continue;
        const n = users.filter((u) => u !== m.playerId).length;
        if (!n) continue;
        got += n;
        shown.push([e, n]);
        emojiCount.set(e, (emojiCount.get(e) || 0) + n);
      }
      p.reactionsGot += got;
      total.reactions += got;
      // момент вечера — сообщение, собравшее больше всего реакций (хотя бы две)
      if (got >= 2 && (!moment || got > moment.count)) {
        const text = stripTags(m.content || '') || (m.roll ? `бросок ${m.origRoll || ''} = ${m.roll.total}` : '');
        moment = { id: m.id, count: got, who: m.who || p.name, color: m.color || p.color, text: text.slice(0, 140) + (text.length > 140 ? '…' : ''), reactions: shown.sort((a, b) => b[1] - a[1]).slice(0, 4) };
      }
    }
  }

  const list = [...players.values()].map((p) => {
    const char = [...p.chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return {
      id: p.id,
      name: p.name,
      char: char && char !== p.name ? char : '',
      color: p.color,
      gm: p.gm,
      rolls: p.rolls,
      dice: p.dice,
      d20: p.d20,
      avg: p.d20 ? Math.round((p.d20sum / p.d20) * 10) / 10 : null,
      nat20: p.nat20,
      nat1: p.nat1,
      streak: p.bestStreak,
      best: p.best,
      talk: p.talk,
      reactionsGot: p.reactionsGot,
    };
  });
  list.sort((a, b) => b.rolls + b.talk - (a.rolls + a.talk));

  const awards = [];
  const who = (p) => ({ id: p.id, name: p.char || p.name, player: p.char ? p.name : '', color: p.color });
  const give = (id, title, icon, value, min, text) => {
    const vals = list.map((p) => [p, value(p)]).filter(([, v]) => v !== null && v !== undefined && v >= min);
    if (!vals.length) return;
    const top = Math.max(...vals.map(([, v]) => v));
    const winners = vals.filter(([, v]) => v === top).map(([p]) => p);
    awards.push({ id, title, icon, who: winners.slice(0, 3).map(who), text: text(top, winners[0]) });
  };
  give('luck', 'Любимец удачи', '🍀', (p) => p.nat20, 1, (n) => nw(n, 'натуральная двадцатка', 'натуральные двадцатки', 'натуральных двадцаток'));
  give('cursed', 'Проклятый кубик', '💀', (p) => p.nat1, 1, (n) => nw(n, 'единица', 'единицы', 'единиц') + ' на d20');
  // средний d20 выше обычных 10,5 — и хотя бы пять бросков
  give('golden', 'Золотая рука', '✨', (p) => (p.d20 >= 5 ? p.avg : null), 11, (n) => `в среднем ${String(n).replace('.', ',')} на d20`);
  give('streak', 'Чёрная полоса', '🌧️', (p) => p.streak, 3, (n) => `${nw(n, 'бросок', 'броска', 'бросков')} d20 подряд меньше 10`);
  give('caliber', 'Главный калибр', '💥', (p) => p.best?.total ?? null, 1, (n, p) => `${n}${p.best?.label ? ' — ' + p.best.label : ''}`);
  give('soul', 'Душа компании', '🎭', (p) => p.reactionsGot, 1, (n) => nw(n, 'реакция', 'реакции', 'реакций') + ' от друзей');
  give('teller', 'Рассказчик', '📜', (p) => p.talk, 3, (n) => nw(n, 'сообщение', 'сообщения', 'сообщений'));
  give('thrower', 'Кубикомёт', '🎲', (p) => p.dice, 10, (n) => nw(n, 'кубик', 'кубика', 'кубиков') + ' за вечер');

  const favorite = [...emojiCount.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  return { scope, from, to, total, players: list, awards, moment, favorite };
}

/** С какого времени идёт текущий (последний) вечер: ts сообщений по убыванию */
export function sessionStart(tsDesc, gap = SESSION_GAP) {
  let start = null;
  let prev = null;
  for (const ts of tsDesc) {
    if (prev !== null && prev - ts > gap) break;
    start = ts;
    prev = ts;
  }
  return start;
}
