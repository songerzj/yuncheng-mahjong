'use strict';

/**
 * 「困难」AI 决策（引用《麻将概率助手电脑版》的牌效思维，按运城规则改造）。
 *
 * 与普通难度的差别（普通 = 固定权重启发式，见 ai.js chooseDiscardNormal）：
 *  1. 枚举全部候选弃牌，用向听数（shanten）而非「对子/相邻加分」衡量牌效；
 *  2. 对弃后 13 张枚举有效进张（ukeire），按 remainingCount 扣掉已见绝张；
 *  3. 进张按运城点数规则加权：1/2 点不能胡（权重 0）、3/4/5 点只能自摸（半权）、
 *     ≥6 点可点炮且得分更高（全权 × 点数收益），避免做出「废听口」；
 *  4. 排序遵循电脑版口诀：先比向听与可胡牌数，可胡牌数相差 ≤2 张时
 *     才让点炮风险介入（不为低风险明显牺牲胡牌机会）；
 *  5. 点炮风险用服务端全知信息精确计算（已报听对手的听口 + 点数限制），
 *     并保留「对手打过同牌 = 现物强安全」「单张字牌优先出」等弱线索。
 *
 * 红中 / 贴金没有通用向听（万能牌），采用同一思维的简化适配：
 * 枚举弃牌 → 该玩法专用听口数（加权剩余张数）→ 风险 → 剩余手牌连接度。
 * 无法给出更优解时返回 null，由调用方回退普通策略，保证 AI 永不卡死。
 */

const rules = require('./rules');
const shanten = require('./shanten');

const HONORS = new Set(rules.HONOR_TILES);

/**
 * 进张权重：把「能摸到」换算成「能胡到、且值多少分」。
 * 依据 rules.canHuByPoints：1/2 点不能胡，3/4/5 点只能自摸，6+ 点可点炮；
 * 扣点点得分 = 胡牌点数 × 牌型倍数，故再乘温和的点数收益因子。
 */
function winWeight(tile) {
  const pt = rules.tilePoints(tile);
  if (!rules.canHuByPoints(pt, 'zimo')) return 0;
  const base = rules.canHuByPoints(pt, 'dianpao') ? 1 : 0.5;
  return base * (1 + pt / 20);
}

/** 逐家点炮风险（扣点点）：精确听口优先，现物与字牌/幺九作弱线索 */
function discardRisk(game, seat, tile) {
  let risk = 0;
  const tingSeats = game.tingSeats || [];
  for (let s = 0; s < 4; s++) {
    if (s === seat) continue;
    const river = (game.discards || [])[s] || [];
    if (river.includes(tile)) {
      risk -= 6; // 该家已打过此牌：现物，强安全证据
      continue;
    }
    if (!tingSeats.includes(s)) continue; // 未报听者不可点炮胡
    const h = (game.hands || [])[s];
    if (!Array.isArray(h)) continue;
    const m = (game.melds || [])[s] || [];
    if (
      rules.canHuWith(h, tile, m) &&
      rules.canHuByPoints(rules.tilePoints(tile), 'dianpao')
    ) {
      risk += 100; // 已报听对手正等这张：精确危险
    }
  }
  if (HONORS.has(tile)) risk -= 1;
  else {
    const n = rules.numOf(tile);
    if (n === 1 || n === 9) risk -= 0.5; // 幺九连接度低，弱安全线索
  }
  return risk;
}

/** 评估每个候选弃牌：向听数 / 有效进张数 / 加权进张 / 点炮风险 */
function scoreDiscards(hand, game, seat) {
  const melds = (game.melds && game.melds[seat]) || [];
  const cnt = rules.countTiles(hand);
  const out = [];
  for (const d of [...new Set(hand)]) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(d), 1);
    let raw = 0;
    let weighted = 0;
    for (const t of shanten.improvingTiles(rest, melds)) {
      const remain = rules.remainingCount(game, seat, t);
      if (!remain) continue; // 桌面/手牌/副露已见满 4 张的绝张不计
      raw += remain;
      weighted += remain * winWeight(t);
    }
    out.push({
      tile: d,
      shanten: shanten.shanten(rest, melds),
      raw,
      weighted,
      risk: discardRisk(game, seat, d),
      honorSingle: HONORS.has(d) && cnt.get(d) === 1 ? 1 : 0,
    });
  }
  return out;
}

/**
 * 困难难度出牌（扣点点 136 张）。
 * @returns {string|null} 选中的弃牌；无法给出更优解时返回 null（调用方回退普通策略）
 */
function chooseDiscard(hand, game, seat) {
  if (!Array.isArray(hand) || hand.length < 2) return null;
  let scored;
  try {
    scored = scoreDiscards(hand, game, seat);
  } catch {
    return null;
  }
  if (!scored.length) return null;

  // 先按「向听数 → 加权进张」找牌效基准
  const byEfficiency = scored.slice().sort(
    (a, b) => a.shanten - b.shanten || b.weighted - a.weighted || b.raw - a.raw
  );
  const best = byEfficiency[0];
  if (best.weighted === 0) return null; // 全是无效（低点/绝张）进张，交给普通策略更稳

  // 电脑版核心：可胡牌数相差不超过 2 张时，才让点炮风险影响排序。
  // 精确点炮（已报听对手的听口）一票否决；其余情况仍以加权进张为主，
  // 现物/字牌等弱线索只作同进张时的平局裁决 —— 不为低风险错过明显更多的胡牌机会。
  const pool = scored.filter((c) => c.shanten === best.shanten && best.raw - c.raw <= 2);
  const deadly = (c) => (c.risk >= 100 ? 1 : 0);
  pool.sort(
    (a, b) =>
      deadly(a) - deadly(b) ||
      b.weighted - a.weighted ||
      a.risk - b.risk ||
      b.honorSingle - a.honorSingle ||
      b.raw - a.raw
  );
  return pool[0] ? pool[0].tile : best.tile;
}

// ============ 红中 / 贴金：万能牌玩法的简化适配 ============

/** 剩余手牌的连接度（搭子/对子/万能牌越多越好），用作同进张时的次级排序 */
function connectivity(hand, isWild) {
  const cnt = rules.countTiles(hand);
  let score = 0;
  for (const [t, c] of cnt) {
    if (isWild(t)) {
      score += c * 4;
      continue;
    }
    if (c >= 2) score += 2;
    if (HONORS.has(t)) continue;
    const s = rules.suitOf(t);
    const n = rules.numOf(t);
    if (n <= 8 && (cnt.get(s + (n + 1)) || 0)) score += 2;
    if (n <= 7 && (cnt.get(s + (n + 2)) || 0)) score += 1;
  }
  return score;
}

/** 万能牌玩法的风险：现物强安全；贴金额外检查已亮金对手的精确听口 */
function variantRisk(game, seat, tile, exactHuWith) {
  let risk = 0;
  for (let s = 0; s < 4; s++) {
    if (s === seat) continue;
    const river = (game.discards || [])[s] || [];
    if (river.includes(tile)) {
      risk -= 6;
      continue;
    }
    if (!exactHuWith) continue; // 红中不能点炮，无点炮风险
    const h = (game.hands || [])[s];
    if (!Array.isArray(h)) continue;
    const lit = ((game.shangjinCount || [])[s] || 0) > 0;
    if (lit && exactHuWith(h, tile, (game.melds || [])[s] || [], game.goldTile)) risk += 100;
  }
  if (HONORS.has(tile)) risk -= 1;
  return risk;
}

/**
 * 万能牌玩法的听口枚举带「早停 + 总预算」：
 * 含万能牌的胡牌判定要跑拆牌递归，比扣点点向听 DFS 贵得多；
 * 无预算时 14 候选 × 28 种 ≈ 120ms，会阻塞服务端事件循环。
 * 找到足够多的听口即停，总判定次数超预算则停止评估剩余候选；
 * 全部候选无听口时返回 null，由普通策略接管（此时牌效计算本就无意义）。
 */
const MAX_TING_TILES = 8;
const MAX_VARIANT_CHECKS = 96;

/** 通用：按「听口加权张数 → 精确风险 → 连接度」挑弃牌；无听口返回 null 回退普通策略 */
function pickVariantDiscard(game, seat, opts) {
  const { hand, isWild, tingTypes, canHu, exactHuWith } = opts;
  const cnt = rules.countTiles(hand);
  const allowed = [...new Set(hand)]
    .filter((t) => !isWild(t))
    .sort(
      (a, b) =>
        (cnt.get(a) === 1 ? 0 : 1) - (cnt.get(b) === 1 ? 0 : 1) ||
        rules.discardRank(a) - rules.discardRank(b)
    );
  if (!allowed.length) return null;

  let budget = MAX_VARIANT_CHECKS;
  const scored = [];
  for (const d of allowed) {
    if (budget <= 0) break;
    const rest = hand.slice();
    rest.splice(rest.indexOf(d), 1);
    const limit = Math.min(MAX_TING_TILES, budget);
    const ting = [];
    for (const t of tingTypes) {
      budget--;
      if (canHu(rest, t)) {
        ting.push(t);
        if (ting.length >= limit) break;
      }
      if (budget <= 0) break;
    }
    let raw = 0;
    let weighted = 0;
    for (const t of ting) {
      const remain = rules.remainingCount(game, seat, t);
      if (!remain) continue;
      raw += remain;
      weighted += remain * (isWild(t) ? 1.5 : 1 + rules.tilePoints(t) / 20);
    }
    scored.push({
      tile: d,
      raw,
      weighted,
      conn: connectivity(rest, isWild),
      risk: variantRisk(game, seat, d, exactHuWith),
    });
  }
  if (!scored.length) return null;
  const bestRaw = Math.max(...scored.map((x) => x.raw));
  if (bestRaw === 0) return null;
  const pool = scored.filter((x) => bestRaw - x.raw <= 2);
  const deadly = (x) => (x.risk >= 100 ? 1 : 0);
  pool.sort(
    (a, b) => deadly(a) - deadly(b) || b.weighted - a.weighted || a.risk - b.risk || b.conn - a.conn
  );
  return pool[0] ? pool[0].tile : null;
}

function chooseHongZhongDiscard(game, seat) {
  const hand = (game.hands || [])[seat];
  if (!Array.isArray(hand)) return null;
  const melds = (game.melds || [])[seat] || [];
  return pickVariantDiscard(game, seat, {
    hand,
    isWild: (t) => t === rules.HONG_ZHONG,
    tingTypes: rules.getHongZhongTileTypes(),
    canHu: (rest, t) => rules.canHuHongZhongWith(rest, t, melds),
    exactHuWith: null, // 红中只能自摸/抢杠，不存在点炮风险
  });
}

function chooseTieJinDiscard(game, seat) {
  const hand = (game.hands || [])[seat];
  if (!Array.isArray(hand)) return null;
  const melds = (game.melds || [])[seat] || [];
  const gold = game.goldTile;
  return pickVariantDiscard(game, seat, {
    hand,
    isWild: (t) => rules.isGold(t, gold),
    tingTypes: rules.getTileTypes(),
    // 金牌摸到需亮金，不视作普通进张
    canHu: (rest, t) => !rules.isGold(t, gold) && rules.canHuTieJinWith(rest, t, melds, gold),
    exactHuWith: rules.canHuTieJinWith,
  });
}

module.exports = {
  chooseDiscard,
  chooseHongZhongDiscard,
  chooseTieJinDiscard,
  scoreDiscards,
  discardRisk,
  winWeight,
  connectivity,
};
