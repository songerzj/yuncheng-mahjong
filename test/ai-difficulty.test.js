'use strict';

// ============ AI 难度（普通 / 困难）单测 ============
// 困难 = 引用《麻将概率助手电脑版》的牌效思维：向听数 + 有效进张 + 逐家点炮风险，
//        按运城扣点点点数规则（1/2 点不能胡、3/4/5 点只能自摸）加权。
// 普通 = 原有固定权重启发式，行为必须完全不变。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const rules = require('../src/rules');
const shanten = require('../src/shanten');
const hard = require('../src/ai-hard');
const ai = require('../src/ai');
const { GameServer } = require('../src/game');
const { newServer, makeWs, send, lastOf, cleanupServer } = require('../lib/testutils');

const ROOT = path.join(__dirname, '..');
const NORMAL = { settings: { allowTing: false } };
const HARD = { settings: { allowTing: false, aiDifficulty: 'hard' } };

function makeGame(overrides = {}) {
  return Object.assign(
    {
      drawnTile: null,
      lastAction: null,
      tingSeats: [],
      hands: [[]],
      melds: [[]],
      discards: [[], [], [], []],
      goldTile: null,
      shangjinCount: [0, 0, 0, 0],
    },
    overrides
  );
}

const FOUR_MELDS = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 't3'];

// ============ 1. 向听内核 ============

test('向听数：和牌 -1、听牌 0，且与 rules.isTing 完全一致（随机 80 手）', () => {
  const win = FOUR_MELDS.concat(['b1', 'b1']);
  assert.equal(rules.checkHu(win), true);
  assert.equal(shanten.shanten(win, []), -1);

  const ten = FOUR_MELDS.concat(['b1']);
  assert.deepEqual(rules.isTing(ten, []), ['b1']);
  assert.equal(shanten.shanten(ten, []), 0);
  assert.deepEqual(shanten.improvingTiles(ten, []), ['b1']);

  const tiles = rules.createTiles();
  for (let k = 0; k < 80; k++) {
    const pool = tiles.slice();
    const h = [];
    for (let i = 0; i < 13; i++) {
      const j = Math.floor(Math.random() * pool.length);
      h.push(pool.splice(j, 1)[0]);
    }
    const s = shanten.shanten(h, []);
    assert.equal(s === 0, rules.isTing(h, []).length > 0, `第 ${k} 手向听/听口不一致：${h.join(' ')}`);
  }
});

test('向听数：七对与十三幺两条支线生效', () => {
  const sixPairs = ['w1', 'w1', 'w2', 'w2', 't3', 't3', 't5', 't5', 'b7', 'b7', 'e', 'e', 'z'];
  assert.equal(shanten.shanten(sixPairs, []), 0, '六对 + 单张 = 听牌（七对支线）');
  const kokushi = ['w1', 'w9', 't1', 't9', 'b1', 'b9', 'e', 's', 'x', 'n', 'z', 'f', 'p'];
  assert.equal(shanten.shanten(kokushi, []), 0, '十三幺 13 种齐 = 听牌');
  assert.equal(shanten.improvingTiles(kokushi, []).length, 13);
});

test('进张权重按运城点数规则：1/2 点无效、3/4/5 点半权、6+ 点全权且随点数递增', () => {
  assert.equal(hard.winWeight('w1'), 0);
  assert.equal(hard.winWeight('w2'), 0);
  assert.equal(hard.winWeight('w4'), 0.5 * 1.2);
  assert.ok(hard.winWeight('w9') > hard.winWeight('w6'));
  assert.equal(hard.winWeight('e'), 1.5, '字牌 10 点可点炮，收益最高');
});

// ============ 2. 困难策略 vs 普通策略 ============

test('困难按点数加权选牌：普通打 b9，困难打 b5（保留 9 点听口）', () => {
  const hand = FOUR_MELDS.concat(['b5', 'b9']);
  const g = makeGame({ hands: [hand] });
  assert.equal(ai.chooseDiscard(hand, g, NORMAL, 0), 'b9', '普通难度保持原有行为');
  assert.equal(ai.chooseDiscard(hand, g, HARD, 0), 'b5', '困难难度保留高点数听口');

  const scores = hard.scoreDiscards(hand, g, 0);
  const b5 = scores.find((x) => x.tile === 'b5');
  const b9 = scores.find((x) => x.tile === 'b9');
  assert.equal(b5.shanten, 0);
  assert.equal(b9.shanten, 0);
  assert.ok(b5.weighted > b9.weighted, '弃 b5 后听 9 点，加权进张应更高');
});

test('困难精确防守：对手报听听 b8 时改打 b9；无人报听时按牌效打 b8', () => {
  const hand = FOUR_MELDS.concat(['b8', 'b9']);
  // 对手 13 张：四副面子 + b8 单张 → 听 b8（8 点可点炮）
  const opp = FOUR_MELDS.concat(['b8']);
  const noTing = makeGame({ hands: [hand, opp], tingSeats: [] });
  const withTing = makeGame({ hands: [hand, opp], tingSeats: [1] });

  assert.equal(ai.chooseDiscard(hand, noTing, HARD, 0), 'b8', '无点炮风险时按加权进张选牌');
  assert.equal(ai.chooseDiscard(hand, withTing, HARD, 0), 'b9', '已报听对手等 b8，必须规避');
  assert.ok(hard.discardRisk(withTing, 0, 'b8') >= 100);
  assert.ok(hard.discardRisk(withTing, 0, 'b9') < 100);
});

test('现物（对手已打过同牌）是强安全线索，但不压过明显更多的胡牌机会', () => {
  const hand = FOUR_MELDS.concat(['b5', 'b9']);
  const g = makeGame({ hands: [hand], discards: [[], ['b9'], [], []] });
  assert.ok(hard.discardRisk(g, 0, 'b9') < hard.discardRisk(g, 0, 'b5'));
  assert.equal(ai.chooseDiscard(hand, g, HARD, 0), 'b5', '弱安全线索不应翻转牌效排序');
});

test('普通难度行为完全不变；困难难度在任意手牌都能给出合法弃牌（不卡死）', () => {
  assert.equal(ai.isHard(NORMAL), false);
  assert.equal(ai.isHard(HARD), true);
  assert.equal(ai.isHard({ settings: {} }), false);
  assert.equal(ai.isHard(null), false);

  const tiles = rules.createTiles();
  for (let k = 0; k < 30; k++) {
    const pool = tiles.slice();
    const h = [];
    for (let i = 0; i < 14; i++) {
      const j = Math.floor(Math.random() * pool.length);
      h.push(pool.splice(j, 1)[0]);
    }
    const g = makeGame({ hands: [h] });
    assert.equal(ai.chooseDiscard(h, g, NORMAL, 0), ai.chooseDiscardNormal(h, g, NORMAL, 0));
    const picked = ai.chooseDiscard(h, g, HARD, 0);
    assert.ok(h.includes(picked), `困难难度返回了不在手牌中的牌：${picked}`);
  }
});

test('困难策略无有效解时回退普通策略', () => {
  assert.equal(hard.chooseDiscard([], makeGame(), 0), null);
  assert.equal(hard.chooseDiscard(['w1'], makeGame(), 0), null);
  const hand = FOUR_MELDS.concat(['w1', 'w2']); // 低点牌，进张加权可能为 0
  const g = makeGame({ hands: [hand] });
  assert.ok(hand.includes(ai.chooseDiscard(hand, g, HARD, 0)));
});

// ============ 3. 红中 / 贴金也能吃到困难难度 ============

test('红中困难：枚举听口选牌，绝不打出万能牌红中', () => {
  const hand = FOUR_MELDS.concat(['b5', rules.HONG_ZHONG]);
  const g = makeGame({ hands: [hand] });
  assert.ok(hard.chooseHongZhongDiscard(g, 0), '有听口时应给出困难解');
  const srv = Object.create(GameServer.prototype);
  const picked = srv._chooseHongZhongDiscard(g, HARD, 0);
  assert.notEqual(picked, rules.HONG_ZHONG);
  assert.ok(hand.includes(picked));
  const normalPicked = srv._chooseHongZhongDiscard(g, NORMAL, 0);
  assert.ok(hand.includes(normalPicked));
});

test('贴金困难：金牌保留，听口按专用胡牌判定枚举', () => {
  const gold = 'b3';
  const hand = FOUR_MELDS.concat(['b5', gold]);
  const g = makeGame({ hands: [hand], goldTile: gold });
  assert.ok(hard.chooseTieJinDiscard(g, 0), '有听口时应给出困难解');
  const srv = Object.create(GameServer.prototype);
  const picked = srv._chooseTieJinDiscard(g, HARD, 0);
  assert.notEqual(picked, gold);
  assert.ok(hand.includes(picked));
});

// ============ 4. 房间设置：校验 / 归一化 / 下发 ============

test('_validateSettings 三种玩法均归一化 aiDifficulty，非法值回落普通', () => {
  const validate = (s) => GameServer.prototype._validateSettings.call({}, s);
  for (const variant of ['koudian', 'hongzhong', 'tiejin']) {
    assert.equal(validate({ totalRounds: 4, variant, aiDifficulty: 'hard' }).aiDifficulty, 'hard');
    assert.equal(validate({ totalRounds: 4, variant }).aiDifficulty, 'normal', '旧客户端缺省 = 普通');
    assert.equal(validate({ totalRounds: 4, variant, aiDifficulty: 'impossible' }).aiDifficulty, 'normal');
  }
});

test('端到端：建房透传困难难度，房间列表与房间状态都带上 aiDifficulty', () => {
  const srv = newServer();
  try {
    const wa = makeWs();
    srv.handleConnection(wa);
    send(wa, { type: 'join_lobby', name: '房主' });
    send(wa, { type: 'create_room', settings: { totalRounds: 4, aiFill: true, aiDifficulty: 'hard' } });
    const room = [...srv.rooms.values()][0];
    assert.equal(room.settings.aiDifficulty, 'hard');

    const wb = makeWs();
    srv.handleConnection(wb);
    send(wb, { type: 'join_lobby', name: '路人' });
    const lobby = lastOf(wb, 'lobby_state');
    assert.equal(lobby.rooms[0].settings.aiDifficulty, 'hard');
    const roomState = lastOf(wa, 'room_state');
    assert.equal(roomState.room.settings.aiDifficulty, 'hard');
  } finally {
    cleanupServer(srv);
  }
});

// ============ 5. 前端：难度选择器 ============

function createFrontendEnv() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:3100/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  window.speechSynthesis = { getVoices: () => [], speak() {}, cancel() {}, addEventListener() {}, removeEventListener() {} };
  window.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  window.Audio = class { constructor(src) { this.src = src; } play() { return Promise.resolve(); } };
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; window.__lastWs = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
  };
  window.eval(appJs);
  return dom;
}

test('前端建房弹窗：默认普通，切到困难后 create_room 透传 aiDifficulty', () => {
  const dom = createFrontendEnv();
  try {
    const doc = dom.window.document;
    const seg = doc.querySelector('#seg-ai-difficulty');
    assert.ok(seg, '建房弹窗应有 AI 难度选择器');
    const btns = [...seg.querySelectorAll('.seg-item')];
    assert.deepEqual(btns.map((b) => b.dataset.value), ['normal', 'hard']);
    assert.ok(btns[0].classList.contains('active'), '默认选中普通');

    doc.querySelector('#create-confirm').click();
    const first = dom.window.__lastWs.sent.find((m) => m.type === 'create_room');
    assert.equal(first.settings.aiDifficulty, 'normal');

    btns[1].click();
    assert.ok(btns[1].classList.contains('active'));
    doc.querySelector('#create-confirm').click();
    const msgs = dom.window.__lastWs.sent.filter((m) => m.type === 'create_room');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].settings.aiDifficulty, 'hard');
  } finally {
    dom.window.close();
  }
});
