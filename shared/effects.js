// Эффекты маркеров, которые меняют сам токен: свет, зрение, размер, прозрачность, невидимость.
// Общее для сервера (он применяет и откатывает) и браузера (подсказки в редакторе эффекта).

/** Поля токена, которые может менять эффект. kind: num — число в пределах, bool — 0/1, color — цвет */
// label — подсказка в редакторе, short и unit — для описаний («яркий свет не меньше 20 фт»)
export const TOKEN_KEYS = {
  'light.bright': { label: 'яркий свет, фт', short: 'яркий свет', unit: 'фт', path: ['light', 'bright'], kind: 'num', min: 0, max: 1000, dflt: 0, enable: ['light', 'enabled'] },
  'light.dim': { label: 'тусклый свет, фт', short: 'тусклый свет', unit: 'фт', path: ['light', 'dim'], kind: 'num', min: 0, max: 1000, dflt: 0, enable: ['light', 'enabled'] },
  'light.color': { label: 'цвет света', short: 'цвет света', path: ['light', 'color'], kind: 'color', dflt: '#ffe7b0', enable: ['light', 'enabled'] },
  'light.angle': { label: 'угол света, °', short: 'угол света', unit: '°', path: ['light', 'angle'], kind: 'num', min: 1, max: 360, dflt: 360 },
  'vision.darkvision': { label: 'тёмное зрение, фт', short: 'тёмное зрение', unit: 'фт', path: ['vision', 'darkvision'], kind: 'num', min: 0, max: 1000, dflt: 0, enable: ['vision', 'enabled'] },
  'vision.range': { label: 'дальность зрения, фт', short: 'дальность зрения', unit: 'фт', path: ['vision', 'range'], kind: 'num', min: 0, max: 5000, dflt: 0, enable: ['vision', 'enabled'] },
  size: { label: 'размер, клеток', short: 'размер', unit: 'кл.', kind: 'size', min: 0.1, max: 20 },
  opacity: { label: 'непрозрачность 0…1', short: 'непрозрачность', path: ['opacity'], kind: 'num', min: 0, max: 1, dflt: 1 },
  invisible: { label: 'невидимость (1 — да)', short: 'невидимость', path: ['effects', 'invisible'], kind: 'bool', dflt: false },
};

export const isTokenKey = (k) => Object.prototype.hasOwnProperty.call(TOKEN_KEYS, String(k || '').trim().toLowerCase());
export const tokenKey = (k) => String(k || '').trim().toLowerCase();

const get = (o, path) => path.reduce((v, p) => (v && typeof v === 'object' ? v[p] : undefined), o);
function set(o, path, value) {
  let cur = o;
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    cur[p] = cur[p] && typeof cur[p] === 'object' ? { ...cur[p] } : {};
    cur = cur[p];
  }
  cur[path[path.length - 1]] = value;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/**
 * Применить изменение поля токена. next — копия токена (меняется), cellSize — размер клетки сцены.
 * Возвращает запись для отката {tok, prev, value, …} или null, если менять нечего.
 */
export function applyTokenChange(next, change, value, cellSize = 70) {
  const key = tokenKey(change.key);
  const def = TOKEN_KEYS[key];
  if (!def) return null;
  const mode = change.mode || 'add';
  if (def.kind === 'size') {
    const w = Number(next.w) || cellSize,
      h = Number(next.h) || cellSize;
    const v = num(value);
    if (v === null) return null;
    let nw, nh;
    if (mode === 'mul') {
      nw = w * v;
      nh = h * v;
    } else if (mode === 'add') {
      nw = w + v * cellSize;
      nh = h + v * cellSize;
    } else if (mode === 'set' || mode === 'max' || mode === 'min') {
      const t = v * cellSize;
      nw = mode === 'set' ? t : mode === 'max' ? Math.max(w, t) : Math.min(w, t);
      nh = mode === 'set' ? t : mode === 'max' ? Math.max(h, t) : Math.min(h, t);
    } else return null;
    nw = r3(clamp(nw, def.min * cellSize, def.max * cellSize));
    nh = r3(clamp(nh, def.min * cellSize, def.max * cellSize));
    if (nw === w && nh === h) return null;
    // растёт от центра — токен остаётся на месте
    const cx = (Number(next.x) || 0) + w / 2,
      cy = (Number(next.y) || 0) + h / 2;
    const prev = { w, h };
    next.w = nw;
    next.h = nh;
    next.x = r3(cx - nw / 2);
    next.y = r3(cy - nh / 2);
    return { tok: key, prev, value: { w: nw, h: nh } };
  }
  const cur = get(next, def.path);
  // у выключенного света «яркий/тусклый» считаются нулём — иначе «не меньше 20» не включит свет
  const base = def.enable && !get(next, def.enable) && def.kind === 'num' ? 0 : cur ?? def.dflt;
  let nv;
  if (def.kind === 'color') {
    if (mode !== 'set' || !/^#[0-9a-f]{3,8}$/i.test(String(value).trim())) return null;
    nv = String(value).trim();
  } else if (def.kind === 'bool') {
    const v = num(value);
    nv = mode === 'set' ? !!v : v ? true : !!cur;
  } else {
    const v = num(value);
    if (v === null) return null;
    const c = num(base) ?? 0;
    if (mode === 'add') nv = c + v;
    else if (mode === 'mul') nv = c * v;
    else if (mode === 'max') nv = Math.max(c, v);
    else if (mode === 'min') nv = Math.min(c, v);
    else if (mode === 'set') nv = v;
    else return null;
    nv = r3(clamp(nv, def.min, def.max));
  }
  const out = { tok: key, prev: cur === undefined ? null : cur, value: nv };
  // свет и зрение, которые эффект настраивает, должны быть включены
  if (def.enable) {
    const en = get(next, def.enable);
    if (!en) {
      out.enabled = false;
      set(next, def.enable, true);
    }
  }
  set(next, def.path, nv);
  return out;
}

/** Откатить изменение поля токена — если его с тех пор не поменяли вручную */
export function revertTokenChange(next, a) {
  const def = TOKEN_KEYS[a?.tok];
  if (!def) return;
  if (def.kind === 'size') {
    if (!a.prev || !a.value || Number(next.w) !== a.value.w || Number(next.h) !== a.value.h) return;
    const cx = (Number(next.x) || 0) + next.w / 2,
      cy = (Number(next.y) || 0) + next.h / 2;
    next.w = a.prev.w;
    next.h = a.prev.h;
    next.x = r3(cx - a.prev.w / 2);
    next.y = r3(cy - a.prev.h / 2);
    return;
  }
  const cur = get(next, def.path);
  if (cur !== a.value) return;
  set(next, def.path, a.prev === null ? def.dflt : a.prev);
  if (def.enable && a.enabled === false) set(next, def.enable, false);
}

/** Привести запись отката к безопасному виду (от клиента и из базы) */
export function cleanTokenApplied(a) {
  const key = tokenKey(a?.tok);
  const def = TOKEN_KEYS[key];
  if (!def) return null;
  const out = { tok: key };
  const val = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') return v.slice(0, 20);
    return null;
  };
  if (def.kind === 'size') {
    const wh = (v) => (v && Number.isFinite(Number(v.w)) && Number.isFinite(Number(v.h)) ? { w: Number(v.w), h: Number(v.h) } : null);
    out.prev = wh(a.prev);
    out.value = wh(a.value);
    if (!out.prev || !out.value) return null;
  } else {
    out.prev = val(a.prev);
    out.value = val(a.value);
  }
  if (a.enabled === false) out.enabled = false;
  return out;
}

/** Длительность эффекта словами: «10 раундов», «до начала следующего хода», «пока не снимут» */
export function durationText(def) {
  if (!def) return '';
  const parts = [];
  if (def.duration === 'turnStart') parts.push('до начала следующего хода');
  else if (def.duration === 'turnEnd') parts.push('до конца следующего хода');
  else if (Number(def.rounds) > 0) {
    const r = Number(def.rounds);
    if (r % 600 === 0) parts.push(`${r / 600} ч`);
    else if (r % 10 === 0 && r >= 10) parts.push(`${r / 10} мин`);
    else parts.push(`${r} р.`);
  }
  if (def.conc) parts.push('концентрация');
  return parts.join(', ');
}
