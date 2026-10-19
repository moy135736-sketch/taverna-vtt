// Оформление стола под систему игры: «Таверна» (по умолчанию), «Киберпанк» (тактический терминал)
// и «Фэнтези» (летопись с золотом и магией). Мастер выбирает для стола (или «по листу»),
// каждый игрок может оставить себе обычное и выключить анимацию оформления.
import { useEffect, useState } from 'preact/hooks';
import { teapot, onTeapot } from '../ui/teapot.js';
// шрифты оформлений: браузер скачает файлы, только когда оформление их применит
import '@fontsource/tektur/cyrillic-600.css';
import '@fontsource/tektur/latin-600.css';
import '@fontsource/ibm-plex-sans/cyrillic-400.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/cyrillic-600.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/cyrillic-400.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/cyrillic-600.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/cormorant-unicase/cyrillic-600.css';
import '@fontsource/cormorant-unicase/latin-600.css';
import '@fontsource/cormorant-unicase/cyrillic-700.css';
import '@fontsource/cormorant-unicase/latin-700.css';
import './cyber.css';
import './fantasy.css';

export const THEMES = {
  tavern: { name: 'Таверна', hint: 'копчёный дуб и латунь' },
  cyber: { name: 'Киберпанк', hint: 'тактический терминал: графит, багровый, данные' },
  fantasy: { name: 'Фэнтези', hint: 'летопись: лазурь, золото, свечи и магия' },
};

const CYBER = /cyber|киберпанк|lancer|shadowrun|starfinder|traveller|mothership|alien|40k|wrath|sci-?fi|neon/i;
const FANTASY = /d&d|dnd|\b5e\b|5th|pathfinder|dungeon|fantasy|фэнтези|wfrp|warhammer fantasy|подзем|дракон/i;

/** Оформление по листу стола (а если листа нет — по названию стола) */
export function detectTheme(game) {
  const sheet = `${game?.sheetName || ''} ${game?.sheetRef || ''}`;
  for (const src of [sheet, game?.name || '']) {
    if (CYBER.test(src)) return 'cyber';
    if (FANTASY.test(src)) return 'fantasy';
  }
  return 'tavern';
}

const read = (k, d) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const write = (k, v) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* хранилище недоступно — настройка на один сеанс */
  }
};

/** Своё оформление игрока: '' — как у стола, иначе всегда это (например, 'tavern' — обычное) */
export const userTheme = () => read('tv:theme', '');
export const setUserTheme = (v) => write('tv:theme', v || null);
/** Анимация оформления (огоньки, мерцание свечи, загрузка терминала); в режиме чайника — нет */
export const themeMotion = () => !teapot() && read('tv:themeMotion', 'on') !== 'off';
export const setThemeMotion = (on) => write('tv:themeMotion', on ? null : 'off');

/**
 * Облегчённая анимация: без видеокарты (программная отрисовка) или когда кадры не успевают,
 * искры и звёзды над доской выключаются — они перерисовывают всю доску каждый кадр и грузят процессор.
 * Остальное (свеча, отблеск, вспышки окон, чернила в чате) остаётся. tv:themeMotion = full — всегда всё.
 */
let lite = null;
function softwareGraphics() {
  try {
    const c = document.createElement('canvas');
    // при программной отрисовке браузер с этим флагом WebGL не даёт
    const gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: true });
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(r);
  } catch {
    return true;
  }
}
const liteGraphics = () => {
  if (read('tv:themeMotion', 'on') === 'full') return false;
  if (lite === null) lite = softwareGraphics();
  return lite;
};
/** Пара секунд после включения: если кадры не успевают (меньше ~40 в секунду) — облегчаем */
let probed = false;
function probeFrames() {
  if (probed || typeof requestAnimationFrame === 'undefined' || read('tv:themeMotion', 'on') === 'full') return;
  probed = true;
  const ts = [];
  const step = (t) => {
    ts.push(t);
    if (t - ts[0] < 2500) return requestAnimationFrame(step);
    const d = ts
      .slice(1)
      .map((x, i) => x - ts[i])
      .sort((a, b) => a - b);
    if ((d[Math.floor(d.length / 2)] || 0) > 25) {
      lite = true;
      document.documentElement.classList.add('theme-lite');
    }
  };
  requestAnimationFrame(step);
}

export function resolveTheme(store) {
  const own = userTheme();
  if (THEMES[own]) return own;
  const t = store.settings?.theme || 'auto';
  if (t === 'auto') return detectTheme(store.game);
  return THEMES[t] ? t : 'tavern';
}

function apply(theme) {
  const el = document.documentElement;
  if (theme && theme !== 'tavern') el.dataset.theme = theme;
  else delete el.dataset.theme;
  const motion = themeMotion();
  el.classList.toggle('theme-still', !motion);
  const animated = motion && theme === 'fantasy';
  el.classList.toggle('theme-lite', animated && liteGraphics());
  if (animated && !el.classList.contains('theme-lite')) setTimeout(probeFrames, 1500);
}

/** Оформление стола: ставится на <html>, пока открыт стол; возвращает текущее */
export function useTableTheme(store, ready) {
  const [theme, setTheme] = useState(() => (ready ? resolveTheme(store) : 'tavern'));
  useEffect(() => {
    if (!ready) return;
    const update = () => {
      const t = resolveTheme(store);
      apply(t);
      setTheme(t);
    };
    update();
    const offGame = store.on('game', update);
    const offLocal = store.on('ui:theme', update);
    const offTeapot = onTeapot(update);
    return () => {
      offGame();
      offLocal();
      offTeapot();
      apply('tavern');
    };
  }, [store, ready]);
  return theme;
}
