function combinations(arr, k) {
  const res = [];
  function dfs(start, path) {
    if (path.length === k) {
      res.push(path.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      path.push(arr[i]);
      dfs(i + 1, path);
      path.pop();
    }
  }
  dfs(0, []);
  return res;
}

function isFlush(five) {
  const s0 = five[0].s;
  return five.every((c) => c.s === s0);
}

function isStraight(ranksSortedDesc) {
  const uniq = [...new Set(ranksSortedDesc)].sort((a, b) => b - a);
  if (uniq.length !== 5) return false;
  if (uniq[0] - uniq[4] === 4) return true;
  if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) return true;
  return false;
}

function rankCounts(five) {
  const m = new Map();
  for (const c of five) m.set(c.r, (m.get(c.r) || 0) + 1);
  const pairs = [];
  for (const [r, n] of m) pairs.push({ r, n });
  pairs.sort((a, b) => b.n - a.n || b.r - a.r);
  return pairs;
}

function evaluate5(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const flush = isFlush(cards);
  const straight = isStraight(ranks);
  const rc = rankCounts(cards);
  const kick = (arr) => arr;
  if (flush && straight) {
    let high = ranks[0];
    if (ranks.includes(14) && ranks.includes(5) && ranks.includes(4) && ranks.includes(3) && ranks.includes(2)) {
      high = 5;
    }
    return { cat: 8, tie: [high] };
  }
  if (rc[0].n === 4) {
    const k = ranks.find((x) => x !== rc[0].r);
    return { cat: 7, tie: [rc[0].r, k] };
  }
  if (rc[0].n === 3 && rc[1].n === 2) {
    return { cat: 6, tie: [rc[0].r, rc[1].r] };
  }
  if (flush) {
    return { cat: 5, tie: ranks.slice().sort((a, b) => b - a) };
  }
  if (straight) {
    let high = ranks[0];
    if (ranks.includes(14) && ranks.includes(5) && ranks.includes(4) && ranks.includes(3) && ranks.includes(2)) {
      high = 5;
    }
    return { cat: 4, tie: [high] };
  }
  if (rc[0].n === 3) {
    const ks = ranks.filter((x) => x !== rc[0].r).sort((a, b) => b - a);
    return { cat: 3, tie: [rc[0].r, ...ks] };
  }
  if (rc[0].n === 2 && rc[1].n === 2) {
    const hi = Math.max(rc[0].r, rc[1].r);
    const lo = Math.min(rc[0].r, rc[1].r);
    const k = ranks.find((x) => x !== rc[0].r && x !== rc[1].r);
    return { cat: 2, tie: [hi, lo, k] };
  }
  if (rc[0].n === 2) {
    const ks = ranks.filter((x) => x !== rc[0].r).sort((a, b) => b - a);
    return { cat: 1, tie: [rc[0].r, ...ks] };
  }
  return { cat: 0, tie: ranks.slice().sort((a, b) => b - a) };
}

function compareEval(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.cat !== b.cat) return a.cat - b.cat;
  for (let i = 0; i < Math.max(a.tie.length, b.tie.length); i++) {
    const x = a.tie[i] || 0;
    const y = b.tie[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function bestOf7(cards7) {
  let best = null;
  for (const five of combinations(cards7, 5)) {
    const e = evaluate5(five);
    if (compareEval(e, best) > 0) best = e;
  }
  return best;
}

function evalLabel(e) {
  const names = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
  return names[e.cat] || '未知';
}

module.exports = { bestOf7, compareEval, evalLabel, evaluate5 };
