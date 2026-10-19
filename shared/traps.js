// Ловушки на карте. Ловушка — любой объект (обычно фигура на слое мастера) с настройкой trap.
// Срабатывает, когда центр токена входит в её область по пути перемещения: сервер находит первую точку входа,
// может остановить токен там и запускает действия ловушки (описание, бросок урона, вспышка, тряска…).

export const TRAP_DEFAULTS = {
  name: 'Ловушка',
  armed: true, // взведена
  trigger: 'players', // 'players' — токены игроков, 'any' — любые токены
  gmMoves: true, // срабатывает и тогда, когда токен двигает мастер
  once: true, // после срабатывания разряжается
  stop: true, // токен останавливается там, где наступил на ловушку
  reveal: false, // после срабатывания игроки видят ловушку
  message: '{name} попадается в ловушку!', // описание для всех; {name} — имя токена; пусто — узнаёт только мастер
  roll: '', // бросок, например 2d10
  damage: false, // снять выпавшее с хитов токена
  save: '', // напоминание о спасброске: «Ловкость, Сл 13»
  shake: false, // тряска у всех
  flash: '', // '' | 'white' | 'red'
  fx: '', // спецэффект в точке срабатывания: burst-fire, explode-smoke…
  count: 0, // сколько раз сработала
};

const FX_SPEC = /^(burst|explode|nova|bubbling|burn|glow|splatter|heal)-(fire|frost|acid|blood|charm|death|holy|magic|slime|smoke|water|lightning)$/;

/** Настройка ловушки без мусора; null — не ловушка */
export function cleanTrap(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const s = (v, n, lines = false) =>
    String(v ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(lines ? /[\u0000-\u0009\u000b-\u001f]/g : /[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, n);
  return {
    name: s(t.name, 60) || TRAP_DEFAULTS.name,
    armed: t.armed !== false,
    trigger: t.trigger === 'any' ? 'any' : 'players',
    gmMoves: t.gmMoves !== false,
    once: t.once !== false,
    stop: t.stop !== false,
    reveal: !!t.reveal,
    message: s(t.message, 600, true),
    roll: s(t.roll, 80),
    damage: !!t.damage,
    save: s(t.save, 60),
    shake: !!t.shake,
    flash: t.flash === 'white' || t.flash === 'red' ? t.flash : '',
    fx: FX_SPEC.test(String(t.fx || '')) ? String(t.fx) : '',
    count: Math.max(0, Math.min(1e6, Math.floor(Number(t.count) || 0))),
  };
}

// многоугольники фигур в квадрате 100×100 (как у фигур на доске)
const SHAPE_PTS = {
  triangle: [50, 0, 100, 100, 0, 100],
  diamond: [50, 0, 100, 50, 50, 100, 0, 50],
  hexagon: [25, 0, 75, 0, 100, 50, 75, 100, 25, 100, 0, 50],
  octagon: [30, 0, 70, 0, 100, 30, 100, 70, 70, 100, 30, 100, 0, 70, 0, 30],
  star: [50, 0, 61, 35, 98, 35, 68, 57, 79, 91, 50, 70, 21, 91, 32, 57, 2, 35, 39, 35],
  cone: [0, 50, 100, 0, 100, 100],
  arrow: [0, 35, 60, 35, 60, 10, 100, 50, 60, 90, 60, 65, 0, 65],
  cross: [35, 0, 65, 0, 65, 35, 100, 35, 100, 65, 65, 65, 65, 100, 35, 100, 35, 65, 0, 65, 0, 35, 35, 35],
};

function inPoly(pts, u, v) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i];
    const yi = pts[i + 1];
    const xj = pts[j];
    const yj = pts[j + 1];
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** Лежит ли точка (x, y) сцены внутри объекта — с учётом поворота, отражения и формы фигуры */
export function pointInObj(o, x, y) {
  const w = Math.max(1, Number(o.w) || 1);
  const h = Math.max(1, Number(o.h) || 1);
  const cx = o.x + w / 2;
  const cy = o.y + h / 2;
  let dx = x - cx;
  let dy = y - cy;
  const r = (-(Number(o.rot) || 0) * Math.PI) / 180;
  if (r) [dx, dy] = [dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)];
  if (o.flipH) dx = -dx;
  if (o.flipV) dy = -dy;
  const u = (dx / w + 0.5) * 100;
  const v = (dy / h + 0.5) * 100;
  if (u < 0 || u > 100 || v < 0 || v > 100) return false;
  if (o.type === 'shape') {
    if (o.shape === 'ellipse') return (u - 50) ** 2 + (v - 50) ** 2 <= 2500;
    const pts = SHAPE_PTS[o.shape];
    if (pts) return inPoly(pts, u, v);
  }
  return true;
}

/**
 * Где путь центра токена впервые входит в область объекта.
 * path — точки [{x, y}] (от старого центра к новому, с поворотами); step — шаг проверки в пикселях.
 * Если путь начинается внутри — считается только новый вход после выхода. null — не входит.
 */
export function pathEntry(o, path, step = 6) {
  if (!Array.isArray(path) || path.length < 2) return null;
  let inside = pointInObj(o, path[0].x, path[0].y);
  let dist = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    let prev = { x: a.x, y: a.y };
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const now = pointInObj(o, p.x, p.y);
      if (now && !inside) {
        // уточняем точку входа делением отрезка пополам
        let lo = prev;
        let hi = p;
        for (let it = 0; it < 8; it++) {
          const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
          if (pointInObj(o, mid.x, mid.y)) hi = mid;
          else lo = mid;
        }
        const segDist = dist + Math.hypot(hi.x - a.x, hi.y - a.y);
        return { x: hi.x, y: hi.y, dist: segDist, dir: len ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 0, y: 0 } };
      }
      inside = now;
      prev = p;
    }
    dist += len;
  }
  return null;
}

/**
 * Объект — токен, который может попасть в ловушку: фигуры и картинки на слое объектов
 * и спрятанные на слое мастера (их ловят только ловушки «на всех», и знает об этом только мастер).
 * Сама ловушка может лежать на любом слое.
 */
export const isTrapVictim = (o) => !!o && (o.type === 'image' || o.type === 'shape') && (o.layer === 'objects' || o.layer === 'gm') && !o.trap;
