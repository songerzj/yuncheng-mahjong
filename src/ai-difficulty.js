'use strict';

/**
 * AI 难度的逐座位解析（唯一真源）
 *
 * 房间级 `settings.aiDifficulty` 是「默认难度」：用于开局自动补位的机器人、
 * 真人断线/托管的代打、以及旧客户端与旧房间数据。
 * 座位级 `room.players[seat].aiDifficulty` 是房主在房间内手动指定的覆盖值，
 * 允许同一局里同时存在普通与困难人机。
 *
 * ai.js 与 ai-journal.js 共用本模块，避免循环依赖（ai.js 依赖 ai-journal）。
 */

const VALUES = ['normal', 'hard'];

/** 归一化：仅 'hard' 进入困难模式，其余（含非法值、undefined）一律普通 */
function normalize(value) {
  return value === 'hard' ? 'hard' : 'normal';
}

/** 严格校验：用于客户端主动下发参数，非法值返回 null 以便报错 */
function parse(value) {
  return VALUES.includes(value) ? value : null;
}

/**
 * 读取某座位的实际 AI 难度。
 * @param {object} room
 * @param {number} seat
 * @returns {'normal'|'hard'}
 */
function difficultyOf(room, seat) {
  const pl = room && Array.isArray(room.players) && Number.isInteger(seat) ? room.players[seat] : null;
  if (pl && VALUES.includes(pl.aiDifficulty)) return pl.aiDifficulty;
  return normalize(room && room.settings && room.settings.aiDifficulty);
}

/** 该座位是否走困难策略 */
function isHard(room, seat) {
  return difficultyOf(room, seat) === 'hard';
}

/** 难度中文标签：UI 徽标与机器人姓名共用，避免两处文案漂移 */
function label(difficulty) {
  return normalize(difficulty) === 'hard' ? '困难' : '普通';
}

// 生成新名字时剥掉可能已存在的旧难度前缀，保证反复切换不会叠成「普通·困难·机器人1」
const AI_NAME_PREFIX_RE = /^(?:(?:普通|困难)·)+/;

/**
 * 机器人显示名：难度始终放在姓名最前面，如「困难·机器人1」。
 * @param {string} baseName 基础姓名（新建时传 `机器人${seq}`），也可直接传旧显示名
 * @param {'normal'|'hard'} difficulty
 */
function aiName(baseName, difficulty) {
  const base = String(baseName || '机器人').replace(AI_NAME_PREFIX_RE, '');
  return `${label(difficulty)}·${base || '机器人'}`;
}

module.exports = { VALUES, normalize, parse, difficultyOf, isHard, label, aiName };
