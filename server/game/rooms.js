import { GameRoom } from './room.js';

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.io = null;
    setInterval(() => this.gc(), 60000).unref();
  }

  setIO(io) {
    this.io = io;
  }

  get(gameId) {
    let r = this.rooms.get(gameId);
    if (!r) {
      r = new GameRoom(gameId, this.io);
      this.rooms.set(gameId, r);
    }
    return r;
  }

  peek(gameId) {
    return this.rooms.get(gameId) || null;
  }

  all() {
    return [...this.rooms.values()];
  }

  // Выгружаем столы без игроков через 10 минут
  gc() {
    const t = Date.now();
    for (const [id, r] of this.rooms) {
      if (!r.sockets.size && t - r.lastActive > 10 * 60000 && !r.pendingRolls.size) {
        r.flush();
        clearInterval(r.flushTimer);
        this.rooms.delete(id);
      }
    }
  }

  /** Разорвать все соединения пользователя (блокировка, смена пароля) */
  disconnectUser(userId, reason = 'Сеанс завершён') {
    if (!this.io) return;
    for (const s of this.io.sockets.sockets.values()) {
      if (s.data?.user?.id !== userId) continue;
      s.emit('kicked', { reason });
      s.disconnect(true);
    }
  }

  /** Сохранить и закрыть все столы, отключить всех (перед заменой базы из резервной копии) */
  closeAll(reason) {
    for (const r of this.rooms.values()) {
      try {
        r.flush();
      } catch (e) {
        console.error('[rooms] flush', e);
      }
      for (const t of r.pendingRolls?.values?.() || []) clearTimeout(t.timer || t);
      r.shutdown(reason);
    }
    this.rooms.clear();
    if (this.io) {
      this.io.emit('kicked', { reason });
      this.io.disconnectSockets(true);
    }
  }

  flushAll() {
    for (const r of this.rooms.values()) {
      try {
        r.flush();
      } catch (e) {
        console.error('[rooms] flush', e);
      }
    }
  }
}

export const rooms = new RoomManager();
