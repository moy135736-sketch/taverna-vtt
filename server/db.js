import Database from './sqlite.js';
import { config } from './config.js';

export const db = new Database(config.dbPath);

function pragmas() {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}
pragmas();

const MIGRATIONS = [
  // 1: базовая схема
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '#c0392b',
    avatar TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    ip TEXT, ua TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE sheets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'upload',
    source_ref TEXT NOT NULL DEFAULT '',
    legacy INTEGER NOT NULL DEFAULT 1,
    html TEXT NOT NULL,
    css TEXT NOT NULL DEFAULT '',
    translation TEXT NOT NULL DEFAULT '{}',
    translations TEXT NOT NULL DEFAULT '{}',
    meta TEXT NOT NULL DEFAULT '{}',
    builtin INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE games (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id TEXT NOT NULL REFERENCES users(id),
    invite_code TEXT NOT NULL UNIQUE,
    sheet_id TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_played INTEGER,
    thumbnail TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE members (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'player',
    joined_at INTEGER NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (game_id, user_id)
  );
  CREATE INDEX members_user ON members(user_id);
  CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    parent_id TEXT,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX entities_game_type ON entities(game_id, type);
  CREATE TABLE attributes (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    char_id TEXT NOT NULL,
    name TEXT NOT NULL,
    current TEXT NOT NULL DEFAULT '',
    max TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX attributes_char ON attributes(char_id);
  CREATE UNIQUE INDEX attributes_char_name ON attributes(char_id, name COLLATE NOCASE);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX messages_game_ts ON messages(game_id, ts);
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id TEXT,
    name TEXT NOT NULL,
    file TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER, height INTEGER,
    folder TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX assets_owner ON assets(owner_id);
  CREATE INDEX assets_game ON assets(game_id);
  `,
  // 2: дата следующей игры (показывается в лобби)
  `
  ALTER TABLE games ADD COLUMN next_session INTEGER;
  `,
];

/** Версия схемы, которую понимает эта версия программы */
export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    db.transaction(() => {
      db.exec(sql);
      version++;
      db.prepare(`INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(version));
    })();
    console.log(`[db] миграция до версии ${version}`);
  }
}
migrate();

/** Открыть базу заново после подмены файла (восстановление из копии): настройки соединения и миграции */
export function reopenDb() {
  db.open();
  pragmas();
  migrate();
}

export function now() {
  return Date.now();
}

export function parseJSON(s, fallback) {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
