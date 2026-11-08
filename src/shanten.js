'use strict';

/**
 * 向听数 / 进张（ukeire）——「困难」AI 的牌效内核。
 *
 * 思路来源：《麻将概率助手电脑版》的 mahjong_probability 模块
 *   shanten() / improving_tiles()，按运城扣点点 136 张规则重新实现：
 *   - 牌型编码沿用 rules.getTileTypes()：w1-9 / t1-9 / b1-9 / 东南西北中发白，共 34 种；
 *   - 标准型：DFS 枚举 面子(melds) / 搭子(taatsu，含雀头对子)，
 *     shanten = 8 - 2*melds - taatsu（块数上限 5；块满且无雀头时 +1 缺将罚分）；
 *   - 门清时另取 七对 / 十三幺 两条支线的最小值；
 *   - 明牌区（碰/杠）计入已成型面子数，手牌长度按 (4-m)*3+2 等效。
 *
 * 返回值：-1 = 已和牌，0 = 听牌，1.. = 还需换掉几张牌才能听牌。
 * 纯函数、无状态依赖（仅内部 LRU 缓存加速），可独立单测。
 */

const rules = require('./rules');

const TILE_TYPES = rules.getTileTypes();
const INDEX = new Map(TILE_TYPES.map((t, i) => [t, i]));
const HONOR_START = 27;
const YAOJIU_INDEX = ['w1', 'w9', 't1', 't9', 'b1', 'b9']
  .map((t) => INDEX.get(t))
  .concat([27, 28, 29, 30, 31, 32, 33]);

const CACHE_LIMIT = 30000;
const cache = new Map();

function countsOf(hand) {
  const c = new Array(34).fill(0);
  for (const t of hand) {
    const i = INDEX.get(t);
    if (i !== undefined) c[i]++;
  }
  return c;
}

/** 标准型 DFS：返回最小向听数 */
function dfs(c, i, melds, taatsu, hasPair) {
  while (i < 34 && c[i] === 0) i++;
  if (i === 34) {
    let t = taatsu;
    if (melds + t > 5) t = 5 - melds;
    let sh = 8 - 2 * melds - t;
    if (!hasPair && melds + t === 5) sh += 1; // 五块齐备却没有雀头
    return sh;
  }

  let best = 8;
  const isNumber = i < HONOR_START;
  const n = i % 9; // 0-based 点数

  // 刻子
  if (melds < 4 && c[i] >= 3) {
    c[i] -= 3;
    best = Math.min(best, dfs(c, i, melds + 1, taatsu, hasPair));
    c[i] += 3;
  }
  // 顺子（字牌不可成顺）
  if (isNumber && melds < 4 && n <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    best = Math.min(best, dfs(c, i, melds + 1, taatsu, hasPair));
    c[i]++; c[i + 1]++; c[i + 2]++;
  }
  if (melds + taatsu < 5) {
    // 对子（可作雀头；多个对子时取 OR 不丢解）
    if (c[i] >= 2) {
      c[i] -= 2;
      best = Math.min(best, dfs(c, i, melds, taatsu + 1, true));
      c[i] += 2;
    }
    // 两面/边张搭子
    if (isNumber && n <= 7 && c[i + 1] > 0) {
      c[i]--; c[i + 1]--;
      best = Math.min(best, dfs(c, i, melds, taatsu + 1, hasPair));
      c[i]++; c[i + 1]++;
    }
    // 嵌张搭子
    if (isNumber && n <= 6 && c[i + 2] > 0) {
      c[i]--; c[i + 2]--;
      best = Math.min(best, dfs(c, i, melds, taatsu + 1, hasPair));
      c[i]++; c[i + 2]++;
    }
  }
  // 该张当浮牌，直接跳过一张
  c[i]--;
  best = Math.min(best, dfs(c, i, melds, taatsu, hasPair));
  c[i]++;
  return best;
}

/**
 * 向听数（支持 13 / 14 张及带明牌区的等效手牌）。
 * @param {string[]} hand 手牌
 * @param {object[]} [melds] 明牌区（碰/杠），每组算一个已成型面子
 */
function shanten(hand, melds) {
  if (!Array.isArray(hand)) return 8;
  const m0 = Array.isArray(melds) ? melds.filter((x) => x && typeof x === 'object' && x.tile).length : 0;
  const c = countsOf(hand);
  const key = m0 + '|' + c.join('');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let best = dfs(c.slice(), 0, m0, 0, false);

  // 门清专属牌型（有副露时七对/十三幺不成立）
  if (m0 === 0) {
    let pairs = 0;
    let kinds = 0;
    for (const v of c) {
      if (v > 0) kinds++;
      if (v >= 2) pairs++;
    }
    const chiitoi = 6 - pairs + Math.max(0, 7 - kinds);
    let yaoKinds = 0;
    let yaoPair = false;
    for (const i of YAOJIU_INDEX) {
      if (c[i] > 0) yaoKinds++;
      if (c[i] >= 2) yaoPair = true;
    }
    const kokushi = 13 - yaoKinds - (yaoPair ? 1 : 0);
    best = Math.min(best, chiitoi, kokushi);
  }

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, best);
  return best;
}

/**
 * 有效进张：13 张状态下摸到哪些牌能降低向听数（含直接和牌张）。
 * 与电脑版 improving_tiles 同义；剩余张数/点数权重由调用方计算。
 */
function improvingTiles(hand, melds) {
  const base = shanten(hand, melds);
  const out = [];
  for (const t of TILE_TYPES) {
    if (shanten(hand.concat(t), melds) < base) out.push(t);
  }
  return out;
}

/** 清空内部缓存（测试/内存控制用） */
function clearCache() {
  cache.clear();
}

module.exports = { shanten, improvingTiles, clearCache, TILE_TYPES };
