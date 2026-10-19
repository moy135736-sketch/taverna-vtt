// Имена атрибутов в стиле Roll20.
//  - имя без учёта регистра;
//  - суффикс _max обращается к максимальному значению атрибута;
//  - repeating_<секция>_<id строки>_<поле> — атрибуты повторяющихся секций.

export const lc = (s) => String(s ?? '').toLowerCase();

/** Разделить «hp_max» на {base:'hp', max:true}. */
export function splitMax(name) {
  const n = String(name);
  if (/_max$/i.test(n) && n.length > 4) return { base: n.slice(0, -4), max: true };
  return { base: n, max: false };
}

/** Похоже ли на id строки Roll20 (-Mxxxx...) */
export function looksLikeRowId(s) {
  return /^-[A-Za-z0-9-]{3,}$/.test(s);
}

/**
 * Разобрать имя атрибута повторяющейся секции.
 * @returns {{section, rowId, field}|null} section — без префикса repeating_
 */
export function parseRepeating(name) {
  const m = /^repeating_([^_]+)_([^_]+)_(.+)$/i.exec(String(name));
  if (!m) return null;
  return { section: m[1], rowId: m[2], field: m[3] };
}

/** Секция без строки: repeating_weapons_name → {section:'weapons', rest:'name'} */
export function parseRepeatingPrefix(name) {
  const m = /^repeating_([^_]+)_(.+)$/i.exec(String(name));
  if (!m) return null;
  return { section: m[1], rest: m[2] };
}

export function repName(section, rowId, field) {
  return `repeating_${section}_${rowId}_${field}`;
}

/** Значение атрибута как строка (для DOM и макросов). */
export function attrString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  return String(v);
}

export function reporderName(section) {
  return `_reporder_repeating_${section}`;
}
