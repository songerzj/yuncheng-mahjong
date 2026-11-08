'use strict';

/**
 * 困难 AI 的「碰牌牌效判据 + 决策复盘 + 胜率自动校准」回归测试。
 * 所有外部状态都通过 configure() 指向临时目录，不污染项目 logs/ 与 data/。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const calibration = require('../src/ai-calibration');
const hard = require('../src/ai-hard');
const ai = require('../src/ai');
const aiJournal = require('../src/ai-journal');
const gameLogger = require('../src/game-logger');
const rules = require('../src/rules');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'ai-calibrate.js');
const D = calibration.DEFAULTS;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-learn-'));
}

function resetCalibration(file) {
  calibration.setParams(D);
  calibration.configure({ enabled: false, file: file || path.join(tmpDir(), 'unused.json') });
}

function mkGame(hand, extra = {}) {
  return Object.assign(
    {
      hands: [hand],
      melds: [[]],
      discards: [[], [], [], []],
      tingSeats: [],
      drawnTile: null,
      lastAction: null,
      pending: null,
    },
    extra
  );
}

function mkRoom(overrides = {}) {
  return Object.assign(
    {
      id: 'ROOM-1',
      roundNo: 1,
      settings: { variant: 'koudian', aiDifficulty: 'hard' },
      players: [
        { seat: 0, isAI: true, roundScore: 12 },
        { seat: 1, isAI: true, roundScore: -4 },
        { seat: 2, isAI: false, roundScore: -8 },
        { seat: 3, isAI: false, roundScore: 0 },
      ],
      game: { winners: { type: 'hu', winnerSeat: 0, discarder: 1, winType: 'dianpao' }, hzWinners: [] },
    },
    overrides
  );
}

/** 生成 N 局记录，控制胜率 / 放铳率 */
function records(n, winEvery, dealInEvery) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const win = winEvery > 0 && i % winEvery === 0;
    out.push({
      win,
      dealIn: !win && dealInEvery > 0 && i % dealInEvery === 0,
      net: win ? 8 : -2,
      difficulty: 'hard',
    });
  }
  return out;
}

// ==================== 1. 校准纯函数 ====================

test('summarize：胜率 / 放铳率 / 净得分聚合正确', () => {
  const s = calibration.summarize([
    { win: true, dealIn: false, net: 10 },
    { win: false, dealIn: true, net: -6 },
    { win: false, dealIn: false, net: 0 },
  ]);
  assert.equal(s.rounds, 3);
  assert.equal(s.wins, 1);
  assert.equal(s.dealIns, 1);
  assert.equal(s.netTotal, 4);
  assert.equal(s.winRate, 0.333);
  assert.equal(s.dealInRate, 0.333);
});

test('calibrate：样本不足时保持参数不变', () => {
  const r = calibration.calibrate(calibration.summarize(records(5, 1, 2)), D, { minRounds: 40 });
  assert.equal(r.changed, false);
  assert.deepEqual(r.params, D);
  assert.match(r.reason, /样本不足/);
});

test('calibrate：放铳率超标时转防守（defenseSlack / riskWeight 上升）', () => {
  const stats = calibration.summarize(records(60, 0, 2)); // 0 胜、30 次放铳
  const r = calibration.calibrate(stats, D, { minRounds: 40 });
  assert.equal(r.changed, true);
  assert.ok(r.params.defenseSlack > D.defenseSlack);
  assert.ok(r.params.riskWeight > D.riskWeight);
  assert.match(r.reason, /防守/);
});

test('calibrate：胜率低且不送炮时转进攻', () => {
  const stats = calibration.summarize(records(60, 10, 0)); // 10% 胜率、0 放铳
  const r = calibration.calibrate(stats, D, { minRounds: 40 });
  assert.ok(r.params.defenseSlack < D.defenseSlack);
  assert.ok(r.params.winWeightBoost > D.winWeightBoost);
  assert.ok(r.params.pengAggression < D.pengAggression);
  assert.match(r.reason, /进攻/);
});

test('calibrate：明显强于目标时向默认参数收敛', () => {
  const from = { defenseSlack: 4, riskWeight: 1.8, winWeightBoost: 0.85, pengAggression: 1.15 };
  const stats = calibration.summarize(records(60, 1, 0)); // 100% 胜、0 放铳
  const r = calibration.calibrate(stats, from, { minRounds: 40 });
  assert.ok(r.params.defenseSlack < from.defenseSlack);
  assert.ok(r.params.riskWeight < from.riskWeight);
  assert.ok(r.params.winWeightBoost > from.winWeightBoost);
  assert.match(r.reason, /收敛/);
});

test('calibrate：反复校准始终夹在安全边界内，且单步不超过 STEP', () => {
  let p = { ...D };
  const stats = calibration.summarize(records(200, 0, 2));
  for (let i = 0; i < 30; i++) {
    const next = calibration.calibrate(stats, p, { minRounds: 40 });
    for (const k of calibration.KEYS) {
      const [lo, hi] = calibration.BOUNDS[k];
      assert.ok(next.params[k] >= lo && next.params[k] <= hi, `${k} 越界: ${next.params[k]}`);
      assert.ok(
        Math.abs(next.params[k] - p[k]) <= calibration.STEP[k] + 1e-6,
        `${k} 单步过大`
      );
    }
    p = next.params;
  }
  assert.equal(p.defenseSlack, calibration.BOUNDS.defenseSlack[1]);
  assert.equal(p.riskWeight, calibration.BOUNDS.riskWeight[1]);
});

test('sanitize：非法值回退默认、越界值夹到边界、未知字段丢弃', () => {
  const s = calibration.sanitize({
    defenseSlack: 999,
    riskWeight: 'oops',
    winWeightBoost: NaN,
    pengAggression: -3,
    evil: 1,
  });
  assert.equal(s.defenseSlack, calibration.BOUNDS.defenseSlack[1]);
  assert.equal(s.riskWeight, D.riskWeight);
  assert.equal(s.winWeightBoost, D.winWeightBoost);
  assert.equal(s.pengAggression, calibration.BOUNDS.pengAggression[0]);
  assert.equal(Object.keys(s).length, calibration.KEYS.length);
});

// ==================== 2. 文件与在线闭环 ====================

test('persist / load：校准文件可往返，含样本与原因', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'calib.json');
  const result = {
    params: { ...D, defenseSlack: 3 },
    reason: '测试',
    stats: calibration.summarize(records(50, 0, 2)),
  };
  calibration.persist(result, file);
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(obj.version, 1);
  assert.equal(obj.params.defenseSlack, 3);
  assert.equal(obj.sample.rounds, 50);
  assert.equal(calibration.load(file).defenseSlack, 3);
  resetCalibration();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load：文件损坏 / 缺失时静默回退默认参数', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(calibration.load(file), D);
  assert.deepEqual(calibration.load(path.join(dir, 'missing.json')), D);
  resetCalibration();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('noteRound：累计到样本门槛自动校准、写盘、清空窗口', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'calib.json');
  calibration.setParams(D);
  calibration.configure({ enabled: true, file, minRounds: 2 });
  const row = { difficulty: 'hard', win: false, dealIn: true, net: -5 };
  assert.equal(calibration.noteRound(row), null);
  assert.equal(calibration.windowSize(), 1);
  assert.equal(fs.existsSync(file), false);
  const out = calibration.noteRound(row);
  assert.ok(out);
  assert.equal(out.changed, true);
  assert.equal(calibration.windowSize(), 0);
  assert.ok(calibration.getParams().defenseSlack > D.defenseSlack);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).params.defenseSlack, calibration.getParams().defenseSlack);
  resetCalibration(file);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('noteRound：普通难度记录不参与校准', () => {
  const dir = tmpDir();
  calibration.configure({ enabled: true, file: path.join(dir, 'c.json'), minRounds: 1 });
  for (let i = 0; i < 5; i++) calibration.noteRound({ difficulty: 'normal', win: false, dealIn: true, net: -1 });
  assert.equal(calibration.windowSize(), 0);
  assert.deepEqual(calibration.getParams(), D);
  resetCalibration();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ==================== 3. 参数进入策略 ====================

test('winWeightBoost 只放大高点数进张收益，低点废张仍为 0', () => {
  assert.equal(hard.winWeight('w1'), 0); // 1 点不能胡
  assert.equal(hard.winWeight('w1', 1.3), 0);
  assert.ok(hard.winWeight('w9', 1.3) > hard.winWeight('w9', 1));
  assert.equal(hard.winWeight('w9'), hard.winWeight('w9', 1));
});

test('riskWeight 只缩放弱线索，精确点炮危险保持一票否决级', () => {
  const g = mkGame(['w1', 'w1'], { discards: [[], ['b9'], [], []] });
  // b9 既是现物（-6）又是幺九（-0.5），弱线索整体受 riskWeight 缩放
  assert.equal(hard.discardRisk(g, 0, 'b9', 1), -6.5);
  assert.equal(hard.discardRisk(g, 0, 'b9', 2), -13);

  const opp = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 't3', 'b8'];
  const g2 = mkGame(['w1', 'w1'], { hands: [['w1', 'w1'], opp], tingSeats: [1] });
  assert.ok(hard.discardRisk(g2, 0, 'b8', 1) >= 100);
  assert.ok(hard.discardRisk(g2, 0, 'b8', 2) >= 100);
});

test('defenseSlack：校准放宽后 AI 愿意为现物牺牲更多进张', () => {
  const hand = ['b1', 'b3', 'b4', 'b1', 't2', 't9', 'b6', 't2', 't8', 'w4', 'b5', 'w3', 'w9', 'w2'];
  const g = mkGame(hand, { discards: [['b6'], [], ['b6'], []] });
  const p = (s) => ({ ...D, defenseSlack: s });
  assert.equal(hard.chooseDiscard(hand, g, 0, p(0)), 'w9'); // 进张多 4 张
  assert.equal(hard.chooseDiscard(hand, g, 0, p(2)), 'w9'); // 默认与旧策略一致
  assert.equal(hard.chooseDiscard(hand, g, 0, p(5)), 'b6'); // 放宽后才让风险介入
});

test('winWeightBoost：调高后出牌选择向高点数进张偏移', () => {
  const hand = ['t5', 't4', 't4', 'w2', 't6', 'b8', 'b3', 'b4', 'b6', 'x', 'x', 'p', 's', 'b9'];
  const g = mkGame(hand);
  assert.equal(hard.chooseDiscard(hand, g, 0, D), 'p');
  assert.equal(hard.chooseDiscard(hand, g, 0, { ...D, winWeightBoost: 1.3 }), 'w2');
});

test('captureTrace：收集决策轨迹、嵌套与异常后都能恢复', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 't3', 'b5', 'b9'];
  const g = mkGame(hand);
  const outer = hard.captureTrace(() => {
    const inner = hard.captureTrace(() => hard.chooseDiscard(hand, g, 0));
    assert.equal(inner.traces.length, 1);
    return hard.chooseDiscard(hand, g, 0);
  });
  assert.equal(outer.traces.length, 1);
  assert.equal(outer.traces[0].picked, outer.result);
  assert.equal(outer.traces[0].candidates.length, 14);
  assert.equal(outer.traces[0].phase, 'discard');
  assert.throws(() => hard.captureTrace(() => { throw new Error('boom'); }), /boom/);
  const after = hard.captureTrace(() => hard.chooseDiscard(hand, g, 0));
  assert.equal(after.traces.length, 1, '异常后 activeCapture 应已复位');
});

// ==================== 4. 碰牌响应决策 ====================

const PENG_HAND = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 'b5', 'b5'];

test('困难响应：能胡优先胡、能杠优先杠', () => {
  const g = mkGame(PENG_HAND);
  const room = { settings: { variant: 'koudian', aiDifficulty: 'hard' } };
  assert.equal(hard.decideResponse(g, room, 0, { canHu: true, canGang: true, canPeng: true }), 'hu');
  assert.equal(hard.decideResponse(g, room, 0, { canHu: false, canGang: true, canPeng: true }), 'gang');
});

test('困难响应：碰牌会亏牌效时 pass，普通难度仍按原策略碰', () => {
  // 这手牌未听牌，普通档「能碰就碰」；困难档算完碰后最优弃牌发现牌效变差，选择过
  const hand = ['w1', 'w8', 'w4', 'w5', 'w4', 't9', 'w8', 't1', 'b5', 'b5', 'b6', 't6', 'b2'];
  const g = mkGame(hand, { pending: { tile: 'w8' } });
  const prompt = { canHu: false, canGang: false, canPeng: true };
  const normal = { settings: { variant: 'koudian' } };
  const hardRoom = { settings: { variant: 'koudian', aiDifficulty: 'hard' } };
  assert.equal(ai.decideResponse(g, normal, 0, prompt), 'peng');
  assert.equal(ai.decideResponseNormal(g, normal, 0, prompt), 'peng');
  assert.equal(ai.decideResponse(g, hardRoom, 0, prompt), 'pass');
});

test('困难响应：已报听者不碰（服务端亦会拒绝）', () => {
  const g = mkGame(PENG_HAND, { pending: { tile: 'b5' }, tingSeats: [0] });
  assert.equal(hard.decideKoudianPeng(g, 0, 'b5', D), 'pass');
});

test('困难响应：碰后加权进张明显提升时接受碰牌', () => {
  const hand = ['f', 'w9', 't5', 'w5', 'b9', 'b1', 'b6', 't4', 'w3', 'n', 'b9', 'b4', 'w8'];
  const g = mkGame(hand, { pending: { tile: 'b9' } });
  const before = hard.handValue(hand, g, 0, [], D);
  const rest = hand.slice();
  rest.splice(rest.indexOf('b9'), 1);
  rest.splice(rest.indexOf('b9'), 1);
  const after = hard.handValue(rest.slice(0, -1), g, 0, [{ type: 'peng', tile: 'b9' }], D);
  assert.ok(after.weighted > before.weighted);
  assert.equal(hard.decideKoudianPeng(g, 0, 'b9', D), 'peng');
});

test('红中/贴金：碰掉唯一对子且无万能牌时 pass，有备用对子时 peng', () => {
  const roomHz = { settings: { variant: 'hongzhong', aiDifficulty: 'hard' } };
  const onlyPair = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 'b5', 'b5'];
  const withPair = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't1', 'b5', 'b5'];
  const prompt = { canHu: false, canGang: false, canPeng: true };
  const mk = (h) => mkGame(h, { pending: { tile: 'b5' } });
  assert.equal(ai.decideVariantResponse(mk(onlyPair), roomHz, 0, prompt), 'pass');
  assert.equal(ai.decideVariantResponse(mk(withPair), roomHz, 0, prompt), 'peng');
  // 普通档返回 null，由 GameServer 沿用原策略
  assert.equal(ai.decideVariantResponse(mk(onlyPair), { settings: { variant: 'hongzhong' } }, 0, prompt), null);
});

test('红中/贴金：万能牌不碰（留在手里价值更高）', () => {
  const g = mkGame(PENG_HAND, { pending: { tile: rules.HONG_ZHONG }, goldTile: 'b3' });
  const prompt = { canHu: false, canGang: false, canPeng: true };
  assert.equal(
    hard.decideResponse(g, { settings: { variant: 'hongzhong' } }, 0, prompt, D),
    'pass'
  );
});

test('困难响应：决策轨迹记录 response 阶段', () => {
  const g = mkGame(PENG_HAND, { pending: { tile: 'b5' } });
  const room = { settings: { variant: 'koudian' } };
  const cap = hard.captureTrace(() => hard.decideResponse(g, room, 0, { canPeng: true }, D));
  assert.equal(cap.traces.length, 1);
  assert.equal(cap.traces[0].phase, 'response');
  assert.equal(cap.traces[0].picked, cap.result);
});

// ==================== 5. 复盘日志与 CLI ====================

test('ai-journal：决策快照 + 本局结果落盘，胜负/放铳/净得分判定正确', async () => {
  const dir = tmpDir();
  aiJournal.configure({ dir, enabled: true, calibration: { enabled: false, file: path.join(dir, 'c.json') } });
  const room = mkRoom();
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 't3', 'b5', 'b9'];
  const g = mkGame(hand, { pending: { tile: 'b5' } });
  ai.chooseDiscard(hand, g, room, 0);
  ai.decideResponse(g, room, 0, { canPeng: true });
  const summary = aiJournal.finishRound(room);
  assert.equal(summary.difficulty, 'hard');
  assert.equal(summary.rows[0].win, true);
  assert.equal(summary.rows[0].dealIn, false);
  assert.equal(summary.rows[0].net, 12);
  assert.equal(summary.rows[0].decisions, 2);
  assert.equal(summary.rows[1].dealIn, true);
  assert.equal(summary.rows[1].net, -4);

  await aiJournal.flush();
  const aiFile = fs.readdirSync(dir).find((f) => f.startsWith('ai-'));
  assert.ok(aiFile);
  const lines = fs.readFileSync(path.join(dir, aiFile), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((x) => x.type), ['ai_decision', 'ai_decision', 'ai_round_result']);
  assert.equal(lines[0].data.difficulty, 'hard');
  assert.equal(lines[0].data.seat, 0);
  assert.ok(lines[0].data.candidates.length > 0);
  assert.equal(lines[1].data.phase, 'response');
  assert.equal(lines[2].data.winSeats[0], 0);
  assert.equal(lines[2].data.discarder, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ai-journal：兼容贴金 winner 字段与红中一炮多响', () => {
  assert.deepEqual(
    aiJournal.winnerSeatsOf(mkRoom({ game: { winners: { type: 'hu', winner: 2, discarder: -1 } } })),
    [2]
  );
  assert.deepEqual(
    aiJournal.winnerSeatsOf(
      mkRoom({
        game: {
          winners: { type: 'hu', payments: [] },
          hzWinners: [{ winnerSeat: 1, discarder: 3 }, { winnerSeat: 2, discarder: 3 }],
        },
      })
    ),
    [1, 2]
  );
  assert.equal(
    aiJournal.discarderOf(
      mkRoom({ game: { winners: { type: 'hu' }, hzWinners: [{ winnerSeat: 1, discarder: 3 }] } })
    ),
    3
  );
  assert.equal(aiJournal.discarderOf(mkRoom({ game: { winners: { type: 'draw' } } })), null);
});

test('game-logger：ai- 与 game- 前缀日志互不干扰（轮转/清理各自隔离）', () => {
  const dir = tmpDir();
  const a = gameLogger.createGameLogger({ dir, prefix: 'ai-', enabled: true });
  const b = gameLogger.createGameLogger({ dir, prefix: 'game-', enabled: true });
  a.append({ id: 'R', roundNo: 1 }, 'ai_decision', { x: 1 });
  b.append({ id: 'R', roundNo: 1 }, 'round_start', { y: 2 });
  a.flushSync();
  b.flushSync();
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2);
  assert.equal(a.cleanup().kept, 1, 'ai 日志器只统计自己的文件');
  assert.equal(b.cleanup().kept, 1, 'game 日志器只统计自己的文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI：--dry-run 输出分组统计与校准判定，不写校准文件', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'calib.json');
  const day = new Date().toISOString().slice(0, 10);
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push(
      JSON.stringify({
        ts: new Date().toISOString(),
        roomId: 'R',
        roundNo: i,
        type: 'ai_round_result',
        data: {
          variant: 'koudian',
          difficulty: 'hard',
          result: 'hu',
          winSeats: i % 4 === 0 ? [0] : [2],
          discarder: i % 5 === 0 ? 0 : 2,
          rows: [{ seat: 0, win: i % 4 === 0, dealIn: i % 5 === 0, net: i % 4 === 0 ? 8 : -2, decisions: 3 }],
        },
      })
    );
  }
  fs.writeFileSync(path.join(dir, `ai-${day}.jsonl`), lines.join('\n') + '\n', 'utf8');
  const out = execFileSync(process.execPath, [CLI, '--log-dir', dir, '--file', file, '--min-rounds', '20'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(out, /koudian\/hard/);
  assert.match(out, /胜率/);
  assert.match(out, /校准判定/);
  assert.match(out, /只读预览/);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI：--apply 写入校准文件，--reset 恢复默认参数', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'calib.json');
  const day = new Date().toISOString().slice(0, 10);
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(
      JSON.stringify({
        ts: new Date().toISOString(),
        roomId: 'R',
        roundNo: i,
        type: 'ai_round_result',
        data: {
          variant: 'koudian',
          difficulty: 'hard',
          rows: [{ seat: 0, win: false, dealIn: i % 2 === 0, net: -3, decisions: 0 }],
        },
      })
    );
  }
  fs.writeFileSync(path.join(dir, `ai-${day}.jsonl`), lines.join('\n') + '\n', 'utf8');
  execFileSync(process.execPath, [CLI, '--log-dir', dir, '--file', file, '--min-rounds', '20', '--apply'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const applied = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(applied.params.defenseSlack > D.defenseSlack);
  assert.equal(applied.sample.rounds, 60);

  execFileSync(process.execPath, [CLI, '--file', file, '--reset'], { cwd: ROOT, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).params, D);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('收尾：恢复全局校准状态，避免影响后续测试', () => {
  resetCalibration();
  assert.deepEqual(calibration.getParams(), D);
});
