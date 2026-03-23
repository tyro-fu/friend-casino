const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'game.json');

const DEFAULTS = {
  gameName: '好友德州扑克',
  scoring: {
    smallBlind: 5,
    bigBlind: 10,
    maxBetPerRound: 99999,
    startingChips: 2000,
    minPlayersToStart: 2,
    maxSeats: 9
  }
};

function readGameConfig() {
  let file = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    file = JSON.parse(raw);
  } catch (e) {
    file = {};
  }
  const nameRaw = file['游戏名称'];
  const rules = file['积分统计规则'] || {};
  const gameName = (typeof nameRaw === 'string' && nameRaw.trim())
    ? nameRaw.trim()
    : (process.env.GAME_NAME && String(process.env.GAME_NAME).trim()) || DEFAULTS.gameName;
  const hasRules = rules && typeof rules === 'object' && Object.keys(rules).length > 0;
  if (!hasRules) {
    return { gameName, scoring: { ...DEFAULTS.scoring } };
  }
  return {
    gameName,
    scoring: {
      smallBlind: num(rules['小盲注积分'], DEFAULTS.scoring.smallBlind),
      bigBlind: num(rules['大盲注积分'], DEFAULTS.scoring.bigBlind),
      maxBetPerRound: num(rules['每轮下注上限积分'], DEFAULTS.scoring.maxBetPerRound),
      startingChips: num(rules['初始筹码积分'], DEFAULTS.scoring.startingChips),
      minPlayersToStart: num(rules['单桌最少开局人数'], DEFAULTS.scoring.minPlayersToStart),
      maxSeats: Math.min(9, Math.max(2, num(rules['单桌最多座位数'], DEFAULTS.scoring.maxSeats)))
    }
  };
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

let cached = null;
function getConfig() {
  if (!cached) cached = readGameConfig();
  return cached;
}

function reloadConfig() {
  cached = readGameConfig();
  return cached;
}

module.exports = { getConfig, reloadConfig, CONFIG_PATH, DEFAULTS };
