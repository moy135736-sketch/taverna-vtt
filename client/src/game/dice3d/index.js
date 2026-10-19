// Объёмные кубики: модуль с three.js и физикой грузится при первом броске, а не вместе со столом
let trayPromise = null;
let broken = false;

const forced = () => {
  try {
    return localStorage.getItem('tv:dice3d') === 'force';
  } catch {
    return false;
  }
};

let webgl = null;
/** Есть ли в браузере WebGL (без него — плоская анимация) */
export function webglAvailable() {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement('canvas');
    webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
}

/** Бросить кубики в контейнере. false — не получилось (тогда показываем плоские). skin — набор кубиков игрока */
export async function roll3d(container, dice, color, skin, opts) {
  if (broken || !container || !webglAvailable()) return false;
  try {
    if (!trayPromise) {
      trayPromise = import('./tray.js').then((m) => new m.DiceTray(container));
    }
    const tray = await trayPromise;
    // без видеокарты или на медленном компьютере — плоские кубики (для проверок можно заставить: tv:dice3d=force)
    if ((tray.software || tray.slow) && !forced()) {
      if (!tray.noted) console.info('[кубики] показываю плоские:', tray.software ? `браузер рисует без видеокарты (${tray.gpu})` : 'кадры идут слишком медленно');
      tray.noted = true;
      return false;
    }
    if (!tray.attach(container)) return false;
    return !!tray.roll(dice, color, skin, opts);
  } catch (e) {
    console.warn('[кубики] объёмные недоступны, показываю плоские:', e);
    broken = true;
    disposeDice3d();
    return false;
  }
}

/** Освободить видеопамять (при выходе со стола) */
export function disposeDice3d() {
  const p = trayPromise;
  trayPromise = null;
  p?.then((t) => t.dispose()).catch(() => {});
}
