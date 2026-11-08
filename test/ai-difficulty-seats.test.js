'use strict';

// ============ 逐座位 AI 难度（同一局混搭普通 / 困难人机）============
// 覆盖：难度解析唯一真源、ai.js 按座位分派、服务端 add_ai / set_ai_difficulty、
//       复盘日志按难度分组、前端座位按钮委托、真实混合房间对局。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const aiDiff = require('../src/ai-difficulty');
const ai = require('../src/ai');
const aiJournal = require('../src/ai-journal');
const calibration = require('../src/ai-calibration');
const { GameServer } = require('../src/game');
const { newServer, makeWs, send, lastOf, cleanupServer, seededRng } = require('../lib/testutils');

const FOUR_MELDS = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 't3'];

function mkGame(hand, overrides = {}) {
  return Object.assign(
    {
      drawnTile: null,
      lastAction: null,
      tingSeats: [],
      hands: [hand],
      melds: [[]],
      discards: [[], [], [], []],
      goldTile: null,
      shangjinCount: [0, 0, 0, 0],
      pending: null,
    },
    overrides
  );
}

function mkRoom(overrides = {}) {
  return Object.assign(
    {
      id: 'MIX-1',
      roundNo: 1,
      settings: { variant: 'koudian', aiDifficulty: 'normal' },
      players: [
        { seat: 0, isAI: true, aiDifficulty: 'hard', roundScore: 12 },
        { seat: 1, isAI: true, aiDifficulty: 'normal', roundScore: -4 },
        { seat: 2, isAI: false, roundScore: -8 },
        { seat: 3, isAI: false, roundScore: 0 },
      ],
      game: { winners: { type: 'hu', winnerSeat: 0, discarder: 1, winType: 'dianpao' }, hzWinners: [] },
    },
    overrides
  );
}

// ==================== 1. 难度解析唯一真源 ====================

test('ai-difficulty：normalize / parse / 座位覆盖 / 房间默认回落', () => {
  assert.equal(aiDiff.normalize('hard'), 'hard');
  assert.equal(aiDiff.normalize('impossible'), 'normal');
  assert.equal(aiDiff.normalize(undefined), 'normal');
  assert.equal(aiDiff.parse('hard'), 'hard');
  assert.equal(aiDiff.parse('impossible'), null);

  const room = {
    settings: { aiDifficulty: 'normal' },
    players: [
      { aiDifficulty: 'hard' },
      { aiDifficulty: 'normal' },
      {},
      { aiDifficulty: 'bogus' },
    ],
  };
  assert.equal(aiDiff.difficultyOf(room, 0), 'hard');
  assert.equal(aiDiff.difficultyOf(room, 1), 'normal');
  assert.equal(aiDiff.difficultyOf(room, 2), 'normal', '未指定 -> 房间默认');
  assert.equal(aiDiff.difficultyOf(room, 3), 'normal', '非法座位值 -> 房间默认');
  assert.equal(aiDiff.difficultyOf(room, 9), 'normal', '越界座位 -> 房间默认');
  assert.deepEqual(
    [0, 1, 2, 3].map((s) => ai.isHard(room, s)),
    [true, false, false, false],
    'ai.isHard 与新模块一致'
  );

  const hardRoom = { settings: { aiDifficulty: 'hard' }, players: [{ aiDifficulty: 'normal' }] };
  assert.equal(aiDiff.difficultyOf(hardRoom, 0), 'normal', '座位显式设置可覆盖困难默认值');
  assert.equal(aiDiff.difficultyOf(hardRoom, 1), 'hard');
  assert.equal(aiDiff.difficultyOf(null, 0), 'normal');
});

test('ai-difficulty：机器人姓名前缀带难度，反复切换不叠加', () => {
  assert.equal(aiDiff.label('hard'), '困难');
  assert.equal(aiDiff.label('normal'), '普通');
  assert.equal(aiDiff.label('bogus'), '普通');
  assert.equal(aiDiff.aiName('机器人1', 'hard'), '困难·机器人1');
  assert.equal(aiDiff.aiName('机器人2', 'normal'), '普通·机器人2');
  assert.equal(aiDiff.aiName('困难·机器人1', 'normal'), '普通·机器人1', '切换难度时剥掉旧前缀');
  assert.equal(aiDiff.aiName('普通·困难·机器人1', 'hard'), '困难·机器人1', '历史脏数据也不叠加前缀');
  assert.equal(aiDiff.aiName('', 'hard'), '困难·机器人');
});

test('同一房间内 ai.chooseDiscard 按座位走不同策略', () => {
  const hand = FOUR_MELDS.concat(['b5', 'b9']);
  const g = mkGame(hand);
  const room = mkRoom({ players: [
    { seat: 0, isAI: true, aiDifficulty: 'normal' },
    { seat: 1, isAI: true, aiDifficulty: 'hard' },
    { seat: 2, isAI: false },
    { seat: 3, isAI: false },
  ], game: null });

  const seen = [];
  const orig = aiJournal.recordDecision;
  aiJournal.recordDecision = (r, seat, trace) => { seen.push({ seat, phase: trace && trace.phase }); return false; };
  try {
    ai.chooseDiscard(hand, g, room, 0);
    ai.chooseDiscard(hand, g, room, 1);
  } finally {
    aiJournal.recordDecision = orig;
  }
  assert.equal(seen.length, 1, '只有困难座位产生决策轨迹');
  assert.equal(seen[0].seat, 1);
  assert.equal(seen[0].phase, 'discard');
});

test('红中 / 贴金出牌也按座位分派（GameServer 内部入口）', () => {
  const srv = newServer();
  try {
    const room = mkRoom({ settings: { variant: 'hongzhong', aiDifficulty: 'normal' } });
    const hand = FOUR_MELDS.concat(['b5', 'b9']);
    const g = mkGame(hand, { hands: [hand, hand.slice(), hand.slice(), hand.slice()], melds: [[], [], [], []] });
    // 用困难内核是否被调用来判断：打桩记录 seat
    const calls = [];
    const orig = ai.hardChooseHongZhongDiscard;
    // GameServer 通过 require 的 ai 模块对象调用，可直接替换其导出方法
    ai.hardChooseHongZhongDiscard = (game, seat, r) => { calls.push(seat); return null; };
    try {
      srv._chooseHongZhongDiscard(g, room, 0);
      srv._chooseHongZhongDiscard(g, room, 1);
    } finally {
      ai.hardChooseHongZhongDiscard = orig;
    }
    assert.deepEqual(calls, [0], '仅 0 号困难座位调用困难内核');
  } finally {
    cleanupServer(srv);
  }
});

// ==================== 2. 服务端：按座位添加 / 切换 ====================

function createRoom(srv, ws, settings = {}) {
  send(ws, { type: 'join_lobby', name: '房主' });
  send(ws, { type: 'create_room', settings: Object.assign({ totalRounds: 4, aiFill: false, aiDifficulty: 'normal' }, settings) });
  return [...srv.rooms.values()][0];
}

test('add_ai 支持难度与指定座位，可搭出混合难度房间', () => {
  const srv = newServer();
  try {
    const wa = makeWs();
    srv.handleConnection(wa);
    const room = createRoom(srv, wa);
    send(wa, { type: 'add_ai', difficulty: 'hard', seat: 1 });
    send(wa, { type: 'add_ai', difficulty: 'normal', seat: 2 });
    send(wa, { type: 'add_ai', seat: 3 }); // 旧客户端：不带难度 -> 房间默认普通

    assert.equal(room.players[1].aiDifficulty, 'hard');
    assert.equal(room.players[2].aiDifficulty, 'normal');
    assert.equal(room.players[3].aiDifficulty, 'normal');
    assert.equal(room.players[0].isAI, false);
    assert.deepEqual(
      [1, 2, 3].map((s) => room.players[s].name),
      ['困难·机器人1', '普通·机器人2', '普通·机器人3'],
      '机器人姓名前缀跟随各自座位难度'
    );

    const state = lastOf(wa, 'room_state');
    assert.deepEqual(state.room.players.map((p) => (p ? p.aiDifficulty : null)), ['normal', 'hard', 'normal', 'normal']);
    assert.equal(state.room.players[1].name, '困难·机器人1', '房间视图下发带前缀的姓名');

    const wb = makeWs();
    srv.handleConnection(wb);
    send(wb, { type: 'join_lobby', name: '路人' });
    assert.deepEqual(lastOf(wb, 'lobby_state').rooms[0].aiDifficulties, ['hard', 'normal', 'normal']);
  } finally {
    cleanupServer(srv);
  }
});

test('add_ai 默认难度跟随建房设置；非法难度 / 座位 / 已占座位均被拒绝', () => {
  const srv = newServer();
  try {
    const wa = makeWs();
    srv.handleConnection(wa);
    const room = createRoom(srv, wa, { aiDifficulty: 'hard' });
    send(wa, { type: 'add_ai' });
    assert.equal(room.players[1].aiDifficulty, 'hard', '不带参数用房间默认困难');
    assert.equal(room.players[1].name, '困难·机器人1', '自动补位的人机姓名也带默认难度');

    const count = room.players.filter(Boolean).length;
    send(wa, { type: 'add_ai', difficulty: 'impossible', seat: 2 });
    assert.equal(lastOf(wa, 'error').message, 'AI 难度只能是 normal 或 hard');
    assert.equal(room.players.filter(Boolean).length, count);

    send(wa, { type: 'add_ai', difficulty: 'normal', seat: 9 });
    assert.equal(lastOf(wa, 'error').message, '座位编号不合法');

    send(wa, { type: 'add_ai', difficulty: 'normal', seat: 0 });
    assert.equal(lastOf(wa, 'error').message, '该座位已有玩家');
    assert.equal(room.players.filter(Boolean).length, count, '被拒绝的请求不得改变房间');
  } finally {
    cleanupServer(srv);
  }
});

test('set_ai_difficulty：等待房/结算房可切换并同步姓名前缀；牌局进行中拒绝；越权 / 真人 / 非法值拒绝', () => {
  const srv = newServer();
  try {
    const wa = makeWs();
    srv.handleConnection(wa);
    const room = createRoom(srv, wa);
    send(wa, { type: 'add_ai', difficulty: 'normal', seat: 1 });
    assert.equal(room.players[1].name, '普通·机器人1');

    // 等待房：切换后姓名前缀同步更新并下发
    send(wa, { type: 'set_ai_difficulty', targetId: 's1', difficulty: 'hard' });
    assert.equal(room.players[1].aiDifficulty, 'hard');
    assert.equal(room.players[1].name, '困难·机器人1');
    assert.equal(lastOf(wa, 'room_state').room.players[1].aiDifficulty, 'hard');
    assert.equal(lastOf(wa, 'room_state').room.players[1].name, '困难·机器人1');

    // 结算后（未开局下一轮）仍可调整
    room.state = 'settled';
    send(wa, { type: 'set_ai_difficulty', seat: 1, difficulty: 'normal' });
    assert.equal(room.players[1].aiDifficulty, 'normal');
    assert.equal(room.players[1].name, '普通·机器人1', '反复切换不叠加前缀');

    // 牌局进行中：直接拒绝，难度与姓名都不变，也不刷新牌桌视图
    room.state = 'playing';
    room.game = { hands: [[], [], [], []], melds: [[], [], [], []], discards: [[], [], [], []] };
    let gameBroadcasts = 0;
    const origBroadcast = srv._broadcastGameState;
    srv._broadcastGameState = () => { gameBroadcasts++; };
    try {
      send(wa, { type: 'set_ai_difficulty', seat: 1, difficulty: 'hard' });
    } finally {
      srv._broadcastGameState = origBroadcast;
    }
    assert.equal(lastOf(wa, 'error').message, '牌局进行中，无法切换 AI 难度');
    assert.equal(room.players[1].aiDifficulty, 'normal', '牌局中不得改动策略');
    assert.equal(room.players[1].name, '普通·机器人1', '牌局中不得改动姓名');
    assert.equal(gameBroadcasts, 0, '牌局中不应刷新 game_state');
    room.state = 'waiting';

    send(wa, { type: 'set_ai_difficulty', seat: 0, difficulty: 'hard' });
    assert.equal(lastOf(wa, 'error').message, '只能调整人机座位的难度');

    send(wa, { type: 'set_ai_difficulty', seat: 1, difficulty: 'impossible' });
    assert.equal(lastOf(wa, 'error').message, 'AI 难度只能是 normal 或 hard');

    const wb = makeWs();
    srv.handleConnection(wb);
    send(wb, { type: 'join_lobby', name: '路人B' });
    send(wb, { type: 'join_room', roomId: room.id });
    assert.ok(room.players[2], '路人应能入座（房间未满）');
    send(wb, { type: 'set_ai_difficulty', seat: 1, difficulty: 'hard' });
    assert.equal(lastOf(wb, 'error').message, '只有房主可以调整 AI 难度');
    assert.equal(room.players[1].aiDifficulty, 'normal', '越权不得改动');
    assert.equal(room.players[1].name, '普通·机器人1', '越权不得改动姓名');
  } finally {
    cleanupServer(srv);
  }
});

// ==================== 3. 复盘日志按座位难度分组 ====================

test('ai-journal：混合房间决策只记困难座位，结算按难度分条且不喂普通样本给校准', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-seats-'));
  const noteCalls = [];
  const origNote = calibration.noteRound;
  aiJournal.configure({ dir, enabled: true, calibration: { enabled: false, file: path.join(dir, 'c.json') } });
  calibration.noteRound = (r) => { noteCalls.push(r); return null; };
  try {
    const room = mkRoom();
    aiJournal.recordDecision(room, 0, { candidates: [], phase: 'discard' });
    aiJournal.recordDecision(room, 1, { candidates: [], phase: 'discard' });
    const summary = aiJournal.finishRound(room);
    assert.equal(summary.difficulty, 'mixed');
    assert.equal(summary.rows.length, 2);
    assert.equal(noteCalls.length, 1, '只有困难座位进入校准窗口');
    assert.equal(noteCalls[0].difficulty, 'hard');
    assert.equal(noteCalls[0].seat, 0);
    assert.equal(noteCalls[0].decisions, 1);

    await aiJournal.flush();
    const file = fs.readdirSync(dir).find((f) => f.startsWith('ai-'));
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(JSON.parse);
    const results = lines.filter((x) => x.type === 'ai_round_result');
    assert.equal(lines.filter((x) => x.type === 'ai_decision').length, 1);
    assert.equal(results.length, 2, '普通/困难各写一条，离线统计按 difficulty 聚合才准确');
    assert.deepEqual(results.map((x) => x.data.difficulty).sort(), ['hard', 'normal']);
    for (const r of results) assert.equal(r.data.rows.length, 1);
  } finally {
    calibration.noteRound = origNote;
    await aiJournal.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== 4. 前端：座位按钮与展示 ====================

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

function push(ws, msg) {
  ws.onmessage({ data: JSON.stringify(msg) });
}

function press(window, el) {
  const ev = new window.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'button', { value: 0 });
  el.dispatchEvent(ev);
}

function lobbyRoom() {
  return {
    id: '9001', state: 'waiting', playerCount: 3, ownerName: '房主',
    settings: { variant: 'koudian', totalRounds: 4, aiFill: true, aiDifficulty: 'normal', roomType: 'public' },
    aiDifficulties: ['hard', 'normal'],
  };
}

function waitingRoom() {
  return {
    id: '9001', state: 'waiting', roundNo: 0, roomType: 'public', ownerId: 'P1',
    isViewer: false, viewerCount: 0, settleConfirms: null, logs: [], chat: [], emoji: [],
    settings: { variant: 'koudian', totalRounds: 4, aiFill: true, aiDifficulty: 'normal', roomType: 'public' },
    players: [
      { seat: 0, id: 'P1', name: '房主', isAI: false, connected: true, hosted: false, score: 0, roundScore: 0, aiDifficulty: 'normal' },
      { seat: 1, id: 's1', name: '困难·机器人1', isAI: true, connected: true, hosted: false, score: 0, roundScore: 0, aiDifficulty: 'hard' },
      null, null,
    ],
  };
}

test('前端：大厅列表与房间信息栏显示逐座位实际难度', () => {
  const dom = createFrontendEnv();
  try {
    const { window } = dom;
    const ws = window.__lastWs;
    push(ws, { type: 'hello', playerId: 'P1', name: '房主' });
    push(ws, { type: 'lobby_state', rooms: [lobbyRoom()] });
    assert.match(window.document.querySelector('#room-list').textContent, /AI 1困难·1普通/);

    push(ws, { type: 'room_state', room: waitingRoom() });
    assert.match(window.document.querySelector('#room-state-text').textContent, /AI 困难×1/);
  } finally {
    dom.window.close();
  }
});

test('前端：空位可分别加普通/困难 AI，AI 座位难度按钮可切换（pointerdown 委托）', () => {
  const dom = createFrontendEnv();
  try {
    const { window } = dom;
    const doc = window.document;
    const ws = window.__lastWs;
    push(ws, { type: 'hello', playerId: 'P1', name: '房主' });
    push(ws, { type: 'room_state', room: waitingRoom() });

    const addBtns = [...doc.querySelectorAll('.ai-add')];
    assert.equal(addBtns.length, 4, '2 个空位 × 普通/困难');
    assert.deepEqual(
      addBtns.map((b) => `${b.dataset.addSeat}:${b.dataset.addDiff}`).sort(),
      ['2:hard', '2:normal', '3:hard', '3:normal']
    );
    assert.match(doc.querySelector('#table-wrap').textContent, /困难·机器人1/, '等待房显示带难度前缀的姓名');
    const toggle = doc.querySelector('.ai-diff-toggle');
    assert.ok(toggle);
    assert.equal(toggle.dataset.diffSeat, '1');
    assert.equal(toggle.dataset.diffNext, 'normal');

    press(window, doc.querySelector('[data-add-seat="2"][data-add-diff="hard"]'));
    assert.deepEqual(ws.sent.at(-1), { type: 'add_ai', difficulty: 'hard', seat: 2 });

    press(window, doc.querySelector('[data-add-seat="3"][data-add-diff="normal"]'));
    assert.deepEqual(ws.sent.at(-1), { type: 'add_ai', difficulty: 'normal', seat: 3 });

    press(window, toggle);
    assert.deepEqual(ws.sent.at(-1), { type: 'set_ai_difficulty', seat: 1, difficulty: 'normal' });
  } finally {
    dom.window.close();
  }
});

test('前端：非房主看到难度徽标但没有可操作按钮', () => {
  const dom = createFrontendEnv();
  try {
    const { window } = dom;
    const doc = window.document;
    const ws = window.__lastWs;
    push(ws, { type: 'hello', playerId: 'P2', name: '路人' });
    const room = waitingRoom();
    room.ownerId = 's0'; // 他人视角房主为座位代称
    room.players[0].id = 's0';
    room.players[0].name = '房主';
    push(ws, { type: 'room_state', room });
    assert.equal(doc.querySelectorAll('.ai-add').length, 0);
    assert.equal(doc.querySelectorAll('.ai-diff-toggle').length, 0);
    assert.match(doc.querySelector('.ai-diff-badge.hard').textContent, /困难/);
  } finally {
    dom.window.close();
  }
});

test('前端：牌局进行中 AI 座位只显示难度徽标，不提供切换按钮', () => {
  const dom = createFrontendEnv();
  try {
    const { window } = dom;
    const doc = window.document;
    const ws = window.__lastWs;
    push(ws, { type: 'hello', playerId: 'P1', name: '房主' });
    const room = waitingRoom();
    room.state = 'playing';
    room.roundNo = 1;
    room.players[1].name = '困难·机器人1';
    room.players[2] = { seat: 2, id: 's2', name: '普通·机器人2', isAI: true, connected: true, hosted: false, score: 0, roundScore: 0, aiDifficulty: 'normal' };
    room.players[3] = { seat: 3, id: 's3', name: '普通·机器人3', isAI: true, connected: true, hosted: false, score: 0, roundScore: 0, aiDifficulty: 'normal' };
    push(ws, { type: 'room_state', room });
    const players = room.players.map((p) => Object.assign({}, p, {
      hand: [], handCount: 0, discards: [], melds: [], isDealer: false, ting: false,
    }));
    push(ws, {
      type: 'game_state',
      game: {
        stage: 'draw', roundNo: 1, yourSeat: 0, turn: 1, wallCount: 60,
        players, winners: null, pending: null, goldTile: null, goldMother: null,
        baoHuZone: false, logs: [],
      },
    });
    assert.equal(doc.querySelectorAll('.ai-diff-toggle').length, 0, '牌桌不提供切换入口');
    assert.equal(doc.querySelectorAll('.ai-diff-badge').length, 3, '三个人机座位仍显示只读徽标');
    assert.match(doc.querySelector('#table-wrap').textContent, /困难·机器人1/);
    assert.match(doc.querySelector('#table-wrap').textContent, /普通·机器人2/);
  } finally {
    dom.window.close();
  }
});

test('前端：建房弹窗仍透传默认难度，并说明可逐座位覆盖', () => {
  const dom = createFrontendEnv();
  try {
    const { window } = dom;
    const doc = window.document;
    assert.match(doc.querySelector('.setting-note').textContent, /每个空座位/);
    assert.match(doc.querySelector('.setting-note').textContent, /牌局进行中不可更改/);
    const seg = doc.querySelector('#seg-ai-difficulty');
    [...seg.querySelectorAll('.seg-item')][1].click();
    doc.querySelector('#create-confirm').click();
    const msg = window.__lastWs.sent.find((m) => m.type === 'create_room');
    assert.equal(msg.settings.aiDifficulty, 'hard');
  } finally {
    dom.window.close();
  }
});

// ==================== 5. 真实混合房间跑完一局 ====================

/**
 * 纯内存驱动真实 GameServer：把 AI 代打的 80ms 定时器换成同步队列、广播置空。
 * 打桩 aiJournal.recordDecision，断言一局里只有困难座位产生困难决策轨迹。
 */
test('端到端：混合难度房间完整打完一局，只有困难座位调用困难内核', () => {
  const q = [];
  const oST = global.setTimeout;
  const oCT = global.clearTimeout;
  const oSI = global.setInterval;
  const oCI = global.clearInterval;
  global.setTimeout = (fn, ms, ...a) => {
    if (ms === 80) {
      const t = { fake: true, cancelled: false };
      q.push({ t, fn: () => fn(...a) });
      return t;
    }
    return oST(fn, ms, ...a);
  };
  global.clearTimeout = (t) => { if (t && t.fake) { t.cancelled = true; return; } return oCT(t); };
  global.setInterval = () => ({ fakeInterval: true });
  global.clearInterval = () => {};

  const calls = [];
  const origRecord = aiJournal.recordDecision;
  aiJournal.recordDecision = (room, seat) => { calls.push(seat); return false; };
  // 前面的日志用例把全局 logger 指向了临时目录（已删除），这里禁掉日志避免结算写盘 ENOENT
  aiJournal.configure({ enabled: false, calibration: { enabled: false } });
  let srv;
  try {
    srv = new GameServer({ gameLog: false, rng: seededRng(20261108), heartbeatIntervalMs: 1e9, heartbeatMaxMiss: 1e9 });
    for (const k of ['_broadcast', '_broadcastRoomState', '_broadcastGameState', '_broadcastLobby', '_send', '_sendWs', '_sendLobbyState']) {
      srv[k] = () => {};
    }
    const handlers = {};
    const ws = {
      readyState: 1, handlers,
      on: (t, cb) => { handlers[t] = cb; },
      send: () => {}, ping: () => {}, terminate: () => {}, close: () => {},
    };
    const emit = (o) => handlers.message(JSON.stringify(o));
    srv.handleConnection(ws);
    emit({ type: 'join_lobby', name: '模拟房主' });
    emit({ type: 'create_room', settings: { totalRounds: 4, aiFill: false, variant: 'koudian', aiDifficulty: 'normal' } });
    const room = [...srv.rooms.values()][0];
    const owner = room.players.find((p) => p && !p.isAI);
    owner.isAI = true; // 4 个座位全部自动代打
    emit({ type: 'add_ai', difficulty: 'hard', seat: 1 });
    emit({ type: 'add_ai', difficulty: 'normal', seat: 2 });
    emit({ type: 'add_ai', difficulty: 'hard', seat: 3 });
    assert.deepEqual(room.players.map((p) => p.aiDifficulty), [undefined, 'hard', 'normal', 'hard']);

    emit({ type: 'start_game' });
    let steps = 0;
    while (q.length) {
      const it = q.shift();
      if (!it.t.cancelled) it.fn();
      if (++steps > 100000) throw new Error('同步队列溢出');
    }
    assert.ok(steps > 50, '应真实推进大量 AI 行动');
    assert.equal(room.state, 'settled', '应打满 4 局并结算');
    assert.ok(calls.length > 0, '困难座位应产生决策轨迹');
    assert.deepEqual([...new Set(calls)].sort(), [1, 3], '只有 1/3 号困难座位调用困难内核');
  } finally {
    aiJournal.recordDecision = origRecord;
    if (srv) srv.stop();
    global.setTimeout = oST;
    global.clearTimeout = oCT;
    global.setInterval = oSI;
    global.clearInterval = oCI;
  }
});
