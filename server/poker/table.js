const { createDeck, shuffle } = require('./deck');
const { bestOf7, compareEval, evalLabel } = require('./evaluate');

function showCards(table, p, forPlayerId) {
  if (table.phase === 'lobby' && table.lastShowdown) {
    const e = table.lastShowdown.players.find((x) => x.id === p.id);
    if (e && e.cards.length) return e.cards;
  }
  if (table.phase === 'playing' && p.id !== forPlayerId) {
    return p.holeCards.length ? [{ hidden: true }, { hidden: true }] : [];
  }
  return p.holeCards;
}

function buildSidePots(players, contributions) {
  const list = players
    .map((p) => ({ id: p.id, c: contributions.get(p.id) || 0 }))
    .filter((x) => x.c > 0)
    .sort((a, b) => a.c - b.c);
  if (list.length === 0) return [];
  const pots = [];
  let prev = 0;
  for (let i = 0; i < list.length; i++) {
    const level = list[i].c;
    if (level <= prev) continue;
    const delta = level - prev;
    const eligible = list.slice(i).map((x) => x.id);
    const amount = delta * eligible.length;
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

class PokerTable {
  constructor(scoring) {
    this.scoring = scoring;
    this.maxSeats = Math.min(9, Math.max(2, scoring.maxSeats || 9));
    this.seats = Array(this.maxSeats).fill(null);
    this.players = new Map();
    this.dealerSeat = 0;
    this.phase = 'lobby';
    this.board = [];
    this.deck = [];
    this.pot = 0;
    this.street = null;
    this.currentBet = 0;
    this.minRaise = 0;
    this.lastRaiseSize = 0;
    this.actorSeat = null;
    this.handContributions = new Map();
    this.winnersLastHand = [];
    this.lastHandLog = null;
    this.chipsAtHandStart = new Map();
    this.actedThisStreet = new Set();
    this.lastShowdown = null;
    this.handNumber = 0;
    this.sessionBuyIns = new Map();
    this.lastHandRecord = null;
  }

  seatOrderIds() {
    const ids = [];
    for (let i = 0; i < this.maxSeats; i++) {
      const pid = this.seats[i];
      if (pid && this.players.has(pid)) ids.push(pid);
    }
    return ids;
  }

  firstOccupiedFrom(start) {
    for (let k = 0; k < this.maxSeats; k++) {
      const i = (start + k) % this.maxSeats;
      if (this.seats[i]) return i;
    }
    return -1;
  }

  addPlayer(playerId, nickname, preferredSeat = -1, startingChipsOverride) {
    if (this.players.size >= this.maxSeats) return { ok: false, error: '房间已满(最多9人)' };
    if (this.players.has(playerId)) return { ok: false, error: '已在房间内' };
    let seat = -1;
    if (preferredSeat >= 0 && preferredSeat < this.maxSeats && !this.seats[preferredSeat]) {
      seat = preferredSeat;
    } else {
      for (let i = 0; i < this.maxSeats; i++) {
        if (!this.seats[i]) {
          seat = i;
          break;
        }
      }
    }
    if (seat < 0) return { ok: false, error: '无空位' };
    let chips = this.scoring.startingChips;
    if (typeof startingChipsOverride === 'number' && Number.isFinite(startingChipsOverride)) {
      const c = Math.floor(startingChipsOverride);
      if (c >= 200) chips = Math.min(c, Number.MAX_SAFE_INTEGER);
    }
    const p = {
      id: playerId,
      nickname: String(nickname || '玩家').slice(0, 24),
      seat,
      chips,
      holeCards: [],
      folded: false,
      allIn: false,
      betStreet: 0,
      totalBetHand: 0,
      connected: true
    };
    this.players.set(playerId, p);
    this.seats[seat] = playerId;
    this.sessionBuyIns.set(playerId, (this.sessionBuyIns.get(playerId) || 0) + chips);
    return { ok: true, seat };
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    const inHand = this.phase !== 'lobby' && this.handContributions.has(playerId);
    if (inHand) {
      p.connected = false;
      return;
    }
    this.seats[p.seat] = null;
    this.players.delete(playerId);
  }

  purgeDisconnectedIfLobby() {
    if (this.phase !== 'lobby') return;
    for (const [id, p] of [...this.players.entries()]) {
      if (!p.connected) {
        this.seats[p.seat] = null;
        this.players.delete(id);
      }
    }
  }

  canStartHand() {
    const withChips = [...this.players.values()].filter((p) => p.chips > 0 && p.connected);
    return withChips.length >= this.scoring.minPlayersToStart;
  }

  startHand() {
    if (this.phase !== 'lobby') return { ok: false, error: '牌局进行中' };
    if (!this.canStartHand()) return { ok: false, error: '人数或筹码不足' };
    this.lastShowdown = null;
    this.winnersLastHand = [];
    this.lastHandRecord = null;
    this.handNumber++;
    this.purgeDisconnectedIfLobby();
    const active = this.seatOrderIds().filter((id) => {
      const p = this.players.get(id);
      return p && p.chips > 0 && p.connected;
    });
    if (active.length < this.scoring.minPlayersToStart) {
      return { ok: false, error: `至少需要${this.scoring.minPlayersToStart}名有筹码玩家` };
    }
    this.chipsAtHandStart.clear();
    for (const id of active) {
      this.chipsAtHandStart.set(id, this.players.get(id).chips);
    }
    this.dealerSeat = this.firstOccupiedFrom(this.dealerSeat + 1);
    if (this.dealerSeat < 0) this.dealerSeat = 0;
    const order = this.circularFrom(this.dealerSeat);
    const inHand = order.filter((id) => this.players.get(id).chips > 0);
    if (inHand.length < 2) return { ok: false, error: '有效玩家不足' };
    this.board = [];
    this.pot = 0;
    this.handContributions = new Map();
    this.deck = shuffle(createDeck());
    for (const id of this.players.keys()) {
      const p = this.players.get(id);
      p.holeCards = [];
      p.folded = !inHand.includes(id) || p.chips <= 0;
      p.allIn = false;
      p.betStreet = 0;
      p.totalBetHand = 0;
    }
    const sbIdx = 1 % inHand.length;
    const bbIdx = 2 % inHand.length;
    const sbId = inHand[sbIdx];
    const bbId = inHand[bbIdx];
    const sbAmt = Math.min(this.scoring.smallBlind, this.players.get(sbId).chips);
    const bbAmt = Math.min(this.scoring.bigBlind, this.players.get(bbId).chips);
    this.postBlind(sbId, sbAmt);
    this.postBlind(bbId, bbAmt);
    this.currentBet = Math.max(this.players.get(sbId).betStreet, this.players.get(bbId).betStreet);
    this.minRaise = this.scoring.bigBlind;
    this.lastRaiseSize = this.scoring.bigBlind;
    this.street = 'preflop';
    this.dealHoles(inHand);
    this.actedThisStreet = new Set();
    const utgIdx = 3 % inHand.length;
    this.actorSeat = this.players.get(inHand[utgIdx]).seat;
    if (inHand.length === 2) {
      this.actorSeat = this.players.get(sbId).seat;
    }
    this.phase = 'playing';
    if (this.allInRunout()) {
      while (this.board.length < 5 && this.nonFolded().length > 1) {
        if (this.board.length === 0) {
          this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        } else if (this.board.length === 3) this.board.push(this.deck.pop());
        else if (this.board.length === 4) this.board.push(this.deck.pop());
      }
      this.finishShowdown();
      return { ok: true };
    }
    if (this.needsAutoAdvance()) this.advanceAfterAction();
    return { ok: true };
  }

  circularFrom(dealerSeat) {
    const out = [];
    for (let k = 0; k < this.maxSeats; k++) {
      const i = (dealerSeat + k) % this.maxSeats;
      const id = this.seats[i];
      if (id) out.push(id);
    }
    return out;
  }

  postBlind(id, amt) {
    const p = this.players.get(id);
    const take = Math.min(amt, p.chips);
    p.chips -= take;
    p.betStreet += take;
    p.totalBetHand += take;
    this.pot += take;
    this.handContributions.set(id, (this.handContributions.get(id) || 0) + take);
    if (p.chips === 0) p.allIn = true;
  }

  dealHoles(inHand) {
    for (let r = 0; r < 2; r++) {
      for (const id of inHand) {
        const p = this.players.get(id);
        p.holeCards.push(this.deck.pop());
      }
    }
  }

  nonFolded() {
    return [...this.players.values()].filter((p) => !p.folded && this.seats[p.seat] === p.id);
  }

  allInRunout() {
    const nf = this.nonFolded().filter((p) => !p.folded);
    if (nf.length <= 1) return false;
    return nf.every((p) => p.allIn);
  }

  bettingComplete() {
    const nf = this.nonFolded();
    if (nf.length <= 1) return true;
    for (const p of nf) {
      if (p.allIn) continue;
      if (p.betStreet < this.currentBet) return false;
    }
    const canAct = nf.filter((p) => !p.allIn);
    if (canAct.length === 0) return true;
    return canAct.every((p) => this.actedThisStreet.has(p.id));
  }

  needsAutoAdvance() {
    const nf = this.nonFolded();
    if (nf.length === 1) return true;
    return this.bettingComplete();
  }

  advanceStreet() {
    for (const p of this.players.values()) {
      p.betStreet = 0;
    }
    this.currentBet = 0;
    this.minRaise = this.scoring.bigBlind;
    this.lastRaiseSize = this.scoring.bigBlind;
    this.actedThisStreet = new Set();
    if (this.street === 'preflop') {
      this.street = 'flop';
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (this.street === 'flop') {
      this.street = 'turn';
      this.board.push(this.deck.pop());
    } else if (this.street === 'turn') {
      this.street = 'river';
      this.board.push(this.deck.pop());
    } else if (this.street === 'river') {
      this.finishShowdown();
      return;
    }
    this.setFirstActorPostFlop();
    if (this.allInRunout()) {
      while (this.board.length < 5 && this.nonFolded().length > 1) {
        if (this.board.length <= 2) {
          while (this.board.length < 3) this.board.push(this.deck.pop());
        } else if (this.board.length === 3) this.board.push(this.deck.pop());
        else if (this.board.length === 4) this.board.push(this.deck.pop());
        else break;
      }
      this.finishShowdown();
    }
  }

  sortedOccupiedSeats() {
    const seats = [];
    for (let i = 0; i < this.maxSeats; i++) {
      if (this.seats[i]) seats.push(i);
    }
    return seats.sort((a, b) => a - b);
  }

  setFirstActorPostFlop() {
    const order = this.circularFrom(this.dealerSeat);
    if (order.length === 0) {
      this.actorSeat = null;
      return;
    }
    for (let k = 1; k < order.length; k++) {
      const id = order[k];
      const p = this.players.get(id);
      if (p && !p.folded && !p.allIn) {
        this.actorSeat = p.seat;
        return;
      }
    }
    const any = order.find((id) => {
      const p = this.players.get(id);
      return p && !p.folded;
    });
    this.actorSeat = any != null ? this.players.get(any).seat : null;
  }

  nextActorFrom(seat) {
    const seats = this.sortedOccupiedSeats();
    if (!seats.length) return null;
    let pos = seats.indexOf(seat);
    if (pos < 0) pos = 0;
    for (let k = 1; k <= seats.length; k++) {
      const s = seats[(pos + k) % seats.length];
      const p = this.getPlayerBySeat(s);
      if (!p || p.folded || p.allIn) continue;
      if (p.betStreet < this.currentBet) return s;
      if (this.currentBet === 0 && !this.actedThisStreet.has(p.id)) return s;
    }
    return null;
  }

  advanceAfterAction() {
    let guard = 0;
    while (guard++ < 200) {
      const nf = this.nonFolded();
      if (nf.length === 1) {
        this.awardSingle(nf[0]);
        return;
      }
      if (this.bettingComplete()) {
        if (this.street === 'river') {
          this.finishShowdown();
          return;
        }
        this.advanceStreet();
        if (this.phase === 'lobby') return;
        if (this.needsAutoAdvance()) continue;
      }
      const cur = this.actorSeat;
      const fb = this.sortedOccupiedSeats()[0] ?? 0;
      const next = this.nextActorFrom(cur == null ? fb : cur);
      this.actorSeat = next;
      if (this.actorSeat == null) continue;
      break;
    }
  }

  captureShowdown() {
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      seat: p.seat,
      cards: p.holeCards.slice(),
      folded: p.folded
    }));
    this.lastShowdown = { board: this.board.slice(), players };
  }

  captureLastHandRecord(isShowdown) {
    const players = [];
    for (const [id, startChips] of this.chipsAtHandStart) {
      const p = this.players.get(id);
      if (!p) continue;
      players.push({
        id: p.id,
        nickname: p.nickname,
        seat: p.seat,
        cards: p.holeCards.slice(),
        folded: p.folded,
        chipChange: p.chips - startChips
      });
    }
    this.lastHandRecord = {
      handNumber: this.handNumber,
      pot: this.pot,
      board: this.board.slice(),
      players,
      winners: this.winnersLastHand.slice(),
      isShowdown: !!isShowdown
    };
  }

  lastHandRecordFor(forPlayerId) {
    const rec = this.lastHandRecord;
    if (!rec) return null;
    return {
      handNumber: rec.handNumber,
      pot: rec.pot,
      board: rec.board,
      winners: rec.winners,
      isShowdown: rec.isShowdown,
      players: rec.players.map((p) => {
        if (rec.isShowdown && !p.folded) return p;
        if (p.id === forPlayerId) return p;
        return { id: p.id, nickname: p.nickname, seat: p.seat, cards: [], folded: p.folded, chipChange: p.chipChange };
      })
    };
  }

  getSessionStats() {
    const stats = [];
    for (const [id, p] of this.players) {
      const buyIn = this.sessionBuyIns.get(id) || 0;
      stats.push({
        id: p.id,
        nickname: p.nickname,
        seat: p.seat,
        chips: p.chips,
        buyIn,
        profit: p.chips - buyIn
      });
    }
    return stats.sort((a, b) => b.profit - a.profit);
  }

  awardSingle(winner) {
    const total = this.pot;
    winner.chips += total;
    this.winnersLastHand = [{ id: winner.id, nickname: winner.nickname, amount: total, hand: '对手弃牌' }];
    this.lastHandLog = { pot: total, winners: this.winnersLastHand.slice() };
    this.captureShowdown();
    this.captureLastHandRecord(false);
    this.pot = 0;
    this.persistHandStats();
    this.endHand();
  }

  finishShowdown() {
    const contenders = this.nonFolded();
    const contributions = new Map();
    for (const p of contenders) {
      contributions.set(p.id, this.handContributions.get(p.id) || 0);
    }
    const pots = buildSidePots(contenders, contributions);
    const results = [];
    for (const pot of pots) {
      const eligible = contenders.filter((p) => pot.eligible.includes(p.id));
      let best = null;
      const bests = [];
      for (const p of eligible) {
        const ev = bestOf7([...p.holeCards, ...this.board]);
        const cmp = best == null ? 1 : compareEval(ev, best.ev);
        if (cmp > 0) {
          best = { p, ev };
          bests.length = 0;
          bests.push(p);
        } else if (cmp === 0) {
          bests.push(p);
        }
      }
      const share = Math.floor(pot.amount / bests.length);
      let rem = pot.amount - share * bests.length;
      for (const w of bests) {
        const add = share + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
        w.chips += add;
        results.push({
          id: w.id,
          nickname: w.nickname,
          amount: add,
          hand: evalLabel(best.ev)
        });
      }
    }
    const merged = new Map();
    for (const r of results) {
      if (!merged.has(r.id)) merged.set(r.id, { ...r });
      else merged.get(r.id).amount += r.amount;
    }
    this.winnersLastHand = [...merged.values()];
    const totalPot = this.pot;
    this.lastHandLog = { pot: totalPot, winners: this.winnersLastHand.slice(), board: this.board.slice() };
    this.captureShowdown();
    this.captureLastHandRecord(true);
    this.pot = 0;
    this.persistHandStats();
    this.endHand();
  }

  persistHandStats() {
    try {
      const db = require('../db');
      const deltas = this.handDeltasForStats();
      if (deltas.length) db.recordHandDeltas(deltas);
    } catch (e) {}
  }

  endHand() {
    this.phase = 'lobby';
    this.street = null;
    this.board = [];
    this.actorSeat = null;
    this.currentBet = 0;
    for (const p of this.players.values()) {
      p.holeCards = [];
      p.betStreet = 0;
      p.totalBetHand = 0;
      p.folded = false;
      p.allIn = false;
    }
    this.handContributions.clear();
  }

  getPlayerBySeat(seat) {
    const id = this.seats[seat];
    return id ? this.players.get(id) : null;
  }

  currentActorId() {
    if (this.actorSeat == null) return null;
    return this.seats[this.actorSeat];
  }

  legalActions(playerId) {
    if (this.phase !== 'playing') return [];
    if (this.currentActorId() !== playerId) return [];
    const p = this.players.get(playerId);
    if (!p || p.folded || p.allIn) return [];
    const toCall = Math.max(0, this.currentBet - p.betStreet);
    const capRoom = Math.max(0, this.scoring.maxBetPerRound - p.betStreet);
    const acts = [];
    if (toCall === 0) acts.push('check');
    else acts.push('fold');
    if (toCall > 0 && p.chips > 0) {
      const callCost = Math.min(toCall, p.chips);
      if (callCost === p.chips || callCost === toCall) acts.push('call');
    }
    if (toCall === 0 && p.chips > 0) acts.push('bet');
    const minRaiseTotal = this.currentBet + Math.min(this.minRaise, p.chips + p.betStreet - this.currentBet);
    if (toCall > 0 && p.chips > toCall) {
      const raiseTo = Math.min(this.currentBet + this.lastRaiseSize, p.betStreet + p.chips);
      if (raiseTo > this.currentBet && raiseTo <= p.betStreet + capRoom) acts.push('raise');
    }
    if (toCall === 0 && p.chips > 0) {
      const target = Math.min(this.currentBet + this.lastRaiseSize, p.betStreet + Math.min(p.chips, capRoom));
      if (target > this.currentBet) acts.push('raise');
    }
    return [...new Set(acts)];
  }

  applyAction(playerId, action, raiseTo) {
    if (this.phase !== 'playing') return { ok: false, error: '非出牌阶段' };
    if (this.currentActorId() !== playerId) return { ok: false, error: '不是你的回合' };
    const p = this.players.get(playerId);
    const toCall = Math.max(0, this.currentBet - p.betStreet);
    const capRoom = Math.max(0, this.scoring.maxBetPerRound - p.betStreet);
    if (action === 'fold') {
      if (toCall === 0) return { ok: false, error: '可过牌' };
      p.folded = true;
      this.actedThisStreet.add(playerId);
      this.advanceAfterAction();
      return { ok: true };
    }
    if (action === 'check') {
      if (toCall !== 0) return { ok: false, error: '需跟注或弃牌' };
      this.actedThisStreet.add(playerId);
      this.advanceAfterAction();
      return { ok: true };
    }
    if (action === 'call') {
      const need = Math.min(toCall, p.chips);
      if (need <= 0) return { ok: false, error: '无法跟注' };
      p.chips -= need;
      p.betStreet += need;
      p.totalBetHand += need;
      this.pot += need;
      this.handContributions.set(playerId, (this.handContributions.get(playerId) || 0) + need);
      if (p.chips === 0) p.allIn = true;
      this.actedThisStreet.add(playerId);
      this.advanceAfterAction();
      return { ok: true };
    }
    if (action === 'bet' || action === 'raise') {
      let target = raiseTo;
      if (action === 'bet' && toCall === 0) {
        if (raiseTo != null && Number.isFinite(raiseTo)) {
          target = raiseTo;
        } else {
          target = Math.min(p.betStreet + Math.max(this.scoring.bigBlind, 1), p.betStreet + p.chips);
          target = Math.min(target, p.betStreet + capRoom);
        }
      }
      if (target == null || !Number.isFinite(target)) {
        return { ok: false, error: '请指定加注额度' };
      }
      const add = target - p.betStreet;
      if (add <= 0 || add > p.chips) return { ok: false, error: '筹码不足或额度非法' };
      if (add > capRoom) return { ok: false, error: '超过本轮下注上限' };
      if (target <= this.currentBet) return { ok: false, error: '需高于当前注' };
      const inc = target - this.currentBet;
      if (inc < this.minRaise && target < p.betStreet + p.chips) {
        return { ok: false, error: '加注幅度不足' };
      }
      p.chips -= add;
      p.betStreet += add;
      p.totalBetHand += add;
      this.pot += add;
      this.handContributions.set(playerId, (this.handContributions.get(playerId) || 0) + add);
      this.lastRaiseSize = inc;
      this.minRaise = Math.max(this.scoring.bigBlind, inc);
      this.currentBet = target;
      if (p.chips === 0) p.allIn = true;
      this.actedThisStreet = new Set([playerId]);
      this.advanceAfterAction();
      return { ok: true };
    }
    return { ok: false, error: '未知操作' };
  }

  publicState(forPlayerId) {
    const scoring = this.scoring;
    const players = [...this.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({
        id: p.id,
        nickname: p.nickname,
        seat: p.seat,
        chips: p.chips,
        betStreet: p.betStreet,
        folded: p.folded,
        allIn: p.allIn,
        connected: p.connected,
        isYou: p.id === forPlayerId,
        cards: showCards(this, p, forPlayerId)
      }));
    return {
      phase: this.phase,
      street: this.street,
      board: this.board,
      pot: this.pot,
      actorSeat: this.actorSeat,
      currentBet: this.currentBet,
      dealerSeat: this.dealerSeat,
      players,
      winnersLastHand: this.winnersLastHand,
      scoring: {
        smallBlind: scoring.smallBlind,
        bigBlind: scoring.bigBlind,
        maxBetPerRound: scoring.maxBetPerRound
      },
      legalActions: forPlayerId ? this.legalActions(forPlayerId) : [],
      lastShowdown: this.lastShowdown,
      lastHandRecord: this.lastHandRecordFor(forPlayerId),
      handNumber: this.handNumber,
      sessionStats: this.getSessionStats()
    };
  }

  handDeltasForStats() {
    const out = [];
    for (const [id, start] of this.chipsAtHandStart.entries()) {
      const p = this.players.get(id);
      if (!p) continue;
      out.push({
        playerId: id,
        nickname: p.nickname,
        delta: p.chips - start
      });
    }
    return out;
  }
}

module.exports = { PokerTable };
