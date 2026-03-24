const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { getConfig, reloadConfig, onConfigChange } = require('./config');
const db = require('./db');
const R = require('./rooms');
const { scheduleDisconnect, cancelDisconnect } = R;

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
    scoring: c.scoring,
    presets: c.presets || []
  });
});
app.use(express.static(publicDir));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const LAST_HAND_DISPLAY_MS = 5000;

// ── 服务端心跳探活 ──────────────────────────────────────────────
// 每 HEARTBEAT_INTERVAL_MS 向客户端发一次 ping（WebSocket 原生帧）
// 若客户端在 HEARTBEAT_TIMEOUT_MS 内无响应，则主动断开连接
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS  = 10000;

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws._hbDead) {
      // 上轮 ping 无响应，主动终止
      return ws.terminate();
    }
    ws._hbDead = true;
    // 发出原生 WebSocket ping 帧（客户端浏览器自动回 pong，无需 JS 处理）
    try { ws.ping(); } catch (e) {}
    // 额外发送应用层 heartbeat 消息（兼容无原生 pong 场景）
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'heartbeat', t: Date.now() })); } catch (e) {}
    }
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatTimer));

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

function clearAutoStart(room) {
  if (room.autoStartTimer) {
    clearInterval(room.autoStartTimer);
    room.autoStartTimer = null;
  }
  room.autoStartCountdown = 0;
}

function scheduleAutoStart(room, seconds) {
  clearAutoStart(room);
  if (room.gameEnded) return;
  room.autoStartCountdown = seconds;
  R.pushState(room);
  room.autoStartTimer = setInterval(() => {
    room.autoStartCountdown--;
    if (room.autoStartCountdown <= 0) {
      clearAutoStart(room);
      if (room.table.phase === 'lobby' && !room.gameEnded) {
        if (room.table.canStartHand(false)) {
          const res = room.table.startHand(false);
          if (res.ok) {
            room.nextHandNotBefore = 0;
            R.pushState(room);
            checkHandEnd(room);
          } else {
            R.pushState(room);
          }
        } else if (room.table.canStartHand(true)) {
          scheduleAutoStart(room, Math.ceil(LAST_HAND_DISPLAY_MS / 1000));
        } else {
          R.pushState(room);
        }
      } else {
        R.pushState(room);
      }
    } else {
      R.pushState(room);
    }
  }, 1000);
}

function checkHandEnd(room) {
  if (room.table.phase === 'lobby' && room.table.winnersLastHand.length > 0) {
    if (room.scheduledEndHands != null) {
      room.scheduledEndHands--;
      if (room.scheduledEndHands <= 0) {
        room.scheduledEndHands = 0;
        room.gameEnded = true;
        clearAutoStart(room);
        R.pushState(room);
        return;
      }
    }
    room.nextHandNotBefore = Date.now() + LAST_HAND_DISPLAY_MS;
    scheduleAutoStart(room, Math.ceil(LAST_HAND_DISPLAY_MS / 1000));
  }
}

wss.on('connection', (ws) => {
  let room = null;
  let playerId = null;

  // 心跳：收到原生 pong 帧时重置 dead 标记
  ws.on('pong', () => { ws._hbDead = false; });

  ws.on('message', (raw) => {
    // 收到任意消息即视为存活
    ws._hbDead = false;
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
      // 客户端回复心跳 ack（应用层，可选）
      if (type === 'heartbeat_ack') {
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
          // 取消宽限期定时器（玩家已重连）
          cancelDisconnect(room, playerId);
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
        if (room.gameEnded) {
          R.send(ws, { type: 'error', message: '本场游戏已结束，房主可点击"开始新一场"' });
          return;
        }
        if (playerId !== room.hostPlayerId) {
          R.send(ws, { type: 'error', message: '仅房主可开局' });
          return;
        }
        if (room.nextHandNotBefore && Date.now() < room.nextHandNotBefore) {
          const sec = Math.ceil((room.nextHandNotBefore - Date.now()) / 1000);
          R.send(ws, { type: 'error', message: `上局结果展示中，请等待约 ${sec} 秒` });
          return;
        }
        clearAutoStart(room);
        const res = room.table.startHand(true);
        if (!res.ok) {
          R.send(ws, { type: 'error', message: res.error });
          return;
        }
        room.nextHandNotBefore = 0;
        R.pushState(room);
        checkHandEnd(room);
        return;
      }
      if (type === 'rebuy') {
        const raw = msg.buyIn;
        if (raw === undefined || raw === null || raw === '') {
          R.send(ws, { type: 'error', message: '请填写买入积分' });
          return;
        }
        const n = Math.floor(Number(raw));
        if (!Number.isFinite(n) || n < 200) {
          R.send(ws, { type: 'error', message: '买入须为不少于 200 的整数' });
          return;
        }
        const res = room.table.rebuy(playerId, n);
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
        checkHandEnd(room);
        return;
      }
      if (type === 'scheduleEnd') {
        if (playerId !== room.hostPlayerId) {
          R.send(ws, { type: 'error', message: '仅房主可操作' });
          return;
        }
        const hands = Math.floor(Number(msg.hands));
        if (msg.cancel) {
          room.scheduledEndHands = null;
        } else if (hands > 0 && hands <= 100) {
          room.scheduledEndHands = hands;
          room.gameEnded = false;
        }
        R.pushState(room);
        return;
      }
      if (type === 'newSession') {
        if (playerId !== room.hostPlayerId) {
          R.send(ws, { type: 'error', message: '仅房主可操作' });
          return;
        }
        clearAutoStart(room);
        room.nextHandNotBefore = 0;
        room.gameEnded = false;
        room.scheduledEndHands = null;
        room.table.sessionBuyIns.clear();
        room.table.sessionHandsPlayed.clear();
        room.table.handNumber = 0;
        room.table.lastHandRecord = null;
        room.table.winnersLastHand = [];
        room.table.lastShowdown = null;
        for (const [id, p] of room.table.players) {
          room.table.sessionBuyIns.set(id, p.chips);
        }
        R.pushState(room);
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
      // 大厅阶段：启动宽限期，60秒内未重连才真正踢出
      scheduleDisconnect(room, playerId, () => {
        room.table.removePlayer(playerId);
        // 如果是房主，尝试转让给在线玩家
        if (room.hostPlayerId === playerId) {
          const next = [...room.table.players.values()].find(pl => pl.connected);
          if (next) {
            room.hostPlayerId = next.id;
            // 通知新房主
            const nc = room.clients.get(next.id);
            if (nc) R.send(nc.ws, { type: 'hostTransferred', message: '原房主已离线，你已成为新房主' });
          }
        }
        if (room.table.players.size === 0) {
          R.deleteRoom(room.code);
        } else {
          R.pushState(room);
        }
      });
    } else {
      // 游戏进行中：仅标记离线，不移除
      // 若是房主断线，宽限30秒后转让（游戏继续）
      if (room.hostPlayerId === playerId) {
        scheduleDisconnect(room, playerId, () => {
          const next = [...room.table.players.values()].find(pl => pl.connected && pl.id !== playerId);
          if (next) {
            room.hostPlayerId = next.id;
            const nc = room.clients.get(next.id);
            if (nc) R.send(nc.ws, { type: 'hostTransferred', message: '原房主已离线，你已成为新房主' });
            R.pushState(room);
          }
        });
      }
    }
    R.pushState(room);
  });
});

// ── 配置热加载：变更时通知所有在线客户端 ──────────────────────
onConfigChange((newCfg) => {
  // 广播配置变更通知给所有在线连接（不含正在进行中的房间，避免干扰游戏）
  const notice = JSON.stringify({
    type: 'configChanged',
    gameName: newCfg.gameName,
    message: '服务器配置已更新，新建房间将使用新规则；当前局完成后自动生效。'
  });
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(notice); } catch (e) {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`[poker] http://127.0.0.1:${PORT}  ${getConfig().gameName}`);
});
