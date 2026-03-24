const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PokerTable } = require('./poker/table');
const db = require('./db');

const rooms = new Map();

function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

function getOrCreateRoom(code, scoring) {
  let r = rooms.get(code);
  if (!r) {
    r = {
      code,
      passwordHash: '',
      table: new PokerTable(scoring),
      hostPlayerId: null,
      clients: new Map(),
      scheduledEndHands: null,
      gameEnded: false,
      autoStartCountdown: 0,
      autoStartTimer: null,
      nextHandNotBefore: 0,
      // 断线宽限期：playerId -> setTimeout handle（大厅阶段）
      disconnectTimers: new Map()
    };
    rooms.set(code, r);
  }
  return r;
}

function deleteRoom(code) {
  const r = rooms.get(code);
  if (r) {
    // 清理所有宽限期定时器
    for (const t of r.disconnectTimers.values()) clearTimeout(t);
    r.disconnectTimers.clear();
  }
  rooms.delete(code);
  try {
    db.deleteRoomRow(code);
  } catch (e) {}
}

// 断线宽限期：大厅阶段延迟 LOBBY_GRACE_MS 后再踢人，进行中局直接标记离线
const LOBBY_GRACE_MS = 60000; // 60秒宽限

/**
 * 大厅断线宽限期：延迟后再从房间移除玩家
 * @param {object} room
 * @param {string} playerId
 * @param {function} removeFn 超时后执行的清理回调
 */
function scheduleDisconnect(room, playerId, removeFn) {
  cancelDisconnect(room, playerId);
  const t = setTimeout(() => {
    room.disconnectTimers.delete(playerId);
    removeFn();
  }, LOBBY_GRACE_MS);
  room.disconnectTimers.set(playerId, t);
}

function cancelDisconnect(room, playerId) {
  const t = room.disconnectTimers.get(playerId);
  if (t != null) {
    clearTimeout(t);
    room.disconnectTimers.delete(playerId);
  }
}

function setRoomPassword(room, plain) {
  const s = String(plain == null ? '' : plain).trim();
  if (!s) {
    room.passwordHash = '';
    db.upsertRoom(room.code, '');
    return;
  }
  const hash = bcrypt.hashSync(s, 8);
  room.passwordHash = hash;
  db.upsertRoom(room.code, hash);
}

function checkPassword(room, plain) {
  const p = String(plain == null ? '' : plain).trim();
  if (!room.passwordHash) return true;
  if (!p) return false;
  return bcrypt.compareSync(p, room.passwordHash);
}

function broadcast(room, msg, exceptWs = null) {
  const data = JSON.stringify(msg);
  for (const [, c] of room.clients) {
    if (c.ws !== exceptWs && c.ws.readyState === 1) c.ws.send(data);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function attachClient(room, ws, playerId, nickname) {
  room.clients.set(playerId, { ws, playerId, nickname });
}

function detachClient(room, playerId) {
  room.clients.delete(playerId);
}

function pushState(room) {
  for (const [pid, c] of room.clients) {
    const st = room.table.publicState(pid);
    st.autoStartCountdown = room.autoStartCountdown || 0;
    st.nextHandNotBefore = room.nextHandNotBefore || 0;
    st.scheduledEndHands = room.scheduledEndHands;
    st.gameEnded = room.gameEnded || false;
    send(c.ws, { type: 'state', payload: st });
  }
}

function ensurePlayerId(msgPlayerId) {
  if (msgPlayerId && typeof msgPlayerId === 'string' && msgPlayerId.length < 80) return msgPlayerId;
  return crypto.randomUUID();
}

module.exports = {
  rooms,
  randomRoomCode,
  getOrCreateRoom,
  deleteRoom,
  setRoomPassword,
  checkPassword,
  broadcast,
  send,
  attachClient,
  detachClient,
  pushState,
  ensurePlayerId,
  scheduleDisconnect,
  cancelDisconnect,
  LOBBY_GRACE_MS
};
