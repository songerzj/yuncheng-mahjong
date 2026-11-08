'use strict';

/**
 * AI 胜率自动校准（引用《麻将概率助手电脑版》training_journal 的「决策 → 结果 → 复盘」思路）
 *
 * 闭环：
 *   困难 AI 决策快照（ai-journal） → 本局结果（胜 / 放铳 / 净得分）
 *     → 滚动窗口聚合 → 与目标的偏差 → 在安全边界内小步调整策略参数
 *     → 原子写入 data/ai-calibration.json → ai-hard.js 每次决策读取最新参数。
 *
 * 设计约束（防止「自动学习」把 AI 带坏）：
 *  1. 样本门槛：累计够 minRounds 条「AI 座位·局」记录才校准一次，之后清空窗口重新累积；
 *  2. 小步调整：每个参数单次变化不超过 STEP，且始终夹在 BOUNDS 内；
 *  3. 可解释：每次校准记录 reason / 样本 / 前后参数，人工可复核可回滚；
 *  4. 默认安全：文件缺失、字段非法、JSON 损坏一律回退 DEFAULTS；
 *     NODE_ENV=test 时默认关闭自动写入，脚本可用 MARVIS_AI_CALIBRATION=0 关闭。
 *
 * 参数含义（与 ai-hard.js 一一对应）：
 *  - defenseSlack   进张数相差 ≤ N 张时才让点炮风险介入（越大越保守）
 *  - riskWeight     现物 / 字牌等弱风险线索的权重（越大越保守）
 *  - winWeightBoost 高点数进张的收益系数（越大越进攻）
 *  - pengAggression 碰牌所需的牌效收益倍率（越小越愿意碰）
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  defenseSlack: 2,
  riskWeight: 1,
  winWeightBoost: 1,
  pengAggression: 1,
});

const BOUNDS = Object.freeze({
  defenseSlack: [0, 5],
  riskWeight: [0.5, 2],
  winWeightBoost: [0.8, 1.3],
  pengAggression: [0.8, 1.2],
});

const STEP = Object.freeze({
  defenseSlack: 0.5,
  riskWeight: 0.1,
  winWeightBoost: 0.05,
  pengAggression: 0.05,
});

// 4 人局随机基准胜率 25%；困难档目标「略强于基准、放铳率不超标」
const TARGETS = Object.freeze({ winRate: 0.3, dealInRate: 0.18 });
const DEFAULT_MIN_ROUNDS = 40;
const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'ai-calibration.json');
const KEYS = Object.keys(DEFAULTS);

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function envInt(v, fallback, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? clamp(Math.floor(n), lo, hi) : fallback;
}

function resolveConfig(env = process.env, overrides = {}) {
  const explicitOn = env.MARVIS_AI_CALIBRATION === '1';
  return {
    enabled:
      overrides.enabled !== undefined
        ? !!overrides.enabled
        : env.MARVIS_AI_CALIBRATION === '0'
          ? false
          : env.NODE_ENV === 'test'
            ? explicitOn
            : true,
    file: overrides.file || env.MARVIS_AI_CALIBRATION_FILE || DEFAULT_FILE,
    minRounds:
      overrides.minRounds !== undefined
        ? Math.max(1, Math.floor(overrides.minRounds))
        : envInt(env.MARVIS_AI_CALIBRATION_MIN_ROUNDS, DEFAULT_MIN_ROUNDS, 1, 10000),
  };
}

/** 只接受已知字段 + 有限数值 + 边界内；任何异常都用默认值兜底 */
function sanitize(input) {
  const out = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return out;
  for (const k of KEYS) {
    const v = input[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = round3(clamp(v, BOUNDS[k][0], BOUNDS[k][1]));
    }
  }
  return out;
}

let config = resolveConfig();
let current = { ...DEFAULTS };
let window = [];

/** 从磁盘加载校准参数；文件不存在/损坏时返回默认值 */
function load(file = config.file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    current = sanitize(obj && obj.params);
  } catch {
    current = { ...DEFAULTS };
  }
  return getParams();
}

/** 当前生效参数（返回副本，调用方只读） */
function getParams() {
  return { ...current };
}

/** 直接设置参数（测试 / 手工回滚用，不写盘） */
function setParams(p) {
  current = sanitize(p);
  return getParams();
}

function configure(opts = {}) {
  config = resolveConfig(process.env, opts);
  if (opts.resetWindow !== false) window = [];
  if (opts.params) setParams(opts.params);
  return { ...config };
}

/** 聚合一批「AI 参与的一局」记录 */
function summarize(records) {
  const out = {
    rounds: 0,
    wins: 0,
    dealIns: 0,
    netTotal: 0,
    netAvg: 0,
    winRate: 0,
    dealInRate: 0,
    decisions: 0,
  };
  for (const r of records || []) {
    if (!r) continue;
    out.rounds += 1;
    if (r.win) out.wins += 1;
    if (r.dealIn) out.dealIns += 1;
    out.netTotal += Number.isFinite(Number(r.net)) ? Number(r.net) : 0;
    const d = Number(r.decisions);
    if (Number.isFinite(d) && d > 0) out.decisions += d;
  }
  out.netAvg = out.rounds ? round3(out.netTotal / out.rounds) : 0;
  out.winRate = out.rounds ? round3(out.wins / out.rounds) : 0;
  out.dealInRate = out.rounds ? round3(out.dealIns / out.rounds) : 0;
  return out;
}

/**
 * 由实测胜率 / 放铳率 / 净得分推导下一组参数。
 * 纯函数：不写盘、不修改模块状态，便于单测与 CLI 的 --dry-run。
 */
function calibrate(stats, from = current, opts = {}) {
  const base = sanitize(from);
  const minRounds = opts.minRounds !== undefined ? opts.minRounds : config.minRounds;
  const s = summarizeFromStats(stats);
  if (!s || s.rounds < minRounds) {
    return {
      params: base,
      changed: false,
      reason: `样本不足（${s ? s.rounds : 0}/${minRounds} 局），保持当前参数`,
      stats: s,
    };
  }

  const p = { ...base };
  const reasons = [];
  const tooRisky = s.dealInRate > TARGETS.dealInRate + 0.02;
  const weakWin = s.winRate < TARGETS.winRate - 0.03 || (s.netAvg < 0 && s.winRate < TARGETS.winRate);
  const strongWin = s.winRate > TARGETS.winRate + 0.06 && s.dealInRate <= TARGETS.dealInRate;

  if (tooRisky) {
    // 放铳过多：扩大防守介入范围、加重弱风险线索
    p.defenseSlack += STEP.defenseSlack;
    p.riskWeight += STEP.riskWeight;
    reasons.push(`放铳率 ${s.dealInRate} 超目标 ${TARGETS.dealInRate}，转为防守`);
  } else if (weakWin) {
    // 胜率偏低且不是因为送炮：提高进攻性，少为弱风险牺牲进张
    p.defenseSlack -= STEP.defenseSlack;
    p.winWeightBoost += STEP.winWeightBoost;
    p.pengAggression -= STEP.pengAggression;
    reasons.push(`胜率 ${s.winRate} 低于目标 ${TARGETS.winRate} 且防守未失控，转为进攻`);
  } else if (strongWin) {
    // 明显优于目标：向默认参数收敛，避免长期漂移过拟合
    for (const k of KEYS) p[k] += (DEFAULTS[k] - p[k]) * 0.25;
    reasons.push(`胜率 ${s.winRate} 明显高于目标，参数向默认值收敛`);
  } else {
    reasons.push('胜率与放铳率均在目标区间，保持当前参数');
  }

  for (const k of KEYS) p[k] = round3(clamp(p[k], BOUNDS[k][0], BOUNDS[k][1]));
  const changed = KEYS.some((k) => p[k] !== base[k]);
  return { params: p, changed, reason: reasons.join('；'), stats: s };
}

/** calibrate 既接受记录数组，也接受已聚合的 stats 对象 */
function summarizeFromStats(stats) {
  if (!stats) return null;
  if (Array.isArray(stats)) return summarize(stats);
  if (typeof stats.rounds === 'number') {
    return {
      rounds: stats.rounds,
      wins: stats.wins || 0,
      dealIns: stats.dealIns || 0,
      netTotal: stats.netTotal || 0,
      netAvg: stats.netAvg || 0,
      winRate: stats.winRate || 0,
      dealInRate: stats.dealInRate || 0,
      decisions: stats.decisions || 0,
    };
  }
  return null;
}

/** 原子写入校准文件（tmp + rename），避免进程中断留下半截 JSON */
function persist(result, file = config.file) {
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    targets: { ...TARGETS },
    sample: result.stats
      ? {
          rounds: result.stats.rounds,
          winRate: result.stats.winRate,
          dealInRate: result.stats.dealInRate,
          netAvg: result.stats.netAvg,
        }
      : null,
    reason: result.reason,
    previous: result.previous || null,
    params: result.params,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

/**
 * 在线校准：每记录一局困难 AI 的结果就累积，达到样本门槛时校准并写盘。
 * @returns {object|null} 发生校准时返回结果，否则 null
 */
function noteRound(record, opts = {}) {
  if (!config.enabled || !record || record.difficulty !== 'hard') return null;
  window.push(record);
  if (window.length < config.minRounds) return null;

  const stats = summarize(window);
  window = []; // 清空窗口：下一轮基于新参数重新采样，避免同一批数据反复调参
  const previous = getParams();
  const result = calibrate(stats, previous, { minRounds: config.minRounds });
  result.previous = previous;
  result.stats = stats;
  if (result.changed) {
    current = { ...result.params };
    if (opts.persist !== false && config.enabled) {
      try {
        persist(result);
      } catch (e) {
        result.persistError = e && e.message;
      }
    }
  }
  return result;
}

/** 测试 / 诊断：当前窗口大小 */
function windowSize() {
  return window.length;
}

// 启动时尝试加载一次已有校准结果（文件不存在时静默使用默认值）
load();

module.exports = {
  DEFAULTS,
  BOUNDS,
  STEP,
  TARGETS,
  KEYS,
  DEFAULT_MIN_ROUNDS,
  DEFAULT_FILE,
  sanitize,
  summarize,
  calibrate,
  getParams,
  setParams,
  load,
  persist,
  configure,
  noteRound,
  windowSize,
};
