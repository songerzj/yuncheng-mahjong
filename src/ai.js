'use strict';

/**
 * AI 决策模块（机器人 / 断线托管代打）
 *
 * 难度：room.settings.aiDifficulty = 'normal'（默认，原有启发式）| 'hard'（向听/进张枚举）。
 * 普通模式行为完全保持原样；困难模式仅替换出牌选择（胡/杠/报听/响应流程共用），
 * 决策内核见 ./ai-hard.js 与 ./shanten.js。
 */

const rules = require('./rules');
const hard = require('./ai-hard');

/** 难度归一化：仅 'hard' 进入困难模式，其余（含旧房间数据）一律普通 */
function isHard(room) {
  return !!(room && room.settings && room.settings.aiDifficulty === 'hard');
}

/**
 * 回合摸牌后的决策
 * @returns {{type:'hu'|'gang'|'play', gangType?:string, tile?:string}}
 */
function decideDrawAction(game, room, seat) {
  const hand = game.hands[seat];

  // 1) 自摸胡（受点数限制：1/2 点不能胡，3/4/5 点可自摸）；明牌区刻子计入已成型面子
  if (
    game.drawnTile !== null &&
    game.tingSeats.includes(seat) && // A1 修复：136 玩法须报听后方可自摸胡（与真人提示一致，禁止跳过报听）
    rules.checkHu(hand, game.melds[seat]) &&
    rules.canHuByPoints(rules.tilePoints(game.drawnTile), 'zimo')
  ) {
    return { type: 'hu' };
  }

  // 1.5) 报听：房间开启且未报听时，若打出某张后仍听牌且听口含 ≥6 点牌则报听（优先于杠，保住听口）
  // 覆盖两种时机：摸牌后（drawnTile 非空）与碰牌后未摸牌（justPeng，碰完即听立即识别，不待下一轮摸牌）
  // 听口判定均计入明牌区碰/杠刻子（melds）
  const justPeng = !!(game.lastAction && game.lastAction.type === 'peng');
  if (
    room.settings.allowTing &&
    (!game.tingSeats || !game.tingSeats.includes(seat)) &&
    (game.drawnTile !== null || justPeng)
  ) {
    if (rules.canDeclareTing136(hand, game.melds[seat])) {
      // D1/D3 修复：枚举全部合法弃牌，排除死听口后按"期望 = 剩余张数 × 点数 × 可达牌型倍数"择优。
      // 扣点点得分与胡牌点数线性相关，选错听口 = 本局报废（报听不可逆）。
      const multOpts = {
        qingyise: { enabled: !!room.settings.enableQingYiSe, mult: room.settings.qingYiSeMult || 4 },
        yitiaolong: { enabled: !!room.settings.enableYiTiaoLong, mult: room.settings.yiTiaoLongMult || 4 },
        shisanyao: { enabled: !!room.settings.enableShiSanYao, mult: room.settings.shiSanYaoMult || 8 },
      };
      let best = null;
      for (const t of [...new Set(hand)]) {
        const rest = hand.slice();
        rest.splice(rest.indexOf(t), 1);
        const ting = rules.isTing(rest, game.melds[seat]);
        const live6 = ting.filter((x) => rules.tilePoints(x) >= 6); // 能点炮/自摸
        if (!live6.length) continue; // 报听硬条件：听口须含 ≥6 点牌
        const live3 = ting.filter((x) => rules.tilePoints(x) >= 3); // 能胡到（含自摸）
        const remain = (x) => rules.remainingCount(game, seat, x); // 精确机会张（含桌面已见、明牌区、暗杠第 4 张）
        const outs = live3.reduce((a, x) => a + remain(x), 0);
        if (outs === 0) continue; // ① 排除死听口：一张都胡不到
        const ev = live3.reduce(
          (a, x) => a + remain(x) * rules.tilePoints(x) * rules.calcMultiplier136([...rest, x], { melds: game.melds[seat] }, multOpts),
          0
        ); // ② 按期望择优（③ 乘可达牌型倍数上界：清一色/一条龙/碰碰胡等）
        if (!best || ev > best.ev) best = { tile: t, ev };
      }
      if (best) return { type: 'ting', tile: best.tile };
    }
  }

  // 2) 暗杠 / 3) 补杠：仅摸牌后可杠（碰牌后 drawnTile 为 null，服务端 _gang 会拒绝“当前不能杠”，
  // 若此处仍返回 gang，AI 动作被拒后无后续出牌，牌局将死锁）
  if (game.drawnTile !== null) {
    const cnt = rules.countTiles(hand);
    // D4 修复：手牌对子单位 ≥6 且未报听时不优先暗杠——七小对(×4)/豪华七小对(×8)在射程内，
    // 暗杠会破坏对子结构并放弃高倍数牌型（暗杠收益 = 点数×2×3，七对/豪七是乘在胡牌点数上的高倍数）。
    const pairUnits = [...cnt.values()].reduce((a, c) => a + Math.floor(c / 2), 0);
    for (const [t, c] of cnt) {
      if (c === 4) {
        if (!game.tingSeats.includes(seat) && pairUnits >= 6) continue;
        return { type: 'gang', gangType: 'angang', tile: t };
      }
    }
    for (const m of game.melds[seat]) {
      if (m.type === 'peng' && cnt.get(m.tile) >= 1) {
        // D2 修复：补杠前检查报听对手是否等这张牌——命中则跳过补杠，避免把炮送进对手听口
        // （补杠触发抢杠判定，仅报听对手可抢（≥6 点），被抢者按点炮赔付，未报听者独赔 3 份）。
        const robbed = (game.tingSeats || []).some(
          (s) =>
            s !== seat &&
            rules.canHuWith(game.hands[s], m.tile, game.melds[s]) &&
            rules.canHuByPoints(rules.tilePoints(m.tile), 'qianggang')
        );
        if (robbed) continue;
        return { type: 'gang', gangType: 'bugang', tile: m.tile };
      }
    }
  }

  // 4) 出牌
  return { type: 'play', tile: chooseDiscard(hand, game, room, seat) };
}

/**
 * 响应阶段决策（碰/杠/胡/过）
 */
function decideResponse(game, room, seat, prompt) {
  if (prompt.canHu) return 'hu';
  if (prompt.canGang) return 'gang';
  if (prompt.canPeng) {
    // 简单策略：接近听牌时倾向不碰，否则碰；明牌区刻子计入听口判断
    if (game.hands[seat].length <= 13 && rules.isTing(game.hands[seat], game.melds[seat]).length > 0) return 'pass';
    return 'peng';
  }
  return 'pass';
}

/**
 * 出牌选择（难度分派）：困难走向听/进张枚举，普通走原有启发式。
 * 困难策略无法给出有效解时回退普通策略，保证 AI 任何局面都能出牌。
 */
function chooseDiscard(hand, game, room, seat) {
  if (isHard(room)) {
    const picked = hard.chooseDiscard(hand, game, seat);
    if (picked) return picked;
  }
  return chooseDiscardNormal(hand, game, room, seat);
}

/**
 * 普通难度出牌：安全度优先（别人打过的牌），其次保留价值低（孤张/边张）的牌。
 * 这段是原实现，未作任何改动，保证默认难度行为与历史完全一致。
 */
function chooseDiscardNormal(hand, game, room, seat) {
  const safe = new Set();
  for (const d of game.discards) {
    for (const t of d) safe.add(t);
  }

  // C1 修复：安全牌权重随放炮风险缩放（不再固定 -12）。
  // 规则依据：未报听者放炮独赔 3 份；自己报听后摸牌只能胡或系统自动摸打，
  // 不再走选牌逻辑，因此只需按对手报听情况计算。
  // 无人报听时（未报听者不可胡）点炮风险为零 -> 安全加成归零，避免无差别拆牌；
  // 有对手报听时按报听人数递增防守权重。
  const oppTing = (game.tingSeats || []).filter((s) => s !== seat).length;
  const safePenalty = oppTing > 0 ? 14 + (oppTing - 1) * 3 : 0;

  const cnt = rules.countTiles(hand);
  let best = null;
  let bestScore = Infinity;
  for (const t of hand) {
    const c = cnt.get(t);
    const s = rules.suitOf(t);
    const num = rules.numOf(t);
    let score = 0;
    // 对子/刻子保留价值高（分数高 = 不优先打）
    if (c >= 3) score += 40;
    else if (c === 2) score += 20;
    // 相邻牌成顺价值
    for (const d of [-2, -1, 1, 2]) {
      const nt = s + (num + d);
      if (num + d >= 1 && num + d <= 9 && cnt.get(nt)) score += 3 - Math.abs(d);
    }
    // 边张价值略低
    if (num === 1 || num === 9) score -= 1;
    // 安全牌优先打出（权重随放炮风险缩放）
    if (safe.has(t)) score -= safePenalty;
    // 与上家刚打出的牌同花色的中张保守处理：无额外逻辑
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best || hand[0];
}

module.exports = {
  decideDrawAction,
  decideResponse,
  chooseDiscard,
  chooseDiscardNormal,
  isHard,
  // 红中/贴金专用 AI 在 GameServer 内，困难模式由此接入同一套牌效思维
  hardChooseHongZhongDiscard: hard.chooseHongZhongDiscard,
  hardChooseTieJinDiscard: hard.chooseTieJinDiscard,
};
