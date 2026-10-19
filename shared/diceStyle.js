// Свои кубики и эффект броска в чате — выбор игрока в «Для меня». Хранится в его аккаунте и виден всем за столом.

/** Эффекты, с которыми бросок прилетает в чат: [id, название] */
export const ROLL_FX = [
  ['auto', 'По оформлению стола'],
  ['none', 'Без эффекта'],
  ['leaves', 'Листопад'],
  ['sparks', 'Искры'],
  ['embers', 'Угли'],
  ['frost', 'Иней'],
  ['lightning', 'Молния'],
  ['smoke', 'Дым'],
  ['petals', 'Лепестки'],
  ['stardust', 'Звёздная пыль'],
  ['ink', 'Чернила'],
  ['splash', 'Брызги'],
  ['runes', 'Руны'],
  ['glitch', 'Глитч'],
];

const okId = (x) => (typeof x === 'string' && /^[a-z0-9-]{1,24}$/.test(x) ? x : undefined);

/** Выбор игрока без мусора: { skin, fx } */
export function cleanDiceStyle(v) {
  const o = v && typeof v === 'object' ? v : {};
  return { skin: okId(o.skin) || 'player', fx: okId(o.fx) || 'auto' };
}
