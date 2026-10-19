// Импорт/экспорт персонажей в формате Roll20 (экспорт VTT Enhancement Suite, schema_version 1–3)
import { newId } from '@shared/ids.js';
import { newBar } from '@shared/defaults.js';

function parseMaybeJson(v, fallback) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v.trim()) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

/** Токен Roll20 → наш формат */
export function roll20TokenToObj(t, attribs = []) {
  if (!t || typeof t !== 'object') return null;
  const byId = new Map(attribs.map((a) => [a.id, a.name]));
  const out = {
    type: 'image',
    src: t.imgsrc || '',
    name: t.name || '',
    showName: !!t.showname,
    showNameToPlayers: t.showplayers_name !== false,
    w: Number(t.width) || 70,
    h: Number(t.height) || 70,
    bars: [],
    light: { enabled: Number(t.light_radius) > 0 || !!t.emits_bright_light, bright: Number(t.bright_light_distance ?? t.light_dimradius) || 0, dim: Number(t.low_light_distance ?? t.light_radius) || 0, color: '#ffe7b0', angle: Number(t.light_angle) || 360, dir: 0, intensity: 1 },
    vision: { enabled: !!(t.light_hassight || t.has_bright_light_vision), range: 0, darkvision: Number(t.night_vision_distance) || 0, angle: Number(t.light_losangle) || 360 },
  };
  const colors = ['#3eaa49', '#3b7bd8', '#d63a3a'];
  for (let i = 1; i <= 3; i++) {
    const v = t[`bar${i}_value`],
      m = t[`bar${i}_max`];
    let link = t[`bar${i}_link`] || '';
    if (link && byId.has(link)) link = byId.get(link);
    if (link && /^sheetattr_/.test(link)) link = link.slice(10);
    if ((v === undefined || v === '') && (m === undefined || m === '') && !link) continue;
    out.bars.push(newBar(i - 1, { color: colors[i - 1], value: v ?? '', max: m ?? '', link, name: link ? link.toUpperCase().slice(0, 6) : '' }));
  }
  return out;
}

export async function importRoll20Character(app, data) {
  const { store, net } = app;
  const c = data.character || data;
  if (!c || (!c.name && !c.attribs)) throw new Error('Это не похоже на экспорт персонажа Roll20');
  const attribs = Array.isArray(c.attribs) ? c.attribs : [];
  const abilities = (Array.isArray(c.abilities) ? c.abilities : []).map((a) => ({
    id: newId(),
    name: String(a.name || 'ability'),
    description: a.description || '',
    action: String(a.action || ''),
    istokenaction: !!a.istokenaction,
    order: a.order ?? 0,
  }));
  const tokenRaw = parseMaybeJson(c.defaulttoken, null);
  const id = newId();
  const ch = {
    id,
    name: c.name || 'Импортированный персонаж',
    avatar: c.avatar || '',
    bio: typeof c.bio === 'string' ? c.bio : '',
    abilities,
    tags: parseMaybeJson(c.tags, []),
    controlledBy: store.isGM ? [] : [store.me.id],
    inJournals: store.isGM ? [] : [store.me.id],
    defaultToken: roll20TokenToObj(tokenRaw, attribs),
  };
  if (store.isGM) ch.gmnotes = typeof c.gmnotes === 'string' ? c.gmnotes : '';
  const r = await net.create('char', ch);
  if (r?.error) throw new Error(r.error);
  // атрибуты — пачками
  const sets = attribs
    .filter((a) => a && a.name)
    .map((a) => ({ name: String(a.name), current: a.current ?? '', max: a.max ?? '' }));
  for (let i = 0; i < sets.length; i += 2000) {
    const res = await net.request('attrs:set', { charId: id, set: sets.slice(i, i + 2000), o: net.origin });
    if (res?.error) throw new Error(res.error);
  }
  return id;
}

export async function exportRoll20Character(app, charId, { returnOnly = false } = {}) {
  const { store, net } = app;
  const ch = store.col.char.get(charId);
  if (!ch) throw new Error('Персонаж не найден');
  const attrs = await net.ensureAttrs(charId);
  const list = [...attrs.values()].map((a) => ({ name: a.name, current: a.current, max: a.max, id: a.id }));
  const t = ch.defaultToken;
  let defaulttoken = '';
  if (t) {
    const rt = { imgsrc: t.src || '', name: t.name || ch.name, showname: !!t.showName, width: t.w, height: t.h, represents: charId };
    (t.bars || []).slice(0, 3).forEach((b, i) => {
      rt[`bar${i + 1}_value`] = b.value;
      rt[`bar${i + 1}_max`] = b.max;
      if (b.link) rt[`bar${i + 1}_link`] = b.link;
    });
    defaulttoken = JSON.stringify(rt);
  }
  const data = {
    schema_version: 3,
    type: 'character',
    character: {
      oldId: charId,
      name: ch.name,
      avatar: ch.avatar || '',
      bio: ch.bio || '',
      gmnotes: ch.gmnotes || '',
      defaulttoken,
      tags: JSON.stringify(ch.tags || []),
      controlledby: '',
      inplayerjournals: '',
      attribs: list,
      abilities: (ch.abilities || []).map((a, i) => ({ name: a.name, description: a.description || '', istokenaction: !!a.istokenaction, action: a.action || '', order: a.order ?? i })),
    },
  };
  if (returnOnly) return data;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (ch.name || 'character').replace(/[\\/:*?"<>|]+/g, '_') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return data;
}
