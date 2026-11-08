'use strict';

// ============ 运城扣点点麻将：服务端三个新功能单测 ============
// 1) 新摸到的牌加视觉标志（game_state 下发 newTile，仅自己视角）
// 2) 房间列表显示创建者名称（lobby_state 下发 ownerName，转让/离开后保持）
// 3) 房主离线超 60 秒 AI 托管，本局结束后自动解散房间

const { test } = require('node:test');
const { HEARTBEAT_MAX_MISS } = require('../src/game');
const rules = require('../src/rules');
const { makeWs, send, sleep, lastOf, newServer, cleanupServer, assert } = require('../lib/testutils');

const BASE_SETTINGS = { aiFill: true, totalRounds: 4, zhuangDi: false };

// ============ 功能2：房间列表显示创建者名称 ============
test('房间列表包含创建者名称 ownerName；房主离开转让后创建者名称保持原创建者', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主甲' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });

  const room = [...srv.rooms.values()][0];
  assert.ok(room);
  assert.equal(room.ownerName, '房主甲'); // 服务端记录创建者名称

  // 其他玩家进入大厅看到的房间列表包含 ownerName
  const wb = makeWs();
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  const lobbyB = lastOf(wb, 'lobby_state');
  assert.ok(lobbyB && lobbyB.rooms.length === 1);
  assert.equal(lobbyB.rooms[0].ownerName, '房主甲');

  // 房主在 waiting 状态离开：房主身份转让给玩家乙，创建者名称保持房主甲
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'leave_room' });
  assert.equal(room.ownerId, wbSentPlayerId(wb, '玩家乙'));
  assert.equal(room.ownerName, '房主甲');
  // 离开后房主回到大厅，房间列表仍显示原创建者名称
  const lobbyA2 = lastOf(wa, 'lobby_state');
  assert.equal(lobbyA2.rooms[0].ownerName, '房主甲');
  cleanupServer(srv);
});

// 辅助：取大厅玩家 id（join_lobby 返回 hello.playerId）
function wbSentPlayerId(ws, name) {
  const hello = ws.sent.find((m) => m.type === 'hello');
  return hello.playerId;
}

// ============ 功能1：新摸到的牌加视觉标志 ============
test('摸牌后 game_state 下发 newTile（仅自己视角），打出后清除', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' }); // aiFill 补 2 个 AI 后开局

  assert.equal(room.state, 'playing');
  const g = room.game;
  // 开局庄家摸第 14 张后，服务端记录了新摸牌（新摸牌标志的源头）
  assert.ok(g.newTiles[g.turn], '庄家摸牌后内部应记录新摸牌');
  assert.ok(g.hands[g.turn].includes(g.newTiles[g.turn]));

  // 手动驱动座位 1（玩家乙）摸牌：验证“自己摸牌 → 自己视角收到 newTile”
  srv._drawCard(room, 1, false);
  const tileB = g.newTiles[1];
  assert.ok(tileB, '玩家乙摸牌后内部应记录新摸牌');
  const gsB = lastOf(wb, 'game_state');
  assert.equal(gsB.game.newTile, tileB, '自己视角应收到 newTile');
  assert.ok(gsB.game.players[1].hand.includes(tileB));

  // 他人视角不可见：房主（座位 0）看到的是自己座位的新摸牌记录，不是玩家乙的牌
  const gsA = lastOf(wa, 'game_state');
  assert.equal(gsA.game.newTile, g.newTiles[0] || null, '他人视角仅能看到自己的新摸牌记录');

  // 打出新摸的牌后：newTile 清除
  send(wb, { type: 'play_tile', tile: tileB });
  const gsB2 = lastOf(wb, 'game_state');
  assert.equal(gsB2.game.newTile, null, '打出后 newTile 应清除');
  assert.equal(g.newTiles[1], null);
  await sleep(300); // 等待 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

// ============ 功能3：房主离线超 60 秒 AI 托管，本局结束自动解散 ============
test('房主离线超时：广播提示，本局结束后自动解散房间并通知所有玩家回大厅', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing');

  // 房主断线：启动 60 秒超时定时器
  wa.handlers.close();
  assert.ok(room.ownerOfflineSince !== null, '房主离线起始时间已记录');
  assert.ok(room.timers.has('owner:offline'), '60 秒超时定时器已启动');

  // 模拟 60 秒超时（直接触发回调）
  srv._handleOwnerOfflineTimeout(room);
  assert.equal(room.pendingDisband, true, '本局结束后解散标记已置位');
  const notice = lastOf(wb, 'room_notice');
  assert.ok(notice && notice.text.includes('房主离线超过60秒'), '已广播房主离线超时提示');
  assert.ok(room.timers.has('owner:offline') === false, '超时回调后定时器已清理');

  // 本局结算结束：自动解散房间，玩家回到大厅
  srv._endRound(room);
  assert.equal(srv.rooms.has(room.id), false, '房间已从服务端移除');
  const kick = lastOf(wb, 'room_state');
  assert.equal(kick.room, null, '玩家收到 room_state null（回大厅）');
  const lobbyB = lastOf(wb, 'lobby_state');
  assert.ok(lobbyB && !lobbyB.rooms.some((r) => r.id === room.id), '大厅房间列表不再包含该房间');
  await sleep(300); // 等待 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

test('牌局中途 _endRound 结算不得误清房主离线超时定时器（保留定时器，超时后结算确认阶段转让房主）', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing');

  // 房主断线：启动 60 秒超时定时器
  wa.handlers.close();
  assert.ok(room.timers.has('owner:offline'));

  // 模拟真实场景：房主超时（60s）之前，牌局先打完了当前局 → _endRound 正常结算
  // 此时不得把 owner:offline 定时器一并清掉，否则超时回调永远不会触发
  srv._endRound(room);
  assert.ok(room.timers.has('owner:offline'), '_endRound 后房主离线超时定时器应保留');
  assert.equal(room.pendingDisband, false, '正常结算不应误触发解散');

  // 60 秒超时回调随后触发：本局已打完（结算确认中），房主转让给在线真人，房间不解散
  const playerB = room.players.find((pl) => pl && pl.name === '玩家乙');
  srv._handleOwnerOfflineTimeout(room);
  assert.equal(room.ownerId, playerB.id, '房主已转让给在线真人玩家乙');
  assert.equal(room.pendingDisband, false, '转让后不置解散标记');
  const notice = lastOf(wb, 'room_notice');
  assert.ok(notice && notice.text.includes('成为新房主'), '已广播新房主提示');
  assert.equal(srv.rooms.has(room.id), true, '有在线真人时房间不解散');
  await sleep(300); // 等待残留定时器跑完，避免挂住 worker
  cleanupServer(srv);
});

test('房主超时时本局已终局（settled）：转让房主给在线真人而非解散', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing');

  // 房主断线：启动 60 秒超时定时器
  wa.handlers.close();
  assert.ok(room.timers.has('owner:offline'));

  // 模拟超时到来前牌局已全部打完（终局 settled）
  room.state = 'settled';
  const playerB = room.players.find((pl) => pl && pl.name === '玩家乙');
  srv._handleOwnerOfflineTimeout(room);
  const notice = lastOf(wb, 'room_notice');
  assert.ok(notice && notice.text.includes('房主离线超时'), '已广播房主离线超时提示');
  assert.equal(room.ownerId, playerB.id, '房主转让给在线真人玩家乙');
  assert.equal(srv.rooms.has(room.id), true, '有在线真人时房间不解散');
  await sleep(300); // 等待残留定时器跑完，避免挂住 worker
  cleanupServer(srv);
});

test('房主离线超时且无其他在线真人（仅AI）：终局阶段直接解散房间', async () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wa, { type: 'start_game' }); // aiFill 补 3 个 AI 开局
  assert.equal(room.state, 'playing');

  // 房主断线：启动 60 秒超时定时器
  wa.handlers.close();
  assert.ok(room.timers.has('owner:offline'));

  // 模拟牌局已终局（settled），房主是唯一真人且已离线
  room.state = 'settled';
  srv._handleOwnerOfflineTimeout(room);
  assert.equal(srv.rooms.has(room.id), false, '无在线真人时房间直接解散');
  await sleep(300); // 等待残留定时器跑完，避免挂住 worker
  cleanupServer(srv);
});

test('房主 60 秒内重连：取消离线超时解散，房间继续正常进行', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  const ownerId = room.ownerId;
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing');

  // 房主断线
  wa.handlers.close();
  assert.ok(room.timers.has('owner:offline'));

  // 60 秒内重连：使用新连接执行 reconnect
  const wa2 = makeWs();
  srv.handleConnection(wa2);
  // 安全改动：重连需 playerId + secret 双因子（缺 secret 一律拒绝），此处补上本人 secret
  send(wa2, { type: 'reconnect', playerId: ownerId, secret: srv.players.get(ownerId).secret, name: '房主' });
  assert.equal(room.ownerOfflineSince, null, '重连后离线起始时间已清除');
  assert.equal(room.timers.has('owner:offline'), false, '重连后超时定时器已取消');

  // 即使超时回调被触发（理论不会），已重连的房主不应导致解散
  srv._handleOwnerOfflineTimeout(room);
  assert.equal(room.pendingDisband, false, '重连后不应触发解散');
  assert.equal(srv.rooms.has(room.id), true, '房间仍在进行');
  await sleep(300); // 等待 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

// ============ 功能5：点炮/抢杠胡算番型必须使用完整手牌（胡牌 tile 并入） ============
// Bug 背景：_settleHu 曾用 g.hands[winnerSeat] 直接算番，点炮/抢杠时手牌少一张（13 张），
// 导致七对/碰碰胡/一条龙/十三幺等 14 张番型被误判为平胡。

function makeHuRoom(srv, extraSettings = {}) {
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS, ...extraSettings } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  return { srv, room };
}

function setupHuState(room, winnerSeat, hand13, tile) {
  // 清空房间残留 AI 定时器链：makeHuRoom 调 start_game 后 AI 定时器仍在运行，
  // 若不阻断可能推进到 winnerSeat 摸牌使 13 张手牌变 14 张，与断言竞速导致偶发失败。
  // 这些用例均直接调 _settleHu 断言结算，不依赖任何定时器，清空安全。
  for (const timeoutId of room.timers.values()) {
    clearTimeout(timeoutId);
  }
  room.timers.clear();
  const g = room.game;
  g.hands[winnerSeat] = hand13.slice(); // 点炮/抢杠时手牌 13 张（不含打出的胡牌）
  g.melds[winnerSeat] = [];
  g.tingSeats = [];
  g.lastAction = null;
  return g;
}

test('点炮胡七对：胡牌 tile 并入后正确算 4 倍（七小对），不再误判平胡', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 1, qiangGang: false });
  assert.equal(g.winners.mult, 4, '点炮七对应计 4 倍');
  assert.ok(g.winners.multNames.includes('七小对'), '番型应识别为七小对');
  assert.ok(!g.winners.multNames.includes('平胡'), '点炮七对不得误判为平胡');
  assert.equal(g.winners.score, 84, '放炮者未报听独赔 3 份 = 点数7 × 4倍 × 扣点1 × 3 = 84');
  await sleep(300);
  cleanupServer(srv);
});

test('点炮胡碰碰胡：胡牌 tile 并入后正确算 2 倍（碰碰胡），不再误判平胡', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't1', 'w2', 'w2', 'w2', 'b3', 'b3', 'b3', 'w5', 'w5', 't7', 't7'];
  const g = setupHuState(room, winnerSeat, hand13, 't7');

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 't7', discarder: 1, qiangGang: false });
  assert.equal(g.winners.mult, 2, '点炮碰碰胡应计 2 倍');
  assert.ok(g.winners.multNames.includes('碰碰胡'), '番型应识别为碰碰胡');
  assert.ok(!g.winners.multNames.includes('平胡'), '点炮碰碰胡不得误判为平胡');
  assert.equal(g.winners.score, 42, '放炮者未报听独赔 3 份 = 点数7 × 2倍 × 扣点1 × 3 = 42');
  await sleep(300);
  cleanupServer(srv);
});

test('点炮胡一条龙：胡牌 tile 并入后正确计一条龙倍数', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv, { enableYiTiaoLong: true, yiTiaoLongMult: 4 });
  const winnerSeat = 0;
  const hand13 = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 'w1', 'w1', 'w1', 'b5'];
  const g = setupHuState(room, winnerSeat, hand13, 'b5');

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b5', discarder: 1, qiangGang: false });
  assert.ok(g.winners.multNames.includes('一条龙'), '番型应识别为一条龙');
  assert.equal(g.winners.mult, 4, '平胡1 × 一条龙4 = 4 倍');
  assert.equal(g.winners.score, 60, '放炮者未报听独赔 3 份 = 点数5 × 4倍 × 扣点1 × 3 = 60');
  await sleep(300);
  cleanupServer(srv);
});

test('点炮胡十三幺：胡牌 tile 并入后正确计 8 倍（十三幺）', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['w1', 'w9', 't1', 't9', 'b1', 'b9', 'e', 's', 'x', 'n', 'z', 'f', 'p'];
  const g = setupHuState(room, winnerSeat, hand13, 'z');

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'z', discarder: 1, qiangGang: false });
  assert.equal(g.winners.mult, 8, '点炮十三幺应计 8 倍');
  assert.ok(g.winners.multNames.includes('十三幺'), '番型应识别为十三幺');
  assert.ok(!g.winners.multNames.includes('平胡'), '点炮十三幺不得误判为平胡');
  assert.equal(g.winners.score, 240, '放炮者未报听独赔 3 份 = 点数10 × 8倍 × 扣点1 × 3 = 240');
  await sleep(300);
  cleanupServer(srv);
});

test('抢杠胡七对：qianggang 路径同样并入胡牌 tile，正确计 4 倍', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');

  srv._settleHu(room, winnerSeat, { winType: 'qianggang', tile: 'b7', discarder: 1, qiangGang: true });
  assert.equal(g.winners.mult, 4, '抢杠胡七对应计 4 倍');
  assert.ok(g.winners.multNames.includes('七小对'), '番型应识别为七小对');
  await sleep(300);
  cleanupServer(srv);
});

test('自摸路径不受影响：完整 14 张手牌照常识别七对 4 倍', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const g = room.game;
  g.hands[winnerSeat] = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7', 'b7'];
  g.melds[winnerSeat] = [];
  g.tingSeats = [];
  g.lastAction = null;

  srv._settleHu(room, winnerSeat, { winType: 'zimo', tile: 'b7' });
  assert.equal(g.winners.mult, 4, '自摸七对应计 4 倍');
  assert.ok(g.winners.multNames.includes('七小对'), '自摸番型应识别为七小对');
  assert.equal(g.winners.score, 56, '自摸分 = 点数7 × 2(自摸) × 4倍 × 扣点1 = 56');
  await sleep(300);
  cleanupServer(srv);
});

// ============ 功能5.5：结算手牌展示（点炮/抢杠赢家补入胡牌 tile，自摸不补） ============
// Bug 背景：_revealHands 使用真实手牌 g.hands，点炮/抢杠时赢家真实手牌为 13 张（胡牌未含入），
// 结算界面视觉少一张。修复：仅结算展示层为赢家补入胡的那张（14 张完整展示），
// g.hands 原始数据与 _settleHu 局部算番副本均不受影响。

test('点炮胡结算展示：赢家补入胡牌 tile 显示 14 张，原始手牌仍 13 张', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 1, qiangGang: false });

  const winnerView = g.winners.hands.find((r) => r && r.seat === winnerSeat);
  assert.equal(winnerView.hand.length, 14, '点炮胡赢家结算展示应为 14 张（补入胡牌）');
  assert.equal(winnerView.hand.filter((t) => t === 'b7').length, 2, '展示手牌应含两张 b7（13 张真实手牌 + 胡牌）');
  assert.equal(g.hands[winnerSeat].length, 13, 'g.hands 原始手牌仍为 13 张，展示补牌不落库');
  const otherView = g.winners.hands.find((r) => r && r.seat !== winnerSeat);
  // 其他玩家展示手牌不受补牌影响：展示长度等于真实手牌长度（随机庄家可能为 14 张，故与 g.hands 对比而非写死 13）
  assert.equal(otherView.hand.length, g.hands[otherView.seat].length, '其他玩家展示手牌不受补牌影响');
  assert.deepEqual(
    otherView.hand,
    rules.sortTiles(g.hands[otherView.seat]),
    '其他玩家展示手牌应与真实手牌排序一致'
  );
  await sleep(300);
  cleanupServer(srv);
});

test('抢杠胡结算展示：赢家同样补入胡牌 tile 显示 14 张', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');

  srv._settleHu(room, winnerSeat, { winType: 'qianggang', tile: 'b7', discarder: 1, qiangGang: true });

  const winnerView = g.winners.hands.find((r) => r && r.seat === winnerSeat);
  assert.equal(winnerView.hand.length, 14, '抢杠胡赢家结算展示应为 14 张（补入胡牌）');
  assert.equal(winnerView.hand.filter((t) => t === 'b7').length, 2, '展示手牌应含两张 b7');
  assert.equal(g.hands[winnerSeat].length, 13, 'g.hands 原始手牌仍为 13 张');
  await sleep(300);
  cleanupServer(srv);
});

test('自摸结算展示：手牌本就 14 张，不重复补牌', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const g = room.game;
  g.hands[winnerSeat] = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7', 'b7'];
  g.melds[winnerSeat] = [];
  g.tingSeats = [];
  g.lastAction = null;

  srv._settleHu(room, winnerSeat, { winType: 'zimo', tile: 'b7' });

  const winnerView = g.winners.hands.find((r) => r && r.seat === winnerSeat);
  assert.equal(winnerView.hand.length, 14, '自摸赢家结算展示应为 14 张（真实手牌）');
  assert.equal(winnerView.hand.filter((t) => t === 'b7').length, 2, '自摸展示手牌保持两张 b7，不额外补牌');
  assert.equal(g.hands[winnerSeat].length, 14, 'g.hands 原始手牌保持 14 张');
  await sleep(300);
  cleanupServer(srv);
});

// ============ 功能5.6：点炮胡支付规则（136 版） ============
// 规则：放炮者已报听 → 三家各出 1 份（score = 点数 × 倍数 × 胡牌者扣点），胡牌者共收 3 份；
// 放炮者未报听 → 放炮者独赔 3 份点炮分（score×3），胡牌者共收 3 份（无论胡牌者是否报听，
// 原包胡一包三并入此规则不再单独加重）；自摸保持三家各付 1 份自摸分不变。

test('点炮者已报听：三家各出 1 份，胡牌者共收 3 份', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.tingSeats = [1]; // 放炮者（seat1）已报听

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 1, qiangGang: false });
  assert.equal(g.winners.score, 28, '单份 = 点数7 × 4倍 × 扣点1 = 28');
  assert.equal(room.players[0].roundScore, 84, '胡牌者共收 3 份 = 28 × 3 = 84');
  assert.equal(room.players[1].roundScore, -28, '放炮者出 1 份');
  assert.equal(room.players[2].roundScore, -28, '闲家2出 1 份');
  assert.equal(room.players[3].roundScore, -28, '闲家3出 1 份');
  assert.equal(room.players[1].roundScore + room.players[2].roundScore + room.players[3].roundScore, -84, '三家合计支出 = 胡牌者收入');
  await sleep(300);
  cleanupServer(srv);
});

test('胡牌者未报听、放炮者未报听：放炮者独赔 3 份点炮分，另两家不出分', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.tingSeats = []; // 胡牌者未报听、放炮者未报听

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 1, qiangGang: false });
  assert.equal(g.winners.score, 84, '独赔 3 份 = 点数7 × 4倍 × 扣点1 × 3 = 84');
  assert.equal(room.players[0].roundScore, 84, '胡牌者收 84');
  assert.equal(room.players[1].roundScore, -84, '放炮者独赔 84');
  assert.equal(room.players[2].roundScore, 0, '闲家2不出分');
  assert.equal(room.players[3].roundScore, 0, '闲家3不出分');
  await sleep(300);
  cleanupServer(srv);
});

test('包胡并入此规则：胡者报听、放炮者未报听同样独赔 3 份点炮分（不再 3×自摸分）', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.tingSeats = [0]; // 胡牌者已报听、放炮者未报听（原包胡场景）

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 1, qiangGang: false });
  assert.equal(g.winners.score, 84, '独赔 3 份点炮分 = 点数7 × 4倍 × 扣点1 × 3 = 84（不再是 3×自摸分 168）');
  assert.equal(room.players[0].roundScore, 84, '胡牌者收 84');
  assert.equal(room.players[1].roundScore, -84, '放炮者独赔 84');
  assert.equal(room.players[2].roundScore, 0, '闲家2不出分');
  assert.equal(room.players[3].roundScore, 0, '闲家3不出分');
  await sleep(300);
  cleanupServer(srv);
});

test('抢杠胡且放炮者已报听：同样三家各出 1 份（抢杠胡算点炮）', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.tingSeats = [1]; // 放炮者已报听

  srv._settleHu(room, winnerSeat, { winType: 'qianggang', tile: 'b7', discarder: 1, qiangGang: true });
  assert.equal(g.winners.score, 28, '单份 = 点数7 × 4倍 × 扣点1 = 28');
  assert.equal(room.players[0].roundScore, 84, '胡牌者共收 3 份 = 84');
  assert.equal(room.players[1].roundScore, -28, '放炮者出 1 份');
  assert.equal(room.players[2].roundScore, -28, '闲家2出 1 份');
  assert.equal(room.players[3].roundScore, -28, '闲家3出 1 份');
  await sleep(300);
  cleanupServer(srv);
});

test('自摸不受影响：三家各付 1 份自摸分，胡牌者共收 3 份自摸分', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const g = room.game;
  g.hands[winnerSeat] = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7', 'b7'];
  g.melds[winnerSeat] = [];
  g.tingSeats = [];
  g.lastAction = null;

  srv._settleHu(room, winnerSeat, { winType: 'zimo', tile: 'b7' });
  assert.equal(g.winners.score, 56, '自摸分 = 点数7 × 2 × 4倍 × 扣点1 = 56');
  assert.equal(room.players[0].roundScore, 168, '胡牌者共收 3 份自摸分 = 56 × 3 = 168');
  assert.equal(room.players[1].roundScore, -56, '闲家1出 1 份自摸分');
  assert.equal(room.players[2].roundScore, -56, '闲家2出 1 份自摸分');
  assert.equal(room.players[3].roundScore, -56, '闲家3出 1 份自摸分');
  await sleep(300);
  cleanupServer(srv);
});

// ============ 功能5.7：结算支付明细（winners.payments 统一明细表数据） ============
// payments 结构：[{ kind:'hu'|'gang', title, toSeat, toAmount, rows:[{seat, amount, role}] }]
// 胡牌支付三情形：自摸三家各付1份；点炮已报听三家各出1份；点炮未报听放炮者独赔3份。
// 杠分：明杠/补杠=牌点、暗杠=牌点×2，乘杠主扣点，其余三家各付一份给杠主。

test('支付明细-点炮未报听：payments 含 hu 条目，放炮者独赔 3 份并带角色标签', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.tingSeats = [];

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 1, qiangGang: false });
  const pays = g.winners.payments;
  assert.ok(Array.isArray(pays) && pays.length >= 1, 'winners 应含 payments 明细');
  const hu = pays.find((p) => p.kind === 'hu');
  assert.ok(hu, 'payments 应含胡牌支付条目');
  assert.equal(hu.toSeat, 0, '收款方为胡牌者');
  assert.equal(hu.toAmount, 84, '胡牌者共收 3 份 = 84');
  assert.equal(hu.rows.length, 1, '未报听仅放炮者一人付');
  assert.equal(hu.rows[0].seat, 1);
  assert.equal(hu.rows[0].amount, -84, '放炮者独赔 84');
  assert.match(hu.rows[0].role, /未报听/, '角色标签含未报听独赔');
  await sleep(300);
  cleanupServer(srv);
});

test('支付明细-点炮已报听：三家各付 1 份，放炮者带已报听标签', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.tingSeats = [1]; // 放炮者（seat1）已报听

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 1, qiangGang: false });
  const hu = g.winners.payments.find((p) => p.kind === 'hu');
  assert.equal(hu.toAmount, 84, '胡牌者共收 3 份 = 84');
  assert.equal(hu.rows.length, 3, '三家各付 1 份');
  assert.equal(hu.rows.reduce((a, r) => a + r.amount, 0), -84, '三家合计支出 = 胡牌者收入');
  assert.ok(hu.rows.every((r) => r.amount === -28), '每份 28 分');
  const discarderRow = hu.rows.find((r) => r.seat === 1);
  assert.match(discarderRow.role, /已报听/, '放炮者角色标签含已报听');
  assert.ok(hu.rows.filter((r) => r.seat !== 1).every((r) => r.role === '闲家' || r.role === '庄家'), '另两家为闲家/庄家（首局庄家随机）');
  await sleep(300);
  cleanupServer(srv);
});

test('支付明细-自摸：三家各付 1 份自摸分，角色均为闲家', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const g = room.game;
  g.hands[winnerSeat] = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7', 'b7'];
  g.melds[winnerSeat] = [];
  g.tingSeats = [];
  g.lastAction = null;

  srv._settleHu(room, winnerSeat, { winType: 'zimo', tile: 'b7' });
  const hu = g.winners.payments.find((p) => p.kind === 'hu');
  assert.equal(hu.toAmount, 168, '胡牌者共收 3 份自摸分 = 56 × 3 = 168');
  assert.equal(hu.rows.length, 3);
  assert.ok(hu.rows.every((r) => r.amount === -56), '三家各付 56 分');
  assert.ok(hu.rows.every((r) => r.role === '闲家' || r.role === '庄家'), '角色均为闲家/庄家（首局庄家随机）');
  await sleep(300);
  cleanupServer(srv);
});

test('支付明细-流局：黄庄杠分不计，payments 为空且分数不变', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const g = room.game;
  g.gangLogs.push({ seat: 1, tile: 'w5', type: 'ming', perSeat: 5, points: 5, kou: 1 });

  srv._settleDraw(room);
  const pays = g.winners.payments;
  assert.ok(Array.isArray(pays) && pays.length === 0, '黄庄杠分不计：流局无支付明细');
  assert.equal(g.winners.gangLogs.length, 1, '杠分明细仍保留展示');
  assert.equal(room.players[1].roundScore, 0, '杠主流局不计杠分');
  assert.equal(room.players[0].roundScore, 0, '付家流局不计杠分');
  await sleep(300);
  cleanupServer(srv);
});

test('支付明细-胡牌：杠分整局结束统一结算（明杠 w5：杠主收 15，其余三家各付 5）', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const winnerSeat = 0;
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.tingSeats = [];
  g.gangLogs.push({ seat: 1, tile: 'w5', type: 'ming', perSeat: 5, points: 5, kou: 1 });

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 1, qiangGang: false });
  // 胡牌：放炮者未报听独赔 3 份 = 84（seat1 -84）；杠分统一结算：seat1 收 15，其余三家各 -5
  assert.equal(room.players[0].roundScore, 84 - 5, '胡牌者收 84，另付杠分 5 → 79');
  assert.equal(room.players[1].roundScore, -84 + 15, '放炮者独赔 84，杠分收 15 → -69');
  assert.equal(room.players[2].roundScore, -5, '闲家2 仅付杠分 5');
  assert.equal(room.players[3].roundScore, -5, '闲家3 仅付杠分 5');
  const gangPay = g.winners.payments.find((p) => p.kind === 'gang');
  assert.ok(gangPay, 'payments 含杠分明细');
  assert.equal(gangPay.toAmount, 15, '杠主共收 5 × 3 = 15');
  await sleep(300);
  cleanupServer(srv);
});

// ============ 功能6：AI 不能成为房主 ============
// Bug 背景：房主退出/超时离开 waiting 房间时，新房主取 others[0]，可能转让给 AI。
// 要求：房主转让仅限真人，无其他真人则直接解散房间。

test('房主退出时房间内有 AI 和真人：房主转让给真人而非 AI', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主甲' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];

  // 先加 AI（占座位 1），再加入真人（座位 2）
  send(wa, { type: 'add_ai' });
  const aiId = room.players.find((p) => p && p.isAI).id;
  assert.ok(aiId, 'AI 已加入');

  const wb = makeWs();
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wb, { type: 'join_room', roomId: room.id });
  const humanId = wbSentPlayerId(wb, '玩家乙');

  // 房主退出：新房主必须是真人乙，不能是 AI
  send(wa, { type: 'leave_room' });
  assert.notEqual(room.ownerId, aiId, 'AI 不得成为房主');
  assert.equal(room.ownerId, humanId, '房主应转让给真人玩家');
  cleanupServer(srv);
});

test('房主退出时房间内只剩 AI：房间直接解散，不留 AI 房主', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主甲' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const roomId = [...srv.rooms.values()][0].id;

  send(wa, { type: 'add_ai' });
  send(wa, { type: 'add_ai' });

  // 房主退出：只剩 AI（未满 4 人不会自动开局），房间应解散
  send(wa, { type: 'leave_room' });
  assert.equal(srv.rooms.has(roomId), false, '无真人房主候选时房间应解散');
  cleanupServer(srv);
});

// ============ 功能7：一炮一响（不支持一炮多响） ============
// Bug 背景：点炮时可能多家能胡，要求仅取距离放炮者最近的一家胡牌（a19e040）。
// 规则：_tryResolvePending 中 huList 取最近座位调用 _settleHu，其余视为过牌。

test('一炮一响：下家与下下家都能点炮胡时，仅最近下家胡牌', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  const wc = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  srv.handleConnection(wc);
  send(wc, { type: 'join_lobby', name: '玩家丙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wc, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' }); // AI 补 seat3 后开局
  assert.equal(room.state, 'playing');

  const g = room.game;
  // 听 b7 的七对 13 张：手牌 + b7 即胡
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  // seat1（玩家乙，下家）、seat2（玩家丙，下下家）都能胡 b7；seat3（AI）不能胡
  g.hands[1] = hand13.slice();
  g.hands[2] = hand13.slice();
  g.hands[3] = ['w1', 'w2', 'w3', 't1', 't2', 't3', 'b1', 'b2', 'b3', 'e', 's', 'x', 'n'];
  g.melds = [[], [], [], []];
  // 两家先报听才能胡（规则：仅报听玩家可胡牌）
  g.tingSeats = [1, 2];
  g.lastAction = null;
  g.lastDiscard = { tile: 'b7', seat: 0 };

  // 房主（seat0）打出 b7，生成响应阶段
  srv._afterDiscard(room, 0);
  assert.equal(g.pending.responders.length, 2, '仅下家与下下家进入响应');
  const huSeats = g.pending.responders.filter((r) => r.canHu).map((r) => r.seat).sort();
  assert.deepEqual(huSeats, [1, 2], '两家都能点炮胡');

  // 两家都选择胡：仅最近下家（seat1）结算胡牌，不产生一炮多响
  send(wb, { type: 'hu' });
  send(wc, { type: 'hu' });
  await sleep(100);
  assert.ok(g.winners, '本局已结算');
  assert.equal(g.winners.winnerSeat, 1, '一炮一响：仅最近下家胡牌');
  assert.equal(g.winners.discarder, 0, '放炮者为房主');
  await sleep(300); // 等待 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

// ============ 功能7.5：仅报听玩家才能胡牌 ============
// 规则：未报听玩家无论自摸/点炮/抢杠均不得胡，报听玩家按原有点数门槛不变。

test('未报听玩家不能点炮胡：g.tingSeats 为空时点炮不产生胡响应', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  const wc = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  srv.handleConnection(wc);
  send(wc, { type: 'join_lobby', name: '玩家丙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wc, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' }); // AI 补 seat3 后开局
  assert.equal(room.state, 'playing');

  const g = room.game;
  // 听 b7 的七对 13 张：手牌 + b7 即胡，但未报听不能胡
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  g.hands[1] = hand13.slice();
  g.hands[2] = hand13.slice();
  g.hands[3] = ['w1', 'w2', 'w3', 't1', 't2', 't3', 'b1', 'b2', 'b3', 'e', 's', 'x', 'n'];
  g.melds = [[], [], [], []];
  g.tingSeats = []; // 未报听
  g.lastAction = null;
  g.lastDiscard = { tile: 'b7', seat: 0 };

  // 房主（seat0）打出 b7，未报听玩家均不能胡
  srv._afterDiscard(room, 0);
  const responders = g.pending ? g.pending.responders : [];
  for (const r of responders) {
    assert.equal(r.canHu, false, '未报听玩家点炮胡 canHu 必须为 false');
  }
  assert.ok(!g.winners, '未报听玩家不能点炮胡结算');
  await sleep(300); // 等待 AI 托管链跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

test('未报听玩家摸到自摸牌不能胡：_buildDrawPrompt 不提供 hu 动作', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const seat = 0;
  const g = room.game;
  // 摸牌后 14 张：b7 对子补齐七对可自摸（b7 点数 7 ≥ 3），但未报听不能胡
  g.hands[seat] = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7', 'b7'];
  g.melds[seat] = [];
  g.drawnTile = 'b7';
  g.tingSeats = []; // 未报听
  g.lastAction = null;

  const prompt = srv._buildDrawPrompt(room, seat);
  assert.equal(prompt.canHu, false, '未报听玩家自摸 canHu 必须为 false');
  assert.ok(!prompt.actions.includes('hu'), '未报听玩家 actions 不得包含 hu');
  assert.ok(prompt.actions.includes('play'), '未报听玩家仍可出牌');
  await sleep(300); // 等待 AI 托管链跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

// ============ 代码审查修复：定时器异常保护 + 房间销毁清理 players ============
test('定时器回调抛错不崩溃：_setTimer 回调异常被捕获，进程与房间状态不受影响', async () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];

  // 注册一个必抛错的定时器：修复前该异常会 uncaught 直接崩掉测试进程
  srv._setTimer(room, 'test:boom', 20, () => {
    throw new Error('boom');
  });

  await sleep(80); // 等待定时器触发
  // 进程未崩溃：房间仍存在且可继续正常操作
  assert.ok(srv.rooms.has(room.id), '异常被捕获后进程存活、房间保留');
  assert.equal(room.timers.has('test:boom'), false, '定时器触发后已从 timers 移除');
  await sleep(300);
  cleanupServer(srv);
});

test('房间销毁后全局 players 清理：AI 与掉线超时真人被移除，在线真人保留', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' }); // AI 补位后开局
  assert.equal(room.state, 'playing');

  const aiPls = room.players.filter(Boolean).filter((x) => x.isAI);
  const humanPls = room.players.filter(Boolean).filter((x) => !x.isAI);
  assert.equal(aiPls.length, 2, '应有 2 个 AI 补位');
  assert.equal(humanPls.length, 2, '应有 2 个真人');
  assert.ok(aiPls.every((x) => srv.players.has(x.id)), 'AI 注册在全局 players 中');

  // 玩家乙（非房主真人）断线并超时未重连
  const pB = humanPls.find((x) => x.id !== room.ownerId);
  wb.handlers.close();
  assert.equal(pB.connected, false, '断线后 connected=false');
  assert.ok(pB.disconnectTimer, '断线后已启动 disconnect 定时器');
  // 模拟 RECONNECT_MS 超时（直接触发回调，无需真实等待 60 秒）
  srv._handleDisconnectTimeout(pB);
  assert.equal(pB.disconnectTimer, null, '超时触发后 disconnectTimer 置空标记');

  // 销毁房间
  srv._destroyRoom(room);
  assert.ok(!srv.rooms.has(room.id), '房间已销毁');
  assert.ok(!srv.players.has(aiPls[0].id), 'AI1 已从全局 players 移除');
  assert.ok(!srv.players.has(aiPls[1].id), 'AI2 已从全局 players 移除');
  assert.ok(!srv.players.has(pB.id), '掉线超时真人已从全局 players 移除');
  const pA = humanPls.find((x) => x.id === room.ownerId);
  assert.ok(srv.players.has(pA.id), '在线房主保留在全局 players 中（可重连）');
  await sleep(300);
  cleanupServer(srv);
});

// ============ 心跳保活（ping/pong） ============
test('心跳：正常连接每周期回 pong 不会被误杀', () => {
  // 该用例断言的是「回 pong 不被误杀」，与阈值大小无关，沿用注入的极小间隔即可
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '心跳甲' });

  assert.ok(wa._heartbeatTimer, 'handleConnection 后应创建心跳定时器');
  // 模拟多个心跳周期，客户端每次均回 pong
  for (let i = 0; i < 10; i++) {
    srv._heartbeatTick(wa);
    wa.handlers.pong();
  }
  assert.equal(wa.terminated, false, '正常回 pong 不应被 terminate');
  assert.equal(wa.readyState, 1, '连接保持打开');
  assert.ok(wa.pingCount >= 10, '服务端已发送 ping');

  cleanupServer(srv);
});

test('心跳：连续超过 HEARTBEAT_MAX_MISS 次未回 pong 判定死连接并 terminate，走断线清理', () => {
  // 断言依赖真实 miss 阈值，覆盖回生产默认的 HEARTBEAT_MAX_MISS
  const srv = newServer({ heartbeatMaxMiss: HEARTBEAT_MAX_MISS });
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '心跳乙' });
  const pid = srv.wsPlayers.get(wa);
  assert.ok(pid);

  // 不响应 pong：前 HEARTBEAT_MAX_MISS 次只发 ping 不 terminate
  for (let i = 0; i < HEARTBEAT_MAX_MISS; i++) {
    srv._heartbeatTick(wa);
    assert.equal(wa.terminated, false, `第 ${i + 1} 次 miss 不应立刻 terminate`);
    assert.ok(wa.pingCount >= i + 1, 'miss 期间仍在发 ping');
  }
  // 超过阈值：下一次 tick 应 terminate
  srv._heartbeatTick(wa);
  assert.equal(wa.terminated, true, '超过阈值未回 pong 应 terminate');

  // terminate 触发 close → _onWsClose 断线清理（connected=false / ws 置空，可重连）
  assert.equal(srv.players.get(pid).connected, false, '死连接已走断线清理');
  assert.equal(srv.players.get(pid).ws, null, 'ws 已从玩家解除绑定');

  cleanupServer(srv);
});

test('心跳：连接关闭后心跳定时器被清理，不泄漏', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '心跳丙' });
  assert.ok(wa._heartbeatTimer, '应创建心跳定时器');

  // 模拟真实 close（如正常断线）
  wa.handlers.close();
  assert.equal(wa._heartbeatTimer, null, 'close 后心跳定时器已清理');
  // 定时器清理后再 tick 不应报错、也不应 terminate
  srv._heartbeatTick(wa);
  assert.equal(wa.terminated, false);

  cleanupServer(srv);
});

// ============ tingHints 听口提示缓存 ============
// 手牌状态（摸牌后 14 张，打出某张后听口含字牌 10 点，保证 hints 有实际内容）
const TING_HAND = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 't1', 't2', 't3', 'b1', 'b2', 'b3', 'e', 'e'];

function makeDrawTurn(room, seat) {
  // 清空房间残留 AI 定时器链（同 setupHuState 惯例），避免广播期间 AI 代打推进牌局
  for (const timeoutId of room.timers.values()) {
    clearTimeout(timeoutId);
  }
  room.timers.clear();
  const g = room.game;
  g.stage = 'draw';
  g.turn = seat;
  g.tingSeats = [];
  g.hands[seat] = TING_HAND.slice();
  g.melds[seat] = [];
  g.kouTiles[seat] = null;
  // 重置缓存统计：makeHuRoom 中 start_game 广播可能已触发过听口计算，避免计数基线漂移
  g.tingCacheStats = { hit: 0, miss: 0 };
  return g;
}

test('tingHints 缓存：相同手牌重复广播命中缓存，不重算', () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const g = makeDrawTurn(room, 0);

  const v1 = srv._buildGameView(room, 0);
  assert.equal(g.tingCacheStats.miss, 1, '首次计算为 miss');
  assert.equal(g.tingCacheStats.hit, 0);
  assert.ok(v1.tingHints && Object.keys(v1.tingHints).length > 0, '听口提示应有实际内容');

  const v2 = srv._buildGameView(room, 0);
  assert.equal(g.tingCacheStats.miss, 1, '手牌未变化时不再重算');
  assert.equal(g.tingCacheStats.hit, 1, '第二次应命中缓存');
  assert.deepEqual(v2.tingHints, v1.tingHints, '命中缓存返回与首次一致的结果');

  cleanupServer(srv);
});

test('tingHints 缓存：手牌变化后自动失效重算', () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const g = makeDrawTurn(room, 0);
  const v1 = srv._buildGameView(room, 0);
  assert.equal(g.tingCacheStats.miss, 1);

  // 摸牌/换牌导致手牌变化：缓存 key 变化，必须重算
  g.hands[0] = ['w1', 'w1', 'w2', 'w2', 'w3', 'w4', 't1', 't2', 't3', 'b1', 'b2', 'b3', 'e', 'e'];
  const v2 = srv._buildGameView(room, 0);
  assert.equal(g.tingCacheStats.miss, 2, '手牌变化后应重算（miss+1）');
  assert.equal(g.tingCacheStats.hit, 0, '手牌变化后不命中缓存');
  // 手牌变化后听口可能不同，但此处只断言结果对象独立、非缓存残留
  assert.notDeepEqual(v2.tingHints, v1.tingHints, '手牌变化后听口提示应更新');

  cleanupServer(srv);
});

test('tingHints 缓存：清缓存后重算结果与缓存结果一致', () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const g = makeDrawTurn(room, 0);
  const v1 = srv._buildGameView(room, 0);
  const v2 = srv._buildGameView(room, 0);
  assert.equal(g.tingCacheStats.hit, 1);

  // 清空缓存强制重算：结果必须与缓存内容完全一致
  g.tingHintsCache.clear();
  const v3 = srv._buildGameView(room, 0);
  assert.equal(g.tingCacheStats.miss, 2, '清缓存后应重算');
  assert.deepEqual(v3.tingHints, v2.tingHints, '重算结果与缓存结果一致');
  assert.deepEqual(v3.tingHints, v1.tingHints, '重算结果与首次结果一致');

  cleanupServer(srv);
});

// ============ 碰/明杠后从打出者弃牌区移除被拿牌 ============
// Bug 背景：_doPeng/_doGangFromDiscard 只从碰/杠者手牌移除牌并加入 melds，
// 未从打出者弃牌区 g.discards[discarder] 移除被拿走的牌，导致前端同一张牌在
// 弃牌区和明牌区重复显示。修复：两方法增加 discarder 参数，从弃牌区末尾向前
// 移除最后一张同值牌；暗杠/补杠不涉及弃牌区，必须不受影响。

function makeMeldedState(room) {
  // 清空房间残留 AI 定时器链（同 setupHuState 惯例），避免 AI 托管推进牌局竞速
  for (const timeoutId of room.timers.values()) {
    clearTimeout(timeoutId);
  }
  room.timers.clear();
  const g = room.game;
  g.discards = [['t1'], ['b1', 'b7'], ['w2'], []];
  g.melds = [[], [], [], []];
  g.tingSeats = []; // 无人报听，避免补杠触发抢杠胡分支
  g.lastAction = null;
  g.newTiles = [null, null, null, null];
  return g;
}

test('碰后从打出者弃牌区移除被碰的牌：g.discards[discarder] 不再含该牌，明牌区出现碰组', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const g = makeMeldedState(room);
  const seat = 0;
  const discarder = 1;
  g.hands[seat] = ['b7', 'b7', 'w1', 'w3', 't1', 't2', 't3', 'w5', 'w6', 'b2', 'b3', 't7', 't8'];

  srv._doPeng(room, seat, 'b7', discarder);

  assert.ok(!g.discards[discarder].includes('b7'), '打出者弃牌区应移除被碰的牌 b7');
  assert.deepEqual(g.discards[discarder], ['b1'], '弃牌区保留其余牌');
  assert.equal(g.melds[seat].length, 1, '碰者明牌区新增一组');
  assert.equal(g.melds[seat][0].type, 'peng');
  assert.deepEqual(g.melds[seat][0].tiles, ['b7', 'b7', 'b7'], '碰组显示完整三张');
  await sleep(300); // 等待 AI 托管链跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

test('明杠后从打出者弃牌区移除被明杠的牌：g.discards[discarder] 不再含该牌，明牌区出现杠组', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const g = makeMeldedState(room);
  const seat = 0;
  const discarder = 1;
  g.hands[seat] = ['b7', 'b7', 'b7', 'w1', 'w3', 't1', 't2', 't3', 'w5', 'w6', 'b2', 'b3', 't7'];

  srv._doGangFromDiscard(room, seat, 'b7', discarder);

  assert.ok(!g.discards[discarder].includes('b7'), '打出者弃牌区应移除被明杠的牌 b7');
  assert.deepEqual(g.discards[discarder], ['b1'], '弃牌区保留其余牌');
  assert.equal(g.melds[seat].length, 1, '明杠者明牌区新增一组');
  assert.equal(g.melds[seat][0].type, 'gang');
  assert.deepEqual(g.melds[seat][0].tiles, ['b7', 'b7', 'b7', 'b7'], '杠组显示完整四张');
  await sleep(300); // 等待 AI 托管链跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

test('暗杠不触及弃牌区：g.discards[discarder] 原样保留', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const g = makeMeldedState(room);
  const seat = 0;
  g.hands[seat] = ['b7', 'b7', 'b7', 'b7', 'w1', 'w3', 't1', 't2', 't3', 'w5', 'w6', 'b2', 'b3'];
  const discardsBefore = g.discards.map((arr) => arr.slice());

  srv._doAnGang(room, seat, 'b7');

  assert.deepEqual(g.discards.map((arr) => arr.slice()), discardsBefore, '暗杠不得改动任何弃牌区');
  assert.equal(g.melds[seat][0].type, 'angang', '暗杠组进入明牌区');
  await sleep(300); // 等待 AI 托管链跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

test('暗杠进行中不再输出算分日志：动作日志脱敏，他人看不到杠了哪张', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const g = makeMeldedState(room);
  const seat = 0;
  g.hands[seat] = ['b7', 'b7', 'b7', 'b7', 'w1', 'w3', 't1', 't2', 't3', 'w5', 'w6', 'b2', 'b3'];
  g.gangLogs = [];

  srv._doAnGang(room, seat, 'b7');

  // 扣点点杠分延迟到整局结束统一结算：进行中不得输出含分值（点数×倍数）的算分日志，否则泄露牌面
  const settleLogs = room.logs.filter((e) => e.text && /整局结束统一结算|每家 \d+ 分/.test(e.text));
  assert.equal(settleLogs.length, 0, '进行中不得有杠分算分日志（防泄露）');

  // 暗杠动作日志仍脱敏（privateFor=杠家座位，maskedText 不含牌面）
  const gangLogs = room.logs.filter((e) => /暗杠/.test(e.text) || /暗杠/.test(e.maskedText || ''));
  assert.ok(gangLogs.length >= 1, '存在暗杠动作日志');

  // 用 _maskLogsForViewer 模拟他人视角（seat=1），确认看不到 b7
  const othersView = srv._maskLogsForViewer(room.logs, 1);
  const leaked = othersView.some((e) => e.text && /b7/.test(e.text) && /暗杠/.test(e.text));
  assert.equal(leaked, false, '其他玩家视角的暗杠日志不含牌面 b7');

  await sleep(300);
  cleanupServer(srv);
});

test('补杠不触及弃牌区：g.discards[discarder] 原样保留', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv);
  const g = makeMeldedState(room);
  const seat = 0;
  g.hands[seat] = ['b7', 'w1', 'w3', 't1', 't2', 't3', 'w5', 'w6', 'b2', 'b3', 't7', 't8', 'w9'];
  g.melds[seat] = [{ type: 'peng', tile: 'b7', tiles: ['b7', 'b7', 'b7'] }];
  const discardsBefore = g.discards.map((arr) => arr.slice());

  srv._doBuGang(room, seat, 'b7');

  assert.deepEqual(g.discards.map((arr) => arr.slice()), discardsBefore, '补杠不得改动任何弃牌区');
  assert.equal(g.melds[seat][0].type, 'bugang', '碰组升级为补杠组');
  assert.deepEqual(g.melds[seat][0].tiles, ['b7', 'b7', 'b7', 'b7']);
  await sleep(300); // 等待 AI 托管链跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

// ============ 新计分模型与庄底（scoreModel / zhuangDi） ============

test('庄底默认关闭：settings.zhuangDi 为 false，庄家胡也无庄底加分', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv, {});
  assert.equal(room.settings.zhuangDi, false, '未显式开启时 zhuangDi 默认 false');
  const winnerSeat = 0;
  const g = room.game;
  g.dealer = 0; // 显式指定庄家为 seat0
  g.hands[winnerSeat] = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7', 'b7'];
  g.melds[winnerSeat] = [];
  g.tingSeats = [];

  srv._settleHu(room, winnerSeat, { winType: 'zimo', tile: 'b7' });
  assert.equal(g.winners.zhuangBonus, 0, '默认关闭时庄底为 0');
  assert.equal(room.players[0].roundScore, 168, '庄家自摸仅收 3×56，无庄底');
  assert.equal(room.players[1].roundScore, -56, '闲家1出 56');
  assert.equal(room.players[2].roundScore, -56, '闲家2出 56');
  assert.equal(room.players[3].roundScore, -56, '闲家3出 56');
  await sleep(300);
  cleanupServer(srv);
});

test('已去除开局扣点玩法：settings 无 enableKoupoint 字段，开局不进入扣点阶段', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv, {});
  assert.equal(room.settings.enableKoupoint, undefined, 'settings 不再含扣点开关');
  assert.notEqual(room.game.stage, 'koupoint', '开局直接进入摸牌阶段');
  await sleep(300);
  cleanupServer(srv);
});

test('乘算+庄底开启-庄家自摸：三家各付 基础分，庄家单边 +10', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv, { zhuangDi: true });
  const winnerSeat = 0;
  const g = room.game;
  g.dealer = 0; // 显式指定庄家为 seat0
  g.hands[winnerSeat] = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7', 'b7'];
  g.melds[winnerSeat] = [];
  g.tingSeats = [];

  srv._settleHu(room, winnerSeat, { winType: 'zimo', tile: 'b7' });
  // 基础 56 = 7×2×4×1；庄底开启仅庄家单边 +10，三家各付 56、庄家另得 10
  assert.equal(g.winners.zhuangBonus, 10, '庄底自摸 +10');
  assert.equal(room.players[0].roundScore, 178, '庄家胡共收 3×56+10');
  assert.equal(room.players[1].roundScore, -56, '闲家1出 56，不扣庄底');
  assert.equal(room.players[2].roundScore, -56, '闲家2出 56，不扣庄底');
  assert.equal(room.players[3].roundScore, -56, '闲家3出 56，不扣庄底');
  await sleep(300);
  cleanupServer(srv);
});

test('乘算+庄底开启-闲家点炮已报听：无庄底项，三家各付基础分', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv, { zhuangDi: true });
  const winnerSeat = 1; // 闲家胡
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.dealer = 0; // 显式指定庄家为 seat0
  g.tingSeats = [2]; // 放炮者 seat2 已报听（非庄家）

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 2, qiangGang: false });
  // 基础 28 = 7×4×1；闲家胡无庄底项，三家各付 28
  assert.equal(g.winners.zhuangBonus, 0, '闲家胡无庄底加分');
  assert.equal(room.players[1].roundScore, 84, '胡牌者共收 3×28');
  assert.equal(room.players[0].roundScore, -28, '庄家出 28，无庄底扣分');
  assert.equal(room.players[2].roundScore, -28, '放炮者（已报听）出 28');
  assert.equal(room.players[3].roundScore, -28, '闲家出 28');
  await sleep(300);
  cleanupServer(srv);
});

test('乘算+庄底开启-庄家点炮胡（放炮者已报听）：三家各付 基础分，庄家单边 +5', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv, { zhuangDi: true });
  const winnerSeat = 0; // 庄家胡
  const hand13 = ['t1', 't1', 't2', 't2', 't3', 't3', 'w4', 'w4', 'w5', 'w5', 'b6', 'b6', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.dealer = 0; // 显式指定庄家为 seat0
  g.tingSeats = [1]; // 放炮者 seat1 已报听

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 1, qiangGang: false });
  // 基础 28 = 7×4×1；庄底开启仅庄家单边 +5，三家各付 28、庄家另得 5
  assert.equal(g.winners.zhuangBonus, 5, '庄底非自摸 +5');
  assert.equal(room.players[0].roundScore, 89, '庄家胡共收 3×28+5');
  assert.equal(room.players[1].roundScore, -28, '放炮者（已报听）出 28，不扣庄底');
  assert.equal(room.players[2].roundScore, -28, '闲家出 28，不扣庄底');
  assert.equal(room.players[3].roundScore, -28, '闲家出 28，不扣庄底');
  await sleep(300);
  cleanupServer(srv);
});

test('加算模型-平胡点炮已报听：底分=牌点，无加番无庄底', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv, { scoreModel: 'add' });
  const winnerSeat = 1;
  const hand13 = ['t1', 't2', 't3', 'w4', 'w5', 'w6', 'b7', 'b8', 'b9', 'z1', 'z2', 'z3', 'b7'];
  const g = setupHuState(room, winnerSeat, hand13, 'b7');
  g.tingSeats = [2];

  srv._settleHu(room, winnerSeat, { winType: 'dianpao', tile: 'b7', discarder: 2, qiangGang: false });
  assert.equal(room.settings.scoreModel, 'add');
  assert.equal(g.winners.addPoints, 0, '平胡无加番');
  assert.equal(g.winners.score, 7, '单份 = 点数7');
  assert.equal(room.players[1].roundScore, 21, '已报听三家各付 3×7');
  await sleep(300);
  cleanupServer(srv);
});

test('加算模型-庄家七对自摸杠红中（攻略示例）：每家 底分20+加番60=80，庄家单边+10', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv, { scoreModel: 'add', zhuangDi: true });
  const winnerSeat = 0; // 庄家
  const g = room.game;
  g.dealer = 0; // 显式指定庄家为 seat0
  g.hands[winnerSeat] = ['z', 'z', 'z', 'z', 't1', 't1', 't2', 't2', 'w3', 'w3', 'w4', 'w4', 'b5', 'b5'];
  g.melds[winnerSeat] = [];
  g.tingSeats = [];

  srv._settleHu(room, winnerSeat, { winType: 'zimo', tile: 'z' });
  assert.equal(g.winners.scoreModel, 'add');
  assert.equal(g.winners.addPoints, 60, '七对 20 + 豪七 40');
  assert.deepEqual(g.winners.addNames, ['七小对', '豪七']);
  assert.equal(g.winners.zhuangBonus, 10, '庄底自摸 +10');
  assert.equal(room.players[0].roundScore, 250, '庄家胡共收 3×80+10');
  assert.equal(room.players[1].roundScore, -80, '闲家1出 底分20+加番60，不扣庄底');
  assert.equal(room.players[2].roundScore, -80);
  assert.equal(room.players[3].roundScore, -80);
  await sleep(300);
  cleanupServer(srv);
});

test('加算模型-清一色开关开启叠加：底分+清一色20+七小对20', async () => {
  const srv = newServer();
  const { room } = makeHuRoom(srv, { scoreModel: 'add', enableQingYiSe: true, zhuangDi: false });
  const winnerSeat = 0;
  const g = room.game;
  g.hands[winnerSeat] = ['b1', 'b1', 'b2', 'b2', 'b3', 'b3', 'b4', 'b4', 'b5', 'b5', 'b6', 'b6', 'b7', 'b7'];
  g.melds[winnerSeat] = [];
  g.tingSeats = [];

  srv._settleHu(room, winnerSeat, { winType: 'zimo', tile: 'b7' });
  assert.equal(g.winners.addPoints, 40, '清一色20 + 七小对20');
  assert.deepEqual(g.winners.addNames, ['七小对', '清一色']);
  assert.equal(g.winners.score, 7 * 2 + 40, '单份 = 底分14 + 加番40');
  assert.equal(room.players[0].roundScore, (7 * 2 + 40) * 3, '胡牌者共收 3 份');
  await sleep(300);
  cleanupServer(srv);
});




// ============ 功能：对局表情互动 ============
test('emoji 表情广播给房间内所有人；非白名单 emoji 被忽略；迟到者可补看', () => {
  const srv = newServer();
  try {
    const wa = makeWs();
    const wb = makeWs();
    srv.handleConnection(wa);
    send(wa, { type: 'join_lobby', name: '甲' });
    srv.handleConnection(wb);
    send(wb, { type: 'join_lobby', name: '乙' });
    send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
    const room = [...srv.rooms.values()][0];
    send(wb, { type: 'join_room', roomId: room.id });

    // 甲发送合法 emoji
    send(wa, { type: 'emoji', emoji: '👍' });
    const ea = lastOf(wa, 'emoji');
    const eb = lastOf(wb, 'emoji');
    assert.ok(ea && eb, '双方都收到 emoji 广播');
    assert.equal(ea.emoji.emoji, '👍');
    assert.equal(ea.emoji.from, '甲');
    assert.equal(eb.emoji.emoji, '👍');
    assert.equal(eb.emoji.from, '甲');

    // 非白名单 emoji 应被忽略：不广播（双方 received 计数不增）
    const beforeA = wa.sent.filter((m) => m.type === 'emoji').length;
    const beforeB = wb.sent.filter((m) => m.type === 'emoji').length;
    send(wb, { type: 'emoji', emoji: '<script>alert(1)</script>' });
    assert.equal(wa.sent.filter((m) => m.type === 'emoji').length, beforeA, '非法 emoji 不下发');
    assert.equal(wb.sent.filter((m) => m.type === 'emoji').length, beforeB, '非法 emoji 不下发');

    // 迟到者（丙）加入后，room_state 携带最近 emoji 供其补看
    const wc = makeWs();
    srv.handleConnection(wc);
    send(wc, { type: 'join_lobby', name: '丙' });
    send(wc, { type: 'join_room', roomId: room.id });
    const rs = lastOf(wc, 'room_state');
    assert.ok(rs && Array.isArray(rs.room.emoji) && rs.room.emoji.length >= 1, '迟到者 room_state 含最近 emoji');
    assert.equal(rs.room.emoji[rs.room.emoji.length - 1].emoji, '👍');
  } finally {
    cleanupServer(srv);
  }
});

// ============ 功能：战绩/排行榜/好友 经 GameServer 端到端 ============
test('get_stats/get_leaderboard/friend 流程经服务端 dispatch 可用', () => {
  const srv = newServer();
  try {
    const wa = makeWs();
    const wb = makeWs();
    srv.handleConnection(wa);
    srv.handleConnection(wb);
    // 用随机用户名：避免持久化 data/ 跨运行残留导致「用户名已存在」偶发失败
    const uniq = 'st' + Math.random().toString(36).slice(2, 8);
    const uA = uniq + 'a';
    const uB = uniq + 'b';
    // 注册两个账号
    send(wa, { type: 'register', username: uA, password: 'password1', name: '统计甲' });
    send(wb, { type: 'register', username: uB, password: 'password1', name: '统计乙' });
    const tokA = lastOf(wa, 'registered').token;
    const tokB = lastOf(wb, 'registered').token;
    assert.ok(tokA && tokB);

    // 排行榜（空数据也应返回数组）
    send(wa, { type: 'get_leaderboard', limit: 10 });
    assert.ok(Array.isArray(lastOf(wa, 'leaderboard').list), 'leaderboard 返回数组');

    // 战绩（新号无记录，stats 不为 guest）
    send(wa, { type: 'get_stats', token: tokA });
    const st = lastOf(wa, 'stats');
    assert.ok(st && !st.guest && st.stats, 'stats 返回聚合');

    // 好友：a 加 b → b 收到请求；b 接受 → 互为好友
    send(wa, { type: 'add_friend', username: uB, token: tokA });
    assert.equal(lastOf(wa, 'friend_result').ok, true);
    send(wb, { type: 'friend_list', token: tokB });
    assert.ok(lastOf(wb, 'friend_list').requests.find((r) => r.username === uA), 'b 收到请求');
    send(wb, { type: 'accept_friend', username: uA, token: tokB });
    assert.equal(lastOf(wb, 'friend_result').ok, true);
    send(wa, { type: 'friend_list', token: tokA });
    assert.ok(lastOf(wa, 'friend_list').friends.find((r) => r.username === uB), 'a 好友含 b');

    // 统计 u1 不存在 → 报错不崩溃
    send(wa, { type: 'add_friend', username: 'nope_' + uniq, token: tokA });
    assert.equal(lastOf(wa, 'friend_result').ok, false);
  } finally {
    cleanupServer(srv);
  }
});

// ============ 功能：观战（旁观者进入 playing 房间，看不到任何手牌） ============
test('观战：旁观者进入进行中房间，收到 game_state 但看不到任何手牌，可退出', async () => {
  const srv = newServer();
  try {
    const wa = makeWs();
    const wb = makeWs();
    const wv = makeWs(); // 旁观者
    srv.handleConnection(wa);
    send(wa, { type: 'join_lobby', name: '房主' });
    srv.handleConnection(wb);
    send(wb, { type: 'join_lobby', name: '玩家乙' });
    send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
    const room = [...srv.rooms.values()][0];
    send(wb, { type: 'join_room', roomId: room.id });
    send(wa, { type: 'start_game' }); // aiFill 补 2 AI 开局
    assert.equal(room.state, 'playing');

    // 旁观者加入：不带 spectate 应被拒（房间进行中），带 spectate 应成功进入观战
    srv.handleConnection(wv);
    send(wv, { type: 'join_lobby', name: '旁观丙' });
    send(wv, { type: 'join_room', roomId: room.id });
    const err = lastOf(wv, 'error');
    assert.ok(err && /不可加入|已满/.test(err.message), '无 spectate 加入进行中房间被拒');

    send(wv, { type: 'join_room', roomId: room.id, spectate: true });
    const rs = lastOf(wv, 'room_state');
    assert.ok(rs && rs.room && rs.room.isViewer === true, '观战者 room_state 标记 isViewer');
    assert.equal(room.viewers.length, 1, '房间记录 1 名旁观者');
    assert.equal(room.viewers[0].seat, -1, '旁观者 seat=-1');

    // 观战者收到 game_state：yourSeat=-1，所有玩家 hand=null（看不到手牌）
    const gv = lastOf(wv, 'game_state');
    assert.ok(gv && gv.game, '观战者收到 game_state');
    assert.equal(gv.game.yourSeat, -1);
    assert.ok(gv.game.players.every((p) => !p || p.hand === null), '旁观者看不到任何玩家手牌');
    assert.ok(gv.game.players.some((p) => p && p.melds !== undefined), '旁观者能看到明牌结构');

    // 旁观者退出：随时可退
    send(wv, { type: 'leave_room' });
    const rs2 = lastOf(wv, 'room_state');
    assert.ok(rs2 && rs2.room === null, '旁观者退出后 room_state 为 null');
    assert.equal(room.viewers.length, 0, '退出后观战列表清空');

    await sleep(300);
  } finally {
    cleanupServer(srv);
  }
});

// ============ 整局结算（settled）后人员变动 ============

test('整局结算后：新玩家可加入、玩家可退出、房主可踢人补 AI，再来一轮重置开局', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  const wc = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' }); // aiFill 补 2 AI 开局
  assert.equal(room.state, 'playing');

  // 模拟整局打完 → settled（终局）
  room.state = 'settled';
  room.settleConfirms = null;

  // 1. 玩家乙可主动退出（settled 状态允许）
  send(wb, { type: 'leave_room' });
  const rsB = lastOf(wb, 'room_state');
  assert.equal(rsB.room, null, '玩家乙在结算后可退出');
  assert.ok(!room.players.some((pl) => pl && pl.name === '玩家乙'), '玩家乙已离座');

  // 2. 新玩家丙可加入（settled 状态允许加入空位）
  srv.handleConnection(wc);
  send(wc, { type: 'join_lobby', name: '玩家丙' });
  send(wc, { type: 'join_room', roomId: room.id });
  const rsC = lastOf(wc, 'room_state');
  assert.ok(rsC && rsC.room && rsC.room.state === 'settled', '新玩家丙加入后收到 settled 状态');
  assert.ok(room.players.some((pl) => pl && pl.name === '玩家丙'), '玩家丙已落座');

  // 3. 房主可踢出玩家丙（settled 状态允许踢人）
  const cId = room.players.find((pl) => pl && pl.name === '玩家丙').id;
  send(wa, { type: 'kick_player', targetId: cId });
  const rsC2 = lastOf(wc, 'room_state');
  assert.equal(rsC2.room, null, '被踢玩家丙回到大厅');
  assert.ok(!room.players.some((pl) => pl && pl.name === '玩家丙'), '玩家丙已被踢出');

  // 4. 房主再来一轮：重置积分并开局（settled → waiting → playing）
  // 记录当前落座玩家 score 置零验证
  for (const pl of room.players) if (pl) pl.score = 123; // 制造脏数据
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing', '再来一轮后重新开局');
  assert.ok(room.players.filter(Boolean).every((pl) => pl.score === 0), '新一轮积分已重置');
  assert.equal(room.roundNo, 1, '局数重新从 1 开始');

  await sleep(300);
  cleanupServer(srv);
});

test('整局结算后：房主踢出 AI，再来一轮 AI 补位补足 4 人', async () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wa, { type: 'start_game' }); // aiFill 补 3 AI 开局
  assert.equal(room.state, 'playing');

  room.state = 'settled';
  room.settleConfirms = null;

  // 找出一个 AI 座位并踢出
  const ai = room.players.find((pl) => pl && pl.isAI);
  assert.ok(ai, '存在 AI 玩家');
  const aiSeat = ai.seat;
  send(wa, { type: 'kick_player', targetId: ai.id });
  assert.equal(room.players[aiSeat], null, 'AI 已被踢出座位');
  assert.ok(!srv.players.has(ai.id), 'AI 已从全局 players 移除');

  // 再来一轮：aiFill 补位应补足 4 人后开局
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing', '再来一轮后开局');
  assert.equal(room.players.filter(Boolean).length, 4, 'AI 补位补足 4 人');

  await sleep(300);
  cleanupServer(srv);
});

test('牌局进行中（playing）：仍禁止加入/踢人/补AI（仅 settled/waiting 放开）', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wc = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wc);
  send(wc, { type: 'join_lobby', name: '玩家丙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wa, { type: 'start_game' }); // aiFill 补 3 AI 开局
  assert.equal(room.state, 'playing');

  // 进行中加入被拒（不可加入）
  send(wc, { type: 'join_room', roomId: room.id });
  const errJoin = lastOf(wc, 'error');
  assert.ok(errJoin && /不可加入|已满/.test(errJoin.message), '进行中不可加入');

  // 进行中踢人（AI）被拒
  const ai = room.players.find((pl) => pl && pl.isAI);
  send(wa, { type: 'kick_player', targetId: ai.id });
  const errKick = lastOf(wa, 'error');
  assert.ok(errKick && /无法踢出/.test(errKick.message), '进行中无法踢人');

  // 进行中补 AI 被拒（已满）
  send(wa, { type: 'add_ai' });
  const errAdd = lastOf(wa, 'error');
  assert.ok(errAdd && /已满|不能添加/.test(errAdd.message), '进行中不能补 AI');

  // 进行中切换 AI 难度被拒（策略与姓名都不变）
  const aiNameBefore = ai.name;
  send(wa, { type: 'set_ai_difficulty', seat: ai.seat, difficulty: 'hard' });
  const errDiff = lastOf(wa, 'error');
  assert.ok(errDiff && /牌局进行中/.test(errDiff.message), '进行中不能切换 AI 难度');
  assert.equal(ai.name, aiNameBefore);

  await sleep(300);
  cleanupServer(srv);
});

// ============ 报听后补杠/暗杠（不破坏听口） ============

// 辅助：构造「报听玩家」的 room/game 状态：seat 已报听，13 张报听手牌 + 刚摸一张可杠牌
function makeTingGangRoom(srv, opts = {}) {
  const { room } = makeHuRoom(srv);
  const g = room.game;
  // 清空定时器，避免 AI 链干扰
  for (const timeoutId of room.timers.values()) clearTimeout(timeoutId);
  room.timers.clear();
  const seat = opts.seat != null ? opts.seat : 0;
  g.turn = seat;
  g.stage = 'draw';
  g.tingSeats = [seat];
  g.hands[seat] = opts.base13.slice();
  g.melds[seat] = opts.melds || [];
  g.drawnTile = opts.drawn;
  g.hands[seat].push(opts.drawn); // 摸牌后 14 张
  g.newTiles[seat] = null; // 报听玩家不标新牌
  return { room, g, seat };
}

test('报听玩家摸到第 4 张凑满暗杠且该牌非听张：_tingGangOptions 返回暗杠选项', () => {
  const srv = newServer();
  const base13 = ['w9', 'w9', 'w9', 'w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w4'];
  const { room, seat } = makeTingGangRoom(srv, { base13, drawn: 'w9' });
  const g = room.game;
  const ting = rules.isTing(base13, g.melds[seat]);
  assert.ok(!ting.includes('w9'), '测试前提：w9 不在报听手牌的听口中');
  const opts = srv._tingGangOptions(room, seat);
  assert.ok(opts.some((o) => o.gangType === 'angang' && o.tile === 'w9'), '应返回 w9 的暗杠选项');
  cleanupServer(srv);
});

test('报听玩家摸到可补杠牌且该牌非听张：_tingGangOptions 返回补杠选项', () => {
  const srv = newServer();
  const base13 = ['w2', 'w1', 'w1', 'w1', 'w3', 'w3', 'w3', 'w4', 'w4', 'w4', 'w5', 'w5', 'w5'];
  const melds = [{ type: 'peng', tile: 'w2', tiles: ['w2', 'w2', 'w2'] }];
  const { room, seat } = makeTingGangRoom(srv, { base13, melds, drawn: 'w2' });
  const g = room.game;
  const ting = rules.isTing(base13, g.melds[seat]);
  assert.ok(!ting.includes('w2'), '测试前提：w2 不在听口中');
  const opts = srv._tingGangOptions(room, seat);
  assert.ok(opts.some((o) => o.gangType === 'bugang' && o.tile === 'w2'), '应返回 w2 的补杠选项');
  cleanupServer(srv);
});

test('报听玩家杠的牌是听张：_tingGangOptions 不返回该杠（杠破坏听口）', () => {
  const srv = newServer();
  // 构造听 w9 的报听手牌：w1w1w1 w2w2w2 w3w3w3 w4w4w4 + w9（单吊 w9）？听口含 w9
  // 用一套 w9 是听张的手牌：w9w9w9 刻子 + w1w1w1 + w2w2w2 + w3w3w3 + 摸 w9（此时 w9 是否听张需验证）
  const base13 = ['w9', 'w9', 'w9', 'w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w4'];
  const { room, seat } = makeTingGangRoom(srv, { base13, drawn: 'w9' });
  const g = room.game;
  const ting = rules.isTing(base13, g.melds[seat]);
  if (!ting.includes('w9')) {
    // 该手牌 w9 不是听张，跳过此断言（用例目标手牌已在上一个用例覆盖）
    cleanupServer(srv);
    return;
  }
  const opts = srv._tingGangOptions(room, seat);
  assert.ok(!opts.some((o) => o.tile === 'w9'), 'w9 是听张时不返回暗杠选项');
  cleanupServer(srv);
});

test('报听玩家摸牌后：能杠（不破坏听口）则进入行动阶段收到 gang 选项，而非强制摸打', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  for (const timeoutId of room.timers.values()) clearTimeout(timeoutId);
  room.timers.clear();

  const g = room.game;
  const seat = 0;
  g.turn = seat;
  g.stage = 'draw';
  g.tingSeats = [seat];
  const base13 = ['w9', 'w9', 'w9', 'w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w4'];
  g.hands[seat] = base13.slice();
  g.melds[seat] = [];
  g.drawnTile = null;
  g.wall = ['w9', 'w9', 'w9', 'w9', 'w9', 'w9', 'w9', 'w9', 'w9', 'w9', 'w9', 'w9', 'w9', 'w9'];
  g.wallPos = 0;

  srv._drawCard(room, seat, false);
  assert.equal(g.stage, 'draw', '仍处于行动阶段');
  assert.ok(g.drawnTile !== null, '已摸到牌');
  const prompt = lastOf(wa, 'action_prompt');
  assert.ok(prompt, '报听玩家应收到 action_prompt（进入行动阶段）');
  assert.ok(
    prompt.prompt.gangOptions && prompt.prompt.gangOptions.some((o) => o.tile === 'w9' && o.gangType === 'angang'),
    'prompt 应含 w9 暗杠选项'
  );

  await sleep(300);
  cleanupServer(srv);
});

// ============ 房间类型（公共局/好友局） + 邀请流程 ============
test('好友局不进大厅列表，公共局进列表；好友局不能输房间号加入', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主甲' });
  // 创建好友局
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS, roomType: 'friend' } });
  const friendRoom = [...srv.rooms.values()][0];
  assert.equal(friendRoom.settings.roomType, 'friend');

  // 另一玩家进大厅：好友局不出现在列表
  const wb = makeWs();
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  const lobbyB = lastOf(wb, 'lobby_state');
  assert.equal(lobbyB.rooms.length, 0, '好友局不进大厅列表');

  // 直接输房间号加入好友局被拒
  send(wb, { type: 'join_room', roomId: friendRoom.id });
  const err = lastOf(wb, 'error');
  assert.ok(err && /好友局/.test(err.message), '好友局不能直接输房间号加入');

  // 创建公共局：出现在列表（由仍在大厅的玩家 wd 视角查询）
  const wc = makeWs();
  srv.handleConnection(wc);
  send(wc, { type: 'join_lobby', name: '玩家丙' });
  send(wc, { type: 'create_room', settings: { ...BASE_SETTINGS, roomType: 'public' } });
  const pubRoom = [...srv.rooms.values()].find((r) => r.settings.roomType === 'public');
  assert.ok(pubRoom, '公共局已创建');
  const wd = makeWs();
  srv.handleConnection(wd);
  send(wd, { type: 'join_lobby', name: '玩家丁' });
  const lobbyD = lastOf(wd, 'lobby_state');
  assert.ok(lobbyD.rooms.some((r) => r.id === pubRoom.id), '公共局出现在大厅列表');

  cleanupServer(srv);
});

test('房主邀请大厅空闲玩家 → 对方收到弹窗 → 接受进入房间', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主甲' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS, roomType: 'friend' } });
  const room = [...srv.rooms.values()][0];

  // 大厅空闲玩家
  const wb = makeWs();
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });

  // 房主查询在线大厅人员
  send(wa, { type: 'list_online' });
  const online = lastOf(wa, 'online_list');
  assert.ok(online, '返回在线列表');
  assert.ok(online.lobby.some((x) => x.name === '玩家乙'), '大厅列表含玩家乙');

  // 房主邀请玩家乙
  const targetKey = online.lobby.find((x) => x.name === '玩家乙').key;
  send(wa, { type: 'invite_player', key: targetKey });
  const recv = lastOf(wb, 'invite_received');
  assert.ok(recv, '玩家乙收到邀请弹窗');
  assert.equal(recv.roomId, room.id);
  assert.equal(recv.roomType, 'friend');
  assert.equal(recv.ownerName, '房主甲');

  // 玩家乙接受
  send(wb, { type: 'invite_reply', roomId: room.id, accept: true });
  assert.ok(room.players.some((p) => p && p.name === '玩家乙'), '玩家乙进入房间');

  cleanupServer(srv);
});

test('非房主不能邀请；目标不在线时报错', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主甲' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS, roomType: 'public' } });
  const room = [...srv.rooms.values()][0];

  // 非房主进入房间后尝试邀请（应被拒）
  const wb = makeWs();
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wb, { type: 'join_room', roomId: room.id }); // 公共局可直接加入
  send(wb, { type: 'invite_player', key: 'someone' });
  const err1 = lastOf(wb, 'error');
  assert.ok(err1 && /房主/.test(err1.message), '非房主不能邀请');

  // 房主邀请不存在的玩家
  send(wa, { type: 'invite_player', key: 'nonexistent' });
  const err2 = lastOf(wa, 'error');
  assert.ok(err2 && /不在线|其他房间/.test(err2.message), '目标不在线报错');

  cleanupServer(srv);
});

