'use strict';

/**
 * AI 决策复盘日志（引用《麻将概率助手电脑版》training_journal 的记录思路）
 *
 * 两类事件落到 logs/ai-YYYY-MM-DD.jsonl（复用 game-logger 的异步写盘 / 大小轮转 / 7 天清理）：
 *  - ai_decision     困难 AI 每次出牌/响应决策的候选快照（向听、进张、风险、实际选择）
 *  - ai_round_result 本局结算后，按 AI 座位汇总「是否胡牌 / 是否放铳 / 本局净得分」
 *
 * 同时在内存里把结算结果喂给 ai-calibration 的滚动窗口，达到样本门槛即自动校准；
 * 离线脚本 scripts/ai-calibrate.js 则可以直接从 jsonl 重建统计并手工重算参数。
 *
 * 日志默认与游戏日志同开关（NODE_ENV=test / MARVIS_GAME_LOG=0 时禁用），
 * 但在线校准由 ai-calibration 自己的开关控制，不依赖日志是否落盘。
 */

const gameLogger = require('./game-logger');
const calibration = require('./ai-calibration');
const { difficultyOf } = require('./ai-difficulty');

const AI_LOG_PREFIX = 'ai-';
const MAX_DECISION_COUNTS = 5000;

let instance = null;
const decisionCounts = new Map(); // `${roomId}|${roundNo}|${seat}` -> 本局困难决策次数

function logger() {
  if (!instance) {
    instance = gameLogger.createGameLogger({
      prefix: AI_LOG_PREFIX,
      dir: process.env.MARVIS_AI_LOG_DIR,
    });
  }
  return instance;
}

/** 测试/部署注入：单独指定 AI 日志目录与开关，并同步校准配置 */
function configure(opts = {}) {
  instance = gameLogger.createGameLogger({
    prefix: AI_LOG_PREFIX,
    dir: opts.dir || process.env.MARVIS_AI_LOG_DIR,
    enabled: opts.enabled,
    maxFileSize: opts.maxFileSize,
  });
  if (opts.calibration) calibration.configure(opts.calibration);
  decisionCounts.clear();
  return instance;
}

function normalizeVariant(v) {
  return v === 'hongzhong' || v === 'tiejin' ? v : 'koudian';
}

function countKey(room, seat) {
  return `${room && room.id}|${room && room.roundNo}|${seat}`;
}

/**
 * 记录一次困难 AI 决策。普通难度不记录（其行为固定，无需复盘）。
 * @param {object} room
 * @param {number} seat
 * @param {object} trace ai-hard 产出的决策轨迹
 */
function recordDecision(room, seat, trace) {
  if (!room || !trace || difficultyOf(room, seat) !== 'hard') return false;
  const key = countKey(room, seat);
  if (decisionCounts.size >= MAX_DECISION_COUNTS) decisionCounts.clear();
  decisionCounts.set(key, (decisionCounts.get(key) || 0) + 1);

  const candidates = Array.isArray(trace.candidates)
    ? trace.candidates.slice(0, 20).map((c) => ({
        tile: c.tile,
        shanten: c.shanten,
        raw: c.raw,
        weighted: c.weighted,
        risk: c.risk,
      }))
    : [];
  return logger().append(room, 'ai_decision', {
    seat,
    variant: normalizeVariant(room.settings && room.settings.variant),
    difficulty: 'hard',
    phase: trace.phase || 'discard',
    picked: trace.picked === undefined ? null : trace.picked,
    fellBack: !!trace.fellBack,
    params: trace.params || calibration.getParams(),
    candidates,
  });
}

/** 兼容三种玩法的 winners 字段：扣点点 winnerSeat、贴金 winner、红中一炮多响 hzWinners */
function winnerSeatsOf(room) {
  const g = room.game || {};
  const w = g.winners;
  if (!w || w.type !== 'hu') return [];
  const seats = [];
  for (const v of [w.winnerSeat, w.winner]) if (Number.isInteger(v)) seats.push(v);
  for (const x of g.hzWinners || []) if (x && Number.isInteger(x.winnerSeat)) seats.push(x.winnerSeat);
  for (const p of w.payments || []) {
    if (p && p.kind === 'hu' && Number.isInteger(p.toSeat)) seats.push(p.toSeat);
  }
  return [...new Set(seats)];
}

function discarderOf(room) {
  const g = room.game || {};
  const w = g.winners;
  if (!w || w.type !== 'hu') return null;
  let d = w.discarder;
  if (!Number.isInteger(d) || d < 0) {
    const multi = (g.hzWinners || []).find((x) => x && Number.isInteger(x.discarder) && x.discarder >= 0);
    d = multi ? multi.discarder : null;
  }
  return Number.isInteger(d) && d >= 0 ? d : null;
}

/**
 * 本局结算收口（由 GameServer._endRound 调用）：写结果日志 + 触发在线校准。
 * @returns {object|null} 汇总信息；房间内无 AI 或异常时返回 null
 */
function finishRound(room) {
  if (!room || !room.game) return null;
  const players = room.players || [];
  const aiSeats = players.filter((p) => p && p.isAI).map((p) => p.seat);
  if (!aiSeats.length) return null;

  const variant = normalizeVariant(room.settings && room.settings.variant);
  const winSeats = winnerSeatsOf(room);
  const discarder = discarderOf(room);
  const result = room.game.winners ? room.game.winners.type : 'aborted';

  const rows = aiSeats.map((seat) => {
    const key = countKey(room, seat);
    const decisions = decisionCounts.get(key) || 0;
    decisionCounts.delete(key);
    const pl = players[seat];
    return {
      seat,
      difficulty: difficultyOf(room, seat),
      win: winSeats.includes(seat),
      dealIn: discarder !== null && discarder === seat && !winSeats.includes(seat),
      net: Number(pl && pl.roundScore) || 0,
      decisions,
    };
  });

  // 同一局可能混有普通/困难人机：按座位难度分条写盘，
  // 离线统计（scripts/ai-calibrate.js）按 data.difficulty 聚合，混合房不能共用一条。
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.difficulty)) groups.set(r.difficulty, []);
    groups.get(r.difficulty).push(r);
  }
  let lastCalibration = null;
  for (const [difficulty, group] of groups) {
    logger().append(room, 'ai_round_result', {
      variant,
      difficulty,
      result,
      winSeats,
      discarder,
      rows: group,
    });
    // 自动校准只吃困难档样本，普通档固定策略仅展示统计
    if (difficulty === 'hard') {
      for (const r of group) {
        const out = calibration.noteRound({ ...r, variant, difficulty });
        if (out) lastCalibration = out;
      }
    }
  }
  const difficulties = [...groups.keys()];
  return {
    variant,
    difficulty: difficulties.length === 1 ? difficulties[0] : 'mixed',
    rows,
    calibration: lastCalibration,
  };
}

/** 异步冲刷（测试 / 脚本退出前） */
function flush() {
  return logger().flush();
}

module.exports = {
  AI_LOG_PREFIX,
  configure,
  recordDecision,
  finishRound,
  winnerSeatsOf,
  discarderOf,
  flush,
};
