const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function createDeck() {
  const d = [];
  for (const s of SUITS) {
    for (const r of RANKS) d.push({ s, r });
  }
  return d;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardStr(c) {
  const map = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const rank = c.r <= 10 ? String(c.r) : map[c.r];
  return rank + c.s;
}

module.exports = { createDeck, shuffle, cardStr, SUITS, RANKS };
