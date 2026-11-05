import { DatabaseSync } from "node:sqlite";

/**
 * Open the SQLite database used by the Pulsewire server.
 *
 * The schema is intentionally small and relational: accounts, sessions,
 * conversations, memberships, messages, and an append-only event log that
 * clients poll for changes. Foreign keys and WAL mode keep writes durable and
 * concurrent reads fast enough for a small team.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const version = Number(row?.user_version ?? 0);
  if (version >= 2) return;

  if (version < 1) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'space')),
      name       TEXT NOT NULL,
      topic      TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      dm_key     TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
      joined_at       TEXT NOT NULL,
      last_read_seq   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      id              TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      author_id       TEXT NOT NULL REFERENCES users(id),
      body            TEXT NOT NULL,
      reply_to_id     TEXT REFERENCES messages(id),
      created_at      TEXT NOT NULL,
      edited_at       TEXT,
      deleted_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_idx
      ON messages(conversation_id, seq DESC);

    CREATE TABLE IF NOT EXISTS events (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      type            TEXT NOT NULL,
      conversation_id TEXT,
      message_id      TEXT,
      actor_id        TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_conversation_idx ON events(conversation_id, seq);

    PRAGMA user_version = 1;
  `);
  }

  if (version < 2) {
    db.exec(`
      ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version = 2;
    `);
  }
}
