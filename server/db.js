const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'poker.sqlite');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db;
function getDb() {
  if (db) return db;
  ensureDir();
  db = new Database(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      password_hash TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function upsertRoom(id, passwordHash) {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO rooms (id, password_hash, created_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash
  `).run(id, passwordHash || '', now);
}

function deleteRoomRow(id) {
  getDb().prepare('DELETE FROM rooms WHERE id = ?').run(id);
}

function getRoomHash(id) {
  const row = getDb().prepare('SELECT password_hash FROM rooms WHERE id = ?').get(id);
  return row ? row.password_hash : null;
}

module.exports = {
  getDb,
  upsertRoom,
  deleteRoomRow,
  getRoomHash,
  DATA_DIR,
  DB_FILE
};
