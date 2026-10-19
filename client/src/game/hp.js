// Хиты токена: какая полоса — хиты и как меняется значение при уроне и лечении (без интерфейса — проверяется тестами)

/** Число из значения полосы или атрибута (null — не число) */
export const num = (v) => {
  const s = String(v ?? '')
    .trim()
    .replace(',', '.')
    .replace('−', '-');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// полоса хитов: по атрибуту, с которым она связана, или по названию
const HP_LINK = /^(hp|hit_?points|hitpoints|health|wounds|npc_hp|hp_current|current_hp|currenthp)$/i;
const HP_NAME = /^(hp|хп|хиты|оз|пз|здоровье|раны|жизнь|жизни|hit ?points|health|wounds)$/i;
export const TEMP = /(temp|врем)/i;
const NOT_HP = /(^|_)(ac|armou?r|кд|speed|mana|mp|ki)($|_)/i;

/** Какая полоса токена — хиты. pref — настройка стола «Полоса хитов»: 'auto' или номер полосы */
export function hpBarOf(bars, pref = 'auto') {
  if (!Array.isArray(bars) || !bars.length) return null;
  if (pref && pref !== 'auto') return bars[Number(pref) - 1] || null;
  const plain = (b) => !TEMP.test(b.name || '') && !TEMP.test(b.link || '');
  return (
    bars.find((b) => plain(b) && b.link && HP_LINK.test(b.link)) ||
    bars.find((b) => plain(b) && HP_NAME.test(String(b.name || '').trim())) ||
    // как в листе D&D 5E: первая полоса — хиты (значение и максимум), вторая связана с КД
    bars.find((b) => plain(b) && !(b.link && NOT_HP.test(b.link)) && num(b.value) !== null && num(b.max) !== null) ||
    (bars.length === 1 && num(bars[0].value) !== null ? bars[0] : null)
  );
}

/** Сколько применить: половина — с округлением вниз, как в D&D */
export function effectiveAmount(amount, mode) {
  const a = Math.max(0, Math.floor(amount));
  return mode === 'half' ? Math.floor(a / 2) : mode === 'double' ? a * 2 : a;
}

/**
 * Новые хиты. cur/max — значение и максимум полосы, temp — временные хиты (принимают урон первыми).
 * Урон не опускает хиты ниже нуля (если не разрешено), лечение не поднимает выше максимума
 * и не уменьшает хиты, которые уже выше максимума.
 * Возвращает { next, temp } — новые хиты и новые временные хиты.
 */
export function applyHp({ cur, max = null, temp = 0, value, heal = false, allowNegative = false }) {
  if (heal) {
    let next = cur + value;
    if (max !== null) next = Math.max(cur, Math.min(max, next));
    return { next, temp };
  }
  const used = Math.min(Math.max(0, temp || 0), value);
  let next = cur - (value - used);
  if (!allowNegative) next = Math.max(Math.min(cur, 0), next);
  return { next, temp: (temp || 0) - used };
}
