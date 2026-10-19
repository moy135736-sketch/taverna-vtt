import crypto from 'node:crypto';
import { processInlineRolls, rollExpression, RollError } from '../../shared/dice.js';
import { parseTemplateProps, inlineRefs } from '../../shared/text.js';
import { newId } from '../../shared/ids.js';

export const rng = (sides) => crypto.randomInt(1, Math.max(1, Math.floor(sides)) + 1);

const TEMPLATE_RE = /&\{template:([^}]*)\}/i;
const NOERROR_RE = /&\{noerror\}/gi;
const TRACKER_RE = /&\{tracker(?::([+-]))?\}/i;

export class ChatError extends Error {}

function parseQuotedName(rest) {
  rest = rest.replace(/^\s+/, '');
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end > 0) return { name: rest.slice(1, end), rest: rest.slice(end + 1).replace(/^\s/, '') };
  }
  const m = /^(\S+)\s?([\s\S]*)$/.exec(rest);
  if (!m) return { name: '', rest: '' };
  return { name: m[1], rest: m[2] };
}

const HELP = `Команды чата:
/roll или /r 1d20+5 — бросок
/gmroll или /gr — бросок, видимый только мастеру
/w Имя текст — шёпот (/w gm — мастеру)
/em текст — действие от лица персонажа
/ooc текст — реплика вне игры
/desc текст — описание (только мастер)
/as "Имя" текст, /emas "Имя" текст — от чужого имени (только мастер)
/fx тип-цвет — спецэффект на выбранном токене
/effect Название — эффект стола на выбранные токены (--target — щёлкнуть по цели, --remove — снять)
/итоги — итоги вечера (/итоги всё — за всю кампанию)
Кинотрюки мастера: /титры Заголовок | подзаголовок, /рассказ текст, /затемнение, /кино (полосы), /тряска [сильно], /вспышка [красная|золотая]
Inline-броски: [[1d20+5]], запросы ?{Вопрос|по умолчанию}, атрибуты @{имя}, способности %{персонаж|способность}, макросы #имя`;

/**
 * Собрать сообщение чата из одной строки.
 * @param room GameRoom
 * @param user {id, displayName, color, avatar}
 * @param payload {text, as:{type,id}, selected:[tokenId]}
 * @returns {{msg?, fx?, error?, tracker?: [...]}}
 */
export function buildMessage(room, user, payload, { isGM }) {
  let text = String(payload.text ?? '').replace(/\s+$/, '');
  if (!text.trim()) return {};
  if (text.length > 60000) text = text.slice(0, 60000);

  // Кто говорит
  let who = user.displayName;
  let avatar = user.avatar || '';
  let charId = null;
  if (payload.as && payload.as.type === 'char' && payload.as.id) {
    const ch = room.entities.char.get(payload.as.id);
    if (ch && room.canControlChar({ userId: user.id, isGM }, ch)) {
      who = ch.name || 'Без имени';
      avatar = ch.avatar || '';
      charId = ch.id;
    }
  }

  const msg = {
    id: newId(),
    ts: Date.now(),
    type: 'general',
    who,
    playerId: user.id,
    color: user.color,
    avatar,
    charId,
    content: '',
  };

  let content = text;
  let isRoll = false;

  if (content.startsWith('!')) {
    return { error: 'Команды API (начинаются с «!») здесь не поддерживаются.' };
  }

  if (content.startsWith('/')) {
    const m = /^\/([\p{L}\w]+)\s?([\s\S]*)$/u.exec(content);
    const cmd = m ? m[1].toLowerCase() : '';
    const rest = m ? m[2] : '';
    switch (cmd) {
      case 'r':
      case 'roll':
        msg.type = 'rollresult';
        content = rest;
        isRoll = true;
        break;
      case 'gr':
      case 'gmroll':
        msg.type = 'gmrollresult';
        msg.toGM = true;
        content = rest;
        isRoll = true;
        break;
      case 'w':
      case 'whisper': {
        const { name, rest: r2 } = parseQuotedName(rest);
        if (!name) return { error: 'Укажите, кому шептать: /w Имя текст' };
        const target = room.resolveWhisperTarget(name);
        if (!target) return { error: `Не найден игрок или персонаж «${name}»` };
        msg.type = 'whisper';
        msg.to = target.ids;
        msg.toGM = !!target.gm;
        msg.targetName = target.name;
        content = r2;
        // /w gm /roll ... — внутри шёпота может быть бросок
        const inner = /^\/(r|roll)\s([\s\S]*)$/i.exec(content);
        if (inner) {
          isRoll = true;
          content = inner[2];
        }
        break;
      }
      case 'em':
      case 'me':
      case 'emote':
        msg.type = 'emote';
        content = rest;
        break;
      case 'ooc':
        msg.type = 'ooc';
        content = rest;
        break;
      case 'desc':
        if (!isGM) return { error: '/desc доступна только мастеру' };
        msg.type = 'desc';
        msg.who = '';
        content = rest;
        break;
      case 'as':
      case 'emas': {
        if (!isGM) return { error: `/${cmd} доступна только мастеру` };
        const { name, rest: r2 } = parseQuotedName(rest);
        msg.who = name || who;
        msg.charId = null;
        msg.avatar = '';
        msg.type = cmd === 'emas' ? 'emote' : 'general';
        content = r2;
        break;
      }
      case 'direct':
        content = rest;
        break;
      case 'fx': {
        const parts = rest.trim().split(/\s+/);
        return { fx: { spec: parts[0] || 'burst-fire', from: parts[1] || (payload.selected || [])[0], to: parts[2] || null } };
      }
      case 'итоги':
      case 'summary':
        return { summary: { arg: rest.trim() } };
      // кинотрюки мастера
      case 'title':
      case 'титры': {
        if (!isGM) return { error: 'Кинотрюки — только у мастера' };
        const [title, ...sub] = rest.split('|');
        return { cine: { kind: 'title', title: title.trim(), subtitle: sub.join('|').trim() } };
      }
      case 'narrate':
      case 'рассказ':
      case 'рассказчик':
        if (!isGM) return { error: 'Кинотрюки — только у мастера' };
        return { cine: { kind: 'narrate', text: rest } };
      case 'fade':
      case 'затемнение':
      case 'bars':
      case 'кино': {
        if (!isGM) return { error: 'Кинотрюки — только у мастера' };
        const a = rest.trim().toLowerCase();
        const on = /^(on|вкл|да|1)$/.test(a) ? true : /^(off|выкл|нет|0)$/.test(a) ? false : undefined;
        return { cine: { kind: cmd === 'fade' || cmd === 'затемнение' ? 'fade' : 'bars', on } };
      }
      case 'shake':
      case 'тряска':
        if (!isGM) return { error: 'Кинотрюки — только у мастера' };
        return { cine: { kind: 'shake', strength: /сильн|strong|big/i.test(rest) ? 'strong' : 'light' } };
      case 'flash':
      case 'вспышка': {
        if (!isGM) return { error: 'Кинотрюки — только у мастера' };
        const color = /красн|red/i.test(rest) ? 'red' : /золот|gold/i.test(rest) ? 'gold' : /ч[её]рн|black/i.test(rest) ? 'black' : 'white';
        return { cine: { kind: 'flash', color } };
      }
      case 'help':
      case '?':
        return { error: HELP, info: true };
      case 'talktomyself':
        return { error: 'Режим разговора с собой включается кнопкой в чате.', info: true };
      default:
        // неизвестная команда — показываем как обычный текст
        break;
    }
  }

  // Флаги
  const noerror = /&\{noerror\}/i.test(content);
  content = content.replace(NOERROR_RE, '');

  // Шаблон
  const tm = TEMPLATE_RE.exec(content);
  if (tm && !isRoll) {
    msg.template = tm[1].trim();
    content = content.replace(new RegExp(TEMPLATE_RE.source, 'gi'), '');
  }

  const ctx = { rng, tables: (name) => room.tableItems(name) };
  const trackerUpdates = [];

  try {
    const { text: replaced, rolls } = processInlineRolls(content, ctx);
    msg.inlinerolls = rolls;
    for (const r of rolls) if (r.tracker) trackerUpdates.push({ value: r.total, mode: r.tracker });
    content = replaced;
    if (isRoll) {
      // inline-броски в /roll работают как переменные
      let rollText = content.replace(/\$\[\[(\d+)\]\]/g, (m, n) => {
        const r = rolls[Number(n)];
        return r ? String(r.type === 'table' ? r.tableText : r.total) : m;
      });
      let tracker = null;
      const trm = TRACKER_RE.exec(rollText);
      if (trm) {
        tracker = trm[1] || '=';
        rollText = rollText.replace(TRACKER_RE, ' ');
      }
      const main = rollExpression(rollText, { ...ctx, allowTrailing: true });
      msg.roll = main;
      msg.origRoll = rollText.trim();
      if (tracker) trackerUpdates.push({ value: main.total, mode: tracker });
      content = '';
    }
  } catch (e) {
    if (e instanceof RollError) {
      if (noerror) return {};
      return { error: 'Ошибка в броске: ' + e.message };
    }
    throw e;
  }

  msg.content = content.trim();
  if (msg.template) {
    // связь «свойство шаблона → inline-бросок» для Custom Roll Parsing
    const keys = {};
    for (const [k, v] of parseTemplateProps(msg.content)) {
      const refs = inlineRefs(v);
      if (refs.length) keys[k] = refs[0];
    }
    msg.rollKeys = keys;
  }
  if (!msg.content && !msg.roll && !msg.template) return {};
  return { msg, tracker: trackerUpdates };
}

/** Результаты для startRoll (Custom Roll Parsing) в формате Roll20 */
export function crpResults(msg) {
  const out = {};
  const keys = msg.rollKeys || {};
  for (const [k, idx] of Object.entries(keys)) {
    const r = msg.inlinerolls[idx];
    if (!r) continue;
    out[k] = {
      result: r.type === 'table' ? r.tableText : r.total,
      dice: r.dice,
      expression: r.expression,
      rolls: r.rolls,
    };
  }
  return out;
}

export function sanitizeComputed(computed) {
  const out = {};
  if (!computed || typeof computed !== 'object') return out;
  for (const [k, v] of Object.entries(computed).slice(0, 200)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 2000);
    else if (typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}
