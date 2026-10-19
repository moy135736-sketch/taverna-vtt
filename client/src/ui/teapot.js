// «Режим чайника» — для слабых и горячих ноутбуков: всё работает как обычно, но без тяжёлой красоты.
// Кубики — плоские, оформление стола — неподвижное, эффекты бросков в чате — выключены, погода и
// спецэффекты — реже и меньше частиц, эффекты токенов (пульсация, горение…) — без движения.
// Хранится на этом устройстве: зависит от компьютера, а не от аккаунта.
const KEY = 'tv:teapot';

export const TEAPOT_ON =
  'Режим чайника включён: кубики плоские, оформление без анимации, эффекты бросков выключены, погода и спецэффекты легче. Всё остальное работает как обычно.';
export const TEAPOT_OFF = 'Режим чайника выключен: снова объёмные кубики, анимация оформления и эффекты бросков.';
/** Что меняет режим — для подсказок */
export const TEAPOT_HINT =
  'Для слабых и горячих компьютеров. Кубики — плоские, оформление стола — без анимации, без эффектов бросков в чате, погода и спецэффекты — реже и легче, эффекты токенов — без движения. Всё остальное работает как обычно. Только на этом устройстве.';

export function teapot() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Поставить класс на <html> (по нему CSS гасит анимации) */
export function applyTeapot() {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('teapot', teapot());
}

export function setTeapot(on) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* хранилище недоступно — режим на один сеанс */
  }
  applyTeapot();
  window.dispatchEvent(new CustomEvent('tv:teapot', { detail: !!on }));
}

/** Подписка на переключение (в этой и в других вкладках). Возвращает отписку */
export function onTeapot(fn) {
  const own = (e) => fn(!!e.detail);
  const other = (e) => {
    if (e.key !== KEY) return;
    applyTeapot();
    fn(teapot());
  };
  window.addEventListener('tv:teapot', own);
  window.addEventListener('storage', other);
  return () => {
    window.removeEventListener('tv:teapot', own);
    window.removeEventListener('storage', other);
  };
}
