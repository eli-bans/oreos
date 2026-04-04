const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../oreos.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student', 'lecturer')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lecturer_id TEXT NOT NULL REFERENCES users(id),
    join_code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'active', 'ended')),
    constraints TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    started_at INTEGER,
    ended_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    student_id TEXT NOT NULL REFERENCES users(id),
    joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(session_id, student_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    student_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    student_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'javascript',
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flags (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    student_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    detail TEXT,
    ts INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_session_student ON events(session_id, student_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_session_student ON snapshots(session_id, student_id);
  CREATE INDEX IF NOT EXISTS idx_flags_session ON flags(session_id);
`);

module.exports = db;
