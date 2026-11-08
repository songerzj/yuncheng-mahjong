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

module.exports = { VALUES, normalize, parse, difficultyOf, isHard };
