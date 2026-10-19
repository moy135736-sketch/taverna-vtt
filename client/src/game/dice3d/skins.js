// Наборы кубиков: цвет, материал, узор и свечение. Выбор игрока хранится в его аккаунте (settings.dice.skin),
// поэтому его кубики выглядят одинаково у всех за столом. Без three.js — общий для объёмных и плоских кубиков.
//   body/ink/edge — тело, цифры, рёбра; rough/metal — шероховатость и металл; opacity — стекло и камни;
//   pattern — узор на гранях; glow — цвет свечения (узор, цифры или рёбра светятся сами).

export const DICE_SKINS = [
  { id: 'player', name: 'Цвет игрока', body: null, rough: 0.42, metal: 0.02 },
  { id: 'ivory', name: 'Слоновая кость', body: '#eee3cb', ink: '#3b2a18', edge: '#a8946c', rough: 0.55, metal: 0, pattern: 'grain' },
  { id: 'parchment', name: 'Пергамент', body: '#e6d3a4', ink: '#4a2a10', edge: '#8a6a3a', rough: 0.85, metal: 0, pattern: 'paper' },
  { id: 'wood', name: 'Морёный дуб', body: '#77482a', ink: '#f6e4c2', edge: '#3a200d', rough: 0.62, metal: 0, pattern: 'wood' },
  { id: 'marble', name: 'Мрамор', body: '#ebe7df', ink: '#22232b', edge: '#b4aea3', rough: 0.22, metal: 0, pattern: 'marble' },
  { id: 'malachite', name: 'Малахит', body: '#1f7d57', ink: '#f2f8f2', edge: '#0b3c27', rough: 0.2, metal: 0, pattern: 'bands' },
  { id: 'obsidian', name: 'Обсидиан', body: '#141217', ink: '#e3bd63', edge: '#4a4350', rough: 0.1, metal: 0.3, pattern: 'sheen' },
  { id: 'gold', name: 'Золото', body: '#dcae3f', ink: '#3a2606', edge: '#8a6416', rough: 0.28, metal: 1 },
  { id: 'silver', name: 'Серебро', body: '#d2d8e0', ink: '#1c232c', edge: '#7c8794', rough: 0.24, metal: 1 },
  { id: 'copper', name: 'Медь с патиной', body: '#b8683c', ink: '#fbeee0', edge: '#5e2e14', rough: 0.36, metal: 0.85, pattern: 'patina' },
  { id: 'ice', name: 'Лёд', body: '#c9eeff', ink: '#0a3956', edge: '#ffffff', rough: 0.06, metal: 0, opacity: 0.74, pattern: 'frost' },
  { id: 'ruby', name: 'Рубин', body: '#a8132f', ink: '#fff0f2', edge: '#ff97ab', rough: 0.07, metal: 0.05, opacity: 0.86 },
  { id: 'emerald', name: 'Изумруд', body: '#0f8a54', ink: '#effff5', edge: '#7dffc0', rough: 0.07, metal: 0.05, opacity: 0.86 },
  { id: 'amethyst', name: 'Аметист', body: '#7243b8', ink: '#f6efff', edge: '#d0b2ff', rough: 0.07, metal: 0.05, opacity: 0.86 },
  { id: 'lava', name: 'Лава', body: '#2a1611', ink: '#ffd27a', edge: '#ff6a1a', rough: 0.78, metal: 0, glow: '#ff6a1a', glowInk: true, pattern: 'cracks' },
  { id: 'night', name: 'Звёздная ночь', body: '#121a46', ink: '#f2f4ff', edge: '#8c9cff', rough: 0.32, metal: 0.05, glow: '#d8e4ff', pattern: 'stars' },
  { id: 'neon', name: 'Неон', body: '#0b1016', ink: '#3ff2ff', edge: '#3ff2ff', rough: 0.35, metal: 0.1, glow: '#3ff2ff', glowInk: true },
  { id: 'toxic', name: 'Яд', body: '#18240f', ink: '#b8ff3c', edge: '#7ad61e', rough: 0.4, metal: 0.05, glow: '#b8ff3c', glowInk: true, pattern: 'bubbles' },
  { id: 'blood', name: 'Кровь', body: '#4f0410', ink: '#ffe1e1', edge: '#b0162c', rough: 0.15, metal: 0.1, pattern: 'swirl' },
];

const BY_ID = new Map(DICE_SKINS.map((s) => [s.id, s]));
export const skinOf = (id) => BY_ID.get(id) || BY_ID.get('player');

// ---------- цвета ----------
export function rgbOf(hex, fallback = 0x7a2e2e) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : fallback;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const toHex = (c) => '#' + c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
export const mix = (a, b, k) => a.map((x, i) => x + (b[i] - x) * k);
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Цвета и материал набора для броска: player — цвет игрока (для набора «Цвет игрока»),
 * dropped — отброшенный кубик (2d20kh1: тот, что не считается) бледнеет.
 */
export function skinLook(skinId, player, dropped = false) {
  const s = skinOf(skinId);
  let body = rgbOf(s.body || player);
  let ink = s.ink || (lum(body) > 0.56 ? '#1d1813' : '#fbf5e6');
  let edge = s.edge ? rgbOf(s.edge) : mix(body, [0, 0, 0], 0.5);
  if (dropped) {
    body = mix(mix(body, [128, 120, 110], 0.7), [40, 34, 28], 0.25);
    ink = lum(body) > 0.56 ? '#1d1813' : '#e8e0d0';
    edge = mix(body, [0, 0, 0], 0.5);
  }
  return {
    id: s.id,
    key: s.id + ':' + toHex(body) + (dropped ? '~' : ''),
    body: toHex(body),
    ink,
    edge: toHex(edge),
    rough: s.rough ?? 0.42,
    metal: s.metal ?? 0,
    opacity: dropped ? 1 : (s.opacity ?? 1),
    pattern: dropped ? null : s.pattern || null,
    glow: dropped ? null : s.glow || null,
    glowInk: !dropped && !!s.glowInk,
  };
}
