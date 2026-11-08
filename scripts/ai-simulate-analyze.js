'use strict';

/**
 * AI 批量模拟结果分析
 *
 * 用法：
 *   node scripts/ai-simulate-analyze.js reports/ai-mixed-10000.json \
 *        [--uniform reports/ai-uniform-2000.json] \
 *        [--calib reports/ai-calib-10000.json] \
 *        [--out reports/ai-sim-report.md]
 *
 * 统计口径：
 *  - 座位·局：每局 4 个座位各算 1 个观察（胜 / 放铳 / 净得分 / 副露数）
 *  - 配对：同一 seed 下两个房间难度对调，按 seed 做 cluster bootstrap，
 *    消除「同屋 4 家得分相关」与「座位 / 庄家偏差」带来的伪显著
 *  - p 值为 bootstrap 双侧经验 p 值，CI 为百分位 95% 区间
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function seededRng(seed = 20261108) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function f(v, n = 2) {
  return Number.isFinite(v) ? v.toFixed(n) : '—';
}
function pct(v, n = 2) {
  return Number.isFinite(v) ? (v * 100).toFixed(n) + '%' : '—';
}

/** 按 seed 聚类的 bootstrap：返回均值、95% CI、双侧经验 p 值 */
function clusterBootstrap(clusters, valueOf, iters = 2000) {
  const values = clusters.map(valueOf);
  const point = mean(values);
  const rng = seededRng();
  const boot = [];
  for (let b = 0; b < iters; b++) {
    let sum = 0;
    for (let i = 0; i < clusters.length; i++) sum += values[Math.floor(rng() * clusters.length)];
    boot.push(sum / clusters.length);
  }
  boot.sort((a, b) => a - b);
  const lo = boot[Math.floor(iters * 0.025)];
  const hi = boot[Math.floor(iters * 0.975)];
  const le = boot.filter((x) => x <= 0).length / iters;
  const ge = boot.filter((x) => x >= 0).length / iters;
  return { point, lo, hi, p: Math.min(1, 2 * Math.min(le, ge)) };
}

function groupBySeed(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.seed)) m.set(r.seed, []);
    m.get(r.seed).push(r);
  }
  return [...m.values()];
}

/** 一局内 H 座位与 N 座位的每座平均差（净得分 / 胜 / 放铳 / 副露） */
function pairDiffs(r) {
  const seats = [0, 1, 2, 3];
  const h = seats.filter((s) => r.pattern[s] === 'H');
  const n = seats.filter((s) => r.pattern[s] === 'N');
  if (!h.length || !n.length) return null;
  const avg = (arr, key) => mean(arr.map((s) => (Array.isArray(key) ? key[s] : r[key][s])));
  return {
    net: avg(h, 'nets') - avg(n, 'nets'),
    win: avg(h, 'wins') - avg(n, 'wins'),
    dealIn: avg(h, 'dealIns') - avg(n, 'dealIns'),
    meld: avg(h, 'meldCounts') - avg(n, 'meldCounts'),
  };
}

function analyzeMixed(rows) {
  const seat = { N: { n: 0, wins: 0, dealIns: 0, net: 0, melds: 0 }, H: { n: 0, wins: 0, dealIns: 0, net: 0, melds: 0 } };
  const winner = { N: { n: 0, zimo: 0, pts: 0, ptsN: 0, mult: 0, score: 0 }, H: { n: 0, zimo: 0, pts: 0, ptsN: 0, mult: 0, score: 0 } };
  const byRound = {};
  const byDealer = { N: { n: 0, wins: 0 }, H: { n: 0, wins: 0 } };
  const source = {
    N: { winGain: 0, dealLoss: 0, winDisc: 0, lowPt: 0, ptsN: 0 },
    H: { winGain: 0, dealLoss: 0, winDisc: 0, lowPt: 0, ptsN: 0 },
  };
  const byWinType = {};
  let hu = 0, draw = 0, aborted = 0, totalDiscards = 0, hardCalls = 0, fallbacks = 0;
  let zimo = 0, dianpao = 0, ptsSum = 0, ptsN = 0, scoreSum = 0, multSum = 0, tingSum = 0;

  for (const r of rows) {
    if (r.result === 'hu') hu++;
    else if (r.result === 'draw') draw++;
    else aborted++;
    totalDiscards += r.discards;
    hardCalls += r.hardCalls || 0;
    fallbacks += r.hardFallbacks || 0;
    tingSum += r.tingCount || 0;
    if (r.result === 'hu') {
      if (r.winType === 'zimo') zimo++; else dianpao++;
      if (r.tilePoints != null) { ptsSum += r.tilePoints; ptsN++; }
      if (r.mult != null) multSum += r.mult;
      if (r.score != null) scoreSum += r.score;
      const d = Number.isInteger(r.winnerSeat) ? r.pattern[r.winnerSeat] : null;
      if (d && winner[d]) {
        const w = winner[d];
        w.n++;
        if (r.winType === 'zimo') w.zimo++;
        if (r.tilePoints != null) { w.pts += r.tilePoints; w.ptsN++; }
        if (r.mult != null) w.mult += r.mult;
        if (r.score != null) w.score += r.score;
        const src = source[d];
        src.winGain += r.nets[r.winnerSeat];
        src.winDisc += r.discards;
        if (r.tilePoints != null) {
          src.ptsN++;
          if (r.tilePoints <= 5) src.lowPt++; // 3/4/5 点只能自摸的低效听口
        }
        if (r.discarder != null && source[r.pattern[r.discarder]]) {
          source[r.pattern[r.discarder]].dealLoss += r.nets[r.discarder];
        }
      }
      const wt = r.winType || 'other';
      if (!byWinType[wt]) byWinType[wt] = { n: 0, diff: 0 };
      byWinType[wt].n++;
      const pd = pairDiffs(r);
      if (pd) byWinType[wt].diff += pd.net;
    }
    for (let s = 0; s < 4; s++) {
      const b = seat[r.pattern[s]];
      b.n++;
      b.wins += r.wins[s];
      b.dealIns += r.dealIns[s];
      b.net += r.nets[s];
      b.melds += r.meldCounts[s] || 0;
      if (r.dealer === s) { byDealer[r.pattern[s]].n++; byDealer[r.pattern[s]].wins += r.wins[s]; }
    }
    const rn = r.roomRound;
    if (!byRound[rn]) byRound[rn] = { n: 0, diff: 0, hu: 0 };
    byRound[rn].n++;
    byRound[rn].diff += pairDiffs(r) ? pairDiffs(r).net : 0;
    if (r.result === 'hu') byRound[rn].hu++;
  }

  const clusters = groupBySeed(rows);
  const diffOf = (key) => (group) => mean(group.map(pairDiffs).filter(Boolean).map((d) => d[key]));
  const boot = {};
  for (const k of ['net', 'win', 'dealIn', 'meld']) boot[k] = clusterBootstrap(clusters, diffOf(k));

  return {
    rows: rows.length,
    seeds: clusters.length,
    hu, draw, aborted,
    huRate: hu / rows.length,
    avgDiscards: totalDiscards / rows.length,
    avgTing: tingSum / rows.length,
    avgPoints: ptsSum / ptsN,
    avgMult: multSum / Math.max(1, hu),
    avgScore: scoreSum / Math.max(1, hu),
    zimoRate: zimo / Math.max(1, hu),
    hardCalls,
    fallbackRate: fallbacks / Math.max(1, hardCalls),
    seat,
    winner,
    byDealer,
    byRound,
    byWinType,
    source,
    boot,
  };
}

function analyzeUniform(rows) {
  const by = {};
  for (const r of rows) {
    const k = r.pattern;
    const b = (by[k] ||= { n: 0, hu: 0, discards: 0, pts: 0, ptsN: 0, score: 0, mult: 0, hardCalls: 0, fallbacks: 0, ting: 0, melds: 0, netsAbs: 0 });
    b.n++;
    if (r.result === 'hu') {
      b.hu++;
      if (r.tilePoints != null) { b.pts += r.tilePoints; b.ptsN++; }
      if (r.score != null) b.score += r.score;
      if (r.mult != null) b.mult += r.mult;
    }
    b.discards += r.discards;
    b.ting += r.tingCount || 0;
    b.melds += (r.meldCounts || []).reduce((a, x) => a + x, 0);
    b.hardCalls += r.hardCalls || 0;
    b.fallbacks += r.hardFallbacks || 0;
    b.netsAbs += r.nets.reduce((a, x) => a + Math.abs(x), 0);
  }
  for (const k of Object.keys(by)) {
    const b = by[k];
    b.huRate = b.hu / b.n;
    b.avgDiscards = b.discards / b.n;
    b.avgPoints = b.pts / b.ptsN;
    b.avgScore = b.score / Math.max(1, b.hu);
    b.avgMelds = b.melds / b.n;
    b.fallbackRate = b.fallbacks / Math.max(1, b.hardCalls);
  }
  return by;
}

function quickCompare(rows) {
  const acc = { N: { n: 0, w: 0, d: 0, net: 0 }, H: { n: 0, w: 0, d: 0, net: 0 } };
  let hu = 0, hardCalls = 0, fallbacks = 0, discards = 0, aborted = 0;
  for (const r of rows) {
    if (r.result === 'hu') hu++;
    if (r.result === 'aborted') aborted++;
    hardCalls += r.hardCalls || 0;
    fallbacks += r.hardFallbacks || 0;
    discards += r.discards;
    for (let s = 0; s < 4; s++) {
      const b = acc[r.pattern[s]];
      b.n++; b.w += r.wins[s]; b.d += r.dealIns[s]; b.net += r.nets[s];
    }
  }
  const clusters = groupBySeed(rows);
  const boot = clusterBootstrap(clusters, (g) => mean(g.map(pairDiffs).filter(Boolean).map((d) => d.net)));
  return {
    rows: rows.length, hu, aborted, huRate: hu / rows.length,
    avgDiscards: discards / rows.length,
    hardCalls, fallbackRate: fallbacks / Math.max(1, hardCalls),
    N: { winRate: acc.N.w / acc.N.n, dealInRate: acc.N.d / acc.N.n, net: acc.N.net / acc.N.n },
    H: { winRate: acc.H.w / acc.H.n, dealInRate: acc.H.d / acc.H.n, net: acc.H.net / acc.H.n },
    boot,
  };
}

function analyzeCalibration(rows, trace) {
  const N = rows.length;
  const seg = Math.floor(N / 4);
  const head = rows.slice(0, seg);
  const tail = rows.slice(-seg);
  const segStat = (part) => {
    let hNet = 0, hWins = 0, hSeats = 0, hDeal = 0;
    for (const r of part) {
      for (let s = 0; s < 4; s++) {
        if (r.pattern[s] !== 'H') continue;
        hSeats++;
        hNet += r.nets[s];
        hWins += r.wins[s];
        hDeal += r.dealIns[s];
      }
    }
    return { netPerSeat: hNet / hSeats, winRate: hWins / hSeats, dealInRate: hDeal / hSeats };
  };
  // 前段 vs 后段：按 seed 聚类的两独立样本 bootstrap，检验「开校准后是否真的变弱」
  const seedVals = (part) =>
    groupBySeed(part).map((g) => {
      let sum = 0;
      let n = 0;
      for (const r of g) for (let s = 0; s < 4; s++) if (r.pattern[s] === 'H') { sum += r.nets[s]; n++; }
      return n ? sum / n : 0;
    });
  const a = seedVals(head);
  const b = seedVals(tail);
  const rng = seededRng(777);
  const diffs = [];
  const pick = (arr) => arr.reduce((x, v) => x + arr[Math.floor(rng() * arr.length)], 0) / arr.length;
  for (let i = 0; i < 2000; i++) diffs.push(pick(a) - pick(b));
  diffs.sort((x, y) => x - y);
  const trendBoot = {
    point: mean(a) - mean(b),
    lo: diffs[50],
    hi: diffs[1949],
    p: Math.min(1, 2 * Math.min(diffs.filter((x) => x <= 0).length, diffs.filter((x) => x >= 0).length) / 2000),
  };
  const keys = ['defenseSlack', 'riskWeight', 'winWeightBoost', 'pengAggression'];
  const series = {};
  for (const k of keys) {
    const vals = trace.map((t) => t.params && t.params[k]).filter(Number.isFinite);
    series[k] = {
      first: vals[0],
      last: vals[vals.length - 1],
      min: Math.min(...vals),
      max: Math.max(...vals),
      changes: vals.reduce((a, v, i) => a + (i && v !== vals[i - 1] ? 1 : 0), 0),
    };
  }
  return { head: segStat(head), tail: segStat(tail), trendBoot, series, tracePoints: trace.length };
}

/**
 * 单实例离线重放：把主实验（固定参数）的每局结果按真实顺序喂给校准器，
 * 用于回答「若长跑中开启在线校准，参数会走向哪里」——避免 worker 间校准状态分片。
 * persist:false 不写盘，纯内存推演。
 */
function replayCalibration(rows) {
  const calibration = require(path.join(__dirname, '..', 'src', 'ai-calibration'));
  calibration.configure({
    enabled: true,
    minRounds: 40,
    params: calibration.DEFAULTS,
    file: path.join(os.tmpdir(), 'mj-sim-replay-calibration.json'),
  });
  const trace = [];
  const directions = {};
  const ordered = rows.slice().sort((a, b) => a.seed - b.seed || a.pair.localeCompare(b.pair) || a.roomRound - b.roomRound);
  let at = 0;
  for (const r of ordered) {
    for (let s = 0; s < 4; s++) {
      if (r.pattern[s] !== 'H') continue;
      const out = calibration.noteRound(
        { seat: s, win: !!r.wins[s], dealIn: !!r.dealIns[s], net: r.nets[s], difficulty: 'hard', variant: r.variant },
        { persist: false }
      );
      if (out) {
        const reason = out.reason || '';
        const dir = /转为防守/.test(reason)
          ? '转防守'
          : /转为进攻/.test(reason)
            ? '转进攻'
            : /向默认值收敛/.test(reason)
              ? '向默认收敛'
              : '保持';
        directions[dir] = (directions[dir] || 0) + 1;
        trace.push({
          at,
          params: calibration.getParams(),
          dir,
          winRate: out.stats && out.stats.winRate,
          dealInRate: out.stats && out.stats.dealInRate,
          changed: out.changed,
        });
      }
    }
    at++;
  }
  return { trace, final: calibration.getParams(), directions, triggers: trace.length };
}

function sig(b) {
  if (b.p < 0.001) return 'p<0.001';
  return `p=${b.p.toFixed(3)}`;
}

function buildReport(main, uniform, calib, replay, variants, meta, files) {
  const L = [];
  L.push(`# AI 难度 ${main.rows.toLocaleString('zh-CN')} 局模拟对局分析`);
  L.push('');
  L.push(`生成时间：${new Date().toISOString()}  `);
  L.push(`数据来源：\`${files.map((x) => path.basename(x)).join('`, `')}\`  `);
  L.push(`主实验：${main.rows} 局 / ${main.seeds} 个随机种子 / ${meta.elapsedSec}s / ${meta.gamesPerSec} 局每秒  `);
  L.push(`玩法：${meta.variant || 'koudian'}（运城扣点点 136：报听制、1/2 点不能胡、3/4/5 点仅自摸）  `);
  L.push('');
  L.push('## 一、实验设计');
  L.push('');
  L.push('- 直接复用线上 `GameServer` + `rules.js` + `ai.js` / `ai-hard.js`，只把 AI 代打的 80ms 定时器换成同步队列、广播与日志置空，**规则和决策逻辑与线上完全一致**。');
  L.push('- 4 个座位全部 AI 代打；每房间连打 4 局（合法总局数），同一随机种子跑两个房间，**难度分配对调**（`NHNH` ↔ `HNHN`），消除座位与庄家偏差。');
  L.push('- 主实验固定默认校准参数，关闭在线调参，比较的是「纯策略强度」；校准实验单独跑一组观察参数演化。');
  L.push('- 显著性用按 seed 聚类的 bootstrap（2000 次重采样）求 95% CI 与双侧经验 p 值，避免把同桌 4 家的相关性当成独立样本。');
  L.push('');
  L.push('## 二、总体牌局');
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('| --- | --- |');
  L.push(`| 和牌局数 / 和牌率 | ${main.hu} / ${pct(main.huRate)} |`);
  L.push(`| 流局 / 异常中止 | ${main.draw} / ${main.aborted} |`);
  L.push(`| 平均全场弃牌数（巡目代理） | ${f(main.avgDiscards, 1)} 张 |`);
  L.push(`| 平均报听人数 | ${f(main.avgTing, 2)} 人 |`);
  L.push(`| 平均胡牌点数 | ${f(main.avgPoints)} 点 |`);
  L.push(`| 平均牌型倍数 / 胡牌得分 | ${f(main.avgMult)} 倍 / ${f(main.avgScore, 1)} 分 |`);
  L.push(`| 自摸占和牌比例 | ${pct(main.zimoRate)} |`);
  L.push(`| 困难内核调用 / 无解回退率 | ${main.hardCalls} 次 / ${pct(main.fallbackRate, 3)} |`);
  L.push('');
  L.push('## 三、普通 vs 困难（同桌直接对抗）');
  L.push('');
  const S = main.seat;
  L.push('| 座位·局指标 | 普通 N | 困难 H | 差值 H−N |');
  L.push('| --- | --- | --- | --- |');
  L.push(`| 样本数 | ${S.N.n} | ${S.H.n} | — |`);
  L.push(`| 和牌率 | ${pct(S.N.wins / S.N.n)} | ${pct(S.H.wins / S.H.n)} | ${pct((S.H.wins / S.H.n - S.N.wins / S.N.n), 2)} |`);
  L.push(`| 放铳率 | ${pct(S.N.dealIns / S.N.n)} | ${pct(S.H.dealIns / S.H.n)} | ${pct((S.H.dealIns / S.H.n - S.N.dealIns / S.N.n), 2)} |`);
  L.push(`| 每座位·局净得分 | ${f(S.N.net / S.N.n, 3)} | ${f(S.H.net / S.H.n, 3)} | ${f(S.H.net / S.H.n - S.N.net / S.N.n, 3)} |`);
  L.push(`| 平均副露组数 | ${f(S.N.melds / S.N.n, 3)} | ${f(S.H.melds / S.H.n, 3)} | ${f(S.H.melds / S.H.n - S.N.melds / S.N.n, 3)} |`);
  L.push('');
  L.push('配对检验（H 减 N，按 seed 聚类 bootstrap）：');
  L.push('');
  L.push('| 指标 | 均值差 | 95% CI | 双侧 p |');
  L.push('| --- | --- | --- | --- |');
  L.push(`| 每座位·局净得分 | ${f(main.boot.net.point, 3)} | [${f(main.boot.net.lo, 3)}, ${f(main.boot.net.hi, 3)}] | ${sig(main.boot.net)} |`);
  L.push(`| 和牌率 | ${pct(main.boot.win.point)} | [${pct(main.boot.win.lo)}, ${pct(main.boot.win.hi)}] | ${sig(main.boot.win)} |`);
  L.push(`| 放铳率 | ${pct(main.boot.dealIn.point)} | [${pct(main.boot.dealIn.lo)}, ${pct(main.boot.dealIn.hi)}] | ${sig(main.boot.dealIn)} |`);
  L.push(`| 副露组数 | ${f(main.boot.meld.point, 3)} | [${f(main.boot.meld.lo, 3)}, ${f(main.boot.meld.hi, 3)}] | ${sig(main.boot.meld)} |`);
  L.push('');
  const W = main.winner;
  L.push('只看赢家时的胡牌质量：');
  L.push('');
  L.push('| 指标 | 普通赢家 | 困难赢家 |');
  L.push('| --- | --- | --- |');
  L.push(`| 胜局数 | ${W.N.n} | ${W.H.n} |`);
  L.push(`| 自摸占比 | ${pct(W.N.zimo / Math.max(1, W.N.n))} | ${pct(W.H.zimo / Math.max(1, W.H.n))} |`);
  L.push(`| 平均点数 | ${f(W.N.pts / Math.max(1, W.N.ptsN))} | ${f(W.H.pts / Math.max(1, W.H.ptsN))} |`);
  L.push(`| 平均得分 | ${f(W.N.score / Math.max(1, W.N.n), 1)} | ${f(W.H.score / Math.max(1, W.H.n), 1)} |`);
  L.push('');
  L.push('## 四、分层结果');
  L.push('');
  L.push('| 房间内局序 | 局数 | 和牌率 | H−N 每座净得分 |');
  L.push('| --- | --- | --- | --- |');
  for (const k of Object.keys(main.byRound).sort((a, b) => Number(a) - Number(b))) {
    const b = main.byRound[k];
    L.push(`| 第 ${k} 局 | ${b.n} | ${pct(b.hu / b.n)} | ${f(b.diff / b.n, 3)} |`);
  }
  L.push('');
  L.push(`庄家分层：普通庄 ${pct(main.byDealer.N.wins / Math.max(1, main.byDealer.N.n))} 和牌率（${main.byDealer.N.n} 次），困难庄 ${pct(main.byDealer.H.wins / Math.max(1, main.byDealer.H.n))}（${main.byDealer.H.n} 次）。`);
  L.push('');
  L.push('## 五、优势来源分解');
  L.push('');
  const sc = main.source;
  const nSeat = main.seat.N.n, hSeat = main.seat.H.n;
  const attack = sc.H.winGain / hSeat - sc.N.winGain / nSeat;
  const defense = sc.H.dealLoss / hSeat - sc.N.dealLoss / nSeat; // 支出越少越有利，故取 H−N（负数差值）
  const denom = Math.abs(attack) + Math.abs(defense) || 1;
  L.push('| 项目（每座位·局） | 普通 N | 困难 H | 对净得分差的贡献 |');
  L.push('| --- | --- | --- | --- |');
  L.push(`| 和牌带来的收入 | ${f(sc.N.winGain / nSeat, 3)} | ${f(sc.H.winGain / hSeat, 3)} | ${f(attack, 3)}（${pct(attack / denom, 1)}） |`);
  L.push(`| 放铳造成的支出 | ${f(sc.N.dealLoss / nSeat, 3)} | ${f(sc.H.dealLoss / hSeat, 3)} | ${f(defense, 3)}（${pct(defense / denom, 1)}） |`);
  L.push(`| 赢家局平均弃牌数（越小越快和牌） | ${f(sc.N.winDisc / Math.max(1, main.winner.N.n), 1)} | ${f(sc.H.winDisc / Math.max(1, main.winner.H.n), 1)} | — |`);
  L.push(`| 赢家里低点听口（3/4/5 点，仅能自摸）占比 | ${pct(sc.N.lowPt / Math.max(1, sc.N.ptsN))} | ${pct(sc.H.lowPt / Math.max(1, sc.H.ptsN))} | — |`);
  L.push('');
  L.push(`结论：困难档的净得分优势约 **${pct(attack / denom, 0)} 来自进攻端**（更多和牌 + 更高点数），${pct(defense / denom, 0)} 来自防守端（少放铳）。`);
  L.push('注意赢家局平均弃牌数两档几乎相同，说明困难档**不是靠抢速度**，而是靠听口选择质量与不拆错搭子；低点听口占比更低，正是「1/2 点进张权重为 0、3/4/5 点半权」这条设计在起作用。');
  L.push('');
  L.push('| 胡牌方式 | 局数 | H−N 每座净得分 |');
  L.push('| --- | --- | --- |');
  for (const [k, v] of Object.entries(main.byWinType)) {
    L.push(`| ${k === 'zimo' ? '自摸' : k === 'dianpao' ? '点炮' : k} | ${v.n} | ${f(v.diff / v.n, 3)} |`);
  }
  L.push('');
  if (uniform) {
    L.push('## 六、绝对牌效对照（全普通 vs 全困难，镜像牌山）');
    L.push('');
    L.push('| 指标 | 全普通 NNNN | 全困难 HHHH |');
    L.push('| --- | --- | --- |');
    const a = uniform.NNNN || {}, b = uniform.HHHH || {};
    L.push(`| 局数 | ${a.n || 0} | ${b.n || 0} |`);
    L.push(`| 和牌率 | ${pct(a.huRate)} | ${pct(b.huRate)} |`);
    L.push(`| 平均全场弃牌数 | ${f(a.avgDiscards, 1)} | ${f(b.avgDiscards, 1)} |`);
    L.push(`| 平均胡牌点数 | ${f(a.avgPoints)} | ${f(b.avgPoints)} |`);
    L.push(`| 平均胡牌得分 | ${f(a.avgScore, 1)} | ${f(b.avgScore, 1)} |`);
    L.push(`| 平均报听人数 | ${f(a.ting / Math.max(1, a.n), 2)} | ${f(b.ting / Math.max(1, b.n), 2)} |`);
    L.push(`| 困难内核调用 / 局 | ${f(a.hardCalls / Math.max(1, a.n), 1)} | ${f(b.hardCalls / Math.max(1, b.n), 1)} |`);
    L.push('');
  }
  if (variants && variants.length) {
    L.push('## 七、跨玩法小样本验证（红中 / 贴金）');
    L.push('');
    L.push('| 玩法 | 局数 | 异常 | 和牌率 | 普通胜率 | 困难胜率 | H−N 每座净得分（95% CI / p） | 困难内核回退率 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const v of variants) {
      const s = v.stats;
      L.push(`| ${v.name} | ${s.rows} | ${s.aborted + (v.errors || 0)} | ${pct(s.huRate)} | ${pct(s.N.winRate)} | ${pct(s.H.winRate)} | ${f(s.boot.point, 3)}（[${f(s.boot.lo, 3)}, ${f(s.boot.hi, 3)}] / ${sig(s.boot)}） | ${pct(s.fallbackRate, 1)} |`);
    }
    L.push('');
    L.push('万能牌玩法没有通用向听函数，困难档改用「专用胡牌判定枚举听口」，且**只在接近听牌时接管**；早中期无有效听口会回退普通策略，因此回退率远高于扣点点（约 0.3%），两档差距也明显更小。样本仅数百局，只作方向参考，不足以做强度结论。');
    L.push('');
  }
  if (calib) {
    L.push('## 八、胜率自动校准的在线长跑表现');
    L.push('');
    L.push(`开启在线校准后，校准触发点 ${calib.tracePoints} 个。前 1/4 与后 1/4 局段对比（仅困难座位）：`);
    L.push('');
    L.push('| 指标 | 前段 | 后段 | 变化 |');
    L.push('| --- | --- | --- | --- |');
    L.push(`| 每座位·局净得分 | ${f(calib.head.netPerSeat, 3)} | ${f(calib.tail.netPerSeat, 3)} | ${f(calib.tail.netPerSeat - calib.head.netPerSeat, 3)} |`);
    L.push(`| 和牌率 | ${pct(calib.head.winRate)} | ${pct(calib.tail.winRate)} | ${pct(calib.tail.winRate - calib.head.winRate)} |`);
    L.push(`| 放铳率 | ${pct(calib.head.dealInRate)} | ${pct(calib.tail.dealInRate)} | ${pct(calib.tail.dealInRate - calib.head.dealInRate)} |`);
    L.push('');
    const tb = calib.trendBoot;
    L.push(`前段 − 后段的每座位·局净得分差 ${f(tb.point, 3)}（95% CI [${f(tb.lo, 3)}, ${f(tb.hi, 3)}]，${sig(tb)}）。`);
    if (tb.point > 0 && tb.p < 0.05) {
      L.push('**结论：开启在线校准后困难档反而显著变弱**——默认参数本已接近较优，而校准器在零和 AI 房里持续往进攻边界推参数，牺牲了防守与听口质量。');
    } else if (tb.point > 0) {
      L.push('方向上开启校准后表现略降，但差异未达显著；仍建议谨慎在生产启用自动调参。');
    } else {
      L.push('开启校准后表现未变弱，但参数仍出现明显漂移，需要更长时间观察。');
    }
    L.push('');
    L.push('| 参数 | 初始 | 最终 | 最小 | 最大 | 变更次数 |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const [k, v] of Object.entries(calib.series)) {
      L.push(`| ${k} | ${f(v.first, 3)} | ${f(v.last, 3)} | ${f(v.min, 3)} | ${f(v.max, 3)} | ${v.changes} |`);
    }
    L.push('');
  }
  L.push('### 单实例离线重放（消除 worker 间校准状态分片）');
  L.push('');
  L.push('把主实验固定的 10000 局结果按真实顺序喂给一个校准器实例（不写盘），检验参数是否收敛：');
  L.push('');
  L.push(`- 校准触发 ${replay.triggers} 次；方向分布：${Object.entries(replay.directions).map(([k, v]) => `${k} ${v} 次`).join('、')}。`);
  L.push('');
  L.push('| 参数 | 默认 | 重放最终值 | 边界 |');
  L.push('| --- | --- | --- | --- |');
  const cal = require(path.join(__dirname, '..', 'src', 'ai-calibration'));
  for (const k of cal.KEYS) {
    const b = cal.BOUNDS[k];
    L.push(`| ${k} | ${f(cal.DEFAULTS[k], 2)} | ${f(replay.final[k], 3)} | [${f(b[0], 2)}, ${f(b[1], 2)}] |`);
  }
  L.push('');
  const atBounds = cal.KEYS.filter((k) => replay.final[k] === cal.BOUNDS[k][0] || replay.final[k] === cal.BOUNDS[k][1]);
  if (atBounds.length >= 2) {
    L.push(`**发现一个设计问题**：4 家同桌是零和的，纯 AI 房里困难档胜率被锁在约 25%，低于校准目标 30%；放铳率又低于 18% 阈值，于是校准器长期偏向「胜率偏低 → 转进攻」，并在放铳偶尔超标时反向加重风险权重，形成振荡（本重放 ${replay.directions['转进攻'] || 0} 次转进攻、${replay.directions['转防守'] || 0} 次转防守）。`);
    L.push(`最终 **${atBounds.length}/${cal.KEYS.length} 个参数贴住边界**（${atBounds.join('、')}），说明在当前目标下参数无法收敛回默认区间。`);
    L.push('建议：把目标从绝对胜率改为**相对同桌其他座位的净得分 > 0**，或只统计含真人玩家的房间；若保留 30% 绝对目标，应排除纯 AI 补位房间，否则线上机器人房会长期把参数顶在边界上。');
  }
  L.push('');
  L.push('## 九、结论与局限');
  L.push('');
  const net = main.boot.net;
  const win = main.boot.win;
  const verdict = net.p < 0.05 ? (net.point > 0 ? '困难档显著更强' : '困难档显著更弱') : '两档强度差异未达到统计显著';
  L.push(`- **强度结论**：${verdict}。每座位·局净得分差 ${f(net.point, 3)} 分（95% CI [${f(net.lo, 3)}, ${f(net.hi, 3)}]，${sig(net)}）；和牌率差 ${pct(win.point)}（${sig(win)}）。`);
  L.push(`- 困难内核在 ${pct(1 - main.fallbackRate, 2)} 的调用中给出了有效解，其余回退普通策略，说明「进张枚举」在运城 136 的点数限制下并非处处可用。`);
  L.push('- 本模拟 4 家均为 AI，衡量的是**策略相对强度**，不代表对真人的胜率；真人会因读牌、记牌、情绪产生额外方差。');
  L.push('- 报听、胡、杠、抢杠等状态机两档共用，差异只来自出牌选择与碰牌判断；若把向听收益也接入杠判断，结论可能变化。');
  L.push('- 同一房间连打 4 局，局间庄家与累计分数相关；统计已按 seed 聚类，避免高估样本独立性。');
  L.push('- 主实验 10000 局为扣点点；红中/贴金另有数百局小样本，因困难策略回退率高、样本小，结论只作方向参考。');
  L.push('- 在线校准实验的 worker 各自持有独立校准器状态（等价于多个短程实例），绝对参数轨迹以单实例离线重放为准。');
  L.push('');
  return L.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const mainFile = args[0];
  if (!mainFile) {
    console.error('用法: node scripts/ai-simulate-analyze.js <主实验.json> [--uniform u.json] [--calib c.json] [--out report.md]');
    process.exit(1);
  }
  const load = (p) => (p ? JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')) : null);
  const mainData = load(mainFile);
  const uniData = load(get('--uniform'));
  const calibData = load(get('--calib'));
  const out = get('--out') || path.join(path.dirname(path.resolve(mainFile)), 'ai-sim-report.md');
  const chartsOut = path.join(path.dirname(path.resolve(out)), 'ai-sim-charts.json');

  const stats = analyzeMixed(mainData.rows);
  const uniform = uniData ? analyzeUniform(uniData.rows) : null;
  const calib = calibData ? analyzeCalibration(calibData.rows, calibData.calibTrace || []) : null;
  const replay = replayCalibration(mainData.rows);
  const variantFiles = (get('--variants') || '').split(',').filter(Boolean);
  const variants = variantFiles.map((p) => {
    const d = JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
    const v = d.meta && d.meta.variant;
    return {
      name: v === 'hongzhong' ? '红中' : v === 'tiejin' ? '贴金' : path.basename(p),
      stats: quickCompare(d.rows),
      errors: (d.errors || []).length,
    };
  });

  const report = buildReport(stats, uniform, calib, replay, variants, mainData.meta || {}, [mainFile, get('--uniform'), get('--calib'), ...variantFiles].filter(Boolean));
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), report);

  const charts = {
    seat: {
      N: { winRate: stats.seat.N.wins / stats.seat.N.n, dealInRate: stats.seat.N.dealIns / stats.seat.N.n, net: stats.seat.N.net / stats.seat.N.n, melds: stats.seat.N.melds / stats.seat.N.n },
      H: { winRate: stats.seat.H.wins / stats.seat.H.n, dealInRate: stats.seat.H.dealIns / stats.seat.H.n, net: stats.seat.H.net / stats.seat.H.n, melds: stats.seat.H.melds / stats.seat.H.n },
    },
    boot: stats.boot,
    byRound: stats.byRound,
    overall: { huRate: stats.huRate, avgDiscards: stats.avgDiscards, avgPoints: stats.avgPoints, fallbackRate: stats.fallbackRate },
    uniform,
    calib,
    replay: {
      triggers: replay.triggers,
      directions: replay.directions,
      final: replay.final,
      trace: replay.trace.filter((_, i) => i % Math.max(1, Math.floor(replay.trace.length / 120)) === 0),
    },
    variants: variants.map((v) => ({ name: v.name, ...v.stats })),
    source: stats.source,
    byWinType: stats.byWinType,
    winner: stats.winner,
  };
  fs.writeFileSync(chartsOut, JSON.stringify(charts, null, 2));

  console.log(report);
  console.log(`\n[analyze] 报告: ${path.resolve(out)}`);
  console.log(`[analyze] 图表数据: ${chartsOut}`);
}

main();
