// Бестиарий: монстры D&D для стола. Источники — System Reference Document 5.2.1 (CC BY 4.0, © Wizards of the Coast):
//   • Markdown SRD 5.2.1 (github.com/downfallx/dnd-5e-srd-markdown) — из него собран встроенный бестиарий;
//   • JSON в духе Open5e (например, gist krisimmig «dnd_srd_5_2_1__monsters.json») — загрузка по ссылке или файлом.
// Из монстра собирается персонаж стола: статблок, атрибуты для листа «D&D 2024», кнопки токена
// (инициатива, спасбросок, атаки с уроном) и токен по размеру существа.
import { newBar } from './defaults.js';

export const SIZES = { Tiny: 0.5, Small: 1, Medium: 1, Large: 2, Huge: 3, Gargantuan: 4 };
export const ABIL = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABIL_ATTR = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
const ABIL_BY_NAME = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
export const ABIL_RU = { str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма' };
const SKILL_KEYS = {
  acrobatics: 'acrobatics', 'animal handling': 'animal_handling', arcana: 'arcana', athletics: 'athletics', deception: 'deception', history: 'history',
  insight: 'insight', intimidation: 'intimidation', investigation: 'investigation', medicine: 'medicine', nature: 'nature', perception: 'perception',
  performance: 'performance', persuasion: 'persuasion', religion: 'religion', 'sleight of hand': 'sleight_of_hand', stealth: 'stealth', survival: 'survival',
};
const SKILL_ABIL = {
  acrobatics: 'dex', animal_handling: 'wis', arcana: 'int', athletics: 'str', deception: 'cha', history: 'int', insight: 'wis', intimidation: 'cha',
  investigation: 'int', medicine: 'wis', nature: 'int', perception: 'wis', performance: 'cha', persuasion: 'cha', religion: 'int', sleight_of_hand: 'dex', stealth: 'dex', survival: 'wis',
};

/** Опыт за монстра по уровню опасности */
export const CR_XP = {
  0: 10, '1/8': 25, '1/4': 50, '1/2': 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900, 9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000,
  14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000,
  28: 120000, 29: 135000, 30: 155000,
};
/** Уровень опасности числом: «1/4» → 0.25 */
export function crValue(cr) {
  const s = String(cr ?? '').trim();
  const f = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (f) return Number(f[1]) / Number(f[2]);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
export const pbOfCr = (cr) => {
  const v = crValue(cr);
  return v < 5 ? 2 : v < 9 ? 3 : v < 13 ? 4 : v < 17 ? 5 : v < 21 ? 6 : v < 25 ? 7 : v < 29 ? 8 : 9;
};
export const modOf = (score) => Math.floor((Number(score) - 10) / 2);
const num = (v, d = 0) => {
  const n = Number(String(v ?? '').replace('−', '-').replace(/\s+/g, ''));
  return Number.isFinite(n) ? n : d;
};
const sign = (n) => (n >= 0 ? '+' : '−') + Math.abs(n);

export function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9а-яё]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'monster'
  );
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', emsp: ' ', ensp: ' ', thinsp: ' ', mdash: '—', ndash: '–', minus: '−', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
/** Строка статблока без HTML: <br> — перенос, прочие теги убираются */
function clean(s) {
  return decode(
    String(s)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t  ]+/g, ' ').trim())
    .join('\n')
    .trim();
}

function emptyMonster(name, group) {
  return {
    id: slugify(name),
    name: String(name).trim(),
    group: group || '',
    size: 'Medium',
    type: '',
    alignment: '',
    ac: 10,
    acNote: '',
    init: 0,
    hp: 1,
    hpFormula: '',
    speed: '',
    abil: Object.fromEntries(ABIL.map((a) => [a, [10, 0, 0]])),
    skills: '',
    resistances: '',
    vulnerabilities: '',
    immunities: '',
    gear: '',
    senses: '',
    languages: '',
    cr: '0',
    xp: 0,
    pb: 2,
    traits: [],
    actions: [],
    bonus: [],
    reactions: [],
    legendary: [],
    legendaryIntro: '',
  };
}

/** «Large Aberration, Lawful Evil» / «Large Beast (Dinosaur), Unaligned» */
function parseKind(m, line) {
  const s = clean(line.replace(/^_|_$/g, ''));
  const k = /^(Tiny|Small|Medium|Large|Huge|Gargantuan)(?:\s+or\s+\w+)?\s+(.+?)(?:,\s*(.+))?$/.exec(s);
  if (!k) return;
  m.size = k[1];
  m.type = k[2].trim();
  m.alignment = (k[3] || '').trim();
}

const SECTIONS = { traits: 'traits', actions: 'actions', 'bonus actions': 'bonus', reactions: 'reactions', 'legendary actions': 'legendary' };

/** Разбор Markdown SRD 5.2.1: «### Имя», курсив с размером и типом, свойства, таблица характеристик, разделы с действиями */
export function parseSrdMarkdown(md) {
  const lines = String(md || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out = [];
  let group = '';
  let cur = null;
  const finishEntry = () => {
    if (cur?.entry) {
      cur.entry.text = clean(cur.entry.text);
      cur.entry = null;
    }
  };
  const flush = () => {
    if (!cur) return;
    finishEntry();
    const m = cur.m;
    // таблица характеристик: группы по 4 ячейки — название, значение, модификатор, спасбросок
    for (let i = 0; i + 3 < cur.cells.length; i += 4) {
      const a = cur.cells[i].toLowerCase();
      if (ABIL.includes(a)) m.abil[a] = [num(cur.cells[i + 1], 10), num(cur.cells[i + 2], 0), num(cur.cells[i + 3], 0)];
    }
    if (m.legendaryIntro) m.legendaryIntro = clean(m.legendaryIntro.replace(/^_|_$/g, ''));
    out.push(m);
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const depth = h[1].length;
      const title = clean(h[2]);
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (/^_(Tiny|Small|Medium|Large|Huge|Gargantuan)\b.*_\s*$/.test(lines[j] || '')) {
        flush();
        cur = { m: emptyMonster(title, group), depth, section: null, entry: null, cells: [] };
        parseKind(cur.m, lines[j].trim());
        i = j;
        continue;
      }
      if (cur && depth > cur.depth) {
        finishEntry();
        cur.section = SECTIONS[title.toLowerCase()] || 'other';
        continue;
      }
      flush();
      if (depth <= 2) group = title;
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    const m = cur.m;
    if (!cur.section) {
      // свойства статблока
      let p;
      if ((p = /\*\*AC\*\*\s*(\d+)\s*(.*?)\s*\*\*Initiative\*\*\s*([+−-]?\s*\d+)/.exec(t) || /\*\*AC\*\*\s*(\d+)\s*(.*)$/.exec(t))) {
        m.ac = Number(p[1]);
        m.acNote = clean(p[2] || '').replace(/^\(|\)$/g, '');
        if (p[3]) m.init = num(p[3]);
      } else if ((p = /^\*\*HP\*\*\s*(\d+)\s*(?:\(([^)]*)\))?/.exec(t))) {
        m.hp = Number(p[1]);
        m.hpFormula = (p[2] || '').trim();
      } else if ((p = /^\*\*(Speed|Skills|Resistances|Vulnerabilities|Immunities|Gear|Senses|Languages)\*\*\s*(.*)$/.exec(t))) {
        const key = { Speed: 'speed', Skills: 'skills', Resistances: 'resistances', Vulnerabilities: 'vulnerabilities', Immunities: 'immunities', Gear: 'gear', Senses: 'senses', Languages: 'languages' }[p[1]];
        m[key] = clean(p[2]);
      } else if ((p = /^\*\*CR\*\*\s*([\d/]+)\s*(?:\((.*)\))?/.exec(t))) {
        m.cr = p[1];
        const xp = /XP\s*([\d,]+)/.exec(p[2] || '');
        m.xp = xp ? Number(xp[1].replace(/,/g, '')) : CR_XP[p[1]] || 0;
        const pb = /PB\s*\+?(\d+)/.exec(p[2] || '');
        m.pb = pb ? Number(pb[1]) : pbOfCr(p[1]);
      } else {
        for (const c of t.matchAll(/<td>(.*?)<\/td>/g)) cur.cells.push(clean(c[1]));
      }
      continue;
    }
    if (!t || /^<hr\s*\/?>$/i.test(t)) continue;
    const list = cur.section === 'other' ? m.traits : m[cur.section];
    const e = /^\*\*_(.+?)_\*\*\s*(.*)$/.exec(t);
    if (e) {
      finishEntry();
      cur.entry = { name: clean(e[1]).replace(/\.$/, ''), text: e[2] };
      list.push(cur.entry);
    } else if (cur.entry) cur.entry.text += '\n' + t;
    else if (cur.section === 'legendary') m.legendaryIntro += (m.legendaryIntro ? '\n' : '') + t;
  }
  flush();
  return out;
}

// ---------- ссылки на GitHub ----------

/**
 * Ссылка, которую дал мастер, → ссылки на сами файлы (raw), которые можно скачать:
 * страница gist → его raw; файл в репозитории (blob) → raw; весь репозиторий Markdown SRD → монстры и животные.
 */
export function githubRawUrls(input) {
  const s = String(input || '').trim();
  let m;
  if ((m = /^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/raw(\/[^#?]*)?(?:[#?].*)?$/i.exec(s))) return [`https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw${m[3] || ''}`];
  if ((m = /^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/?(?:[#?].*)?$/i.exec(s))) return [`https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`];
  if ((m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+?)(?:[#?].*)?$/i.exec(s))) return [`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`];
  if ((m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(s))) return ['monsters-A-Z.md', 'animals.md'].map((f) => `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/${f}`);
  return s ? [s] : [];
}

// ---------- JSON в духе Open5e ----------

const cap = (s) => String(s || '').replace(/^\w/, (c) => c.toUpperCase());
function speedText(sp) {
  if (typeof sp === 'string') return sp;
  if (!sp || typeof sp !== 'object') return '';
  const parts = [];
  if (sp.walk !== undefined) parts.push(`${sp.walk} ft.`);
  for (const [k, v] of Object.entries(sp)) {
    if (k === 'walk' || k === 'hover' || v === null || v === undefined || v === false) continue;
    parts.push(`${cap(k)} ${v} ft.${k === 'fly' && sp.hover ? ' (hover)' : ''}`);
  }
  return parts.join(', ');
}
const listText = (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v || ''));
const entries = (v) => (Array.isArray(v) ? v.filter((e) => e && (e.name || e.desc)).map((e) => ({ name: String(e.name || '').replace(/\.$/, ''), text: String(e.desc || '').trim() })) : []);

/** Монстр в формате Open5e (поля name, armor_class, hit_points, speed{…}, strength…, actions[{name, desc}] …) */
export function fromOpen5e(o, slug = '') {
  const m = emptyMonster(o.name || slug, o.group || '');
  if (slug || o.slug) m.id = slugify(o.slug || slug);
  m.size = cap(o.size) || 'Medium';
  m.type = cap(o.type) + (o.subtype ? ` (${o.subtype})` : '');
  m.alignment = cap(o.alignment);
  m.ac = num(o.armor_class, 10);
  m.acNote = String(o.armor_desc || '');
  m.hp = num(o.hit_points, 1);
  m.hpFormula = String(o.hit_dice || '');
  m.speed = speedText(o.speed);
  for (const a of ABIL) {
    const full = ABIL_ATTR[a];
    const score = num(o[full], 10);
    const mod = modOf(score);
    const save = o[full + '_save'];
    m.abil[a] = [score, mod, save === null || save === undefined || save === '' ? mod : num(save, mod)];
  }
  m.init = o.initiative !== undefined && o.initiative !== null ? num(o.initiative) : m.abil.dex[1];
  // навыки: объект skills; у Open5e Внимательность бывает отдельным полем perception
  const skills = o.skills && typeof o.skills === 'object' && !Array.isArray(o.skills) ? { ...o.skills } : {};
  if (skills.perception === undefined && o.perception !== undefined && o.perception !== null && o.perception !== '') skills.perception = o.perception;
  if (Object.keys(skills).length)
    m.skills = Object.entries(skills)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${cap(k.replace(/_/g, ' '))} ${sign(num(v))}`)
      .join(', ');
  m.resistances = listText(o.damage_resistances);
  m.vulnerabilities = listText(o.damage_vulnerabilities);
  m.immunities = [listText(o.damage_immunities), listText(o.condition_immunities)].filter(Boolean).join('; ');
  m.senses = String(o.senses || '');
  m.languages = String(o.languages || '');
  m.cr = String(o.challenge_rating ?? o.cr ?? '0');
  m.xp = CR_XP[m.cr] ?? 0;
  m.pb = pbOfCr(m.cr);
  m.traits = entries(o.special_abilities);
  m.actions = entries(o.actions);
  m.bonus = entries(o.bonus_actions);
  m.reactions = entries(o.reactions);
  m.legendary = entries(o.legendary_actions);
  m.legendaryIntro = String(o.legendary_desc || '');
  return m;
}

/**
 * Монстры из текста: JSON (объект «slug → монстр», массив или {results: […]}) или Markdown SRD.
 * Возвращает только то, что похоже на монстров.
 */
export function parseBestiary(text) {
  const s = String(text || '').trim();
  let list = [];
  if (s.startsWith('{') || s.startsWith('[')) {
    let data;
    try {
      data = JSON.parse(s);
    } catch {
      throw new Error('Файл похож на JSON, но прочитать его не удалось');
    }
    // уже наш формат: {monsters: […]}
    if (data && Array.isArray(data.monsters)) return uniqueIds(data.monsters.filter((m) => m && m.name && m.abil).map(normalize));
    const items = Array.isArray(data) ? data.map((o) => [o?.slug || '', o]) : Array.isArray(data?.results) ? data.results.map((o) => [o?.slug || '', o]) : Object.entries(data || {});
    for (const [k, o] of items) if (o && typeof o === 'object' && !Array.isArray(o) && o.name && (o.hit_points !== undefined || o.armor_class !== undefined)) list.push(fromOpen5e(o, k));
  } else list = parseSrdMarkdown(s);
  return uniqueIds(list.map(normalize));
}

/** Одинаковые id в одном списке (два «Bandit» в разных файлах) → «bandit», «bandit-2» */
export function uniqueIds(list) {
  const seen = new Map();
  return list.map((m) => {
    const n = (seen.get(m.id) || 0) + 1;
    seen.set(m.id, n);
    return n > 1 ? { ...m, id: `${m.id}-${n}` } : m;
  });
}

/** Проверка и приведение (свои поля и границы — данные приходят из чужих файлов) */
function normalize(m) {
  const str = (v, n = 4000) => String(v ?? '').slice(0, n);
  const ent = (l) => (Array.isArray(l) ? l.slice(0, 40).map((e) => ({ name: str(e?.name, 120), text: str(e?.text, 4000) })) : []);
  const abil = {};
  for (const a of ABIL) {
    const v = Array.isArray(m.abil?.[a]) ? m.abil[a] : [10, 0, 0];
    abil[a] = [num(v[0], 10), num(v[1], modOf(num(v[0], 10))), num(v[2], num(v[1], 0))];
  }
  return {
    id: slugify(m.id || m.name),
    name: str(m.name, 120),
    group: str(m.group, 120),
    size: SIZES[m.size] ? m.size : 'Medium',
    type: str(m.type, 80),
    alignment: str(m.alignment, 80),
    ac: num(m.ac, 10),
    acNote: str(m.acNote, 120),
    init: num(m.init, abil.dex[1]),
    hp: Math.max(1, num(m.hp, 1)),
    hpFormula: str(m.hpFormula, 60),
    speed: str(m.speed, 200),
    abil,
    skills: str(m.skills, 400),
    resistances: str(m.resistances, 400),
    vulnerabilities: str(m.vulnerabilities, 400),
    immunities: str(m.immunities, 400),
    gear: str(m.gear, 400),
    senses: str(m.senses, 400),
    languages: str(m.languages, 400),
    cr: str(m.cr || '0', 8),
    xp: num(m.xp, CR_XP[m.cr] || 0),
    pb: num(m.pb, pbOfCr(m.cr)),
    traits: ent(m.traits),
    actions: ent(m.actions),
    bonus: ent(m.bonus),
    reactions: ent(m.reactions),
    legendary: ent(m.legendary),
    legendaryIntro: str(m.legendaryIntro, 1000),
  };
}

// ---------- действия: атака, спасбросок, урон ----------

const plainText = (s) =>
  String(s || '')
    .replace(/\*\*|__|\*|_/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const diceExpr = (s) =>
  String(s)
    .replace(/\s+/g, '')
    .replace(/[−–]/g, '-');

const DMG_TYPES = 'Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Piercing|Poison|Psychic|Radiant|Slashing|Thunder';
const capType = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const DICE = '\\d*d\\d+(?:\\s*[+−-]\\s*\\d+)?';

/**
 * Что делает действие: { attack: {kind, bonus, reach}, save: {ability, dc, target}, damage: [{dice, type}], rest, success }
 * Формат SRD 5.2.1: «Melee Attack Roll: +9, reach 15 ft. Hit: 12 (2d6 + 5) Bludgeoning damage. …»,
 * «Dexterity Saving Throw: DC 15, each creature in a 30-foot Cone. Failure: 49 (14d6) Fire damage. Success: Half damage.»
 * Понимает и старый SRD 5.1 (2014), как в JSON Open5e: «Melee Weapon Attack: +4 to hit, reach 5 ft., one target.
 * Hit: 5 (1d6 + 2) slashing damage.», «…must make a DC 13 Dexterity saving throw, taking 22 (4d10) fire damage
 * on a failed save, or half as much damage on a successful one.»
 */
export function parseAction(text) {
  const t = plainText(text);
  const out = { attack: null, save: null, damage: [], rest: '', success: '' };
  // «reach 5 ft. or range 120 ft.» — в тексте до «Hit:» есть точки сокращений, поэтому берём всё до «Hit:»
  const atk =
    /\b(Melee or Ranged|Melee|Ranged) Attack Roll:\s*([+−-]\s?\d+)\s*,?\s*(.*?)\s*(?:Hit:|$)/i.exec(t) ||
    /\b(Melee or Ranged|Melee|Ranged) (?:Weapon|Spell) Attack:\s*([+−-]\s?\d+)\s*to hit\s*,?\s*(.*?)\s*(?:Hit:|$)/i.exec(t);
  if (atk) out.attack = { kind: atk[1], bonus: num(atk[2]), reach: atk[3].replace(/\.$/, '').trim() };
  const sv = /\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) Saving Throw:\s*DC\s*(\d+)\s*,?\s*(.*?)\s*(?:Failure:|Success:|$)/i.exec(t);
  const sv14 = !sv && /\bDC\s*(\d+)\s+(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/i.exec(t);
  if (sv && !atk) out.save = { ability: ABIL_BY_NAME[sv[1].toLowerCase()], dc: Number(sv[2]), target: sv[3].replace(/\.$/, '').trim() };
  else if (sv14 && !atk) out.save = { ability: ABIL_BY_NAME[sv14[2].toLowerCase()], dc: Number(sv14[1]), target: '' };
  const legacySave = !!(out.save && sv14);
  // где искать урон: после «Hit:» у атаки, после «Failure:» у спасброска, иначе во всём тексте
  let part = t;
  let both = '';
  if (atk) {
    const h = t.search(/\bHit:/i);
    if (h >= 0) part = t.slice(h + 4);
  } else if (out.save && !legacySave) {
    const f = t.search(/\bFailure:/);
    part = f >= 0 ? t.slice(f + 8) : '';
    const fos = part.search(/\bFailure or Success:/);
    if (fos >= 0) {
      both = part.slice(fos + 19).trim();
      part = part.slice(0, fos);
    }
    const sIdx = part.search(/\bSuccess:/);
    if (sIdx >= 0) {
      out.success = part.slice(sIdx + 8).trim();
      part = part.slice(0, sIdx);
    }
  }
  // урон — в первом предложении после «Hit:» / «Failure:» (дальше обычно идут другие последствия);
  // «…, plus 2 (1d4) Slashing damage if the attack roll had Advantage» — урон с условием, отдельно
  if (atk || (out.save && !legacySave)) {
    const cut = /\.\s+(?=[A-Z])/.exec(part);
    const first = cut ? part.slice(0, cut.index + 1) : part;
    const later = cut ? part.slice(cut.index + 1).trim() : '';
    const dmgRe = new RegExp(`(?:,?\\s*(?:plus|and)\\s+)?(\\d+)\\s*(?:\\((${DICE})\\))?\\s+(${DMG_TYPES}) damage((?:\\s+(?:if|while|when|against|to|on)\\b[^.;]*)?)`, 'gi');
    let restFirst = first;
    for (const m of first.matchAll(dmgRe)) {
      const d = { dice: m[2] ? diceExpr(m[2]) : m[1], type: capType(m[3]), avg: Number(m[1]) };
      const cond = (m[4] || '').trim();
      if (cond) d.cond = cond;
      out.damage.push(d);
      restFirst = restFirst.replace(m[0], ' ');
    }
    restFirst = restFirst.replace(/^[\s,;.]+/, '').replace(/^(?:and|plus)\s+/i, '').replace(/^\.$/, '').trim();
    out.rest = [restFirst, later, both].filter(Boolean).join(' ');
  } else {
    // описание целиком; урон — «N (XdY) тип damage» (у старого спасброска — все, иначе первый)
    const all = [...t.matchAll(new RegExp(`(\\d+)\\s*\\((${DICE})\\)\\s+(${DMG_TYPES}) damage`, 'gi'))];
    for (const m of legacySave ? all : all.slice(0, 1)) out.damage.push({ dice: diceExpr(m[2]), type: capType(m[3]), avg: Number(m[1]) });
    if (legacySave && /half as much damage on a successful one/i.test(t)) out.success = 'Half damage.';
    out.rest = t;
  }
  out.rest = out.rest.replace(/^[a-z]/, (c) => c.toUpperCase());
  out.rest = out.rest.replace(/^[,;.\s]+/, '').trim();
  return out;
}

/** Текст для шаблона броска: без «}}» и «[[», которые сломают разбор, одной строкой */
const tval = (s, n = 600) => {
  const t = plainText(
    String(s || '')
      .replace(/:\s*\n+\s*/g, ': ')
      .replace(/\s*\n+\s*/g, '; '),
  )
    .replace(/\}\}/g, '} }')
    .replace(/\[\[/g, '[ [')
    .replace(/\]\]/g, '] ]');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Карточка действия в чат: атака, урон, спасбросок, описание (шаблон default) */
export function actionMacro(e, monster) {
  const a = parseAction(e.text);
  const rows = [`{{name=${tval(e.name, 120)}}}`];
  if (a.attack) rows.push(`{{Атака=[[1d20${a.attack.bonus >= 0 ? '+' : '-'}${Math.abs(a.attack.bonus)}]]${a.attack.reach ? ' — ' + tval(a.attack.reach, 120) : ''}}}`);
  if (a.save) rows.push(`{{Спасбросок=${ABIL_RU[a.save.ability]}, Сл ${a.save.dc}${a.save.target ? ' — ' + tval(a.save.target, 200) : ''}}}`);
  const main = a.damage.filter((d) => !d.cond);
  const extra = a.damage.filter((d) => d.cond);
  const dmg = main.map((d) => `[[${d.dice}]] ${tval(d.type, 30)}`).join(' + ');
  if (a.save) {
    // при провале — урон и/или что ещё случается
    const fail = [dmg, a.rest && tval(a.rest, 400)].filter(Boolean).join('. ');
    if (fail) rows.push(`{{При провале=${fail}}}`);
    if (a.success) rows.push(`{{При успехе=${tval(a.success, 300)}}}`);
  } else {
    if (dmg) rows.push(`{{Урон=${dmg}}}`);
    for (const d of extra) rows.push(`{{Ещё урон=[[${d.dice}]] ${tval(d.type, 30)} — ${tval(d.cond, 200)}}}`);
    const rest = a.attack ? a.rest : e.text;
    if (rest) rows.push(`{{Описание=${tval(rest)}}}`);
  }
  return '&{template:default} ' + rows.join(' ');
}

/** Свойство без броска (черта монстра) — карточкой в чат */
export const traitMacro = (e) => `&{template:default} {{name=${tval(e.name, 120)}}} {{Описание=${tval(e.text, 1500)}}}`;

/** Бросок только мастеру: «/r …» → «/gr …», уже скрытое — как есть, остальное — шёпотом «/w gm …» */
export function gmOnly(text) {
  const s = String(text || '').trim();
  if (!s) return s;
  if (/^\/(gr|gmroll|w|whisper)\s/i.test(s)) return s;
  if (/^\/(r|roll)\s/i.test(s)) return s.replace(/^\/(r|roll)\s/i, '/gr ');
  return '/w gm ' + s;
}

/** Бросок инициативы: попадает в порядок ходов выделенного токена */
export const initiativeMacro = (m) => `/r 1d20${m.init >= 0 ? '+' : '-'}${Math.abs(m.init)} [Инициатива] &{tracker}`;

/** Спасбросок с выбором характеристики */
export function saveMacro(m) {
  const opts = ABIL.map((a) => `${ABIL_RU[a]} (${sign(m.abil[a][2])}),${m.abil[a][2]}`).join('|');
  return `&{template:default} {{name=Спасбросок}} {{Результат=[[1d20+?{Спасбросок|${opts}}]]}}`;
}

/** Кнопки токена монстра: инициатива, спасбросок, действия, бонусные действия, реакции, легендарные действия */
export function monsterAbilities(m, newId) {
  const out = [];
  // ref — какое место статблока кнопка бросает (по нему статблок находит свою кнопку)
  const add = (name, action, ref, description = '') => out.push({ id: newId(), name: String(name).slice(0, 80), action, istokenaction: true, description, ref });
  add('Инициатива', initiativeMacro(m), 'init');
  add('Спасбросок', saveMacro(m), 'save');
  for (const [key, tag] of [
    ['actions', ''],
    ['bonus', 'бонус'],
    ['reactions', 'реакция'],
    ['legendary', 'легенд.'],
  ])
    (m[key] || []).forEach((e, i) => add(tag ? `${e.name} (${tag})` : e.name, actionMacro(e, m), `${key}:${i}`, tag));
  return out;
}

/** Атрибуты персонажа: хиты, КД, характеристики, владение спасбросками и навыками (для листа «D&D 2024») */
export function monsterAttrs(m) {
  const pb = m.pb || pbOfCr(m.cr);
  const set = [
    { name: 'hp', current: m.hp, max: m.hp },
    { name: 'hp_max', current: m.hp, max: '' },
    { name: 'ac', current: m.ac, max: '' },
    { name: 'pb_custom', current: pb, max: '' },
    { name: 'initiative_misc', current: m.init - m.abil.dex[1], max: '' },
    // готовый бонус инициативы — для порядка ходов, пока лист ещё ни разу не пересчитывался
    { name: 'initiative_bonus', current: m.init, max: '' },
    { name: 'cr', current: m.cr, max: '' },
  ];
  const walk = /(\d+)\s*ft/.exec(m.speed || '');
  if (walk) set.push({ name: 'speed', current: Number(walk[1]), max: '' });
  for (const a of ABIL) {
    const [score, mod, save] = m.abil[a];
    set.push({ name: ABIL_ATTR[a], current: score, max: '' });
    set.push({ name: ABIL_ATTR[a] + '_save_prof', current: save > mod ? '1' : '0', max: '' });
  }
  for (const part of String(m.skills || '').split(',')) {
    const s = /^\s*([A-Za-z ]+?)\s*([+−-]\s*\d+)\s*$/.exec(part);
    const key = s && SKILL_KEYS[s[1].toLowerCase()];
    if (!key) continue;
    const extra = num(s[2]) - m.abil[SKILL_ABIL[key]][1];
    const prof = extra >= pb * 2 ? 2 : extra >= pb ? 1 : 0;
    if (prof) set.push({ name: key + '_prof', current: String(prof), max: '' });
  }
  return set;
}

// ---------- токен ----------

/** Цвет кольца токена по типу существа */
export const TYPE_COLORS = {
  aberration: '#8e5bb5',
  beast: '#6f8f3a',
  celestial: '#d9b44a',
  construct: '#8d939c',
  dragon: '#c0392b',
  elemental: '#2f8fbf',
  fey: '#3faf90',
  fiend: '#a3302b',
  giant: '#a7743f',
  humanoid: '#b8956a',
  monstrosity: '#a05a2c',
  ooze: '#7aa83a',
  plant: '#4f8a3a',
  undead: '#7a6f9a',
  swarm: '#6f8f3a',
};
export const typeKey = (type) => String(type || '').toLowerCase().split(/[\s(]/)[0];

/** Инициалы для токена: «Goblin Warrior» → «GW», «Owlbear» → «Ow» */
export function initials(name) {
  const words = String(name || '?')
    .replace(/[^A-Za-zА-Яа-яЁё' -]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w && !/^(of|the|and)$/i.test(w));
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** Картинка токена без арта: тёмный круг, кольцо цвета типа существа, инициалы (SVG в data-ссылке) */
export function tokenImage(m) {
  const ring = TYPE_COLORS[typeKey(m.type)] || '#b8956a';
  const txt = initials(m.name);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<defs><radialGradient id="g" cx="50%" cy="36%" r="72%"><stop offset="0" stop-color="#3b322a"/><stop offset="1" stop-color="#14100c"/></radialGradient></defs>` +
    `<circle cx="50" cy="50" r="46" fill="url(#g)" stroke="${ring}" stroke-width="7"/>` +
    `<circle cx="50" cy="50" r="38.5" fill="none" stroke="${ring}" stroke-opacity=".45" stroke-width="1.6"/>` +
    `<text x="50" y="${txt.length > 1 ? 61 : 63}" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-size="${txt.length > 1 ? 31 : 36}" font-weight="700" fill="#f1e6cc">${xmlEsc(txt)}</text>` +
    `</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** Токен по умолчанию: размер по существу (в клетках), полоса хитов */
export function monsterToken(m) {
  return {
    type: 'image',
    src: tokenImage(m),
    cells: SIZES[m.size] || 1,
    name: m.name,
    showName: true,
    bars: [newBar(2, { name: 'HP', color: '#d63a3a', link: 'hp', value: m.hp, max: m.hp })],
  };
}

export const SRD_ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';

/** Персонаж стола из монстра (без атрибутов — они отдельно, monsterAttrs) */
export function monsterCharacter(m, newId, { source = 'SRD 5.2.1', nameRu = '' } = {}) {
  return {
    name: m.name,
    avatar: '',
    bio: [nameRu && `${m.name} — ${nameRu}`, `${m.size} ${m.type}${m.alignment ? ', ' + m.alignment : ''}. AC ${m.ac}, HP ${m.hp}${m.hpFormula ? ` (${m.hpFormula})` : ''}, CR ${m.cr}.`, `Источник: ${source}.`].filter(Boolean).join('\n'),
    folder: 'Монстры',
    tags: ['монстр'],
    abilities: monsterAbilities(m, newId),
    defaultToken: monsterToken(m),
    statblock: { ...m, source, nameRu },
  };
}
