'use strict';

/**
 * AI 批量对局模拟器（无网络 / 纯内存 / 可复现）
 *
 * 目的：评估普通 vs 困难 AI 的实际强度，并为「胜率自动校准」提供大样本验证。
 *
 * 做法（不改任何产品代码，只做运行时注入）：
 *  - 直接复用真实 GameServer、规则引擎与 AI 决策，保证模拟与线上行为一致；
 *  - 把 AI 代打的 80ms setTimeout 换成同步队列（令牌/取消语义保留），
 *    把广播与日志换成空操作，从而绕开网络、定时器与磁盘；
 *  - 用 seededRng 注入可复现牌墙；同一 seed 跑两个房间，难度分配对调，
 *    消除座位 / 庄家偏差（配对实验）；
 *  - mixed 模式每局 2 普通 + 2 困难同桌直接对抗；uniform 模式全普通 / 全困难镜像。
 *
 * 用法：
 *   node scripts/ai-simulate.js --games 10000
 *   node scripts/ai-simulate.js --games 2000 --mode uniform --variant hongzhong
 *   node scripts/ai-simulate.js --games 10000 --calibration on --out reports/calib.json
 *
 * 输出：一个 JSON，含 meta / 每局精简记录 / 校准参数轨迹。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

// 模拟一律禁用落盘日志、历史与在线校准的默认副作用；校准实验由 worker 自行显式开启。
process.env.NODE_ENV = 'test';
process.env.MARVIS_GAME_LOG = '0';
process.env.MARVIS_AI_CALIBRATION = '0';

const ROOT = path.join(__dirname, '..');
const ROUNDS_PER_ROOM = 4; // 合法总局数之一，一个房间连续打 4 局

function parseArgs(argv) {
  const out = {
    games: 10000,
    workers: Math.min(8, Math.max(1, (os.cpus() || [{}, {}]).length - 2)),
    mode: 'mixed',
    variant: 'koudian',
    calibration: 'off',
    seedBase: 100000,
    out: path.join(ROOT, 'reports', 'ai-simulate.json'),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--games') out.games = Math.max(1, Math.floor(Number(v)));
    else if (k === '--workers') out.workers = Math.max(1, Math.floor(Number(v)));
    else if (k === '--mode') out.mode = v;
    else if (k === '--variant') out.variant = v;
    else if (k === '--calibration') out.calibration = v;
    else if (k === '--seed-base') out.seedBase = Math.floor(Number(v));
    else if (k === '--out') out.out = path.resolve(v);
  }
  if (!['mixed', 'uniform'].includes(out.mode)) throw new Error('--mode 必须是 mixed 或 uniform');
  if (!['koudian', 'hongzhong', 'tiejin'].includes(out.variant)) throw new Error('--variant 不合法');
  return out;
}

// ============================ 主进程 ============================
if (isMainThread) {
  const opts = parseArgs(process.argv.slice(2));
  // 每个 seed 跑两个房间 × 4 局 = 8 局
  const seeds = Math.ceil(opts.games / (ROUNDS_PER_ROOM * 2));
  const perWorker = Math.ceil(seeds / opts.workers);
  const ranges = [];
  for (let i = 0; i < opts.workers; i++) {
    const from = i * perWorker;
    const to = Math.min(seeds, from + perWorker);
    if (from < to) ranges.push([from, to]);
  }
  const totalPlanned = seeds * ROUNDS_PER_ROOM * 2;
  console.log(`[sim] 目标 ${opts.games} 局 | 实际计划 ${totalPlanned} 局（${seeds} seeds × 2 房间 × 4 局）`);
  console.log(`[sim] 玩法=${opts.variant} 模式=${opts.mode} 校准=${opts.calibration} workers=${ranges.length}`);

  const all = [];
  const calibTrace = [];
  const errors = [];
  const t0 = Date.now();
  let done = 0;

  const progress = new Map();
  const jobs = ranges.map(
    ([from, to], wi) =>
      new Promise((resolve, reject) => {
        const w = new Worker(__filename, {
          workerData: {
            from,
            to,
            seedBase: opts.seedBase,
            mode: opts.mode,
            variant: opts.variant,
            calibration: opts.calibration,
            roundsPerRoom: ROUNDS_PER_ROOM,
          },
        });
        w.on('message', (m) => {
          if (m.type === 'progress') {
            progress.set(wi, m.rows);
            const sum = [...progress.values()].reduce((a, b) => a + b, 0);
            process.stdout.write(`\r[sim] 已完成约 ${sum}/${totalPlanned} 局  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
          } else if (m.type === 'done') {
            all.push(...m.rows);
            calibTrace.push(...(m.calibTrace || []));
            errors.push(...(m.errors || []));
            done++;
            resolve();
          } else if (m.type === 'error') {
            reject(new Error(m.message));
          }
        });
        w.on('error', reject);
        w.on('exit', (code) => {
          if (code !== 0 && done < ranges.length) reject(new Error('worker 退出码 ' + code));
        });
      })
  );

  Promise.all(jobs)
    .then(() => {
      process.stdout.write('\n');
      // 按 seed / pair / 局序稳定排序，保证结果可复现
      all.sort((a, b) => a.seed - b.seed || a.pair.localeCompare(b.pair) || a.roomRound - b.roomRound);
      const rows = all.slice(0, opts.games);
      const elapsed = (Date.now() - t0) / 1000;
      const payload = {
        meta: {
          createdAt: new Date().toISOString(),
          node: process.version,
          cpus: (os.cpus() || []).length,
          games: rows.length,
          planned: totalPlanned,
          elapsedSec: Number(elapsed.toFixed(1)),
          gamesPerSec: Number((rows.length / elapsed).toFixed(1)),
          ...opts,
          out: undefined,
        },
        rows,
        calibTrace,
        errors,
      };
      delete payload.meta.out;
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, JSON.stringify(payload));
      console.log(`[sim] 完成 ${rows.length} 局，用时 ${elapsed.toFixed(1)}s（${(rows.length / elapsed).toFixed(1)} 局/秒）`);
      console.log(`[sim] 异常局 ${errors.length} 条；结果已写入 ${opts.out}`);
    })
    .catch((e) => {
      console.error('[sim] 失败:', e);
      process.exitCode = 1;
    });
} else {
  // ============================ Worker ============================
  runWorker(workerData).catch((e) => {
    parentPort.postMessage({ type: 'error', message: String((e && e.stack) || e) });
  });
}

async function runWorker(cfg) {
  const { GameServer } = require(path.join(ROOT, 'src', 'game'));
  const { seededRng } = require(path.join(ROOT, 'lib', 'testutils'));
  const aiJournal = require(path.join(ROOT, 'src', 'ai-journal'));
  const calibration = require(path.join(ROOT, 'src', 'ai-calibration'));
  const ai = require(path.join(ROOT, 'src', 'ai'));
  const hard = require(path.join(ROOT, 'src', 'ai-hard'));

  // 探针：统计困难内核的真实调用次数 / 无解回退次数。
  // ai.js 通过 hard.chooseDiscard 属性访问，故运行时替换可被真实决策链看到。
  // 这既是验证「按座位难度注入生效」的硬证据，也是分析困难策略覆盖率的数据。
  const hc = { calls: 0, fallbacks: 0 };
  for (const name of ['chooseDiscard', 'chooseHongZhongDiscard', 'chooseTieJinDiscard']) {
    const orig = hard[name].bind(hard);
    hard[name] = (...args) => {
      hc.calls++;
      const r = orig(...args);
      if (!r) hc.fallbacks++;
      return r;
    };
  }

  // ---- 1. 关闭复盘日志；校准实验按需单独开启 ----
  let calibEnabled = cfg.calibration === 'on';
  let calibFile = null;
  if (calibEnabled) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-calib-'));
    calibFile = path.join(tmp, 'ai-calibration.json');
    calibration.configure({ enabled: true, file: calibFile, minRounds: 40, params: calibration.DEFAULTS });
    aiJournal.recordDecision = () => false; // 决策快照不落盘，但保留结算喂给校准器
    // 生产里难度是「房间级」，finishRound 按房间标注一次即可；模拟里难度是「座位级」，
    // 因此按座位逐条喂给校准器，保证样本标注正确（不改变校准算法本身）。
    aiJournal.finishRound = (room) => {
      const g = room.game || {};
      const w = g.winners || {};
      const winSeats = w.type === 'hu' && Number.isInteger(w.winnerSeat) ? [w.winnerSeat] : [];
      const discarder = Number.isInteger(w.discarder) ? w.discarder : null;
      const out = [];
      for (let s = 0; s < 4; s++) {
        const pl = room.players && room.players[s];
        if (!pl) continue;
        const rec = {
          seat: s,
          win: winSeats.includes(s),
          dealIn: discarder !== null && discarder === s && !winSeats.includes(s),
          net: Number(pl.roundScore) || 0,
          difficulty: activeAssignment[s] === 'hard' ? 'hard' : 'normal',
          variant: cfg.variant,
        };
        if (rec.difficulty === 'hard') calibration.noteRound(rec);
        out.push(rec);
      }
      return { rows: out };
    };
  } else {
    aiJournal.recordDecision = () => false;
    aiJournal.finishRound = () => null;
  }

  // ---- 2. 接管定时器：80ms 的 AI 代打改为同步队列，其余保持原样 ----
  const queue = [];
  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 80) {
      const token = { fake: true, cancelled: false };
      const item = { token, fn: () => fn(...args), seat: null };
      queue.push(item);
      return token;
    }
    return origSetTimeout(fn, ms, ...args);
  };
  global.clearTimeout = (t) => {
    if (t && t.fake) {
      t.cancelled = true;
      return;
    }
    return origClearTimeout(t);
  };
  global.setInterval = () => ({ fakeInterval: true }); // 心跳不参与模拟
  global.clearInterval = () => {};

  const rows = [];
  const calibTrace = [];
  const errors = [];
  let activeAssignment = ['normal', 'normal', 'normal', 'normal'];
  let errList = [];

  function drain(max = 200000) {
    let n = 0;
    while (queue.length) {
      const item = queue.shift();
      if (item.token.cancelled) continue;
      item.fn();
      if (++n > max) throw new Error('drain overflow：牌局未能收敛');
    }
    return n;
  }

  function mkws() {
    const handlers = {};
    return {
      readyState: 1,
      handlers,
      on: (t, cb) => (handlers[t] = cb),
      send: () => {},
      ping: () => {},
      terminate: () => {},
      close: () => {},
    };
  }
  const send = (ws, obj) => ws.handlers.message(JSON.stringify(obj));

  function capture(room, seed, pair, assignment) {
    const g = room.game || {};
    const w = g.winners || {};
    const players = room.players || [];
    const nets = players.map((p) => (p ? Number(p.roundScore) || 0 : 0));
    // 三玩法 winners 字段不统一：扣点点 winnerSeat、贴金 winner、红中一炮多响 hzWinners
    const winSeats = [];
    if (w.type === 'hu') {
      if (Number.isInteger(w.winnerSeat)) winSeats.push(w.winnerSeat);
      if (Number.isInteger(w.winner)) winSeats.push(w.winner);
      for (const x of g.hzWinners || []) if (x && Number.isInteger(x.winnerSeat)) winSeats.push(x.winnerSeat);
      for (const p of w.payments || []) {
        if (Number.isInteger(p.toSeat)) winSeats.push(p.toSeat);
        else if (Number.isInteger(p.to) && p.kind === 'hu') winSeats.push(p.to);
      }
    }
    const discarder = Number.isInteger(w.discarder) && w.discarder >= 0 && w.discarder < 4 ? w.discarder : null;
    return {
      seed,
      pair,
      roomRound: room.roundNo,
      variant: cfg.variant,
      pattern: assignment.map((x) => (x === 'hard' ? 'H' : 'N')).join(''), // 'NHNH' / 'HNHN' / 'NNNN' / 'HHHH'
      result: w.type || 'aborted',
      winType: w.winType || null,
      winnerSeat: w.type === 'hu' ? (winSeats[0] === undefined ? null : winSeats[0]) : null,
      discarder,
      tilePoints: Number.isFinite(w.tilePoints) ? w.tilePoints : null,
      mult: Number.isFinite(w.mult) ? w.mult : null,
      score: Number.isFinite(w.score) ? w.score : null,
      dealer: g.dealer === undefined ? null : g.dealer,
      discards: (g.discards || []).reduce((a, d) => a + (d ? d.length : 0), 0),
      tingCount: (g.tingSeats || []).length,
      meldCounts: (g.melds || []).map((m) => (m ? m.length : 0)),
      nets,
      wins: [0, 1, 2, 3].map((s) => (winSeats.includes(s) ? 1 : 0)),
      dealIns: [0, 1, 2, 3].map((s) => (discarder !== null && discarder === s && !winSeats.includes(s) ? 1 : 0)),
      params: calibEnabled ? calibration.getParams() : null,
    };
  }

  function playRoom(seed, pair, assignment) {
    const srv = new GameServer({
      gameLog: false,
      rng: seededRng(seed),
      heartbeatIntervalMs: 1e9,
      heartbeatMaxMiss: 1e9,
    });
    // 广播 / 下发全部置空（模拟不需要网络视图），但保留错误收集以检测异常局
    for (const k of ['_broadcast', '_broadcastRoomState', '_broadcastGameState', '_broadcastLobby', '_send', '_sendWs', '_sendLobbyState']) {
      srv[k] = () => {};
    }
    errList = [];
    const origErr = srv._err.bind(srv);
    srv._err = (p, msg) => {
      errList.push(String(msg));
      return origErr(p, msg);
    };
    let lastCalls = hc.calls;
    let lastFallbacks = hc.fallbacks;
    const origEndRound = srv._endRound.bind(srv);
    srv._endRound = (room) => {
      const rec = capture(room, seed, pair, assignment);
      rec.hardCalls = hc.calls - lastCalls;
      rec.hardFallbacks = hc.fallbacks - lastFallbacks;
      lastCalls = hc.calls;
      lastFallbacks = hc.fallbacks;
      rows.push(rec);
      origEndRound(room);
    };
    // 精确记录每次代打调度的座位，供难度 getter 使用
    const origSchedule = srv._scheduleAutoAct.bind(srv);
    srv._scheduleAutoAct = (room, seat) => {
      const before = queue.length;
      origSchedule(room, seat);
      for (let i = before; i < queue.length; i++) queue[i].seat = seat;
    };

    const ws = mkws();
    srv.handleConnection(ws);
    send(ws, { type: 'join_lobby', name: 'sim' });
    send(ws, {
      type: 'create_room',
      settings: {
        aiFill: false,
        totalRounds: cfg.roundsPerRoom,
        variant: cfg.variant,
        aiDifficulty: 'normal',
        zhuangDi: false,
      },
    });
    const room = [...srv.rooms.values()][0];
    if (!room) throw new Error('建房失败');
    activeAssignment = assignment;
    // 房主也标记为 AI：4 个座位全部自动代打，且结算统计覆盖全部座位
    const owner = room.players.find((p) => p && !p.isAI);
    if (owner) owner.isAI = true;
    // 与线上一致：用 add_ai 消息按座位添加不同难度的人机（逐座位难度，不再覆写房间设置）
    for (let s = 0; s < 4; s++) {
      if (room.players[s]) continue;
      send(ws, { type: 'add_ai', difficulty: assignment[s], seat: s });
    }
    if (room.players.filter(Boolean).length !== 4) throw new Error('按座位添加 AI 失败');
    // 房主座位原本是真人，显式指定其托管代打难度
    if (owner) owner.aiDifficulty = assignment[owner.seat];
    send(ws, { type: 'start_game' });
    const steps = drain();
    const got = rows.length;
    const localErrs = errList.slice(0, 5);
    const state = room.state;
    const stage = room.game && room.game.stage;
    srv.stop();
    // 清掉本房间遗留队列（异常局可能留下未执行动作）
    queue.length = 0;
    return { steps, got, localErrs, state, stage };
  }

  const assignments =
    cfg.mode === 'mixed'
      ? [
          ['normal', 'hard', 'normal', 'hard'],
          ['hard', 'normal', 'hard', 'normal'],
        ]
      : [
          ['normal', 'normal', 'normal', 'normal'],
          ['hard', 'hard', 'hard', 'hard'],
        ];
  const short = assignments.map((a) => a.map((x) => (x === 'hard' ? 'H' : 'N')).join(''));

  for (let i = cfg.from; i < cfg.to; i++) {
    const seed = cfg.seedBase + i;
    for (let p = 0; p < 2; p++) {
      const before = rows.length;
      let info;
      try {
        info = playRoom(seed, p === 0 ? 'A' : 'B', assignments[p]);
      } catch (e) {
        errors.push({ seed, pair: p === 0 ? 'A' : 'B', pattern: short[p], error: String((e && e.message) || e) });
        continue;
      }
      const added = rows.length - before;
      if (added !== cfg.roundsPerRoom || info.state !== 'settled' || info.localErrs.length) {
        errors.push({
          seed,
          pair: p === 0 ? 'A' : 'B',
          pattern: short[p],
          rounds: added,
          state: info.state,
          stage: info.stage,
          steps: info.steps,
          errs: info.localErrs,
        });
      }
      if (calibEnabled && info) {
        const last = rows[rows.length - 1];
        calibTrace.push({ seed, pair: p === 0 ? 'A' : 'B', roundIndex: rows.length, params: last.params });
      }
    }
    if ((i - cfg.from + 1) % 10 === 0 || i === cfg.to - 1) {
      parentPort.postMessage({ type: 'progress', rows: rows.length });
    }
  }

  global.setTimeout = origSetTimeout;
  global.clearTimeout = origClearTimeout;
  global.setInterval = origSetInterval;
  global.clearInterval = origClearInterval;
  parentPort.postMessage({ type: 'done', rows, calibTrace, errors });
}
