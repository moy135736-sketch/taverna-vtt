// Генерация идентификаторов в стиле Roll20 (Firebase push id, 20 символов, начинаются с "-").
// Используется и на сервере, и в браузере.

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
// id строк и объектов: время — без "_" (63 символа), случайная часть — ещё и без заглавных,
// чтобы id не совпадали без учёта регистра (имена атрибутов регистронезависимы)
const TIME_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ROW_CHARS = '-0123456789abcdefghijklmnopqrstuvwxyz';

function randInt(n) {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] % n;
  }
  return Math.floor(Math.random() * n);
}

/**
 * Генератор push-id: 8 символов времени + 12 символов случайной части.
 * Внутри одной миллисекунды случайная часть увеличивается на единицу, поэтому id уникальны
 * и растут в порядке создания.
 */
function pushIdGenerator(timeChars, randChars) {
  const tb = timeChars.length;
  const base = randChars.length;
  let lastTime = 0;
  const last = [];
  return function () {
    let now = Date.now();
    const dup = now === lastTime;
    lastTime = now;
    let ts = '';
    for (let i = 0; i < 8; i++) {
      ts = timeChars.charAt(now % tb) + ts;
      now = Math.floor(now / tb);
    }
    if (!dup) for (let i = 0; i < 12; i++) last[i] = randInt(base);
    else {
      let i;
      for (i = 11; i >= 0 && last[i] === base - 1; i--) last[i] = 0;
      if (i >= 0) last[i]++;
    }
    let id = ts;
    for (let i = 0; i < 12; i++) id += randChars.charAt(last[i]);
    return id;
  };
}

/** Уникальный, монотонно растущий идентификатор (как у объектов Roll20). */
export const generateUUID = pushIdGenerator(PUSH_CHARS, PUSH_CHARS);

/** Идентификатор строки повторяющейся секции — без "_" (как generateRowID в Roll20), растёт по времени. */
export const generateRowID = pushIdGenerator(TIME_CHARS, ROW_CHARS);

/** Идентификатор объекта игры. Без "_", чтобы его можно было безопасно вставлять в имена атрибутов. */
export function newId() {
  return generateRowID();
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Короткий код (для приглашения в стол), без похожих символов 0/O, 1/I. */
export function randomCode(len = 8) {
  let s = '';
  const c = globalThis.crypto;
  const a = new Uint8Array(len);
  if (c && c.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < len; i++) a[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < len; i++) s += CODE_CHARS[a[i] % CODE_CHARS.length];
  return s;
}
