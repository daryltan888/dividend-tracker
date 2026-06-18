'use strict';

const path      = require('path');
const fs        = require('fs');
const initSqlJs = require('sql.js');

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'dividends.db');

// ── Compat layer ──────────────────────────────────────────────────────────────
// sql.js is an in-memory WASM SQLite port. We persist by calling rawDb.export()
// → Uint8Array and writing it to disk after every write (or after COMMIT).
// The API below mirrors the synchronous better-sqlite3 interface used by server.js.

class Statement {
  constructor(db, sql) {
    this._db  = db;   // parent Db instance
    this._sql = sql;
  }

  _bind(args) {
    if (args.length === 0) return [];
    if (args.length === 1 && Array.isArray(args[0])) return args[0];
    return Array.from(args);
  }

  // Execute a write statement; returns { lastInsertRowid, changes }.
  run(...args) {
    const params = this._bind(args);
    this._db._raw.run(this._sql, params);
    const rowid = this._db._raw.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? null;
    this._db._save();
    return { lastInsertRowid: rowid, changes: this._db._raw.getRowsModified() };
  }

  // Fetch at most one row as a plain object; returns undefined when no rows.
  get(...args) {
    const params = this._bind(args);
    const stmt = this._db._raw.prepare(this._sql);
    try {
      stmt.bind(params);
      if (!stmt.step()) return undefined;
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  // Fetch all rows as an array of plain objects.
  all(...args) {
    const params = this._bind(args);
    const stmt = this._db._raw.prepare(this._sql);
    const rows = [];
    try {
      stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }
}

class Db {
  constructor(raw) {
    this._raw = raw;
    this._inTx = false; // skip per-write saves inside a transaction
  }

  // Persist in-memory state to disk (noop inside a transaction).
  _save() {
    if (!this._inTx) fs.writeFileSync(DB_PATH, this._raw.export());
  }

  pragma(str) {
    this._raw.exec(`PRAGMA ${str}`);
  }

  exec(sql) {
    this._raw.exec(sql);
    this._save();
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  // Returns a function that, when called, wraps fn() in BEGIN / COMMIT.
  // One file save after COMMIT keeps disk-writes minimal.
  transaction(fn) {
    return (...args) => {
      this._raw.run('BEGIN');
      this._inTx = true;
      try {
        const result = fn(...args);
        this._raw.run('COMMIT');
        this._inTx = false;
        this._save();
        return result;
      } catch (e) {
        this._inTx = false;
        try { this._raw.run('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
    };
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS holdings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker     TEXT NOT NULL,
    user_id    INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ticker, user_id)
  );

  CREATE TABLE IF NOT EXISTS lots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    holding_id      INTEGER NOT NULL,
    shares          INTEGER NOT NULL,
    price_per_share REAL,
    date_bought     DATE NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS dividend_cache (
    ticker     TEXT PRIMARY KEY,
    data       TEXT,
    fetched_at DATETIME
  );

  CREATE INDEX IF NOT EXISTS idx_lots_holding ON lots(holding_id);
`;

function columnExists(raw, table, column) {
  const res = raw.exec(`PRAGMA table_info(${table})`);
  if (!res.length) return false;
  return res[0].values.some(row => row[1] === column);
}

// ── Initialise ────────────────────────────────────────────────────────────────
// Exported as a Promise<Db>. server.js awaits it once at startup; subsequent
// accesses are instant since module exports are cached.
module.exports = (async () => {
  const SQL = await initSqlJs();
  const buf = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  const raw = new SQL.Database(buf);
  const db  = new Db(raw);

  db.pragma('foreign_keys = ON');

  // Apply schema (idempotent). Bypass compat exec() to avoid mid-schema saves.
  raw.exec(SCHEMA);

  // Pre-auth databases have a `holdings` table without user_id and with a
  // global UNIQUE(ticker) constraint. Rebuild it so the same ticker can be
  // tracked independently by multiple users; existing rows keep user_id NULL
  // until claimed by the first registered user (see POST /auth/register).
  if (!columnExists(raw, 'holdings', 'user_id')) {
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec(`
      ALTER TABLE holdings RENAME TO holdings_old;
      CREATE TABLE holdings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker     TEXT NOT NULL,
        user_id    INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ticker, user_id)
      );
      INSERT INTO holdings (id, ticker, user_id, created_at)
        SELECT id, ticker, NULL, created_at FROM holdings_old;
      DROP TABLE holdings_old;
    `);
    raw.exec('PRAGMA foreign_keys = ON');
  }

  fs.writeFileSync(DB_PATH, raw.export());

  return db;
})();
