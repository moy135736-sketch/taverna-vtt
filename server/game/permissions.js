// Права доступа и фильтрация данных для конкретного зрителя.
// viewer = { userId, isGM }

const has = (list, userId) => Array.isArray(list) && (list.includes('all') || list.includes(userId));

export function canControlChar(room, viewer, char) {
  if (!char) return false;
  if (viewer.isGM) return true;
  return has(char.controlledBy, viewer.userId);
}

export function canSeeChar(room, viewer, char) {
  if (!char) return false;
  if (viewer.isGM) return true;
  if (char.archived && !has(char.controlledBy, viewer.userId)) return false;
  return has(char.controlledBy, viewer.userId) || has(char.inJournals, viewer.userId);
}

export function canControlObj(room, viewer, obj) {
  if (!obj) return false;
  if (viewer.isGM) return true;
  if (obj.ownerId && obj.ownerId === viewer.userId) return true;
  if (has(obj.controlledBy, viewer.userId)) return true;
  if (obj.represents) {
    const ch = room.entities.char.get(obj.represents);
    if (ch && has(ch.controlledBy, viewer.userId)) return true;
  }
  return false;
}

export function filterObj(room, viewer, obj) {
  if (!obj) return null;
  if (viewer.isGM) return obj;
  if (obj.layer === 'gm') return null;
  // игроку — только объекты сцены, на которой он сейчас находится
  if (!room.canSeePage(viewer, obj.pageId)) return null;
  const control = canControlObj(room, viewer, obj);
  const out = { ...obj };
  delete out.gmnotes;
  // настройки ловушки (что в ней и сколько урона) — только мастеру
  delete out.trap;
  if (Array.isArray(obj.bars) && obj.bars.length) {
    out.bars = obj.bars.filter((b) => b.visibility !== 'gm' && (b.visibility !== 'owners' || control));
  }
  if (!control && obj.showNameToPlayers === false) out.name = '';
  // макросы токена — только тем, кто им управляет (у мастера там могут быть свои подсказки)
  if (!control) delete out.actions;
  if (Array.isArray(obj.auras)) out.auras = obj.auras.filter((a) => a.visibleToPlayers !== false || control);
  return out;
}

export function filterChar(room, viewer, char) {
  if (!canSeeChar(room, viewer, char)) return null;
  if (viewer.isGM) return char;
  const out = { ...char };
  delete out.gmnotes;
  return out;
}

export function canSeeHandout(room, viewer, h) {
  if (viewer.isGM) return true;
  if (h.archived) return false;
  return has(h.inJournals, viewer.userId) || has(h.controlledBy, viewer.userId);
}

export function filterHandout(room, viewer, h) {
  if (!h || !canSeeHandout(room, viewer, h)) return null;
  if (viewer.isGM) return h;
  const out = { ...h };
  delete out.gmnotes;
  return out;
}

export function filterMacro(room, viewer, m) {
  if (!m) return null;
  if (m.ownerId === viewer.userId) return m;
  if (m.visibleTo === 'all' || has(m.visibleTo, viewer.userId)) return m;
  return null;
}

export function filterTable(room, viewer, t) {
  if (!t) return null;
  if (viewer.isGM || t.showPlayers) return t;
  return null;
}

export function filterPage(room, viewer, p) {
  if (!p) return null;
  if (viewer.isGM) return p;
  if (!room.canSeePage(viewer, p.id)) return null;
  const out = { ...p };
  delete out.gmnotes;
  return out;
}

export function filterTrack(room, viewer, t) {
  return t || null;
}

export const FILTERS = {
  page: filterPage,
  obj: filterObj,
  char: filterChar,
  handout: filterHandout,
  macro: filterMacro,
  rtable: filterTable,
  track: filterTrack,
};

export function messageVisible(msg, viewer) {
  if (!msg) return false;
  if (msg.playerId === viewer.userId) return true;
  if (msg.to && Array.isArray(msg.to)) {
    if (msg.to.includes(viewer.userId)) return true;
    if (msg.toGM && viewer.isGM) return true;
    return false;
  }
  if (msg.toGM) return viewer.isGM;
  return true;
}
