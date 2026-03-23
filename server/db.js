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
    CREATE TABLE IF NOT EXISTS player_stats (
      player_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      total_points INTEGER NOT NULL DEFAULT 0,
      hands_played INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stats_points ON player_stats(total_points DESC);
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

function recordHandDeltas(deltas) {
  const now = Date.now();
  const ins = getDb().prepare(`
    INSERT INTO player_stats (player_id, nickname, total_points, hands_played, updated_at)
    VALUES (@player_id, @nickname, @delta, 1, @updated_at)
    ON CONFLICT(player_id) DO UPDATE SET
      nickname = excluded.nickname,
      total_points = player_stats.total_points + excluded.total_points,
      hands_played = player_stats.hands_played + 1,
      updated_at = excluded.updated_at
  `);
  const tx = getDb().transaction((rows) => {
    for (const r of rows) {
      ins.run({
        player_id: r.playerId,
        nickname: r.nickname,
        delta: r.delta,
        updated_at: now
      });
    }
  });
  tx(deltas);
}

function getLeaderboard(limit = 50) {
  return getDb().prepare(`
    SELECT player_id, nickname, total_points, hands_played, updated_at
    FROM player_stats
    ORDER BY total_points DESC
    LIMIT ?
  `).all(limit);
}

module.exports = {
  getDb,
  upsertRoom,
  deleteRoomRow,
  getRoomHash,
  recordHandDeltas,
  getLeaderboard,
  DATA_DIR,
  DB_FILE
};
