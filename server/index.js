const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { getConfig, reloadConfig } = require('./config');
const db = require('./db');
const R = require('./rooms');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json({ limit: '32kb' }));
app.get('/health', (req, res) => {
  res.type('text/plain').send('ok');
});
app.get('/api/config', (req, res) => {
  const c = reloadConfig();
  res.json({
    gameName: c.gameName,
    scoring: c.scoring
  });
});
app.get('/api/leaderboard', (req, res) => {
  try {
    const rows = db.getLeaderboard(100);
    res.json({ list: rows });
  } catch (e) {
    res.status(500).json({ error: 'leaderboard_failed' });
  }
});
app.use(express.static(publicDir));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function scoringFromConfig() {
  const c = getConfig();
  return {
    smallBlind: c.scoring.smallBlind,
    bigBlind: c.scoring.bigBlind,
    maxBetPerRound: c.scoring.maxBetPerRound,
    startingChips: c.scoring.startingChips,
    minPlayersToStart: c.scoring.minPlayersToStart,
    maxSeats: c.scoring.maxSeats
  };
}

function resolveBuyIn(msg, defaultChips) {
  const raw = msg.buyIn;
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, chips: defaultChips };
  }
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 200) {
    return { ok: false, error: '带入积分须为不少于 200 的整数' };
  }
  if (n > Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: '带入数额无效' };
  }
  return { ok: true, chips: n };
}

wss.on('connection', (ws) => {
  let room = null;
  let playerId = null;
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (e) {
      R.send(ws, { type: 'error', message: '无效消息' });
      return;
    }
    const type = msg.type;
    const scoring = scoringFromConfig();
    try {
      if (type === 'ping') {
        R.send(ws, { type: 'pong', t: msg.t != null ? msg.t : Date.now() });
        return;
      }
      if (type === 'createRoom') {
        const code = R.randomRoomCode();
        room = R.getOrCreateRoom(code, scoring);
        R.setRoomPassword(room, msg.password || '');
        playerId = R.ensurePlayerId(msg.playerId);
        const nick = String(msg.nickname || '玩家').slice(0, 24);
        const bi = resolveBuyIn(msg, scoring.startingChips);
        if (!bi.ok) {
          R.send(ws, { type: 'error', message: bi.error });
          return;
        }
        const add = room.table.addPlayer(playerId, nick, Number(msg.seat) >= 0 ? Number(msg.seat) : -1, bi.chips);
        if (!add.ok) {
          R.send(ws, { type: 'error', message: add.error });
          return;
        }
        room.hostPlayerId = playerId;
        R.attachClient(room, ws, playerId, nick);
        R.send(ws, { type: 'joined', roomCode: code, playerId, shareUrl: `/room.html#${code}`, isHost: true });
        R.pushState(room);
        return;
      }
      if (type === 'joinRoom') {
        const code = String(msg.roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        if (code.length < 4) {
          R.send(ws, { type: 'error', message: '房间号无效' });
          return;
        }
        let r = R.rooms.get(code);
        const hash = db.getRoomHash(code);
        if (!r && !hash) {
          R.send(ws, { type: 'error', message: '房间不存在' });
          return;
        }
        if (!r) {
          r = R.getOrCreateRoom(code, scoring);
          r.passwordHash = hash || '';
        }
        if (!R.checkPassword(r, msg.password)) {
          R.send(ws, { type: 'error', message: '密码错误' });
          return;
        }
        playerId = R.ensurePlayerId(msg.playerId);
        const nick = String(msg.nickname || '玩家').slice(0, 24);
        const existing = r.table.players.get(playerId);
        if (existing) {
          existing.connected = true;
          if (nick && nick !== '玩家') existing.nickname = nick.slice(0, 24);
          room = r;
          R.attachClient(room, ws, playerId, existing.nickname);
          R.send(ws, { type: 'joined', roomCode: code, playerId, shareUrl: `/room.html#${code}`, isHost: r.hostPlayerId === playerId });
          R.pushState(room);
          return;
        }
        if (r.table.players.size >= r.table.maxSeats) {
          R.send(ws, { type: 'error', message: '房间已满' });
          return;
        }
        const bi = resolveBuyIn(msg, scoring.startingChips);
        if (!bi.ok) {
          R.send(ws, { type: 'error', message: bi.error });
          return;
        }
        const add = r.table.addPlayer(playerId, nick, Number(msg.seat) >= 0 ? Number(msg.seat) : -1, bi.chips);
        if (!add.ok) {
          R.send(ws, { type: 'error', message: add.error });
          return;
        }
        room = r;
        R.attachClient(room, ws, playerId, nick);
        R.send(ws, { type: 'joined', roomCode: code, playerId, shareUrl: `/room.html#${code}`, isHost: r.hostPlayerId === playerId });
        R.pushState(room);
        return;
      }
      if (!room || !playerId) {
        R.send(ws, { type: 'error', message: '请先创建或加入房间' });
        return;
      }
      if (type === 'startHand') {
        if (playerId !== room.hostPlayerId) {
          R.send(ws, { type: 'error', message: '仅房主可开局' });
          return;
        }
        const res = room.table.startHand();
        if (!res.ok) {
          R.send(ws, { type: 'error', message: res.error });
          return;
        }
        R.pushState(room);
        return;
      }
      if (type === 'action') {
        const rawRt = msg.raiseTo;
        const raiseToParsed = rawRt !== undefined && rawRt !== null && rawRt !== '' && Number.isFinite(Number(rawRt))
          ? Number(rawRt)
          : null;
        const res = room.table.applyAction(playerId, msg.action, raiseToParsed);
        if (!res.ok) {
          R.send(ws, { type: 'error', message: res.error });
          return;
        }
        R.pushState(room);
        R.broadcast(room, { type: 'leaderboardTick' });
        return;
      }
    } catch (e) {
      R.send(ws, { type: 'error', message: '服务器异常' });
    }
  });
  ws.on('close', () => {
    if (!room || !playerId) return;
    const p = room.table.players.get(playerId);
    if (p) p.connected = false;
    R.detachClient(room, playerId);
    if (room.table.phase === 'lobby') {
      room.table.removePlayer(playerId);
      if (room.table.players.size === 0) {
        R.deleteRoom(room.code);
      }
    }
    R.pushState(room);
  });
});

server.listen(PORT, () => {
  console.log(`[poker] http://127.0.0.1:${PORT}  ${getConfig().gameName}`);
});
