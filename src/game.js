'use strict';

/**
 * 房间与牌局状态机（GameServer）
 *
 * 职责：
 *  - 大厅：昵称注册、重连
 *  - 房间：创建/加入/退出/解散、AI 补位、房主管理、4 人满自动开局
 *  - 牌局：发牌、回合流转（摸牌→出牌→响应）、碰/杠/胡/过、抢杠胡、
 *    杠上开花、海底捞月、流局荒庄、积分结算、总局数结算
 *  - 健壮性：全部操作服务端校验；断线 60 秒重连恢复；超时 AI 托管
 */

const rules = require('./rules');
const ai = require('./ai');
const gameLogger = require('./game-logger');
const aiJournal = require('./ai-journal');
const users = require('./users');
const crypto = require('crypto');

// 阶段一重构：把账号/好友、纯工具、发送广播 I/O 拆到独立 mixin，方法内 this 上下文不变。
// 视图构建（_buildRoomView/_buildGameView）与玩法状态机仍留在本文件（深度耦合 rules/游戏状态）。
const accountMixin = require('./game/account');
const utilsMixin = require('./game/utils');
const ioMixin = require('./game/io');
const variants = require('./game/variants');

users.initUsers(); // 启动即加载账号与历史存储（文件在 data/，gitignore）

const RECONNECT_MS = 60000; // 断线重连窗口
const HEARTBEAT_INTERVAL_MS = 30000; // 心跳 ping 间隔（模块级默认，生产用；可按实例注入覆盖）
const HEARTBEAT_MAX_MISS = 3; // 连续 3 次未收到 pong（约 90s）判定死连接（模块级默认；可按实例注入覆盖）
const OWNER_OFFLINE_MS = 60000; // 房主离线超时：AI 托管打完本局，本局结束后自动解散房间
const HUMAN_TIMEOUT_MS = 30000; // 真人行动超时（自动托管）
const RESPONSE_TIMEOUT_MS = 20000; // 响应窗口
const SETTLE_TIMEOUT_MS = 60000; // 结算确认超时：在线真人 60 秒未点「确定」自动确认
const MAX_ROOMS = 100;
const MAX_LOGS = 200;
const MAX_CHAT = 50;
const MAX_EMOJI = 30; // 房间内保留的最近表情条数（供迟到/重连者补看）
// 对局表情互动白名单（仅这些 emoji 可被广播，防滥用/注入任意内容）
const EMOJI_WHITELIST = ['👍', '😂', '😅', '😭', '😡', '🤔', '👏', '🎉', '💪', '🀄', '🔥', '💰'];

// ---- 安全护栏（P0）----
const MAX_RAW_MSG = 16 * 1024; // 单条消息最大字符数（与 server.js WebSocketServer maxPayload 一致），超限直接丢弃
const RATE_LIMIT_PER_SEC = 60; // 每连接令牌桶速率（条/秒），桶容量同值（允许 60 条突发）
const MAX_WS_PER_IP = 24; // 单「IP + User-Agent 哈希」额度：局域网/家庭 WiFi 多机共用出口 IP 时不再互相挤占
const MAX_WS_PER_IP_TOTAL = 48; // 单 IP 硬顶：UA 可伪造，必须有 IP 级总闸兜底，否则伪造 UA 即可绕过上限
const MAX_WS_PER_IP_NO_UA = 12; // 握手拿不到 User-Agent 时（脚本/非浏览器）退化为按 IP 计数的保守上限
const MAX_PLAYERS = 5000; // this.players 上限：超限拒绝新身份，防止重复 join_lobby 造成内存无界增长
const VOICE_SIG_MAX = 12 * 1024; // 语音信令 sig 上限：须小于 MAX_RAW_MSG，否则永远到不了业务逻辑
const JOIN_FAIL_LIMIT = 5; // 连续加入房间失败次数上限（达到即锁定）
const JOIN_LOCK_MS = 30000; // 加入失败锁定退避时长
const SEAT_REF_RE = /^s[0-3]$/; // 房间内座位代称（他人视角的 id）：s0-s3

function nowTime() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** 校验注入值为正整数，非法（undefined/null/0/负数/非数字）时回落到模块级默认值 */
function positiveInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

class GameServer {
  constructor(opts = {}) {
    this.rooms = new Map(); // roomId -> room
    this.players = new Map(); // playerId -> player
    this.wsPlayers = new Map(); // ws -> playerId
    // 心跳参数可按实例注入（测试注入极小间隔便于快速收敛），缺省沿用模块级生产默认值
    this.heartbeatIntervalMs = positiveInt(opts.heartbeatIntervalMs, HEARTBEAT_INTERVAL_MS);
    this.heartbeatMaxMiss = positiveInt(opts.heartbeatMaxMiss, HEARTBEAT_MAX_MISS);
    // 随机源可注入（测试注入可复现种子，消除牌墙/金母/庄家的随机抖动），缺省用 Math.random。
    // 覆盖的业务随机点：洗牌 shuffle、庄家随机 dealer；crypto 生成的 roomId/userId/secret 属标识符，不参与规则判定，不种子化。
    this.rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    // 全局登记「所有曾创建」的心跳定时器（ws -> interval）。wsPlayers 只含当前在册连接，
    // 已离开房间/已超时移除/从未 join 的连接不在其中，仅遍历 wsPlayers 会漏清其 interval。
    this._heartbeatTimers = new Map();
    // 全局登记所有仍在运行的房间/断线定时器句柄。room.timers 与 p.disconnectTimer
    // 都可能被外部（如测试）丢弃引用，只遍历它们会漏清真实存活的定时器；
    // 这里以句柄为准，stop() 时无条件全量清理。
    this._timers = new Set();
    this.ipConns = new Map(); // 「ip|uaHash」-> 连接数（有 UA 时）/ ip -> 连接数（无 UA 时）
    this.ipTotals = new Map(); // ip -> 该 IP 的连接总数（UA 可伪造的兜底总闸，仅在能拿到 UA 时维护）
    // 安全护栏计数：仅用于观测/测试断言，超限行为是丢弃而非报错
    this.stats = { oversize: 0, rateLimited: 0, unknownType: 0, rejectedConn: 0, joinLocked: 0 };
    // 游戏日志：默认按环境启用（NODE_ENV=test 或 MARVIS_GAME_LOG=0 时禁用）；
    // opts.gameLog === false 强制关闭（测试场景用）；opts.gameLog === true 强制开启（集成测试用）
    const gameLogOpt = opts.gameLog !== undefined ? { enabled: !!opts.gameLog } : {};
    this.gameLogger = gameLogger.createGameLogger({ ...gameLogOpt, dir: opts.gameLogDir });
    if (this.gameLogger.enabled) this.gameLogger.cleanup();
  }

  // ============ 网络层 ============

  /**
   * 新连接接入。opts.ip 由 server.js 从 req.socket.remoteAddress 传入（测试伪 ws 不传，即不启用 IP 限制）；
   * opts.ua 为握手 User-Agent（可缺省），用于把单 IP 计数细化到「IP + UA」，降低 NAT 误伤。
   * 单 IP 并发超限时直接关闭，不进入业务层。
   */
  handleConnection(ws, opts = {}) {
    const ip = (opts && opts.ip) || '';
    const ua = (opts && opts.ua) || '';
    const key = ip ? this._trackIpConnect(ip, ua) : '';
    if (ip && !key) {
      this.stats.rejectedConn += 1;
      try { ws.close(1008, '连接数超限'); } catch (e) { /* ignore */ }
      return;
    }
    ws._ip = ip;
    ws._ipKey = key;
    ws.on('message', (raw) => {
      // 先量长度再 toString：避免超大帧进入 JSON 解析（ws 层 maxPayload 之外的二次护栏）
      const len = typeof raw === 'string' ? raw.length : (raw && raw.length) || 0;
      if (len > MAX_RAW_MSG) {
        this.stats.oversize += 1;
        return;
      }
      this.handleMessage(ws, raw.toString());
    });
    ws.on('close', () => {
      this._releaseIp(ws);
      this._onWsClose(ws);
    });
    ws.on('error', () => {});
    this._startHeartbeat(ws);
  }

  /**
   * 单 IP 并发计数（只在传入 ip 时生效）。返回计数 key（超限返回 ''），由调用方挂在 ws._ipKey 供关闭时回收。
   * 双重额度：① 「IP + User-Agent 哈希」桶 ≤ MAX_WS_PER_IP —— 同一出口 IP 下不同设备（UA 不同）
   * 各自有额度，降低 NAT 误伤；② 该 IP 的连接总数 ≤ MAX_WS_PER_IP_TOTAL —— UA 是客户端可控字段，
   * 只按桶计数会被「伪造 UA」无限绕过，因此必须有 IP 级总闸。
   * 拿不到 UA（脚本/非浏览器直连）时无法区分来源，退化为按 IP 计数并沿用更严的 MAX_WS_PER_IP_NO_UA。
   */
  _trackIpConnect(ip, ua) {
    const key = this._ipKeyOf(ip, ua);
    const bucketLimit = ua ? MAX_WS_PER_IP : MAX_WS_PER_IP_NO_UA;
    const ipLimit = ua ? MAX_WS_PER_IP_TOTAL : MAX_WS_PER_IP_NO_UA;
    const ipTotal = (this.ipTotals.get(ip) || 0) + 1;
    if (ipTotal > ipLimit) return '';
    const n = (this.ipConns.get(key) || 0) + 1;
    if (n > bucketLimit) return '';
    this.ipTotals.set(ip, ipTotal);
    this.ipConns.set(key, n);
    return key;
  }

  _ipKeyOf(ip, ua) {
    if (!ua) return ip;
    return ip + '|' + crypto.createHash('sha1').update(ua).digest('hex').slice(0, 10);
  }

  _releaseIp(ws) {
    const key = ws && ws._ipKey;
    if (!key) return;
    const n = (this.ipConns.get(key) || 0) - 1;
    if (n <= 0) this.ipConns.delete(key);
    else this.ipConns.set(key, n);
    const ip = ws._ip;
    if (ip && this.ipTotals.has(ip)) {
      const t = this.ipTotals.get(ip) - 1;
      if (t <= 0) this.ipTotals.delete(ip);
      else this.ipTotals.set(ip, t);
    }
  }

  /** 每连接令牌桶：速率 RATE_LIMIT_PER_SEC 条/秒、容量同值；超限丢弃（不报错、不计入业务） */
  _allowByRate(ws) {
    const now = Date.now();
    if (typeof ws._tokens !== 'number' || typeof ws._lastRefill !== 'number') {
      ws._tokens = RATE_LIMIT_PER_SEC;
      ws._lastRefill = now;
    }
    const elapsed = now - ws._lastRefill;
    if (elapsed > 0) {
      ws._tokens = Math.min(RATE_LIMIT_PER_SEC, ws._tokens + (elapsed / 1000) * RATE_LIMIT_PER_SEC);
      ws._lastRefill = now;
    }
    if (ws._tokens < 1) return false;
    ws._tokens -= 1;
    return true;
  }

  // ---------- 心跳保活（ping/pong） ----------
  _startHeartbeat(ws) {
    if (!ws || typeof ws.ping !== 'function' || ws._heartbeatTimer) return;
    ws._pongMiss = 0;
    // ws 库收到 pong 帧自动触发 'pong' 事件（客户端浏览器/ws 库均自动回 pong，无需改协议）
    ws.on('pong', () => { ws._pongMiss = 0; });
    const timer = setInterval(() => this._heartbeatTick(ws), this.heartbeatIntervalMs);
    ws._heartbeatTimer = timer;
    this._heartbeatTimers.set(ws, timer);
    this._timers.add(timer);
  }

  /** 停止单个连接的心跳定时器并注销登记；连接关闭与全量清理共用，保证不会漏清 */
  _stopHeartbeat(ws) {
    const timer = ws && ws._heartbeatTimer;
    if (!timer) return;
    clearInterval(timer);
    this._timers.delete(timer);
    ws._heartbeatTimer = null;
    this._heartbeatTimers.delete(ws);
  }

  // 每个心跳周期：累计 miss，超过阈值判定半开/死连接
  _heartbeatTick(ws) {
    if (!ws || ws.readyState !== 1) return;
    ws._pongMiss = (ws._pongMiss || 0) + 1;
    if (ws._pongMiss > this.heartbeatMaxMiss) {
      // 连续超过阈值未收到 pong：强制断开，触发 close → _onWsClose 走既有断线重连流程
      // 先在本侧摘除定时器：即便 terminate 因异常未触发 close，也不会留下悬挂 interval
      this._stopHeartbeat(ws);
      try { ws.terminate(); } catch (e) { console.error('[game] heartbeat terminate error:', e); }
      return;
    }
    try { ws.ping(); } catch (e) { console.error('[game] heartbeat ping error:', e); }
  }

  /**
   * 服务端侧全量清理入口：停掉所有心跳 interval、房间定时器、玩家断线重连定时器。
   * 覆盖「所有曾创建」的连接（不依赖 wsPlayers / rooms 的当前成员关系），供退出前调用，
   * 避免 setInterval 持续持有事件循环导致进程无法退出。不涉及任何游戏逻辑。
   */
  stop() {
    for (const ws of this._heartbeatTimers.keys()) this._stopHeartbeat(ws);
    this._heartbeatTimers.clear();
    // 以句柄集合为准，不依赖 room.timers / players 的当前成员关系：
    // 被外部丢弃引用的定时器（room.timers.clear()）与已从 players 移除但仍在计时的
    // 断线定时器，都能在这里被可靠停掉。
    for (const t of this._timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this._timers.clear();
    for (const room of this.rooms.values()) room.timers.clear();
    for (const p of this.players.values()) p.disconnectTimer = null;
  }

  /** stop() 的语义别名 */
  dispose() {
    this.stop();
  }

  handleMessage(ws, raw) {
    // 护栏1：超长消息直接丢弃（不解析、不报错）
    if (typeof raw !== 'string' || raw.length > MAX_RAW_MSG) {
      this.stats.oversize += 1;
      return;
    }
    // 护栏2：每连接令牌桶限流，超限静默丢弃
    if (!this._allowByRate(ws)) {
      this.stats.rateLimited += 1;
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this._sendWs(ws, { type: 'error', message: '无效的消息格式' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || msg.type.length > 32) {
      this._sendWs(ws, { type: 'error', message: '无效的消息格式' });
      return;
    }
    try {
      if (msg.type === 'join_lobby') return this._joinLobby(ws, msg);
      if (msg.type === 'reconnect') return this._reconnect(ws, msg);
      // 账号体系：注册/登录/登出 不要求已进入大厅，可随时发起
      if (msg.type === 'register') return this._register(ws, msg);
      if (msg.type === 'login') return this._login(ws, msg);
      if (msg.type === 'logout') return this._logout(ws, msg);
      // 账号设置：改昵称 / 改密码 / 注销账号，已登录即可操作，无需先进入大厅
      if (msg.type === 'change_name') return this._changeName(ws, msg);
      if (msg.type === 'change_password') return this._changePassword(ws, msg);
      if (msg.type === 'delete_account') return this._deleteAccount(ws, msg);
      // 历史对局记录：已登录（token）即可查，无需先进入大厅
      if (msg.type === 'get_history') return this._getHistory(ws, msg);
      // 战绩统计与排行榜：已登录（token）即可查，无需先进入大厅
      if (msg.type === 'get_stats') return this._getStats(ws, msg);
      if (msg.type === 'get_leaderboard') return this._getLeaderboard(ws, msg);
      // 好友系统：已登录（token）即可操作，无需先进入大厅
      if (msg.type === 'add_friend') return this._addFriend(ws, msg);
      if (msg.type === 'accept_friend') return this._acceptFriend(ws, msg);
      if (msg.type === 'decline_friend') return this._declineFriend(ws, msg);
      if (msg.type === 'remove_friend') return this._removeFriend(ws, msg);
      if (msg.type === 'friend_list') return this._friendList(ws, msg);

      const playerId = this.wsPlayers.get(ws);
      const p0 = playerId ? this.players.get(playerId) : null;
      // 邀请相关：需已进大厅（有身份）。查询在线好友/大厅人员 + 发邀请 + 受邀回应
      if (p0 && msg.type === 'list_online') return this._listOnline(p0, msg);
      if (p0 && msg.type === 'invite_player') return this._invitePlayer(p0, msg);
      if (p0 && msg.type === 'invite_reply') return this._inviteReply(p0, msg);
      const p = playerId ? this.players.get(playerId) : null;
      if (!p) {
        this._sendWs(ws, { type: 'error', message: '请先进入大厅' });
        return;
      }
      switch (msg.type) {
        case 'create_room': return this._createRoom(p, msg);
        case 'join_room': return this._joinRoom(p, msg);
        case 'leave_room': return this._leaveRoom(p);
        case 'start_game': return this._startGame(p);
        case 'add_ai': return this._addAIByPlayer(p);
        case 'kick_player': return this._kickPlayer(p, msg);
        case 'dissolve': return this._dissolve(p);
        case 'play_tile': return this._playTile(p, msg);
        case 'ting': return this._ting(p, msg);
        case 'peng': return this._peng(p);
        case 'gang': return this._gang(p, msg);
        case 'hu': return this._hu(p);
        case 'pass': return this._pass(p);
        case 'liangjin': return this._liangjin(p, msg);
        case 'set_hosted': return this._setHosted(p);
        case 'cancel_hosted': return this._cancelHosted(p);
        case 'settle_confirm': return this._settleConfirm(p);
        case 'chat': return this._chat(p, msg);
        case 'emoji': return this._emoji(p, msg);
        case 'voice_signal': return this._voiceSignal(p, msg);
        default:
          // 未知消息类型：静默丢弃并计数（不回显，避免成为探测通道）
          this.stats.unknownType += 1;
          return;
      }
    } catch (e) {
      console.error('[game] handleMessage error:', e);
      this._sendWs(ws, { type: 'error', message: '服务器内部错误' });
    }
  }

  // ============ 大厅 ============

  _joinLobby(ws, msg) {
    // 若携带有效 token，则关联账号（昵称用账户的 displayName，避免游客改名绕过身份）
    let account = null;
    if (msg && msg.token) {
      const u = users.getUserByToken(msg.token);
      if (u) account = u;
    }
    const name = this._sanitizeName(account ? account.displayName : (msg && msg.name));
    if (!name) {
      this._sendWs(ws, { type: 'error', message: '昵称不能为空（1-12 个字符）' });
      return;
    }
    // 同一连接重复 join_lobby：复用该连接上已有的旧身份（无房间绑定者），
    // 避免每次调用都新建 player 让 this.players 无界增长（内存 DoS + _broadcastLobby O(N)）
    const oldId = this.wsPlayers.get(ws);
    const old = oldId ? this.players.get(oldId) : null;
    if (old) {
      // 仍在房间内（含重连窗口内断线的座位）：绝不回收/顶替——删除会把座位变成无法重连的幽灵玩家，
      // 重连路径 _reconnect 依赖 p.id/p.secret/p.roomId 保持不变
      if (old.roomId) {
        this._sendWs(ws, { type: 'error', code: 'ALREADY_IN_ROOM', message: '当前身份仍在房间中，请先退出房间' });
        return;
      }
      old.name = name;
      old.ws = ws;
      old.connected = true;
      old.hosted = false;
      if (account) { old.account = account.username; old.name = account.displayName; }
      this._clearDisconnectTimer(old);
      this._send(old, { type: 'hello', playerId: old.id, secret: old.secret, name: old.name });
      this._sendLobbyState(old);
      return;
    }
    if (this.players.size >= MAX_PLAYERS) {
      this._sendWs(ws, { type: 'error', code: 'SERVER_FULL', message: '服务器人数已满，请稍后再试' });
      return;
    }
    const p = this._createPlayer(ws, name);
    if (account) p.account = account.username; // 关联登录账户，供历史对局记录归因
    // secret 仅在此处（本人连接）下发一次；room_state 与任何广播不再携带 playerId/secret
    this._send(p, { type: 'hello', playerId: p.id, secret: p.secret, name: p.name });
    this._sendLobbyState(p);
  }

  // ============ 账号体系（注册 / 登录 / 登出 / 历史 / 好友 / 战绩） ============
  // 已拆至 src/game/account.js（通过 Object.assign 混入）。此处不再重复定义。

  _reconnect(ws, msg) {
    const id = String((msg && msg.playerId) || '');
    const secret = String((msg && msg.secret) || '');
    const p = this.players.get(id);
    // 重连凭据：playerId + secret 双因子。缺 secret 或 secret 不匹配一律拒绝，
    // 防止房间内其他人仅凭广播到的 playerId 顶替座位、接管积分
    if (!p || !p.secret || !secret || secret !== p.secret) {
      // 结构化错误码：前端据此判断"凭据已失效"，清除本地身份并回大厅重新登录（老用户自愈）
      // 中文文案保留用于直接展示；校验强度不变，不因缺少 secret 放行
      this._sendWs(ws, { type: 'error', code: 'AUTH_FAILED', message: '重连失败：凭据无效，请重新进入大厅' });
      return;
    }
    // 替换旧连接
    if (p.ws && p.ws !== ws && p.ws.readyState === 1) {
      try { p.ws.close(); } catch { /* ignore */ }
    }
    if (p.ws) this.wsPlayers.delete(p.ws);
    p.ws = ws;
    p.connected = true;
    p.hosted = false;
    this._clearDisconnectTimer(p);
    this.wsPlayers.set(ws, p.id);
    this._send(p, { type: 'hello', playerId: p.id, secret: p.secret, name: p.name });

    if (p.roomId) {
      const room = this.rooms.get(p.roomId);
      const stillSeated = room && room.players[p.seat] === p;
      if (!room || !stillSeated) {
        p.roomId = null;
        p.seat = null;
        this._sendLobbyState(p);
        return;
      }
      // 房主重连：取消离线超时解散定时器（已触发 pendingDisband 的不回退）
      if (p.id === room.ownerId) {
        this._clearTimer(room, 'owner:offline');
        room.ownerOfflineSince = null;
      }
      this._log(room, `${p.name} 重新连接`);
      this._send(p, { type: 'room_state', room: this._buildRoomView(room, p.seat) });
      if (room.state === 'playing' && room.game) {
        this._send(p, { type: 'game_state', game: this._buildGameView(room, p.seat) });
        // 重连补发 action_prompt：若正好轮到该玩家出牌，或该玩家尚有未决定的碰/杠/胡响应权，
        // 否则前端 prompt 为空，手牌/操作按钮不可点，会卡住整局
        const g = room.game;
        if (g.stage === 'draw' && g.turn === p.seat) {
          this._send(p, { type: 'action_prompt', prompt: this._buildDrawPrompt(room, p.seat) });
        } else if (g.stage === 'response' && g.pending) {
          const r = g.pending.responders.find((x) => x.seat === p.seat);
          if (r && r.choice === null) {
            this._send(p, { type: 'action_prompt', prompt: this._buildResponsePrompt(room, r) });
          }
        }
      }
      if (room.game && room.game.winners) this._sendSettlement(room, p);
      this._broadcastRoomState(room);
      // 若正好轮到他且已托管：恢复真人控制后仍由本人操作
      this._broadcastGameState(room);
    } else {
      this._sendLobbyState(p);
    }
  }

  _onWsClose(ws) {
    // 连接关闭即清理心跳定时器，避免泄漏
    this._stopHeartbeat(ws);
    const playerId = this.wsPlayers.get(ws);
    if (!playerId) return;
    this.wsPlayers.delete(ws);
    const p = this.players.get(playerId);
    if (!p) return;
    if (p.ws === ws) p.ws = null;
    p.connected = false;

    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (room) {
      // 旁观者断线：直接移除（无需重连窗口、无需托管），房间继续
      if (p.isViewer) {
        room.viewers = (room.viewers || []).filter((v) => v !== p);
        p.roomId = null;
        p.seat = null;
        p.isViewer = false;
        this.players.delete(p.id);
        this._log(room, `${p.name} 退出观战`);
        this._broadcastRoomState(room);
        return;
      }
      this._log(room, `${p.name} 断线（60 秒内可重连）`);
      if (room.state === 'playing' && room.game) {
        p.hosted = true;
        // 若正等该玩家响应 → 立即视为过，避免卡局
        const g = room.game;
        if (g.stage === 'response' && g.pending) {
          const r = g.pending.responders.find((x) => x.seat === p.seat);
          if (r && r.choice === null) {
            r.choice = 'pass';
            this._clearTimer(room, 'resp:' + p.seat);
            this._log(room, `${p.name} 断线，响应视为过`);
            this._tryResolvePending(room, g, g.pending);
          }
        }
        if (this._shouldAutoAct(room, p.seat)) this._scheduleAutoAct(room, p.seat);
      }
      // 结算确认阶段掉线：立即自动确认本局结算，避免全员等待该座位
      if (room.settleConfirms && !room.settleConfirms[p.seat]) {
        this._clearTimer(room, 'settle:' + p.seat);
        room.settleConfirms[p.seat] = true;
        this._log(room, `${p.name} 断线，自动确认本局结算`);
        this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
        this._tryStartNextRound(room);
      }
      // 房主断线：非 waiting 状态启动 60 秒超时定时器；超时后牌局进行中则 AI 托管打完本局自动解散，牌局未进行（结算确认/终局）则转让房主或解散
      if (p.id === room.ownerId && room.state !== 'waiting' && !room.pendingDisband) {
        room.ownerOfflineSince = Date.now();
        this._setTimer(room, 'owner:offline', OWNER_OFFLINE_MS, () => this._handleOwnerOfflineTimeout(room));
      }
      this._broadcastRoomState(room);
      if (room.state === 'playing' && room.game) this._broadcastGameState(room);
    }
    if (!p.disconnectTimer) {
      const dt = setTimeout(() => {
        this._timers.delete(dt);
        try {
          this._handleDisconnectTimeout(p);
        } catch (e) {
          console.error('[game] disconnect timer error:', e);
        }
      }, RECONNECT_MS);
      p.disconnectTimer = dt;
      this._timers.add(dt);
    }
  }

  /** 统一清理断线重连定时器：同步注销全局句柄登记，避免 stop() 漏清 */
  _clearDisconnectTimer(p) {
    if (!p || !p.disconnectTimer) return;
    clearTimeout(p.disconnectTimer);
    this._timers.delete(p.disconnectTimer);
    p.disconnectTimer = null;
  }

  _handleDisconnectTimeout(p) {
    // 超时已触发：无论是否重连都置空，便于下次断线重新计时；同时作为「已超时」标记供清理判断
    p.disconnectTimer = null;
    if (p.connected) return;
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) {
      this.players.delete(p.id);
      return;
    }
    if (room.state === 'waiting') {
      this._log(room, `${p.name} 超时未重连，已离开房间`);
      if (p.id === room.ownerId) {
        // AI 不能成为房主：仅从其他在线真人中转让，无真人则解散房间
        const others = room.players.filter(Boolean).filter((x) => x.id !== p.id && !x.isAI);
        if (others.length === 0) {
          this._destroyRoom(room);
          return;
        }
        room.ownerId = others[0].id;
      }
      this._unseatPlayer(room, p);
      this.players.delete(p.id);
      this._broadcastRoomState(room);
      this._broadcastLobby();
    } else {
      if (!p.hosted) p.hosted = true;
      this._log(room, `${p.name} 超时未重连，座位已由 AI 托管`);
      // 结算确认阶段超时未重连：确保该座位已自动确认（掉线时通常已即时确认，此处幂等兜底）
      if (room.settleConfirms && !room.settleConfirms[p.seat]) {
        this._clearTimer(room, 'settle:' + p.seat);
        room.settleConfirms[p.seat] = true;
        this._log(room, `${p.name} 超时未重连，自动确认本局结算`);
        this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
        this._tryStartNextRound(room);
      }
      this._broadcastRoomState(room);
      if (room.state === 'playing' && room.game && this._shouldAutoAct(room, p.seat)) {
        this._scheduleAutoAct(room, p.seat);
      }
    }
  }

  /** 房主离线超过 60 秒：牌局进行中则 AI 托管打完本局、本局结束自动解散；牌局未进行（结算确认/终局）则转让房主给在线真人，无真人则解散 */
  _handleOwnerOfflineTimeout(room) {
    // 回调已触发：无论是否重连都清理定时器，防止重入/重复触发
    this._clearTimer(room, 'owner:offline');
    const owner = room.players.find((pl) => pl && pl.id === room.ownerId);
    if (owner && owner.connected) {
      // 已重连：取消解散
      room.ownerOfflineSince = null;
      return;
    }
    // 无任何在线真人（含房主）：房间已无意义，直接解散
    if (!room.players.some((pl) => pl && !pl.isAI && pl.connected)) {
      this._destroyRoom(room);
      return;
    }
    // 牌局进行中（未到结算）：房主座位 AI 托管打完本局，本局结束后自动解散
    if (room.state === 'playing' && room.game && room.game.stage !== 'over') {
      room.pendingDisband = true;
      this._log(room, '房主离线超过 60 秒，本局结束后将解散房间');
      this._broadcast(room, { type: 'room_notice', text: '房主离线超过60秒，本局结束后将解散房间' });
      this._broadcastRoomState(room);
      // 确保房主座位由 AI 托管继续打本局（断线时已托管，此处兜底）
      const ownerSeat = owner ? room.players.indexOf(owner) : -1;
      if (ownerSeat >= 0 && this._shouldAutoAct(room, ownerSeat)) {
        this._scheduleAutoAct(room, ownerSeat);
      }
      return;
    }
    // 牌局未进行（结算确认中 / 终局 settled）：房主不在则转让给其他在线真人，无真人则解散
    const others = room.players.filter(Boolean).filter((x) => x.id !== room.ownerId && !x.isAI && x.connected);
    if (others.length === 0) {
      this._destroyRoom(room);
      return;
    }
    const newOwner = others[0];
    room.ownerId = newOwner.id;
    room.ownerOfflineSince = null;
    this._log(room, `房主 ${owner ? owner.name : '（离线）'} 离线超时，${newOwner.name} 成为新房主`);
    this._broadcast(room, { type: 'room_notice', text: `房主离线超时，${newOwner.name} 成为新房主` });
    this._broadcastRoomState(room);
    this._broadcastLobby();
  }

  // ============ 房间 ============

  _createRoom(p, msg) {
    if (p.roomId) return this._err(p, '您已在房间中，请先退出');
    if (this.rooms.size >= MAX_ROOMS) return this._err(p, '房间数量已达上限');
    const settings = this._validateSettings(msg && msg.settings);
    if (!settings) return this._err(p, '房间设置不合法（总局数取值错误）');

    let id;
    do {
      // 4 位房间码保持不变（熟人局不增加输入负担），但改用 crypto 随机，避免可预测
      id = String(crypto.randomInt(1000, 10000));
    } while (this.rooms.has(id));

    const room = {
      id,
      settings,
      ownerId: p.id,
      ownerName: p.name, // 创建者名称（房主转让/离开后保持原创建者）
      ownerOfflineSince: null, // 房主离线起始时间；超 60 秒后 AI 托管并在本局结束后解散
      pendingDisband: false, // 房主离线超时标记：本局结束后自动解散房间
      state: 'waiting',
      roundNo: 0,
      players: [null, null, null, null],
      viewers: [], // 旁观者列表（非座位玩家，seat=-1，可观看牌局但不可操作）
      game: null,
      dealer: null,
      lastWinner: null,
      settleConfirms: null, // 本局结算确认状态：[seat] -> bool；null 表示不在确认阶段
      logs: [],
      chat: [],
      timers: new Map(),
      autoSeq: 0, // AI 自动行动定时器唯一 key 递增序号
      nextAiNo: 1,
    };
    this.rooms.set(id, room);
    this._seatPlayer(room, p);
    this._resetJoinFails(p); // 创建成功：清空加入失败计数/锁定
    this._log(room, `${p.name} 创建了房间 ${id}`);
    this._send(p, { type: 'room_state', room: this._buildRoomView(room, p.seat) });
    this._broadcastLobby();
  }

  _joinRoom(p, msg) {
    if (p.roomId) return this._err(p, '您已在房间中，请先退出');
    // 防房间号暴力枚举：连续失败达上限后锁定退避（成功后清零），锁定期内不再处理加入请求
    const lockLeft = this._joinLockLeft(p);
    if (lockLeft > 0) {
      this.stats.joinLocked += 1;
      return this._err(p, `加入尝试过于频繁，请 ${Math.ceil(lockLeft / 1000)} 秒后再试`);
    }
    const id = String((msg && msg.roomId) || '').trim();
    if (!/^\d{4}$/.test(id)) return this._failJoin(p, '房间号必须是 4 位数字');
    const room = this.rooms.get(id);
    if (!room) return this._failJoin(p, '房间不存在');
    // 好友局不进大厅列表，也不接受直接输房间号加入——只能由房主邀请进入
    if (room.settings && room.settings.roomType === 'friend') {
      return this._failJoin(p, '该房间为好友局，需由房主邀请加入');
    }

    // 观战路径：房间进行中 / 已满 / 已结算时，允许以旁观者身份进入（不可操作，仅观看）
    const wantSpectate = !!(msg && msg.spectate);
    // 可加入状态：waiting（等待中）或 settled（整局结束，可自由换人后再开新一轮）
    const joinable = room.state === 'waiting' || room.state === 'settled';
    if (!joinable || !room.players.some((x) => x === null)) {
      if (wantSpectate && room.state === 'playing') return this._spectateRoom(p, room);
      if (wantSpectate) return this._failJoin(p, '该房间暂不可观战（未开始）');
      if (room.state !== 'waiting' && room.state !== 'settled') return this._failJoin(p, '房间当前不可加入（游戏中）');
      return this._failJoin(p, '房间已满');
    }

    this._resetJoinFails(p);
    this._seatPlayer(room, p);
    this._log(room, `${p.name} 加入房间`);
    this._send(p, { type: 'room_state', room: this._buildRoomView(room, p.seat) });
    this._broadcastRoomState(room);
    this._broadcastLobby();
    // 不再自动开局：人齐后由房主点击「开始游戏」触发
  }

  // 以旁观者身份进入进行中的房间：seat=-1，收到 game_state/room_state 但看不到任何手牌
  _spectateRoom(p, room) {
    this._resetJoinFails(p);
    p.roomId = room.id;
    p.seat = -1;
    p.isViewer = true;
    p.score = 0;
    p.roundScore = 0;
    room.viewers.push(p);
    this._log(room, `${p.name} 进入观战`);
    this._send(p, { type: 'room_state', room: this._buildRoomView(room, -1) });
    if (room.game) this._send(p, { type: 'game_state', game: this._buildGameView(room, -1) });
    this._broadcastRoomState(room);
  }

  // ---------- 加入房间失败限频（防 4 位房间号暴力枚举） ----------
  // 计数挂在 player 上：玩家对象随断线超时/退出从 this.players 删除而自然回收，不会无界增长
  _failJoin(p, message) {
    p.joinFails = (p.joinFails || 0) + 1;
    if (p.joinFails >= JOIN_FAIL_LIMIT) p.joinLockUntil = Date.now() + JOIN_LOCK_MS;
    return this._err(p, message);
  }

  _resetJoinFails(p) {
    p.joinFails = 0;
    p.joinLockUntil = 0;
  }

  /** 剩余锁定毫秒数（0 表示未锁定） */
  _joinLockLeft(p) {
    return Math.max(0, (p.joinLockUntil || 0) - Date.now());
  }

  // ---------- 邀请（在线好友 / 大厅人员） ----------

  /** 在线玩家唯一标识：已登录账户用 username 定位（跨连接稳定），游客用 playerId */
  _onlineKey(pl) {
    return pl.account || pl.id;
  }

  /** 某人是否在线且空闲（有连接、未断线、不在任何房间中） */
  _isLobbyIdle(pl) {
    return !!pl && pl.connected && !pl.roomId;
  }

  /**
   * 查询可邀请对象：在线好友 + 大厅空闲人员。
   * 返回 { friends:[...], lobby:[...] }，每条含 id/key、name、online 标记。
   * 好友仅列在线者（离线好友不可邀）；大厅列所有空闲在线玩家（不含自己）。
   */
  _listOnline(p, msg) {
    const meKey = this._onlineKey(p);
    // 在线好友：取好友列表，映射到在线空闲连接
    let friends = [];
    if (p.account) {
      const list = users.listFriends(p.account);
      const onlineMap = new Map(); // account -> 空闲在线 player
      for (const pl of this.players.values()) {
        if (pl.account && this._isLobbyIdle(pl) && pl.account !== p.account) onlineMap.set(pl.account, pl);
      }
      friends = list
        .map((f) => onlineMap.get(f.username))
        .filter(Boolean)
        .map((pl) => ({ key: this._onlineKey(pl), name: pl.name, online: true }));
    }
    // 大厅空闲人员：所有在线空闲玩家（排除自己、排除已在房间内的自己）
    const lobby = [];
    for (const pl of this.players.values()) {
      const key = this._onlineKey(pl);
      if (key === meKey) continue; // 排除自己
      if (!this._isLobbyIdle(pl)) continue; // 已在房间或离线者不可邀
      // 已登录且已出现在好友列表里的不再重复列入大厅
      if (p.account && pl.account && users.listFriends(p.account).some((f) => f.username === pl.account)) continue;
      lobby.push({ key, name: pl.name, online: true });
    }
    this._send(p, { type: 'online_list', friends, lobby });
  }

  /**
   * 房主邀请在线玩家（好友或大厅人员）进入自己的房间。
   * msg.key：目标玩家的 onlineKey（登录用户=username，游客=playerId）。
   * 好友局必须受邀进入；公共局也可邀请。目标空闲则下发 invite_received 弹窗。
   */
  _invitePlayer(p, msg) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (p.id !== room.ownerId) return this._err(p, '只有房主可以邀请玩家');
    // 仅 waiting/settled 状态可邀请（进行中不可加人，观战另说）
    if (room.state !== 'waiting' && room.state !== 'settled') return this._err(p, '牌局进行中，无法邀请新玩家');
    if (!room.players.some((x) => x === null)) return this._err(p, '房间已满');
    const key = String((msg && msg.key) || '').trim();
    if (!key) return this._err(p, '未指定邀请对象');
    // 定位目标在线玩家
    let target = null;
    for (const pl of this.players.values()) {
      if (this._onlineKey(pl) === key) { target = pl; break; }
    }
    if (!target || !this._isLobbyIdle(target)) return this._err(p, '该玩家当前不在线或已在其他房间');
    if (target.id === p.id) return this._err(p, '不能邀请自己');
    // 下发邀请弹窗（含房间信息）
    this._send(target, {
      type: 'invite_received',
      roomId: room.id,
      roomType: room.settings ? room.settings.roomType : 'public',
      ownerName: p.name,
      variant: room.settings ? room.settings.variant : 'koudian',
    });
    this._send(p, { type: 'invite_result', ok: true, name: target.name });
    this._log(room, `${p.name} 邀请了 ${target.name}`);
  }

  /**
   * 被邀请方回应：accept 则直接拉入房间（好友局无需房间号），decline 则忽略。
   * 仅等待中的房间可接受；好友局依赖此路径进入（大厅列表不可见）。
   */
  _inviteReply(p, msg) {
    const roomId = String((msg && msg.roomId) || '').trim();
    const accept = !!(msg && msg.accept);
    if (!roomId) return this._err(p, '缺少房间号');
    const room = this.rooms.get(roomId);
    if (!room) return this._err(p, '房间已不存在');
    if (!accept) {
      this._send(p, { type: 'invite_result', ok: false, declined: true });
      return;
    }
    if (p.roomId) return this._err(p, '您已在房间中');
    if (room.state !== 'waiting' && room.state !== 'settled') return this._err(p, '牌局已开始，无法加入');
    if (!room.players.some((x) => x === null)) return this._err(p, '房间已满');
    this._resetJoinFails(p);
    this._seatPlayer(room, p);
    this._log(room, `${p.name} 接受邀请加入房间`);
    this._send(p, { type: 'room_state', room: this._buildRoomView(room, p.seat) });
    this._broadcastRoomState(room);
    this._broadcastLobby();
  }

  _leaveRoom(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    // 旁观者：随时可退出，不受 playing 状态限制
    if (p.isViewer) {
      room.viewers = (room.viewers || []).filter((v) => v !== p);
      p.roomId = null;
      p.seat = null;
      p.isViewer = false;
      this._log(room, `${p.name} 退出观战`);
      this._send(p, { type: 'room_state', room: null });
      this._sendLobbyState(p);
      this._broadcastRoomState(room);
      return;
    }
    if (room.state === 'playing') {
      return this._err(p, '牌局进行中，无法退出（可请房主解散房间）');
    }
    if (p.id === room.ownerId) {
      // AI 不能成为房主：仅从其他真人中转让，无真人则解散房间
      const others = room.players.filter(Boolean).filter((x) => x.id !== p.id && !x.isAI);
      if (others.length === 0) {
        this._destroyRoom(room);
        return;
      }
      room.ownerId = others[0].id;
      this._log(room, `房主 ${p.name} 退出，${others[0].name} 成为新房主`);
    }
    this._unseatPlayer(room, p);
    this._log(room, `${p.name} 离开了房间`);
    this._send(p, { type: 'room_state', room: null });
    this._sendLobbyState(p);
    this._broadcastRoomState(room);
    this._broadcastLobby();
  }

  _dissolve(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (p.id !== room.ownerId) return this._err(p, '只有房主可以解散房间');
    this._log(room, `房间 ${room.id} 已被房主解散`);
    this._destroyRoom(room);
  }

  _addAIByPlayer(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (p.id !== room.ownerId) return this._err(p, '只有房主可以添加 AI');
    if (room.state !== 'waiting' && room.state !== 'settled') return this._err(p, '当前状态不能添加 AI');
    if (room.players.filter(Boolean).length >= 4) return this._err(p, '房间已满');
    this._addAI(room);
    this._broadcastRoomState(room);
    this._broadcastLobby();
    // 不再自动开局：人齐后由房主点击「开始游戏」触发
  }

  _kickPlayer(p, msg) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (p.id !== room.ownerId) return this._err(p, '只有房主可以踢出玩家');
    if (room.state !== 'waiting' && room.state !== 'settled') return this._err(p, '牌局进行中，无法踢出玩家');
    const targetId = String((msg && msg.targetId) || '').trim();
    // 房间视图里他人 id 是座位代称（s0-s3）；兼容旧客户端直传的真实 playerId
    const target = this._resolveRoomPlayer(room, targetId);
    if (!target) return this._err(p, '目标玩家不在房间中');
    if (target.id === p.id) return this._err(p, '不能踢出自己');
    this._unseatPlayer(room, target);
    if (target.isAI) {
      this.players.delete(target.id);
      this._log(room, `${p.name} 将 ${target.name}（AI）踢出了房间`);
    } else {
      this._send(target, { type: 'room_state', room: null });
      this._sendLobbyState(target);
      this._log(room, `${p.name} 将 ${target.name} 踢出了房间`);
    }
    this._broadcastRoomState(room);
    this._broadcastLobby();
  }

  _startGame(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (p.id !== room.ownerId) return this._err(p, '只有房主可以开始游戏');
    if (room.state !== 'waiting' && room.state !== 'settled') {
      return this._err(p, '牌局正在进行中');
    }
    if (!room.settings.aiFill && room.players.filter(Boolean).length < 4) {
      return this._err(p, '人数不足 4 人，无法开局（AI 补位已关闭）');
    }
    this._startGameInternal(room);
  }

  _startGameInternal(room) {
    if (room.state === 'settled') {
      // 新一轮：重置积分与局数
      room.roundNo = 0;
      room.lastWinner = null;
      room.dealer = null;
      for (const pl of room.players) {
        if (pl) {
          pl.score = 0;
          pl.roundScore = 0;
          pl.hosted = false;
        }
      }
      room.state = 'waiting';
      this._log(room, '开启新一轮，积分已重置');
    }
    if (room.state !== 'waiting') return;
    if (room.settings.aiFill) {
      while (room.players.filter(Boolean).length < 4) this._addAI(room);
    }
    if (room.players.filter(Boolean).length !== 4) {
      this._log(room, '人数不足，无法开局（AI 补位已关闭）');
      this._broadcastRoomState(room);
      return;
    }
    this._dealRound(room);
  }

  _addAI(room) {
    const seat = room.players.findIndex((x) => x === null);
    if (seat < 0) return null;
    const seq = room.nextAiNo++;
    const p = {
      id: `ai_${room.id}_${seq}`,
      name: `机器人${seq}`,
      isAI: true,
      connected: true,
      hosted: false,
      ws: null,
      roomId: room.id,
      seat,
      score: 0,
      roundScore: 0,
      disconnectTimer: null,
      _autoToken: 0, _autoGen: 0, _autoActing: false,
    };
    room.players[seat] = p;
    this.players.set(p.id, p);
    this._log(room, `${p.name} 加入房间（AI）`);
    return p;
  }

  // ============ 牌局 ============

  /** 发牌开局（三玩法统一）：普通 136 张扣点点；红中 112 张直接开局；贴金翻金母定金牌直接开局 */
  _dealRound(room) {
    room.roundNo = (room.roundNo || 0) + 1;
    const isHz = this._isHongZhong(room);
    const isTj = this._isTieJin(room);
    const wall = rules.shuffle(isHz ? rules.createTiles112() : rules.createTiles(), this.rng);
    // 贴金：翻金母，从牌墙末翻一张作为金母（不参与摸牌），按对牌关系确定本局金牌
    const goldMother = isTj ? wall[wall.length - 1] : null;
    if (isTj) wall.pop();
    const goldTile = isTj ? rules.goldFromMother(goldMother) : null;
    const g = (room.game = {
      roundNo: room.roundNo,
      wall,
      wallPos: 0,
      hands: [[], [], [], []],
      melds: [[], [], [], []],
      discards: [[], [], [], []],
      kouTiles: [[], [], [], []],
      gangLogs: [], // 本局杠分明细
      turn: -1,
      stage: 'draw',
      drawnTile: null,
      newTiles: [null, null, null, null], // 每位玩家当前“新摸到”的牌（仅自己视角可见，打出/碰/杠/报听后清除）
      lastDiscard: null,
      lastAction: null,
      pending: null,
      dealer: -1,
      winners: null,
      tingSeats: [], // 已报听（听口）的玩家 seat 列表（红中/贴金无报听，恒空）
      ...(isHz ? { zhaMaTiles: null, hzWinners: null } : {}), // 红中：本局扎码牌、一炮多响赢家明细
      ...(isTj
        ? {
            goldMother,
            goldTile,
            shangjinTiles: [[], [], [], []], // 亮金区（已亮出的金牌）
            shangjinCount: [0, 0, 0, 0], // 亮金张数（锁金亮出的 2 张也计入，计分时三金封顶）
            locked: [false, false, false, false], // 锁金状态（被锁者只能自摸）
            lockSeat: -1, // 锁金者座位
            huPassed: [false, false, false, false], // 过胡限制：获得下一次抓牌权前禁胡
          }
        : {}),
      startAt: Date.now(),
    });
    // 坐庄：谁胡谁坐庄（庄胡连庄）；首局普通/红中随机、贴金创建房间者为庄；流局普通按 dealerFlow、红中连庄、贴金有杠下家坐庄
    if (room.lastWinner != null && room.players[room.lastWinner]) {
      room.dealer = room.lastWinner;
    } else if (room.dealer == null || !room.players[room.dealer]) {
      if (isTj) {
        const ownerSeat = room.players.findIndex((pl) => pl && pl.id === room.ownerId);
        room.dealer = ownerSeat >= 0 ? ownerSeat : Math.floor(this.rng() * 4);
      } else {
        room.dealer = Math.floor(this.rng() * 4);
      }
    } else if (isTj && room.lastFlowHadGang) {
      room.dealer = (room.dealer + 1) % 4; // 贴金流局有杠：下家坐庄
    } else if (!isHz && !isTj && room.settings.dealerFlow !== 'keep') {
      room.dealer = (room.dealer + 1) % 4; // 普通流局下家接庄
    }
    // dealerFlow === 'keep' 或红中：流局连庄，room.dealer 保持不变
    if (isTj) room.lastFlowHadGang = false; // 每局重置，流局结算时按本局杠情况设置
    g.dealer = room.dealer;
    for (const pl of room.players) if (pl) pl.roundScore = 0;
    room.state = 'playing';
    if (isHz) this._log(room, `第 ${room.roundNo} 局开始（红中麻将），${this._pName(room, g.dealer)} 坐庄`);
    else if (isTj)
      this._log(room, `第 ${room.roundNo} 局开始（运城贴金麻将），${this._pName(room, g.dealer)} 坐庄，金母 ${rules.tileName(goldMother)} → 金牌 ${rules.tileName(goldTile)}`);
    else this._log(room, `第 ${room.roundNo} 局开始，${this._pName(room, g.dealer)} 坐庄`);

    // 发牌：先各发 13 张
    for (let i = 0; i < 13; i++) {
      for (let s = 0; s < 4; s++) g.hands[s].push(g.wall[g.wallPos++]);
    }
    // 游戏日志：本局开局快照（房间信息 + 底牌：完整牌墙 / 各家手牌 / 金牌信息）
    this._logGame(room, 'round_start', {
      variant: isHz ? 'hongzhong' : isTj ? 'tiejin' : 'koudian',
      settings: room.settings,
      dealer: g.dealer,
      players: this._logPlayers(room),
      wall: g.wall.slice(), // 完整牌墙（含已发部分与剩余牌，wallPos 标识摸牌进度）
      wallPos: g.wallPos,
      hands: g.hands.map((h) => h.slice()),
      melds: g.melds.map((m) => m.slice()),
      discards: g.discards.map((d) => d.slice()),
      goldMother: goldMother,
      goldTile: goldTile,
      kouTiles: g.kouTiles.map((k) => k.slice()),
      shangjinCount: g.shangjinCount ? g.shangjinCount.slice() : null,
    });
    // 红中/贴金：庄家补第 14 张直接开局（起手即终态，不再摸牌）
    if (isHz || isTj) {
      g.hands[g.dealer].push(g.wall[g.wallPos++]);
      this._broadcastRoomState(room);
      this._broadcastGameState(room);
      this._startPlay(room, g.dealer);
      return;
    }
    // 普通：发牌后庄家直接摸第 14 张开局（已去除开局扣点玩法）
    this._broadcastRoomState(room);
    this._broadcastGameState(room);
    this._drawCard(room, g.dealer, false);
    return;
  }

  /** 摸牌 / 杠后补牌（三玩法统一）：流局判定按玩法分支；普通报听锁死摸打，红中/贴金直接行动，贴金解除过胡限制 */
  _drawCard(room, seat, afterGang) {
    const g = room.game;
    if (this._isHongZhong(room)) {
      // 红中流局判定：行牌摸完最后一张（牌墙摸空无人胡）才流局；扎码牌另行抓取，不参与此判定
      if (g.wall.length - g.wallPos <= 0) {
        this._settleDraw(room);
        return;
      }
    } else if (this._isTieJin(room)) {
      // 贴金流局判定：同摸牌（扎码牌另行抓取）
      if (this._tieJinWallEnded(room, g)) {
        this._settleDraw(room);
        return;
      }
    } else {
      // 普通流局判定：牌墙剩 6 墩（12 张）直接流局
      if (g.wall.length - g.wallPos <= 12) {
        this._settleDraw(room);
        return;
      }
    }
    const tile = g.wall[g.wallPos++];
    g.hands[seat].push(tile);
    g.turn = seat;
    g.stage = 'draw';
    g.drawnTile = tile;
    g.lastDiscard = null;
    g.lastAction = afterGang ? { type: 'gang' } : null; // 杠后补牌保持杠标记 → 杠上开花
    // 普通报听玩家摸牌即打（或自摸），手牌锁死，不标“新牌”；红中/贴金无报听，正常记录新摸牌
    g.newTiles[seat] = (this._isHongZhong(room) || this._isTieJin(room) || !g.tingSeats.includes(seat)) ? tile : null;
    if (this._isTieJin(room)) g.huPassed[seat] = false; // 贴金：获得抓牌权，过胡限制解除
    this._log(room, `${this._pName(room, seat)} ${afterGang ? '杠后补到' : '摸到'} ${rules.tileName(tile)}`, seat, `${this._pName(room, seat)} ${afterGang ? '杠后补牌' : '摸牌'}`);
    this._logGame(room, 'action', { action: 'draw', seat, tile, afterGang: !!afterGang, wallPos: g.wallPos });
    const cur = room.players[seat];
    if (cur && cur.ws) this._send(cur, { type: 'draw_notice', tile });
    // 普通报听玩家：摸牌即打（不能换牌、不能碰），但若摸到可补杠/暗杠且不破坏听口则进入行动阶段给杠选项
    // （低点胡 1/2 点不能自摸，不进入行动阶段，否则 AI 决策会落回 play 被 _playTile 拒绝导致 stuck）
    if (!this._isHongZhong(room) && !this._isTieJin(room) && g.tingSeats.includes(seat)) {
      // 报听玩家：若摸牌构成自摸胡（且满足点数限制），进入行动阶段给胡/过；或摸到可杠（不破坏听口）给杠；否则摸牌即打（锁死）
      const canSelfHu = rules.checkHu(g.hands[seat], g.melds[seat]) && rules.canHuByPoints(rules.tilePoints(tile), 'zimo');
      const gangOpts = this._tingGangOptions(room, seat);
      if (canSelfHu || gangOpts.length > 0) {
        this._afterTurnStart(room, seat);
        return;
      }
      this._autoTingDiscard(room, seat, tile);
      return;
    }
    this._afterTurnStart(room, seat);
  }

  /** 听口玩家摸牌即打：将刚摸的牌立即打出，并进入响应判定 */
  _autoTingDiscard(room, seat, tile) {
    const g = room.game;
    const idx = g.hands[seat].lastIndexOf(tile);
    if (idx >= 0) g.hands[seat].splice(idx, 1);
    g.discards[seat].push(tile);
    g.lastDiscard = { tile, seat };
    g.drawnTile = null;
    g.lastAction = null;
    g.newTiles[seat] = null; // 摸牌即打：新牌标志随出牌清除
    this._clearTimer(room, 'draw:' + seat);
    this._log(room, `${this._pName(room, seat)} 摸牌即打 ${rules.tileName(tile)}（听口）`);
    this._logGame(room, 'action', { action: 'discard', seat, tile, auto: true, ting: true });
    this._afterDiscard(room, seat);
  }

  /** 碰后 / 摸牌后 / 杠后补牌后：统一进入行动阶段 */
  _afterTurnStart(room, seat) {
    const g = room.game;
    this._broadcastGameState(room);
    this._prompt(room, seat, this._buildDrawPrompt(room, seat));
    this._setTimer(room, 'draw:' + seat, HUMAN_TIMEOUT_MS, () => {
      const g2 = room.game;
      if (room.state === 'playing' && g2 === g && g2.stage === 'draw' && g2.turn === seat) {
        const pl = room.players[seat];
        if (pl && !pl.isAI && pl.connected && !pl.hosted) {
          pl.hosted = true;
          this._log(room, `${pl.name} 操作超时，已由 AI 托管`);
          this._broadcastRoomState(room);
        }
        if (this._shouldAutoAct(room, seat)) this._scheduleAutoAct(room, seat);
      }
    });
    if (this._shouldAutoAct(room, seat)) this._scheduleAutoAct(room, seat);
  }

  _nextTurn(room, fromSeat) {
    for (let i = 1; i <= 4; i++) {
      const s = (fromSeat + i) % 4;
      if (room.players[s]) {
        this._drawCard(room, s, false);
        return;
      }
    }
  }

  /** 出牌后的响应判定 */
  _afterDiscard(room, discarder) {
    const g = room.game;
    const tile = g.lastDiscard.tile;
    const responders = [];
    if (this._isTieJin(room)) {
      // 贴金：截胡单响（逆时针最近的可胡者；字牌整副胡只能自摸），其余座位按杠/碰判定
      const gold = g.goldTile;
      let huSeat = -1;
      for (let i = 1; i <= 3; i++) {
        const s = (discarder + i) % 4;
        if (!room.players[s]) continue;
        if (g.huPassed[s]) continue;
        if (!this._tieJinCanDianpao(room, s)) continue;
        if (rules.isFirstGoldUnplayed([...g.hands[s], tile], gold, (g.shangjinCount || [])[s] || 0)) continue; // 有金未上：不能胡
        if (!rules.canHuTieJinWith(g.hands[s], tile, g.melds[s], gold)) continue;
        if (rules.isAllHonorShape([...g.hands[s], tile], g.melds[s], gold)) continue; // 字牌整副胡只能自摸
        huSeat = s;
        break;
      }
      for (let i = 1; i <= 3; i++) {
        const s = (discarder + i) % 4;
        if (!room.players[s]) continue;
        // 首金未亮且亮金可行：只能亮金（亮金需要出牌权），本轮不提供碰/杠/胡响应
        if (this._tieJinMustLiangjin(room, s)) continue;
        if (s === huSeat) {
          responders.push({ seat: s, canHu: true, canGang: false, canPeng: false, choice: null });
          continue;
        }
        const canGang = rules.canGangTieJin(g.hands[s], tile, gold);
        const canPeng = rules.canPengTieJin(g.hands[s], tile, gold);
        if (canGang || canPeng) {
          responders.push({ seat: s, canHu: false, canGang, canPeng, choice: null });
        }
      }
    } else if (this._isHongZhong(room)) {
      for (let s = 0; s < 4; s++) {
        if (!room.players[s] || s === discarder) continue;
        const canHu = false; // 禁点炮胡，仅自摸/抢杠可胡
        const canGang = rules.canGangHongZhong(g.hands[s], tile);
        const canPeng = rules.canPengHongZhong(g.hands[s], tile);
        if (canHu || canGang || canPeng) {
          responders.push({ seat: s, canHu, canGang, canPeng, choice: null });
        }
      }
    } else {
      for (let s = 0; s < 4; s++) {
        if (!room.players[s] || s === discarder) continue;
        // 胡牌受点数限制（6 点及以上才可点炮胡）；仅报听玩家可胡/可杠，不能碰
        const canHu = g.tingSeats.includes(s) && rules.canHuWith(g.hands[s], tile, g.melds[s]) && rules.canHuByPoints(rules.tilePoints(tile), 'dianpao');
        // 报听玩家杠不能破坏听张：杠牌若在当前听口中则不允许明杠
        const canGang = g.tingSeats.includes(s)
          ? (rules.canGang(g.hands[s], tile) && !rules.isTing(g.hands[s], g.melds[s]).includes(tile))
          : rules.canGang(g.hands[s], tile);
        const canPeng = g.tingSeats.includes(s) ? false : rules.canPeng(g.hands[s], tile);
        if (canHu || canGang || canPeng) {
          responders.push({ seat: s, canHu, canGang, canPeng, choice: null });
        }
      }
    }
    if (responders.length === 0) {
      g.lastAction = null;
      this._nextTurn(room, discarder);
      return;
    }
    g.stage = 'response';
    g.pending = { type: 'discard', tile, discarder, responders };
    this._broadcastGameState(room);
    for (const r of responders) {
      this._prompt(room, r.seat, this._buildResponsePrompt(room, r));
      this._setTimer(room, 'resp:' + r.seat, RESPONSE_TIMEOUT_MS, () => {
        const g2 = room.game;
        if (room.state === 'playing' && g2 === g && g.pending === r._pendingRef && r.choice === null) {
          // 仅自动过牌，不托管在线真人：响应窗口只给“过”的兜底，
          // 托管交由出牌阶段 HUMAN_TIMEOUT 处理，避免在线玩家被误判挂机
          r.choice = 'pass';
          this._tryResolvePending(room, g, g.pending);
        }
      });
      r._pendingRef = g.pending;
      if (this._shouldAutoAct(room, r.seat)) this._scheduleAutoAct(room, r.seat);
    }
  }

  _tryResolvePending(room, g, pending) {
    if (!pending) return;
    const allDecided = pending.responders.every((r) => r.choice !== null);
    if (!allDecided) return;
    for (const r of pending.responders) this._clearTimer(room, 'resp:' + r.seat);
    g.pending = null;

    const huList = pending.responders.filter((r) => r.choice === 'hu');
    if (huList.length > 0) {
      if (this._isHongZhong(room)) {
        // 红中：一炮多响，全部同时胡（hzWinners/_accPayments 在 _settleHu 内累计，收尾统一广播结算）
        for (const r of huList) {
          this._settleHu(room, r.seat, {
            winType: pending.type === 'qianggang' ? 'qianggang' : 'dianpao',
            tile: pending.tile,
            discarder: pending.discarder,
          });
        }
      } else {
        // 普通：距放炮（补杠）者最近的一家胡牌；贴金：截胡单响（huList 至多 1）
        const pick = this._isTieJin(room)
          ? huList[0].seat
          : this._nearestSeat(huList.map((r) => r.seat), pending.discarder);
        this._settleHu(room, pick, {
          winType: pending.type === 'qianggang' ? 'qianggang' : 'dianpao',
          tile: pending.tile,
          discarder: pending.discarder,
          qiangGang: pending.type === 'qianggang',
        });
      }
      this._finishHuRound(room);
      return;
    }
    // 贴金过胡限制：可胡者主动过（或超时）→ 在获得下一次抓牌权前禁止其胡牌
    if (this._isTieJin(room)) {
      for (const r of pending.responders) {
        if (r.canHu && r.choice === 'pass') g.huPassed[r.seat] = true;
      }
    }
    const gangList = pending.responders.filter((r) => r.choice === 'gang');
    if (gangList.length > 0) {
      const pick = this._nearestSeat(gangList.map((r) => r.seat), pending.discarder);
      this._doGangFromDiscard(room, pick, pending.tile, pending.discarder);
      return;
    }
    const pengList = pending.responders.filter((r) => r.choice === 'peng');
    if (pengList.length > 0) {
      const pick = this._nearestSeat(pengList.map((r) => r.seat), pending.discarder);
      this._doPeng(room, pick, pending.tile, pending.discarder);
      return;
    }
    g.lastAction = null;
    this._nextTurn(room, pending.discarder);
  }

  _nearestSeat(seats, fromSeat) {
    let best = seats[0];
    let bestDist = Infinity;
    for (const s of seats) {
      const d = (s - fromSeat + 4) % 4;
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  _doPeng(room, seat, tile, discarder) {
    const g = room.game;
    // 贴金双保险：首金未亮且亮金可行时只能亮金，不允许碰
    if (this._isTieJin(room) && this._tieJinMustLiangjin(room, seat)) return;
    const hand = g.hands[seat];
    let removed = 0;
    for (let i = 0; i < hand.length && removed < 2; i++) {
      if (hand[i] === tile) {
        hand.splice(i, 1);
        i--;
        removed++;
      }
    }
    // 从打出者弃牌区移除被碰的牌（打出者最近打出的牌位于数组末尾，从末尾向前找最后一张同值牌）
    if (discarder != null && g.discards[discarder]) {
      const arr = g.discards[discarder];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] === tile) {
          arr.splice(i, 1);
          break;
        }
      }
    }
    g.melds[seat].push({ type: 'peng', tile, tiles: [tile, tile, tile] });
    g.lastDiscard = null;
    g.lastAction = { type: 'peng' };
    g.turn = seat;
    g.stage = 'draw';
    g.drawnTile = null; // 碰后只能出牌/报听（碰完即听可立即报听），不能胡/杠
    g.newTiles[seat] = null; // 碰后手牌变动，新牌标志清除
    this._log(room, `${this._pName(room, seat)} 碰了 ${rules.tileName(tile)}`);
    this._logGame(room, 'action', { action: 'peng', seat, tile, fromSeat: discarder });
    this._afterTurnStart(room, seat);
  }

  /** 136 模式杠分：明杠/补杠=该牌点数（字牌 10 点）、暗杠=点数×2；其余三家各付一份给杠主；杠时仅记录明细，整局结束（胡牌）统一结算、流局不计；抢杠胡成立时不记录（调用方在抢杠分支直接返回，不会进入本方法） */
  _settleGangScore(room, seat, tile, type) {
    const g = room.game;
    const points = rules.tilePoints(tile); // 数牌按面值、字牌 10 点
    const perSeat = type === 'angang' ? points * 2 : points;
    g.gangLogs.push({ seat, tile, type, perSeat, points, kou: 1 });
    // 不在此处输出算分日志：扣点点杠分延迟到整局结束统一结算，进行中显示分值会泄露牌面信息
    // （点数×倍数可反推暗杠/明杠的牌）；杠的动作日志已由 _doMingGang/_doAnGang/_doBuGang 各自记录
  }

  /** 136 模式杠分统一入账：仅胡牌结算时调用；遍历 gangLogs，杠家收 perSeat×3，其余三家各付 perSeat；流局（黄庄）不调用即杠分不计 */
  _applyGangScores(room) {
    const g = room.game;
    for (const lg of g.gangLogs) {
      const gain = lg.perSeat * 3;
      for (let s = 0; s < 4; s++) {
        if (s === lg.seat || !room.players[s]) continue;
        room.players[s].score -= lg.perSeat;
        room.players[s].roundScore -= lg.perSeat;
      }
      room.players[lg.seat].score += gain;
      room.players[lg.seat].roundScore += gain;
    }
    if (g.gangLogs.length > 0) {
      const detail = g.gangLogs
        .map((lg) => `${this._pName(room, lg.seat)} 收 ${lg.perSeat * 3} 分（${lg.type === 'angang' ? '暗杠' : lg.type === 'bugang' ? '补杠' : '明杠'} ${rules.tileName(lg.tile)}）`)
        .join('、');
      this._log(room, `杠分统一结算：${detail}`);
    }
  }

  /** 杠分支付明细条目（统一支付明细表用）：
   *  136：明杠/补杠=牌点、暗杠=牌点×2，其余三家各付一份给杠主；
   *  红中（lg.hz）：杠分当场已结算——放杠(有payer)放杠者独付2手、补杠每家1手、暗杠每家2手，这里仅补展示明细
   */
  _buildGangPayments(room) {
    const g = room.game;
    const pays = [];
    for (const lg of g.gangLogs) {
      if (lg.hz) {
        if (lg.payer != null) {
          pays.push({
            kind: 'gang',
            title: `放杠 ${rules.tileName(lg.tile)}（放杠者付 ${lg.perSeat} 手）`,
            toSeat: lg.seat,
            toAmount: lg.perSeat,
            rows: [{ seat: lg.payer, amount: -lg.perSeat, role: '放杠' }],
          });
        } else {
          const typeName = lg.type === 'angang' ? '暗杠' : '补杠';
          const rows = [];
          for (let s = 0; s < 4; s++) {
            if (s === lg.seat) continue;
            rows.push({ seat: s, amount: -lg.perSeat, role: '杠分' });
          }
          pays.push({
            kind: 'gang',
            title: `${typeName} ${rules.tileName(lg.tile)}（每家付 ${lg.perSeat} 手）`,
            toSeat: lg.seat,
            toAmount: lg.perSeat * 3,
            rows,
          });
        }
        continue;
      }
      const typeName = lg.type === 'angang' ? '暗杠' : lg.type === 'bugang' ? '补杠' : '明杠';
      const rows = [];
      for (let s = 0; s < 4; s++) {
        if (s === lg.seat) continue;
        rows.push({ seat: s, amount: -lg.perSeat, role: '杠分' });
      }
      pays.push({
        kind: 'gang',
        title: `${typeName} ${rules.tileName(lg.tile)}（${lg.points}点）`,
        toSeat: lg.seat,
        toAmount: lg.perSeat * 3,
        rows,
      });
    }
    return pays;
  }

  /** 明杠（放杠）：普通玩法延迟统一结算；红中杠牌当场结（放杠者付 2 手）；贴金杠牌当场结（其余三家各付 1 分，含放杠者） */
  _doGangFromDiscard(room, seat, tile, discarder) {
    const g = room.game;
    const hand = g.hands[seat];
    let removed = 0;
    for (let i = 0; i < hand.length && removed < 3; i++) {
      if (hand[i] === tile) {
        hand.splice(i, 1);
        i--;
        removed++;
      }
    }
    // 从打出者弃牌区移除被明杠的牌（从末尾向前找最后一张同值牌）
    if (discarder != null && g.discards[discarder]) {
      const arr = g.discards[discarder];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] === tile) {
          arr.splice(i, 1);
          break;
        }
      }
    }
    g.melds[seat].push({ type: 'gang', tile, tiles: [tile, tile, tile, tile] });
    g.lastDiscard = null;
    g.lastAction = { type: 'gang' };
    g.turn = seat;
    g.newTiles[seat] = null; // 杠后补牌前清除旧标志（补牌后重新设置）
    if (this._isHongZhong(room)) {
      // 红中：杠牌当场结——放杠者付 2 手（2 分）给杠家
      if (discarder != null && room.players[discarder]) {
        room.players[discarder].score -= 2;
        room.players[discarder].roundScore -= 2;
        room.players[seat].score += 2;
        room.players[seat].roundScore += 2;
      }
      g.gangLogs.push({ seat, tile, type: 'gang', perSeat: 2, points: 2, kou: 1, payer: discarder, hz: true });
      this._log(room, `${this._pName(room, seat)} 放杠 ${rules.tileName(tile)}（${this._pName(room, discarder)} 付 2 手）`);
      this._logGame(room, 'action', { action: 'gang', gangType: 'ming', seat, tile, fromSeat: discarder, perSeat: 2, hz: true });
      this._drawCard(room, seat, true);
      return;
    }
    if (this._isTieJin(room)) {
      // 贴金：杠牌当场结——其余三家各付 1 分给杠家（含放杠者）
      for (let s = 0; s < 4; s++) {
        if (s === seat || !room.players[s]) continue;
        room.players[s].score -= 1;
        room.players[s].roundScore -= 1;
      }
      room.players[seat].score += 3;
      room.players[seat].roundScore += 3;
      g.gangLogs.push({ seat, tile, type: 'gang', perSeat: 1, points: 3, payer: discarder, kou: 1 });
      this._log(room, `${this._pName(room, seat)} 放杠 ${rules.tileName(tile)}（每家付 1 分）`);
      this._logGame(room, 'action', { action: 'gang', gangType: 'ming', seat, tile, fromSeat: discarder, perSeat: 1 });
      this._drawCard(room, seat, true);
      return;
    }
    // 普通玩法：杠分统一延迟结算
    this._log(room, `${this._pName(room, seat)} 明杠了 ${rules.tileName(tile)}`);
    this._logGame(room, 'action', { action: 'gang', gangType: 'ming', seat, tile, fromSeat: discarder });
    this._settleGangScore(room, seat, tile, 'ming');
    this._drawCard(room, seat, true);
  }

  /** 暗杠：普通玩法延迟统一结算；红中杠牌当场结（其余每家付 2 手）；贴金杠牌当场结（其余每家付 2 分，金牌不可杠） */
  _doAnGang(room, seat, tile) {
    const g = room.game;
    // 贴金双保险（金牌不可杠 + 首金未亮时只能亮金）
    if (this._isTieJin(room) && !rules.canAnGangTieJin(g.hands[seat], tile, g.goldTile)) return;
    if (this._isTieJin(room) && this._tieJinMustLiangjin(room, seat)) return;
    const hand = g.hands[seat];
    let removed = 0;
    for (let i = 0; i < hand.length && removed < 4; i++) {
      if (hand[i] === tile) {
        hand.splice(i, 1);
        i--;
        removed++;
      }
    }
    g.melds[seat].push({ type: 'angang', tile, tiles: [tile, tile, tile, tile] });
    g.lastAction = { type: 'gang' };
    g.newTiles[seat] = null; // 杠后补牌前清除旧标志（补牌后重新设置）
    if (this._isHongZhong(room)) {
      // 红中：杠牌当场结——其余每家付 2 手（2 分）给杠家
      for (let s = 0; s < 4; s++) {
        if (s === seat || !room.players[s]) continue;
        room.players[s].score -= 2;
        room.players[s].roundScore -= 2;
      }
      room.players[seat].score += 6;
      room.players[seat].roundScore += 6;
      g.gangLogs.push({ seat, tile, type: 'angang', perSeat: 2, points: 2, kou: 1, hz: true });
      this._log(room, `${this._pName(room, seat)} 暗杠了 ${rules.tileName(tile)}（每家付 2 手）`, seat, `${this._pName(room, seat)} 暗杠（每家付 2 手）`);
      this._logGame(room, 'action', { action: 'gang', gangType: 'angang', seat, tile, perSeat: 2, hz: true });
      this._drawCard(room, seat, true);
      return;
    }
    if (this._isTieJin(room)) {
      // 贴金：杠牌当场结——其余每家付 2 分给杠家
      for (let s = 0; s < 4; s++) {
        if (s === seat || !room.players[s]) continue;
        room.players[s].score -= 2;
        room.players[s].roundScore -= 2;
      }
      room.players[seat].score += 6;
      room.players[seat].roundScore += 6;
      g.gangLogs.push({ seat, tile, type: 'angang', perSeat: 2, points: 6, kou: 1 });
      this._log(room, `${this._pName(room, seat)} 暗杠了 ${rules.tileName(tile)}（每家付 2 分）`, seat, `${this._pName(room, seat)} 暗杠（每家付 2 分）`);
      this._logGame(room, 'action', { action: 'gang', gangType: 'angang', seat, tile, perSeat: 2 });
      this._drawCard(room, seat, true);
      return;
    }
    // 普通玩法：杠分统一延迟结算
    this._log(room, `${this._pName(room, seat)} 暗杠了 ${rules.tileName(tile)}`, seat, `${this._pName(room, seat)} 暗杠`);
    this._logGame(room, 'action', { action: 'gang', gangType: 'angang', seat, tile });
    this._settleGangScore(room, seat, tile, 'angang');
    this._drawCard(room, seat, true);
  }

  /** 补杠：普通玩法延迟统一结算；红中杠牌当场结（其余每家付 1 手）；贴金杠牌当场结（其余每家付 1 分）。抢杠判定：普通/红中多响，贴金截胡单响 */
  _doBuGang(room, seat, tile) {
    const g = room.game;
    // 贴金双保险（金牌不可杠 + 首金未亮时只能亮金）
    if (this._isTieJin(room) && !rules.canBuGangTieJin(g.hands[seat], g.melds[seat], tile, g.goldTile)) return;
    if (this._isTieJin(room) && this._tieJinMustLiangjin(room, seat)) return;
    // 先检查抢杠胡（玩法判定各异）
    const grabbers = [];
    let resolveFn = null;
    let onPass = null;
    if (this._isTieJin(room)) {
      // 贴金：截胡单响（逆时针最近的可胡者；字牌整副胡只能自摸）
      for (let i = 1; i <= 3; i++) {
        const s = (seat + i) % 4;
        if (!room.players[s]) continue;
        if (g.huPassed[s]) continue;
        if (!this._tieJinCanDianpao(room, s)) continue;
        if (rules.isFirstGoldUnplayed([...g.hands[s], tile], g.goldTile, (g.shangjinCount || [])[s] || 0)) continue; // 有金未上：不能胡
        if (!rules.canHuTieJinWith(g.hands[s], tile, g.melds[s], g.goldTile)) continue;
        if (rules.isAllHonorShape([...g.hands[s], tile], g.melds[s], g.goldTile)) continue;
        grabbers.push(s);
        break;
      }
      resolveFn = (r2, g2, pending) => this._tryResolvePending(r2, g2, pending);
      onPass = (g2, s) => { g2.huPassed[s] = true; };
    } else if (this._isHongZhong(room)) {
      // 红中：一炮多响
      for (let s = 0; s < 4; s++) {
        if (s === seat || !room.players[s]) continue;
        if (rules.canHuHongZhongWith(g.hands[s], tile, g.melds[s])) grabbers.push(s);
      }
      resolveFn = (r2, g2, pending) => this._tryResolvePending(r2, g2, pending);
    } else {
      // 普通：抢杠胡算点炮，受点数限制（6 点及以上才可胡）；仅报听玩家可抢杠；明牌区刻子计入已成型面子
      for (let s = 0; s < 4; s++) {
        if (s === seat || !room.players[s]) continue;
        const canHu = g.tingSeats.includes(s) && rules.canHuWith(g.hands[s], tile, g.melds[s]) && rules.canHuByPoints(rules.tilePoints(tile), 'qianggang');
        if (canHu) grabbers.push(s);
      }
      resolveFn = (r2, g2, pending) => this._tryResolvePending(r2, g2, pending);
    }
    if (grabbers.length > 0) {
      g.stage = 'response';
      g.pending = {
        type: 'qianggang',
        tile,
        discarder: seat,
        responders: grabbers.map((s) => ({
          seat: s,
          canHu: true,
          canGang: false,
          canPeng: false,
          choice: null,
        })),
      };
      this._log(room, `${this._pName(room, seat)} 补杠了 ${rules.tileName(tile)}，触发抢杠胡判定`);
      this._broadcastGameState(room);
      for (const r of g.pending.responders) {
        this._prompt(room, r.seat, this._buildResponsePrompt(room, r));
        this._setTimer(room, 'resp:' + r.seat, RESPONSE_TIMEOUT_MS, () => {
          const g2 = room.game;
          if (room.state === 'playing' && g2 === g && g.pending === r._pendingRef && r.choice === null) {
            r.choice = 'pass';
            if (onPass) onPass(g2, r.seat);
            resolveFn(room, g2, g2.pending);
          }
        });
        r._pendingRef = g.pending;
        if (this._shouldAutoAct(room, r.seat)) this._scheduleAutoAct(room, r.seat);
      }
      return;
    }
    // 无人抢杠 → 补杠
    const hand = g.hands[seat];
    const idx = hand.indexOf(tile);
    if (idx >= 0) hand.splice(idx, 1);
    const m = g.melds[seat].find((mm) => mm.type === 'peng' && mm.tile === tile);
    if (m) {
      m.type = 'bugang';
      m.tiles.push(tile);
    }
    g.lastAction = { type: 'gang' };
    g.newTiles[seat] = null; // 杠后补牌前清除旧标志（补牌后重新设置；抢杠分支不动，牌仍在手）
    if (this._isHongZhong(room)) {
      // 红中：杠牌当场结——其余每家付 1 手给杠家
      for (let s = 0; s < 4; s++) {
        if (s === seat || !room.players[s]) continue;
        room.players[s].score -= 1;
        room.players[s].roundScore -= 1;
      }
      room.players[seat].score += 3;
      room.players[seat].roundScore += 3;
      g.gangLogs.push({ seat, tile, type: 'bugang', perSeat: 1, points: 1, kou: 1, hz: true });
      this._log(room, `${this._pName(room, seat)} 补杠了 ${rules.tileName(tile)}（每家付 1 手）`);
      this._logGame(room, 'action', { action: 'gang', gangType: 'bugang', seat, tile, perSeat: 1, hz: true });
      this._drawCard(room, seat, true);
      return;
    }
    if (this._isTieJin(room)) {
      // 贴金：杠牌当场结——其余每家付 1 分给杠家
      for (let s = 0; s < 4; s++) {
        if (s === seat || !room.players[s]) continue;
        room.players[s].score -= 1;
        room.players[s].roundScore -= 1;
      }
      room.players[seat].score += 3;
      room.players[seat].roundScore += 3;
      g.gangLogs.push({ seat, tile, type: 'bugang', perSeat: 1, points: 3, kou: 1 });
      this._log(room, `${this._pName(room, seat)} 补杠了 ${rules.tileName(tile)}（每家付 1 分）`);
      this._logGame(room, 'action', { action: 'gang', gangType: 'bugang', seat, tile, perSeat: 1 });
      this._drawCard(room, seat, true);
      return;
    }
    // 普通玩法：杠分统一延迟结算
    this._log(room, `${this._pName(room, seat)} 补杠了 ${rules.tileName(tile)}`);
    this._logGame(room, 'action', { action: 'gang', gangType: 'bugang', seat, tile });
    this._settleGangScore(room, seat, tile, 'bugang');
    this._drawCard(room, seat, true);
  }


  _settleHu(room, winnerSeat, info) {
    const g = room.game;
    // 游戏日志：胡牌动作（自摸/点炮/抢杠），每个赢家恰好记录一次（红中一炮多响循环内亦逐家记录）
    this._logGame(room, 'action', {
      action: 'hu',
      seat: winnerSeat,
      winType: info.winType,
      tile: info.tile,
      discarder: info.discarder,
    });
    // 三玩法结算互斥：按玩法分派到各自独立的结算方法（贴金/红中/扣点点）
    if (this._isTieJin(room)) return this._settleHuTieJin(room, winnerSeat, info);
    if (this._isHongZhong(room)) return this._settleHuHongZhong(room, winnerSeat, info);
    return this._settleHuKoudian(room, winnerSeat, info);
  }

  // ===== 贴金玩法结算：金分体系（A/B 计分，三金封顶）；杠分已当场结清仅随结算展示 =====
  _settleHuTieJin(room, winnerSeat, info) {
    const g = room.game;
    const goldCount = Math.min(g.shangjinCount[winnerSeat] || 0, 3); // 三金封顶
    const winnerDealer = winnerSeat === g.dealer;
    const mode = room.settings && room.settings.scoreMode === 'B' ? 'B' : 'A';
    // 牌型加番（只放胡牌分/基础份，金分不变）：七小对 ×2、豪华七小对 ×4
    const winHand = info.winType === 'zimo' ? g.hands[winnerSeat].slice() : [...g.hands[winnerSeat], info.tile];
    const shape = rules.tiejinShapeMult(winHand, g.melds[winnerSeat], g.goldTile);
    // 包胡：牌墙剩最后 4 张时点炮/抢杠 → 放炮者（被抢杠者）独赔三家（仅自摸不触发）
    const baoHu = this._tieJinIsBaoHu(room, info);
    const res =
      mode === 'B'
        ? rules.calcTieJinScoreB({ winType: info.winType, winnerDealer, goldCount, fanMult: shape.mult })
        : rules.calcTieJinScoreA({ winType: info.winType, winnerDealer, goldCount, fanMult: shape.mult });
    const isZimo = info.winType === 'zimo';
    const payerSeats = [];
    if (isZimo) {
      // N1 修复：B 模式偏家自摸时 res.payers[0] 为庄家份（dealerShare），
      // 必须落到实际庄家座位，另两份 base 归两个偏家；不能按座次顺排。
      if (mode === 'B' && !winnerDealer) {
        payerSeats.push(g.dealer);
        for (let i = 1; i <= 3; i++) {
          const s = (winnerSeat + i) % 4;
          if (s !== winnerSeat && s !== g.dealer) payerSeats.push(s);
        }
      } else {
        for (let i = 1; i <= 3; i++) payerSeats.push((winnerSeat + i) % 4);
      }
    } else {
      payerSeats.push(info.discarder);
      for (let i = 1; i <= 3; i++) {
        const s = (info.discarder + i) % 4;
        if (s !== winnerSeat) payerSeats.push(s);
      }
    }
    let payments;
    let winnerGainTotal;
    if (baoHu) {
      // 包胡：放炮者一人承担三家应付总额（其余两家不出分）
      winnerGainTotal = res.winnerGain;
      const loser = room.players[info.discarder];
      if (loser) {
        loser.score -= winnerGainTotal;
        loser.roundScore -= winnerGainTotal;
      }
      room.players[winnerSeat].score += winnerGainTotal;
      room.players[winnerSeat].roundScore += winnerGainTotal;
      payments = [{
        from: info.discarder,
        to: winnerSeat,
        amount: winnerGainTotal,
        formula: res.payers.map((p) => p.formula).join(' + ') + ` = ${winnerGainTotal}（包三家）`,
        role: info.winType === 'qianggang' ? '被抢杠者（包三家）' : '放炮者（包三家）',
      }];
    } else {
      winnerGainTotal = res.winnerGain;
      for (let i = 0; i < payerSeats.length; i++) {
        const ps = payerSeats[i];
        const amt = res.payers[i].amount;
        if (room.players[ps]) {
          room.players[ps].score -= amt;
          room.players[ps].roundScore -= amt;
        }
      }
      room.players[winnerSeat].score += res.winnerGain;
      room.players[winnerSeat].roundScore += res.winnerGain;
      payments = payerSeats.map((ps, i) => ({
        from: ps,
        to: winnerSeat,
        amount: res.payers[i].amount,
        formula: res.payers[i].formula,
        role: res.payers[i].role,
      }));
    }
    const winLabel = isZimo ? '自摸' : info.winType === 'qianggang' ? '抢杠胡' : '点炮胡';
    const shapeLabel = shape.names.length ? `，${shape.names.join('、')}×${shape.mult}` : '';
    const baoLabel = baoHu ? '，包胡（牌墙剩最后4张放炮者包三家）' : '';
    this._log(
      room,
      `${this._pName(room, winnerSeat)} ${winLabel} ${rules.tileName(info.tile)}（${mode === 'B' ? '125' : '边趣'}计分，亮金 ${goldCount} 张，金分 ${res.G}${shapeLabel}${baoLabel}）→ +${winnerGainTotal} 分`
    );
    g.winners = {
      type: 'hu',
      variant: 'tiejin',
      mode136: true,
      winType: info.winType,
      winner: winnerSeat,
      tile: info.tile,
      discarder: isZimo ? -1 : info.discarder,
      goldMother: g.goldMother,
      goldTile: g.goldTile,
      goldCount,
      goldScore: res.G,
      huGain: res.huGain || 0,
      winnerGain: winnerGainTotal,
      scoreMode: mode,
      shapeMult: shape.mult,
      shapeNames: shape.names,
      baoHu,
      payments,
      shangjinCount: g.shangjinCount.slice(),
      locked: g.locked.slice(),
      lockSeat: g.lockSeat,
      gangLogs: g.gangLogs.slice(),
      hands: this._revealHandsWithWinTile(room, winnerSeat, info),
    };
  }

  // ===== 红中玩法结算：扎码无番制（中码倍数=2^中码张数；杠分已当场结清仅随结算展示）=====
  _settleHuHongZhong(room, winnerSeat, info) {
    const g = room.game;
    const hand = g.hands[winnerSeat].slice();
    if (info.winType !== 'zimo') hand.push(info.tile);
    const winLabel =
    info.winType === 'zimo' ? '自摸' : info.winType === 'qianggang' ? '抢杠胡' : '点炮胡';
    // 扎码：从牌墙补抓，1/5/9 万筒条 + 红中中码，每张使中码倍数翻一倍
    let zhaMaCount = 0;
    const zhaMaTiles = [];
    if (room.settings.zhaMa > 0 && g.wall.length - g.wallPos > 0) {
      const n = Math.min(room.settings.zhaMa, g.wall.length - g.wallPos);
      for (let i = 0; i < n; i++) {
        const t = g.wall[g.wallPos++];
        zhaMaTiles.push(t);
        if (rules.isZhongMa(t)) zhaMaCount++;
      }
    }
    g.zhaMaTiles = zhaMaTiles;
    const zmaMult = Math.pow(2, zhaMaCount); // 中码倍数：中0码=1倍，每中一张翻一倍
    const base = 1; // 红中底注恒为 1 分

    const zimoPay = () => (2 + zmaMult) * base;
    const baoShare = (1 + zmaMult) * base;
    const baoTotal = baoShare * 3;

    let winnerGain = 0;
    const payments = [];
    if (info.winType === 'zimo') {
      // 自摸：三家各付
      let total = 0;
      const rows = [];
      for (let s = 0; s < 4; s++) {
        if (s === winnerSeat || !room.players[s]) continue;
        const pay = zimoPay();
        room.players[s].score -= pay;
        room.players[s].roundScore -= pay;
        total += pay;
        rows.push({
          seat: s,
          amount: -pay,
          role: '自摸',
          formula: `1底注×(2+${zmaMult}中码倍数)=${pay}`,
        });
      }
      room.players[winnerSeat].score += total;
      room.players[winnerSeat].roundScore += total;
      winnerGain = total;
      payments.push({
        kind: 'hu',
        title: `自摸${zhaMaCount ? `，中码 ${zhaMaCount} 张 ×${zmaMult}` : ''} · 三家各付`,
        toSeat: winnerSeat,
        toAmount: total,
        rows,
      });
    } else {
      // 点炮 / 抢杠：放炮者（被抢杠者）包赔三家
      const loser = room.players[info.discarder];
      if (loser) {
        loser.score -= baoTotal;
        loser.roundScore -= baoTotal;
      }
      room.players[winnerSeat].score += baoTotal;
      room.players[winnerSeat].roundScore += baoTotal;
      winnerGain = baoTotal;
      const role = info.winType === 'qianggang' ? '被抢杠者（包三家）' : '放炮者（包三家）';
      payments.push({
        kind: 'hu',
        title: `${winLabel}${zhaMaCount ? `，中码 ${zhaMaCount} 张 ×${zmaMult}` : ''} · ${role}独赔 ${baoTotal} 分`,
        toSeat: winnerSeat,
        toAmount: baoTotal,
        rows: [{
          seat: info.discarder,
          amount: -baoTotal,
          role,
          formula: `1底注×(1+${zmaMult}中码倍数)×3家=${baoTotal}`,
        }],
      });
    }

    g.hzWinners = g.hzWinners || [];
    const isMulti = g.hzWinners.length > 0; // 一炮多响：已有赢家记录
    g.hzWinners.push({
      winnerSeat,
      winType: info.winType,
      tile: info.tile,
      discarder: info.winType === 'zimo' ? null : info.discarder,
      fan: 0,
      mult: zmaMult,
      zmaMult,
      noFan: true,
      names: ['无番'],
      scorePer: winnerGain / 3,
      paoGain: 0,
      zhaMaCount,
      zhaMaTiles: zhaMaTiles.slice(),
    });
    // 多响时累计各家支付记录（杠支付只在最后一次补上，避免重复）
    g._accPayments = g._accPayments || [];
    if (!isMulti) g._accPayments = [];
    g._accPayments = g._accPayments.concat(payments);
    const gangPay = this._buildGangPayments(room);
    const allPayments = g._accPayments.concat(gangPay);
    // 兼容结算视图（一炮多响时保留最后一家主信息 + winners 明细列表）
    g.winners = {
      type: 'hu',
      variant: 'hongzhong',
      winnerSeat,
      winType: info.winType,
      winners: g.hzWinners.slice(),
      totalFan: 0,
      mult: zmaMult,
      zmaMult,
      noFan: true,
      fanNames: ['无番'],
      zhaMaCount,
      zhaMaTiles: zhaMaTiles.slice(),
      gangLogs: g.gangLogs.slice(),
      score: winnerGain,
      tile: info.tile,
      discarder: info.winType === 'zimo' ? null : info.discarder,
      payments: allPayments,
      hands: this._revealHandsWithWinTile(room, winnerSeat, info),
    };
    room.lastWinner = winnerSeat;
    this._log(
      room,
      `${this._pName(room, winnerSeat)} ${winLabel} ${rules.tileName(info.tile)}${zhaMaCount ? `（中码 ${zhaMaCount} 张 ×${zmaMult}）` : ''} → +${winnerGain} 分`
    );
    return;
  }

  // ===== 扣点点玩法结算：乘算（点数 × 牌型倍数）或 加算（底分 + 固定加番）；庄底独立开关 =====
  _settleHuKoudian(room, winnerSeat, info) {
    const g = room.game;
    // 算番型时必须使用完整手牌：自摸时胡牌已在手牌；点炮/抢杠时 info.tile 是打出的胡牌，需并入
    const hand = g.hands[winnerSeat].slice();
    if (info.winType !== 'zimo') hand.push(info.tile);
    const gangShang = info.winType === 'zimo' && !!(g.lastAction && g.lastAction.type === 'gang');
    const winLabel =
      info.winType === 'zimo' ? '自摸' : info.winType === 'qianggang' ? '抢杠胡' : '点炮胡';

    // ===== 计分模型：乘算（点数 × 牌型倍数）或 加算（底分 + 固定加番）；庄底独立开关 =====
    const tilePoints = rules.tilePoints(info.tile);
    const multOpts = {
      qingyise: { enabled: room.settings.enableQingYiSe, mult: room.settings.qingYiSeMult },
      yitiaolong: { enabled: room.settings.enableYiTiaoLong, mult: room.settings.yiTiaoLongMult },
      shisanyao: { enabled: room.settings.enableShiSanYao, mult: room.settings.shiSanYaoMult },
    };
    const scoreModel = room.settings.scoreModel === 'add' ? 'add' : 'multiply';
    const zhuangDiOn = room.settings.zhuangDi === true;
    const zhuangSeat = g.dealer;
    const isZhuang = winnerSeat === zhuangSeat;
    // 庄底（默认关闭）：开启时仅庄家胡牌单边加分（非自摸+5 / 自摸+10），输家不扣分；闲家胡无庄底
    const zhuangBonus = !zhuangDiOn || !isZhuang ? 0 : info.winType === 'zimo' ? 10 : 5;

    let mult = 1;
    let multNames = [];
    let addPoints = 0;
    let addNames = [];
    let baseScore; // 每份基础分（不含庄底）
    if (scoreModel === 'add') {
      // 加算（洪洞固定加分）：底分=胡牌点数（自摸翻倍）+ 清一色/一条龙/七小对+20、豪七额外+40（叠加不翻倍）
      const addCalc = rules.calcAddPoints136(
        hand,
        { winType: info.winType, gangShang, qiangGang: !!info.qiangGang, melds: g.melds[winnerSeat] },
        { qingyise: multOpts.qingyise, yitiaolong: multOpts.yitiaolong }
      );
      addPoints = addCalc.add;
      addNames = addCalc.names;
      baseScore = tilePoints * (info.winType === 'zimo' ? 2 : 1) + addPoints;
    } else {
      // 乘算：点数 × 牌型倍数
      const multCalc = rules.calcMultiplier136(
        hand,
        { winType: info.winType, gangShang, qiangGang: !!info.qiangGang, melds: g.melds[winnerSeat] },
        multOpts,
        true
      );
      mult = multCalc.mult;
      multNames = multCalc.names;
      baseScore = tilePoints * (info.winType === 'zimo' ? 2 : 1) * mult;
    }
    const discarderTing = info.winType !== 'zimo' && g.tingSeats.includes(info.discarder);

    let score;
    const huPayments = [];
    const zhuangNote = zhuangBonus ? `（庄底+${zhuangBonus}，庄家单边加分）` : '';
    if (info.winType === 'zimo') {
      // 自摸：三家各付 基础分；庄家胡且庄底开启时，胡牌者单边另得庄底分（输家不扣）
      score = baseScore;
      const perDesc = zhuangBonus
        ? `三家各付 ${baseScore} 分，庄家另得庄底+${zhuangBonus}`
        : `三家各付 ${baseScore} 分`;
      for (let s = 0; s < 4; s++) {
        if (s === winnerSeat || !room.players[s]) continue;
        const pay = baseScore;
        room.players[s].score -= pay;
        room.players[s].roundScore -= pay;
        room.players[winnerSeat].score += pay;
        room.players[winnerSeat].roundScore += pay;
      }
      if (zhuangBonus) {
        room.players[winnerSeat].score += zhuangBonus;
        room.players[winnerSeat].roundScore += zhuangBonus;
      }
      huPayments.push({
        kind: 'hu',
        title: `自摸 · ${perDesc}${zhuangNote}`,
        toSeat: winnerSeat,
        toAmount: baseScore * 3 + zhuangBonus,
        rows: [0, 1, 2, 3]
          .filter((s) => s !== winnerSeat)
          .map((s) => ({ seat: s, amount: -baseScore, role: s === zhuangSeat ? '庄家' : '闲家' })),
      });
    } else if (discarderTing) {
      // 点炮且放炮者已报听：三家各出 1 份，胡牌者共收 3 份；庄家胡且庄底开启时，胡牌者单边另得庄底分（输家不扣）
      score = baseScore;
      const perDesc = zhuangBonus
        ? `三家各付 ${baseScore} 分，庄家另得庄底+${zhuangBonus}`
        : `三家各付 ${baseScore} 分`;
      for (let s = 0; s < 4; s++) {
        if (s === winnerSeat || !room.players[s]) continue;
        const pay = baseScore;
        room.players[s].score -= pay;
        room.players[s].roundScore -= pay;
        room.players[winnerSeat].score += pay;
        room.players[winnerSeat].roundScore += pay;
      }
      if (zhuangBonus) {
        room.players[winnerSeat].score += zhuangBonus;
        room.players[winnerSeat].roundScore += zhuangBonus;
      }
      huPayments.push({
        kind: 'hu',
        title: `${winLabel}（放炮者已报听）· ${perDesc}${zhuangNote}`,
        toSeat: winnerSeat,
        toAmount: baseScore * 3 + zhuangBonus,
        rows: [0, 1, 2, 3]
          .filter((s) => s !== winnerSeat)
          .map((s) => ({
            seat: s,
            amount: -baseScore,
            role: s === info.discarder ? '放炮者（已报听）' : s === zhuangSeat ? '庄家' : '闲家',
          })),
      });
    } else {
      // 点炮且放炮者未报听：放炮者独赔 3 份基础分（含原包胡情形）；庄家胡且庄底开启时，胡牌者单边另得庄底分（输家不扣）
      const basePay = baseScore * 3;
      score = basePay;
      const loser = room.players[info.discarder];
      if (loser) {
        loser.score -= basePay;
        loser.roundScore -= basePay;
        room.players[winnerSeat].score += basePay;
        room.players[winnerSeat].roundScore += basePay;
      }
      if (zhuangBonus) {
        room.players[winnerSeat].score += zhuangBonus;
        room.players[winnerSeat].roundScore += zhuangBonus;
      }
      huPayments.push({
        kind: 'hu',
        title: `${winLabel}（放炮者未报听）· 放炮者独赔 ${basePay} 分${zhuangNote}`,
        toSeat: winnerSeat,
        toAmount: basePay + zhuangBonus,
        rows: [{ seat: info.discarder, amount: -basePay, role: '放炮者（未报听，独赔3份）' }],
      });
    }

    // 杠分整局结束统一结算：杠时仅记录 gangLogs，胡牌时一并入账（流局黄庄不计杠分，见 _settleDraw）
    this._applyGangScores(room);

    g.winners = {
      type: 'hu',
      winnerSeat,
      winType: info.winType,
      mode136: true,
      scoreModel,
      tilePoints,
      mult,
      multNames,
      addPoints,
      addNames,
      zhuangBonus,
      discarderTing,
      score,
      tile: info.tile,
      discarder: info.winType === 'zimo' ? null : info.discarder,
      gangLogs: g.gangLogs.slice(),
      payments: [...huPayments, ...this._buildGangPayments(room)],
      hands: this._revealHandsWithWinTile(room, winnerSeat, info),
    };
    room.lastWinner = winnerSeat;
    const payLabel =
      info.winType === 'zimo'
        ? ''
        : discarderTing
          ? '（放炮者已报听，三家各出1份）'
          : '（放炮者未报听，独赔3份）';
    const calcLog = scoreModel === 'add'
      ? `${tilePoints}点${info.winType === 'zimo' ? '×2' : ''}${addPoints ? `+${addPoints}（${addNames.join('、')}）` : ''}${zhuangBonus ? `+庄底${zhuangBonus}` : ''}`
      : `${tilePoints}点 × ${mult}倍`;
    this._log(
      room,
      `${this._pName(room, winnerSeat)} ${winLabel} ${rules.tileName(info.tile)}（${calcLog}${payLabel} → ${score}分）`
    );
  }

  /** 流局结算（三玩法统一）：普通黄庄杠分不计（杠分改为整局结束统一结算、流局不入账）；红中无胡支付庄家连庄；贴金杠分回滚、有杠下家坐庄 */
  _settleDraw(room) {
    const g = room.game;
    const isHz = this._isHongZhong(room);
    const isTj = this._isTieJin(room);
    if (isTj) {
      // 贴金流局杠分不计：回滚本局当场结算的杠分
      for (const lg of g.gangLogs) {
        if (room.players[lg.seat]) {
          room.players[lg.seat].score -= lg.points;
          room.players[lg.seat].roundScore -= lg.points;
        }
        for (let s = 0; s < 4; s++) {
          if (s === lg.seat || !room.players[s]) continue;
          room.players[s].score += lg.perSeat;
          room.players[s].roundScore += lg.perSeat;
        }
      }
    }
    g.stage = 'over';
    // 普通：听牌检测；红中/贴金无听牌概念
    const tingSeats = [];
    const notTing = [];
    if (!isHz && !isTj) {
      for (let s = 0; s < 4; s++) {
        if (room.players[s] && rules.isTing(g.hands[s], g.melds[s]).length > 0) tingSeats.push(s);
      }
      for (let s = 0; s < 4; s++) {
        if (room.players[s] && !tingSeats.includes(s)) notTing.push(s);
      }
    }
    const winners = {
      type: 'draw',
      mode136: true,
      gangLogs: g.gangLogs.slice(), // 杠分明细（仅记录展示；黄庄杠分不计，不入账）
      payments: [], // 流局无胡牌支付，且黄庄杠分不计 → 无任何支付明细
      hands: this._revealHands(room),
    };
    if (isHz) winners.variant = 'hongzhong';
    else if (isTj) {
      winners.variant = 'tiejin';
      winners.goldMother = g.goldMother;
      winners.goldTile = g.goldTile;
      winners.shangjinCount = g.shangjinCount.slice();
      winners.locked = g.locked.slice();
      winners.lockSeat = g.lockSeat;
    } else {
      winners.tingSeats = tingSeats;
      winners.notTing = notTing;
    }
    g.winners = winners;
    room.lastWinner = null; // 流局：庄家流转由 _dealRound 按玩法处理（普通 dealerFlow / 红中连庄 / 贴金有杠下家）
    if (isTj) {
      room.lastFlowHadGang = g.gangLogs.length > 0; // 贴金流局有杠：下家坐庄
      this._log(room, '流局（运城贴金麻将）' + (g.gangLogs.length > 0 ? '，有杠下家坐庄' : '，无杠庄家连庄'));
    } else if (isHz) {
      this._log(room, '牌墙摸完，流局（红中麻将）');
    } else {
      this._log(room, '牌墙剩 6 墩，流局' + (tingSeats.length ? `，听牌者：${tingSeats.map((s) => this._pName(room, s)).join('、')}` : ''));
    }
    this._logGame(room, 'action', { action: 'draw_round', reason: isTj ? (g.gangLogs.length ? 'wall_end_with_gang' : 'wall_end') : isHz ? 'wall_end' : 'wall_6_dui', tingSeats });
    this._broadcastGameState(room);
    this._sendSettlement(room);
    this._broadcastRoomState(room);
    this._endRound(room);
  }

  _endRound(room) {
    const g = room.game;
    if (g) g.stage = 'over';
    this._recordRoundHistory(room); // 本局结算收口处落盘历史（胡/流局统一入口）
    // 游戏日志：本局结束（完整结算：winners 含支付明细/杠分/金分/庄底/各家手牌，players 含各家最终得分）
    this._logGame(room, 'round_end', {
      result: g && g.winners ? g.winners.type : 'aborted',
      winners: g && g.winners ? g.winners : null,
      players: this._logPlayers(room),
      gangLogs: g && g.gangLogs ? g.gangLogs.slice() : [],
      settings: room.settings,
      dealer: g ? g.dealer : null,
      variant: room.settings ? room.settings.variant : null,
    });
    // AI 复盘：按 AI 座位汇总本局结果（胜/放铳/净得分），并驱动困难档胜率自动校准
    try {
      aiJournal.finishRound(room);
    } catch (e) {
      console.error('[ai-journal] finishRound failed:', e && e.message);
    }
    // 保留房主离线超时定时器：本局结束时不能误清，否则房主超时后本局结束自动解散将失效
    const ownerOfflineTimer = room.timers.get('owner:offline');
    for (const [k, t] of room.timers) {
      if (k === 'owner:offline') continue;
      clearTimeout(t);
      this._timers.delete(t);
    }
    room.timers.clear();
    // 清理 AI 代打：本局结束所有挂起的自动代打定时器已清除，令牌作废防泄漏
    for (const pl of room.players) {
      if (pl) {
        pl._autoGen = pl._autoToken; // 作废所有未触发令牌
        pl._autoActing = false;
        pl._autoRetry = 0;
      }
    }
    if (ownerOfflineTimer) room.timers.set('owner:offline', ownerOfflineTimer);
    // 房主离线超时：本局结算已广播，直接解散房间，通知所有玩家回大厅
    if (room.pendingDisband) {
      this._log(room, '房主离线超时，本局结束，房间解散');
      this._broadcast(room, { type: 'room_notice', text: '房主离线超时，本局结束，房间已解散' });
      this._destroyRoom(room);
      return;
    }
    const total = room.settings.totalRounds;
    if (total > 0 && room.roundNo >= total) {
      room.state = 'settled';
      room.settleConfirms = null;
      this._log(room, `已打完 ${total} 局，房间进入结算（房主可「再来一轮」或解散）`);
      this._broadcastRoomState(room);
      this._broadcastLobby();
      return;
    }
    // 非最后一局：进入结算确认阶段，全员确认后才自动开始下一局
    room.settleConfirms = [false, false, false, false];
    for (let s = 0; s < 4; s++) {
      if (!room.players[s]) {
        // 空座位：无人确认，直接视为已确认，避免结算确认阶段卡死
        room.settleConfirms[s] = true;
      } else if (this._shouldAutoAct(room, s)) {
        // AI / 托管 / 断线玩家自动确认；在线真人等待手动点击「确定」
        room.settleConfirms[s] = true;
      } else {
        // 在线真人：启动 60 秒确认超时定时器，超时未点「确定」则自动确认
        this._setTimer(room, 'settle:' + s, SETTLE_TIMEOUT_MS, () => this._handleSettleTimeout(room, s));
      }
    }
    this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
    this._broadcastRoomState(room);
    this._log(room, '本局结束，等待所有玩家确认「确定」后开始下一局');
    this._tryStartNextRound(room);
  }

  // ============ 结算确认 ============

  /** 在线真人 60 秒未点「确定」：自动确认本局结算 */
  _handleSettleTimeout(room, seat) {
    this._clearTimer(room, 'settle:' + seat); // 回调已触发，清理防重入
    if (!room.settleConfirms) return; // 已开局 / 终局 / 房间销毁
    if (room.settleConfirms[seat]) return; // 已确认（掉线自动确认等）幂等忽略
    const p = room.players[seat];
    if (!p) return;
    room.settleConfirms[seat] = true;
    this._log(room, `${p.name} 60 秒未确认，系统自动确认本局结算`);
    this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
    this._tryStartNextRound(room);
  }

  _settleConfirm(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (!room.settleConfirms) return this._err(p, '当前没有需要确认的结算');
    if (room.players[p.seat] !== p) return this._err(p, '您不在本局座位中');
    if (room.settleConfirms[p.seat]) return; // 幂等：已确认直接忽略
    room.settleConfirms[p.seat] = true;
    this._clearTimer(room, 'settle:' + p.seat); // 手动确认后取消本人超时定时器
    this._log(room, `${p.name} 已确认本局结算`);
    this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
    this._tryStartNextRound(room);
  }

  _tryStartNextRound(room) {
    if (!room.settleConfirms) return;
    if (!room.settleConfirms.every(Boolean)) return;
    room.settleConfirms = null;
    // 全员确认：清理所有结算确认超时定时器
    for (let s = 0; s < 4; s++) this._clearTimer(room, 'settle:' + s);
    this._log(room, '所有玩家已确认，开始下一局');
    this._dealRound(room);
  }

  // ============ 玩家操作（全部服务端校验） ============

  _playTile(p, msg) {
    if (p._autoActing) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.tingSeats.includes(p.seat)) return this._err(p, '听口状态由系统自动摸打，不能出牌');
    if (g.stage !== 'draw') return this._err(p, '当前不能出牌');
    if (g.turn !== p.seat) return this._err(p, '不是您的回合');
    const tile = String((msg && msg.tile) || '');
    if (!this._hzTileTypes(room).includes(tile)) return this._err(p, '非法的牌');
    const hand = g.hands[p.seat];
    const idx = hand.indexOf(tile);
    if (idx < 0) return this._err(p, '手牌中没有这张牌');
    // 贴金：首金未亮且亮金可行 → 亮金是唯一合法操作，任何牌都不能出（必须先亮出首金）
    if (this._isTieJin(room) && this._tieJinMustLiangjin(room, p.seat)) {
      return this._err(p, '首金必须亮出：请先执行「亮金」，亮金前不能出牌/碰/杠/胡');
    }
    // 贴金：金牌不能作为普通出牌打出，只能通过「亮金」独立操作处理（或保留在手中）
    if (this._isTieJin(room) && tile === g.goldTile) {
      // P2 修复：当手牌除金牌外已无其他可打牌时，放行金牌作为强制出牌（与红中"只剩红中则打出"行为对齐），
      // 避免 AI/真人全金牌手牌且亮金走不通（牌墙已尽等）时整局永久卡死
      const hasOther = hand.some((t) => t !== g.goldTile);
      if (hasOther) {
        return this._err(p, '金牌不能作为普通出牌打出，请通过亮金操作处理');
      }
    }

    hand.splice(idx, 1);
    g.discards[p.seat].push(tile);
    g.lastDiscard = { tile, seat: p.seat };
    g.drawnTile = null;
    g.newTiles[p.seat] = null; // 新牌已打出，标志清除
    this._clearTimer(room, 'draw:' + p.seat);
    this._log(room, `${this._pName(room, p.seat)} 打出 ${rules.tileName(tile)}`);
    this._logGame(room, 'action', { action: 'discard', seat: p.seat, tile, auto: false });
    this._afterDiscard(room, p.seat);
  }

  /** 报听（听口）：摸牌后（或碰后立即听牌）存在可打的听牌牌型时，打出指定牌并锁定手牌 */
  _ting(p, msg) {
    if (p._autoActing) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (this._isHongZhong(room) || this._isTieJin(room)) return this._err(p, '该玩法不支持报听玩法');
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.stage !== 'draw') return this._err(p, '当前不能报听');
    if (g.turn !== p.seat) return this._err(p, '不是您的回合');
    // 碰后（未摸牌）也可报听：碰完即听立即识别，不待下一轮摸牌
    const justPeng = !!(g.lastAction && g.lastAction.type === 'peng');
    if (g.drawnTile === null && !justPeng) return this._err(p, '未摸牌不能报听');
    if (!room.settings.allowTing) return this._err(p, '房间未开启听口玩法');
    if (g.tingSeats.includes(p.seat)) return this._err(p, '您已经报听');
    const tile = String((msg && msg.tile) || '');
    if (!rules.getTileTypes().includes(tile)) return this._err(p, '非法的牌');
    const hand = g.hands[p.seat];
    const idx = hand.indexOf(tile);
    if (idx < 0) return this._err(p, '手牌中没有这张牌');
    const rest = hand.slice();
    rest.splice(idx, 1);
    // 碰/杠刻子（明牌区）作为已成型面子参与听口计算
    const tingList = rules.isTing(rest, g.melds[p.seat]);
    if (tingList.length === 0) return this._err(p, '当前手牌不能报听');

    // 报听硬性条件：听牌中至少含一张 6 点及以上牌
    if (!tingList.some((x) => rules.tilePoints(x) >= 6)) {
      return this._err(p, '听牌中须至少含一张 6 点及以上牌（6/7/8/9/字牌）才能报听');
    }
    hand.splice(idx, 1);
    g.tingSeats.push(p.seat);
    g.kouTiles[p.seat] = tile; // 记录扣牌（报听状态标识，不再单独上架公示）
    g.discards[p.seat].push('back'); // 暗扣进废牌堆：渲染为牌背，不参与任何响应判定
    g.drawnTile = null;
    g.lastAction = null;
    g.lastDiscard = null; // 扣牌不进入响应判定，他人不能碰/胡
    g.newTiles[p.seat] = null; // 报听后手牌锁定，新牌标志清除
    this._clearTimer(room, 'draw:' + p.seat);
    this._log(room, `${this._pName(room, p.seat)} 报听，扣牌暗扣进废牌堆`);
    this._logGame(room, 'action', { action: 'ting', seat: p.seat, tile, tingList: tingList.slice() });
    this._broadcastGameState(room);
    this._nextTurn(room, p.seat);
  }

  _peng(p) {
    if (p._autoActing) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.stage !== 'response' || !g.pending) return this._err(p, '当前没有可响应的操作');
    const r = g.pending.responders.find((x) => x.seat === p.seat);
    if (!r) return this._err(p, '您没有可响应的操作');
    if (r.choice !== null) return this._err(p, '您已响应过');
    if (!r.canPeng) return this._err(p, '不能碰');
    r.choice = 'peng';
    this._clearTimer(room, 'resp:' + p.seat);
    this._log(room, `${p.name} 选择碰`);
    this._tryResolvePending(room, g, g.pending);
  }

  /** 报听玩家摸牌后可杠选项（补杠/暗杠），且杠牌不在当前听口中（杠不破坏听口）。仅扣点点玩法（红中/贴金无报听）。 */
  _tingGangOptions(room, seat) {
    const g = room.game;
    if (!g || this._isHongZhong(room) || this._isTieJin(room)) return [];
    if (!g.tingSeats.includes(seat) || g.drawnTile === null) return [];
    const hand = g.hands[seat];
    // 报听状态手牌 = 当前 14 张去掉刚摸的那张（听口在报听那一刻已固定）
    const base = hand.slice();
    const di = base.lastIndexOf(g.drawnTile);
    if (di >= 0) base.splice(di, 1);
    const ting = rules.isTing(base, g.melds[seat]);
    const cnt = rules.countTiles(hand);
    const opts = [];
    // 暗杠：手牌某牌满 4 张，且该牌不是听张
    for (const [t, c] of cnt) {
      if (c === 4 && !ting.includes(t)) opts.push({ gangType: 'angang', tile: t });
    }
    // 补杠：手牌有 1 张该牌 + 明牌区有对应碰，且该牌不是听张；抢杠防守（D2，与 _tingGangTile 一致）
    for (const m of g.melds[seat]) {
      if (m.type === 'peng' && cnt.get(m.tile) >= 1 && !ting.includes(m.tile)) {
        const robbed = (g.tingSeats || []).some(
          (s) =>
            s !== seat &&
            rules.canHuWith(g.hands[s], m.tile, g.melds[s]) &&
            rules.canHuByPoints(rules.tilePoints(m.tile), 'qianggang')
        );
        if (robbed) continue;
        opts.push({ gangType: 'bugang', tile: m.tile });
      }
    }
    return opts;
  }

  _gang(p, msg) {
    if (p._autoActing) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    // 报听玩家允许杠（杠后补牌手牌继续锁死）

    // 响应阶段：明杠（别人打出的牌）
    if (g.stage === 'response' && g.pending) {
      const r = g.pending.responders.find((x) => x.seat === p.seat);
      if (!r) return this._err(p, '您没有可响应的操作');
      if (r.choice !== null) return this._err(p, '您已响应过');
      if (!r.canGang) return this._err(p, '不能杠');
      // 双保险：报听玩家明杠听张（响应判定已过滤，此处防绕过）；红中无报听
      if (!this._isHongZhong(room) && g.tingSeats.includes(p.seat) && rules.isTing(g.hands[p.seat], g.melds[p.seat]).includes(g.pending.tile)) {
        return this._err(p, '报听后不能杠听张，会破坏听口');
      }
      r.choice = 'gang';
      this._clearTimer(room, 'resp:' + p.seat);
      this._log(room, `${p.name} 选择杠`);
      this._tryResolvePending(room, g, g.pending);
      return;
    }

    // 行动阶段：暗杠 / 补杠（自己回合）
    if (g.stage === 'draw' && g.turn === p.seat) {
      if (g.drawnTile === null) return this._err(p, '当前不能杠');
      const tile = String((msg && msg.tile) || '');
      if (!this._hzTileTypes(room).includes(tile)) return this._err(p, '非法的牌');
      // 报听后杠不能破坏听张：去掉刚摸的牌后，杠牌若仍在听口中则拒绝；红中无报听
      if (!this._isHongZhong(room) && g.tingSeats.includes(p.seat)) {
        const base = g.hands[p.seat].slice();
        const di = base.lastIndexOf(g.drawnTile);
        if (di >= 0) base.splice(di, 1);
        if (rules.isTing(base, g.melds[p.seat]).includes(tile)) {
          return this._err(p, '报听后不能杠听张，会破坏听口');
        }
      }
      const gangType = msg && msg.gangType === 'bugang' ? 'bugang' : 'angang';
      // 运城贴金麻将：杠不即时结算杠分，走贴金杠流程（暗杠不可抢、补杠触发抢杠）
      if (this._isTieJin(room)) {
        // 首金未亮且亮金可行：亮金是唯一操作，不能杠（牌墙已尽时放行）
        if (this._tieJinMustLiangjin(room, p.seat)) {
          return this._err(p, '首金必须亮出：请先执行「亮金」，亮金前不能杠');
        }
        if (gangType === 'angang') {
          if (!rules.canAnGangTieJin(g.hands[p.seat], tile, g.goldTile)) return this._err(p, '不能暗杠');
          this._doAnGang(room, p.seat, tile);
        } else {
          if (!rules.canBuGangTieJin(g.hands[p.seat], g.melds[p.seat], tile, g.goldTile)) return this._err(p, '不能补杠');
          this._doBuGang(room, p.seat, tile);
        }
        return;
      }
      // 红中麻将：杠不即时结算杠分，走红中杠流程（暗杠不可抢、补杠触发抢杠）
      if (this._isHongZhong(room)) {
        if (gangType === 'angang') {
          if (!rules.canAnGangHongZhong(g.hands[p.seat], tile)) return this._err(p, '不能暗杠');
          this._doAnGang(room, p.seat, tile);
        } else {
          if (!rules.canBuGang(g.hands[p.seat], g.melds[p.seat], tile)) return this._err(p, '不能补杠');
          this._doBuGang(room, p.seat, tile);
        }
        return;
      }
      if (gangType === 'angang') {
        if (!rules.canAnGang(g.hands[p.seat], tile)) return this._err(p, '不能暗杠');
        this._doAnGang(room, p.seat, tile);
      } else {
        if (!rules.canBuGang(g.hands[p.seat], g.melds[p.seat], tile)) return this._err(p, '不能补杠');
        this._doBuGang(room, p.seat, tile);
      }
      return;
    }
    return this._err(p, '当前不能杠');
  }

  _hu(p) {
    if (p._autoActing) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');

    // 响应阶段：点炮 / 抢杠胡
    if (g.stage === 'response' && g.pending) {
      // 报听玩家可点炮/抢杠（胡牌点数限制已在响应判定中处理）
      const r = g.pending.responders.find((x) => x.seat === p.seat);
      if (!r) return this._err(p, '您没有可响应的操作');
      if (r.choice !== null) return this._err(p, '您已响应过');
      if (!r.canHu) return this._err(p, '不能胡');
      r.choice = 'hu';
      this._clearTimer(room, 'resp:' + p.seat);
      this._log(room, `${p.name} 胡牌`);
      this._tryResolvePending(room, g, g.pending);
      return;
    }

    // 行动阶段：自摸
    if (g.stage === 'draw' && g.turn === p.seat && g.drawnTile !== null) {
      // 运城贴金麻将：金牌万能胡判定（无点数限制），按贴金结算
      if (this._isTieJin(room)) {
        if (!rules.checkHuTieJin(g.hands[p.seat], g.melds[p.seat], g.goldTile)) {
          return this._err(p, '手牌不构成胡牌');
        }
        // 首金未亮且亮金可行：亮金是唯一操作，此时不能自摸胡（牌墙已尽时放行）
        if (this._tieJinMustLiangjin(room, p.seat)) {
          return this._err(p, '首金必须亮出：请先执行「亮金」，亮金前不能胡牌');
        }
        this._settleHu(room, p.seat, { winType: 'zimo', tile: g.drawnTile });
        this._finishHuRound(room);
        return;
      }
      // 红中麻将：癞子胡判定（无点数限制），按红中结算
      if (this._isHongZhong(room)) {
        if (!rules.checkHuHongZhong(g.hands[p.seat], g.melds[p.seat])) {
          return this._err(p, '手牌不构成胡牌');
        }
        this._settleHu(room, p.seat, { winType: 'zimo', tile: g.drawnTile });
        this._finishHuRound(room);
        return;
      }
      if (!rules.checkHu(g.hands[p.seat], g.melds[p.seat])) return this._err(p, '手牌不构成胡牌');
      // 自摸胡点数限制：1/2 点不能胡
      if (!rules.canHuByPoints(rules.tilePoints(g.drawnTile), 'zimo')) {
        return this._err(p, '胡牌点数限制：1/2 点不能胡（自摸也不允许）');
      }
      this._settleHu(room, p.seat, {
        winType: 'zimo',
        tile: g.drawnTile,
      });
      this._finishHuRound(room);
      return;
    }
    return this._err(p, '当前不能胡');
  }

  _pass(p) {
    if (p._autoActing) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    // 报听玩家自摸可选择不胡：系统自动打出刚摸的牌（手牌继续锁死）
    if (g.stage === 'draw' && g.turn === p.seat && g.drawnTile !== null) {
      if (g.tingSeats.includes(p.seat)) {
        this._autoTingDiscard(room, p.seat, g.drawnTile);
        return;
      }
      return this._err(p, '当前不能过牌');
    }
    if (g.stage !== 'response' || !g.pending) return this._err(p, '当前没有可响应的操作');
    const r = g.pending.responders.find((x) => x.seat === p.seat);
    if (!r) return this._err(p, '您没有可响应的操作');
    if (r.choice !== null) return this._err(p, '您已响应过');
    r.choice = 'pass';
    this._clearTimer(room, 'resp:' + p.seat);
    this._log(room, `${p.name} 选择过`);
    this._logGame(room, 'action', { action: 'pass', seat: p.seat });
    this._tryResolvePending(room, g, g.pending);
  }

  _chat(p, msg) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const text = String((msg && msg.text) || '').trim().slice(0, 200);
    if (!text) return;
    room.chat.push({ from: p.name, text, time: nowTime() });
    if (room.chat.length > MAX_CHAT) room.chat.shift();
    this._broadcast(room, { type: 'chat', chat: room.chat.slice(-MAX_CHAT) });
  }

  // 对局表情互动：点击表情后向房间广播，轻量、无持久化的桌上氛围反馈
  // 仅允许白名单内的 emoji，防滥用；保留最近若干条供迟到/重连者补看
  _emoji(p, msg) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const emoji = String((msg && msg.emoji) || '').trim();
    if (!EMOJI_WHITELIST.includes(emoji)) return; // 非白名单直接忽略，不广播
    const entry = { from: p.name, seat: p.seat, emoji, time: nowTime() };
    if (!room.emoji) room.emoji = [];
    room.emoji.push(entry);
    if (room.emoji.length > MAX_EMOJI) room.emoji.shift();
    this._broadcast(room, { type: 'emoji', emoji: entry });
  }

  // 实时语音对讲信令转发（WebRTC mesh：信令走 WS，媒体走 P2P）
  // 校验：发起者在房间内；目标为同房间真人玩家（非 AI、有可用 ws）；sig 序列化 ≤ VOICE_SIG_MAX
  _voiceSignal(p, msg) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room || !room.players || room.players[p.seat] !== p) return; // 不在房间，静默忽略
    const targetId = String((msg && msg.target) || '');
    // 目标按房间内身份解析（座位代称 s0-s3 或兼容真实 id），且必须是同房间真人玩家
    const target = this._resolveRoomPlayer(room, targetId);
    if (!target || target.isAI || !target.ws || target.ws.readyState !== 1) return;
    if (target.roomId !== room.id || !room.players || room.players[target.seat] !== target) return;
    const sig = (msg && msg.sig) || null;
    if (!sig || typeof sig !== 'object') return;
    let sigJson;
    try {
      sigJson = JSON.stringify(sig);
    } catch {
      return; // 序列化失败（循环引用等）直接忽略
    }
    // 上限与 MAX_RAW_MSG（16KB，ws maxPayload）对齐：单条 SDP/ICE 信令实际仅数 KB，
    // 保留足够余量即可，避免整帧在 ws 层就被切断导致语音功能不可用
    if (sigJson.length > VOICE_SIG_MAX) return; // 超限拒绝，防滥用
    this._send(target, {
      type: 'voice_signal',
      // 不下发真实 playerId：用房间内座位代称，接收方据此回查座位
      from: this._seatRef(p),
      fromName: p.name,
      fromSeat: p.seat,
      sig,
    });
  }

  // ============ AI 自动行动 ============

  _shouldAutoAct(room, seat) {
    const pl = room.players[seat];
    return !!pl && (pl.isAI || pl.hosted || !pl.connected);
  }

  _markAutoActing(p) {
    // AI 代打中的动作：维持托管状态，不恢复真人控制（_restoreControl 的反面）
    if (p && !p.isAI) p.hosted = true;
  }

  _restoreControl(p) {
    if (p && p.hosted && !p.isAI) p.hosted = false;
  }

  /** 玩家主动开启托管，AI 代打接管（可随时取消） */
  _setHosted(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room || !room.players || room.players[p.seat] !== p) {
      return this._err(p, '您不在房间中');
    }
    if (p.isAI) return this._err(p, 'AI 玩家无需托管');
    if (!p.connected) return this._err(p, '您当前不在线，无法托管');
    if (p.hosted) return this._err(p, '您已处于托管状态');
    p.hosted = true;
    this._log(room, `${p.name} 手动开启托管`);
    if (room.state === 'playing' && room.game) {
      const g = room.game;
      if (g.stage === 'response' && g.pending) {
        const r = g.pending.responders.find((x) => x.seat === p.seat);
        if (r && r.choice === null) {
          r.choice = 'pass';
          this._clearTimer(room, 'resp:' + p.seat);
          this._log(room, `${p.name} 托管，响应视为过`);
          this._tryResolvePending(room, g, g.pending);
        }
      } else if (this._shouldAutoAct(room, p.seat)) {
        this._scheduleAutoAct(room, p.seat);
      }
    }
    this._broadcastRoomState(room);
    if (room.state === 'playing' && room.game) this._broadcastGameState(room);
  }

  /** 玩家主动取消托管，恢复真人控制 */
  _cancelHosted(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room || !room.players || room.players[p.seat] !== p) {
      return this._err(p, '您不在房间中');
    }
    if (p.isAI) return this._err(p, 'AI 玩家无法取消托管');
    if (!p.connected) return this._err(p, '您当前不在线，无法取消托管');
    if (!p.hosted) return this._err(p, '您当前未被托管');
    p.hosted = false;
    // 若正好轮到该玩家且有 AI 待执行动作：作废未触发令牌，后续不再调度新 AI 动作
    if (room.state === 'playing' && room.game && room.game.turn === p.seat) {
      p._autoGen = p._autoToken;
    }
    this._log(room, `${p.name} 已取消托管`);
    this._broadcastRoomState(room);
    if (room.state === 'playing' && room.game) this._broadcastGameState(room);
  }

  /** A2 修复：报听玩家的摸牌后杠判定（暗杠/补杠），杠牌不得破坏听口（与服务端 _gang 校验一致）；
   *  红中/贴金无报听概念，永不命中。返回 {tile, gangType} 或 null。 */
  _tingGangTile(g, room, seat) {
    if (this._isHongZhong(room) || this._isTieJin(room)) return null;
    const hand = g.hands[seat];
    const base = hand.slice();
    const di = base.lastIndexOf(g.drawnTile);
    if (di >= 0) base.splice(di, 1);
    const ting = rules.isTing(base, g.melds[seat]);
    const cnt = rules.countTiles(hand);
    for (const [t, c] of cnt) {
      if (c === 4 && !ting.includes(t) && rules.canAnGang(hand, t)) return { tile: t, gangType: 'angang' };
    }
    for (const m of g.melds[seat]) {
      if (m.type === 'peng' && (cnt.get(m.tile) || 0) >= 1 && !ting.includes(m.tile) && rules.canBuGang(hand, g.melds[seat], m.tile)) {
        // D2 修复：补杠前检查报听对手是否等这张牌，命中则跳过——避免抢杠送炮（仅报听对手可抢，≥6 点）
        const robbed = (g.tingSeats || []).some(
          (s) =>
            s !== seat &&
            rules.canHuWith(g.hands[s], m.tile, g.melds[s]) &&
            rules.canHuByPoints(rules.tilePoints(m.tile), 'qianggang')
        );
        if (robbed) continue;
        return { tile: m.tile, gangType: 'bugang' };
      }
    }
    return null;
  }

  _scheduleAutoAct(room, seat) {
    const pl = room.players[seat];
    if (!pl) return;
    // 令牌制：每条调度持有唯一令牌；真人接管/本局清理时推进 _autoGen 作废旧令牌。
    // 修复：旧共享计数器 _auto 会被回调收尾无条件递减，终局动作（如胡）同步开启
    // 下一局并为同座位创建新调度后，新调度令牌被旧回调抵消 → 庄家开局干等 30s 超时。
    const myToken = ++pl._autoToken;
    // 纳入 room.timers 统一跟踪：唯一 key（seat + 递增序号）支持同一座位并发多定时器，
    // 不使用 _setTimer（会 clear 旧 key），回调触发后自行删除本 key。
    const autoKey = 'auto:' + seat + ':' + (++room.autoSeq);
    const autoTimer = setTimeout(() => {
      this._timers.delete(autoTimer);
      room.timers.delete(autoKey);
      try {
        if (!room.players[seat]) return;
        if (room.state !== 'playing' || !room.game) return;
        const g = room.game;
        // 令牌已被取消（真人接管/本局结束清理）：直接退出，不代打
        if (myToken <= (pl._autoGen || 0) || !this._shouldAutoAct(room, seat)) return;
        // P1 修复：回调触发时若该座位并不处于动作点（非当前回合 / 非待响应），
        // 直接正常退出，不落入下方"动作未推进"快照比对 → 消除非当前回合调度的 AI stuck 100% 误报
        const pend = g.pending ? g.pending.responders.find((r) => r.seat === seat) : null;
        const isMyTurn = g.stage === 'draw' && g.turn === seat;
        const isMyResponse = g.stage === 'response' && !!pend && pend.choice === null;
        if (!isMyTurn && !isMyResponse) {
          return;
        }
        const snap = { stage: g.stage, turn: g.turn, drawn: g.drawnTile, lastAction: g.lastAction && g.lastAction.type, choices: g.pending ? g.pending.responders.map((r) => r.choice).join(',') : '' };
        if (g.stage === 'draw' && g.turn === seat) {
          // 报听兜底：报听玩家在摸牌后阶段只能胡或摸打，绝不落回 AI 出牌
          // （避免断线/托管等非 _drawCard 入口触发 decideDrawAction
          //   返回 play，被 _playTile 以"听口状态由系统自动摸打"拒绝后 stuck）
          if (g.tingSeats.includes(seat)) {
            if (g.drawnTile !== null) {
              pl._autoActing = true;
              try {
              if (rules.checkHu(g.hands[seat], g.melds[seat]) && rules.canHuByPoints(rules.tilePoints(g.drawnTile), 'zimo')) {
                const decision = this._variantCall(room, this._variantHandlers(room).decideDrawAction, g, room, seat);
                if (decision.type === 'hu') this._hu(pl, {});
                else this._pass(pl);
              } else {
                // A2 修复：报听玩家可杠（不破坏听口）则杠，不再一律摸打丢杠分
                const gangTile = this._tingGangTile(g, room, seat);
                if (gangTile) this._gang(pl, { tile: gangTile.tile, gangType: gangTile.gangType });
                else this._autoTingDiscard(room, seat, g.drawnTile);
              }
              } finally { pl._autoActing = false; }
              return;
            }
            return; // 报听玩家尚未摸牌：等待系统摸打，不代打
          }
          const decision = this._variantCall(room, this._variantHandlers(room).decideDrawAction, g, room, seat);
          pl._autoActing = true; // 动作执行期维持托管标记（动作可能同步开启下一局）
          try {
            if (decision.type === 'hu') this._hu(pl, {});
            else if (decision.type === 'ting') this._ting(pl, { tile: decision.tile });
            else if (decision.type === 'gang') this._gang(pl, { tile: decision.tile, gangType: decision.gangType });
            else if (decision.type === 'liangjin') this._liangjin(pl, {});
            else this._playTile(pl, { tile: decision.tile });
          } finally { pl._autoActing = false; }
        } else if (g.stage === 'response' && g.pending) {
          const r = g.pending.responders.find((x) => x.seat === seat);
          if (r && r.choice === null) {
            const choice = this._variantCall(room, this._variantHandlers(room).decideResponse, g, room, seat, r);
            pl._autoActing = true;
            try {
              if (choice === 'hu') this._hu(pl, {});
              else if (choice === 'gang') this._gang(pl, {});
              else if (choice === 'peng') this._peng(pl);
              else this._pass(pl);
            } finally { pl._autoActing = false; }
          }
        }
        // 兜底：动作未推进牌局（被校验拒绝/异常，快照未变）时有限重试，防 AI 永久卡死
        if (
          room.state === 'playing' &&
          room.game === g &&
          g.stage === snap.stage &&
          g.turn === snap.turn &&
          g.drawnTile === snap.drawn &&
          (g.lastAction && g.lastAction.type) === snap.lastAction &&
          (g.pending ? g.pending.responders.map((r) => r.choice).join(',') : '') === snap.choices &&
          this._shouldAutoAct(room, seat)
        ) {
          pl._autoRetry = (pl._autoRetry || 0) + 1;
          if (pl._autoRetry <= 2) {
            this._scheduleAutoAct(room, seat);
            return;
          }
          console.error('[game] AI stuck at seat', seat, 'after', pl._autoRetry, 'retries');
          pl._autoRetry = 0;
        }
      } catch (e) {
        console.error('[game] AI action error:', e);
      }
    }, 80);
    room.timers.set(autoKey, autoTimer);
    this._timers.add(autoTimer);
  }

  // ============ 构建视图 / 消息 ============

  // ---------- 身份脱敏：真实 playerId 只在本人连接可见 ----------
  // _seatRef / _idForViewer 已拆至 src/game/utils.js（mixin 混入）

  /** 房间视图中的 ownerId：本人是房主时为真实 id，否则为房主座位代称；房主不在座位时不下发 */
  _ownerRefForViewer(room, viewerSeat) {
    const ownerSeat = room.players.findIndex((pl) => pl && pl.id === room.ownerId);
    if (ownerSeat < 0) return '';
    const owner = room.players[ownerSeat];
    return owner.seat === viewerSeat ? room.ownerId : this._seatRef(owner);
  }

  /** 房间内身份解析：首选座位代称（s0-s3），兼容旧客户端直传真实 playerId */
  _resolveRoomPlayer(room, ref) {
    if (!ref) return null;
    if (SEAT_REF_RE.test(ref)) return room.players[Number(ref.slice(1))] || null;
    return room.players.find((x) => x && x.id === ref) || null;
  }

  _buildRoomView(room, viewerSeat) {
    return {
      id: room.id,
      state: room.state,
      roundNo: room.roundNo,
      settings: room.settings,
      roomType: room.settings ? room.settings.roomType : 'public',
      // 旁观者标记：viewerSeat=-1 表示以旁观者视角查看（前端据此隐藏操作区）
      isViewer: viewerSeat === -1,
      viewerCount: (room.viewers || []).length,
      // 房主标识：本人视角下发真实 id（前端据此判断 isOwner），他人视角仅下发座位代称
      ownerId: this._ownerRefForViewer(room, viewerSeat),
      players: room.players.map((pl, seat) =>
        pl
          ? {
              seat,
              // 他人一律用座位代称（s0-s3）：真实 playerId 是重连凭据的一半，不再广播
              id: this._idForViewer(pl, viewerSeat),
              name: pl.name,
              isAI: pl.isAI,
              connected: pl.connected,
              hosted: pl.hosted,
              score: pl.score,
              roundScore: pl.roundScore,
            }
          : null
      ),
      settleConfirms: room.settleConfirms ? room.settleConfirms.slice() : null,
      logs: this._maskLogsForViewer(room.logs.slice(-MAX_LOGS), viewerSeat),
      chat: room.chat.slice(-MAX_CHAT),
      emoji: room.emoji ? room.emoji.slice(-MAX_EMOJI) : [],
    };
  }

  _buildGameView(room, viewerSeat) {
    const g = room.game;
    const players = [];
    for (let s = 0; s < 4; s++) {
      const pl = room.players[s];
      if (!pl) {
        players.push(null);
        continue;
      }
      const isSelf = s === viewerSeat;
      players.push({
        seat: s,
        name: pl.name,
        isAI: pl.isAI,
        connected: pl.connected,
        hosted: pl.hosted,
        score: pl.score,
        roundScore: pl.roundScore,
        hand: isSelf ? rules.sortTiles(g.hands[s]) : null,
        handCount: g.hands[s].length,
        melds: g.melds[s],
        discards: g.discards[s],
        isDealer: s === g.dealer,
        ting: g.tingSeats.includes(s),
      });
    }
    const isDrawTurn = g.stage === 'draw' && g.turn === viewerSeat;
    const view = {
      roundNo: g.roundNo,
      dealer: g.dealer,
      turn: g.turn,
      stage: g.stage,
      wallCount: g.wall.length - g.wallPos,
      lastDiscard: g.lastDiscard,
      drawnTile: isDrawTurn && g.drawnTile !== null ? g.drawnTile : null,
      // 新摸牌标志：仅下发本玩家自己的新摸牌（他人视角恒为 null）
      newTile: (g.newTiles && g.newTiles[viewerSeat]) || null,
      yourSeat: viewerSeat,
      isDrawTurn,
      // 报听扣牌上架暗牌脱敏（所有人只见背面，不含牌面）与杠分明细全公开
      kouTiles: g.kouTiles.map((t) => (t ? 'back' : null)),
      gangLogs: g.gangLogs.slice(),
      players,
      pending: g.pending
        ? {
            type: g.pending.type,
            tile: g.pending.tile,
            discarder: g.pending.discarder,
            // 信息脱敏：仅本人可见自己的 canHu/canGang/canPeng 选项（他人只能看到座位与是否已决策）
            responders: g.pending.responders.map((r) => {
              const base = { seat: r.seat, choice: r.choice };
              if (r.seat === viewerSeat) {
                return { ...base, canHu: r.canHu, canGang: r.canGang, canPeng: r.canPeng };
              }
              return base;
            }),
          }
        : null,
      winners: g.winners,
      settings: room.settings,
      // 运城贴金麻将：金母/金牌/亮金区/锁金状态（非贴金玩法为 null，前端据此隐藏）
      goldMother: g.goldMother || null,
      goldTile: g.goldTile || null,
      shangjinTiles: g.shangjinTiles ? g.shangjinTiles.map((arr) => arr.slice()) : null,
      shangjinCount: g.shangjinCount ? g.shangjinCount.slice() : null,
      locked: g.locked ? g.locked.slice() : null,
      lockSeat: g.lockSeat != null ? g.lockSeat : -1,
      canLiangjin: isDrawTurn && !!g.goldTile && rules.countGold(g.hands[viewerSeat], g.goldTile) > 0 && !this._tieJinWallEnded(room, g),
      // 首金必须亮出：有金未亮且亮金可行 → 前端亮金按钮做强制提示（唯一可选操作）
      needLiangjin: isDrawTurn && this._tieJinMustLiangjin(room, viewerSeat),
      // 包胡阶段提示：牌墙剩最后 4 张，此时点炮由放炮者独赔三家
      baoHuZone: this._tieJinInBaoHuZone(room),
      wallRemain: g.wall.length - g.wallPos,
      logs: this._maskLogsForViewer(room.logs, viewerSeat),
    };
    if (isDrawTurn && !this._isHongZhong(room) && !this._isTieJin(room) && !g.tingSeats.includes(viewerSeat)) {
      // 听牌提示：打出某张后，听口剩余可胡张数（4 - 已见张数）
      // 性能优化：以 手牌牌型/自身明牌/已见牌 快照为 key 缓存，手牌未变化时直接复用，
      // 避免每次广播对整副牌型做 去重手牌×34牌型×checkHu 回溯重算（约 2000 次 checkHu）。
      if (!g.tingHintsCache) g.tingHintsCache = new Map();
      if (!g.tingCacheStats) g.tingCacheStats = { hit: 0, miss: 0 };
      const cacheKey = this._buildTingHintsKey(g, viewerSeat);
      const cached = g.tingHintsCache.get(cacheKey);
      if (cached !== undefined) {
        g.tingCacheStats.hit++;
        view.tingHints = { ...cached };
      } else {
        g.tingCacheStats.miss++;
        const hints = {};
        const hand = g.hands[viewerSeat];
        // 统计已见牌：自己手牌 + 各家弃牌(牌背不统计) + 明牌区(碰/杠) + 报听扣牌(自己视角可知)
        const seen = new Map();
        const addSeen = (t) => {
          if (t && t !== 'back') seen.set(t, (seen.get(t) || 0) + 1);
        };
        for (const t of hand) addSeen(t);
        for (const d of g.discards) for (const t of d) addSeen(t);
        for (const m of g.melds) for (const meld of m) for (const t of meld.tiles) addSeen(t);
        if (g.kouTiles[viewerSeat]) addSeen(g.kouTiles[viewerSeat]);
        for (const t of [...new Set(hand)]) {
          const rest = hand.slice();
          rest.splice(rest.indexOf(t), 1);
          const ting = rules.isTing(rest, g.melds[viewerSeat]);
          // 只提示可报听的选项：听口中须至少含一张 ≥6 点牌，与 canDeclareTing136 保持一致
          if (ting.length > 0 && ting.some((x) => rules.tilePoints(x) >= 6)) {
            hints[t] = ting.reduce((sum, x) => sum + Math.max(0, 4 - (seen.get(x) || 0)), 0);
          }
        }
        g.tingHintsCache.set(cacheKey, hints);
        view.tingHints = hints;
      }
    }
    return view;
  }

  // tingHints 缓存 key：覆盖所有影响听口结果的输入（手牌牌型、自身明牌结构、已见牌），
  // 摸牌/出牌/杠/报听等任何手牌或牌面变化都会改变 key，从而自动失效。
  _buildTingHintsKey(g, seat) {
    const parts = [];
    parts.push('h:' + rules.sortTiles(g.hands[seat]).join(','));
    parts.push('m:' + g.melds[seat].map((mm) => mm.type + mm.tile + mm.tiles.join('')).join(';'));
    const seen = [];
    for (const d of g.discards) seen.push(d.join(''));
    for (const ms of g.melds) for (const mm of ms) seen.push(mm.tiles.join(''));
    if (g.kouTiles[seat]) seen.push(g.kouTiles[seat]);
    parts.push('s:' + seen.join(';'));
    return parts.join('|');
  }

  _buildDrawPrompt(room, seat) {
    const g = room.game;
    const hand = g.hands[seat];
    // 策略表分发：红中/贴金走专用提示构建，扣点点用下方默认实现
    const promptBuilder = this._variantHandlers(room).buildDrawPrompt;
    if (promptBuilder !== '_buildDrawPrompt') return this[promptBuilder](room, seat);
    const actions = ['play'];
    const gangOptions = [];
    // 碰后（未摸牌）也可报听：碰完即听立即识别，不待下一轮摸牌；碰后手牌结构不允许胡/杠，只给 play/ting
    const justPeng = !!(g.lastAction && g.lastAction.type === 'peng');
    if (justPeng) {
      if (room.settings.allowTing && !g.tingSeats.includes(seat)) {
        // 报听：碰后 11 张手牌存在某张可扣牌，打出后仍听牌且听口中含 ≥6 点牌；明牌区刻子计入
        if (rules.canDeclareTing136(hand, g.melds[seat])) {
          actions.push('ting');
        }
      }
      return {
        type: 'draw',
        actions,
        gangOptions,
        canHu: false,
        canDeclareTing: actions.includes('ting'),
        timeoutMs: HUMAN_TIMEOUT_MS,
      };
    }
    if (g.drawnTile !== null) {
      // 自摸胡受点数限制：1/2 点不能胡（自摸也不允许），3/4/5 点可自摸；明牌区刻子计入已成型面子
      const selfHuByRules = rules.checkHu(hand, g.melds[seat]) && rules.canHuByPoints(rules.tilePoints(g.drawnTile), 'zimo');
      // 仅报听玩家可自摸胡
      if (g.tingSeats.includes(seat) && selfHuByRules) actions.push('hu');
      // 报听玩家：自摸可胡（满足点数限制），不胡则系统摸打（给“过”）；可补杠/暗杠（不破坏听口）给“杠”
      if (g.tingSeats.includes(seat)) {
        const gangOpts = this._tingGangOptions(room, seat);
        const tingActions = [];
        if (selfHuByRules) tingActions.push('hu');
        if (gangOpts.length) tingActions.push('gang');
        tingActions.push('pass');
        return {
          type: 'draw',
          actions: tingActions,
          gangOptions: gangOpts,
          canHu: selfHuByRules,
          canDeclareTing: false,
          timeoutMs: HUMAN_TIMEOUT_MS,
        };
      }
      const cnt = rules.countTiles(hand);
      for (const [t, c] of cnt) {
        if (c === 4) gangOptions.push({ gangType: 'angang', tile: t });
      }
      for (const m of g.melds[seat]) {
        if (m.type === 'peng' && cnt.get(m.tile) >= 1) {
          gangOptions.push({ gangType: 'bugang', tile: m.tile });
        }
      }
      if (gangOptions.length) actions.push('gang');
      if (room.settings.allowTing && !g.tingSeats.includes(seat)) {
        // 报听：手牌（摸牌后 14 张）存在某张可扣牌，打出后仍听牌且听口中含 ≥6 点牌；明牌区刻子计入
        if (rules.canDeclareTing136(hand, g.melds[seat])) {
          actions.push('ting');
        }
      }
    }
    return {
      type: 'draw',
      actions,
      gangOptions,
      canHu: actions.includes('hu'),
      canDeclareTing: actions.includes('ting'),
      timeoutMs: HUMAN_TIMEOUT_MS,
    };
  }

  _buildResponsePrompt(room, r) {
    const actions = [];
    if (r.canHu) actions.push('hu');
    if (r.canGang) actions.push('gang');
    if (r.canPeng) actions.push('peng');
    actions.push('pass');
    return {
      type: 'response',
      actions,
      canHu: r.canHu,
      canGang: r.canGang,
      canPeng: r.canPeng,
      tile: room.game.pending.tile,
      pendingType: room.game.pending.type,
      timeoutMs: RESPONSE_TIMEOUT_MS,
    };
  }

  _revealHands(room, opts = {}) {
    const g = room.game;
    return [0, 1, 2, 3].map((s) =>
      room.players[s]
        ? {
            seat: s,
            name: room.players[s].name,
            hand: rules.sortTiles(this._revealHandOf(room, s, opts.skipSeat)),
            melds: g.melds[s],
            roundScore: room.players[s].roundScore,
          }
        : null
    );
  }

  // 结算展示手牌：报听玩家的暗扣牌补回，保持 14 张完整口径（skipSeat 用于排除已按胡牌结构展示的赢家）
  _revealHandOf(room, seat, skipSeat) {
    const g = room.game;
    const hand = g.hands[seat].slice();
    if (g.tingSeats.includes(seat) && g.kouTiles[seat] && seat !== skipSeat) {
      hand.push(g.kouTiles[seat]);
    }
    return hand;
  }

  /**
   * 结算手牌展示：基于真实手牌（_revealHands），点炮/抢杠胡赢家补入胡的那张牌（14 张完整展示），自摸不补（胡牌已在手）。
   * 仅影响展示，g.hands 原始数据与 _settleHu 局部算番副本均不受影响。
   */
  _revealHandsWithWinTile(room, winnerSeat, info) {
    const revealed = this._revealHands(room, { skipSeat: winnerSeat });
    if (info.winType !== 'zimo') {
      const w = revealed.find((r) => r && r.seat === winnerSeat);
      if (w) w.hand = rules.sortTiles([...w.hand, info.tile]);
    }
    return revealed;
  }

  // ============ 工具方法 ============

  _createPlayer(ws, name) {
    // id 与 secret 均用 crypto 随机：playerId 不再可预测，secret 作为重连第二因子
    const id = 'u' + crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(24).toString('hex');
    const p = {
      id,
      secret, // 重连凭据第二因子：仅通过 hello 下发给本人连接
      name,
      ws,
      account: null, // 关联登录账户用户名（null = 游客）；历史对局记录据此归因
      roomId: null,
      seat: null,
      connected: true,
      hosted: false,
      isAI: false,
      score: 0,
      roundScore: 0,
      disconnectTimer: null,
      joinFails: 0, // 连续加入房间失败次数（成功即清零）
      joinLockUntil: 0, // 加入失败锁定截止时间戳
      _autoToken: 0, _autoGen: 0, _autoActing: false,
    };
    this.players.set(id, p);
    this.wsPlayers.set(ws, id);
    return p;
  }

  // _sanitizeName 已拆至 src/game/utils.js（mixin 混入）

  _validateSettings(s) {
    if (!s || typeof s !== 'object') return null;
    const totalRounds = Number(s.totalRounds);
    if (![0, 4, 8, 12].includes(totalRounds)) return null;
    const variant = s.variant === 'hongzhong' ? 'hongzhong' : (s.variant === 'tiejin' ? 'tiejin' : 'koudian');
    // 房间类型：public=公共局（大厅列表可见，任何人可加入）；friend=好友局（大厅列表不可见，仅受邀进入）。默认 public 保持向后兼容
    const roomType = s.roomType === 'friend' ? 'friend' : 'public';
    // AI 难度：normal=原有启发式（默认，旧客户端/旧房间数据兼容）；hard=向听/进张枚举 + 精确风险
    const aiDifficulty = s.aiDifficulty === 'hard' ? 'hard' : 'normal';
    // 红中麻将专属设置：扎码张数（0=不扎码 / 1/2/4/6）。
    // 固定胡牌方式：只能自摸/抢杠胡（禁点炮、抢杠仅限补杠）。
    if (variant === 'hongzhong') {
      const zhaMa = Number(s.zhaMa) || 0;
      if (![0, 1, 2, 4, 6].includes(zhaMa)) return null;
      return {
        totalRounds,
        aiFill: !!s.aiFill,
        variant,
        roomType,
        aiDifficulty,
        zhaMa,
        dealerFlow: 'keep', // 红中：流局庄家连庄（设计固定）
      };
    }
    // 运城贴金麻将专属设置：锁金为固定规则（连续亮金两张自动锁金）、流局开关（A=摸完 / B=硬10墩）、计分开关（A=边趣版 / B=125体系）。
    if (variant === 'tiejin') {
      return {
        totalRounds,
        aiFill: !!s.aiFill,
        variant,
        roomType,
        aiDifficulty,
        drawEndMode: s.drawEndMode === 'B' ? 'B' : 'A', // 流局开关：默认 A（摸完）
        scoreMode: s.scoreMode === 'B' ? 'B' : 'A', // 计分开关：默认 A（边趣版）
        dealerFlow: 'flow', // 贴金：轮庄/流局坐庄（有杠下家、无杠连庄）
      };
    }
    const qingYiSeMult = Number(s.qingYiSeMult) || 4;
    const yiTiaoLongMult = Number(s.yiTiaoLongMult) || 4;
    const shiSanYaoMult = Number(s.shiSanYaoMult) || 8;
    const scoreModel = s.scoreModel === 'add' ? 'add' : 'multiply'; // 计分模型：multiply=乘算（点数×倍数）/ add=加算（底分+固定加番）
    return {
      totalRounds,
      aiFill: !!s.aiFill,
      variant,
      roomType,
      aiDifficulty,
      allowTing: true, // 报听为 136 必选核心规则
      enableQingYiSe: !!s.enableQingYiSe,
      enableYiTiaoLong: !!s.enableYiTiaoLong,
      enableShiSanYao: !!s.enableShiSanYao,
      qingYiSeMult,
      yiTiaoLongMult,
      shiSanYaoMult,
      dealerFlow: s.dealerFlow === 'keep' ? 'keep' : 'next', // 流局庄家：keep=连庄 / next=下家接庄（默认）
      scoreModel,
      zhuangDi: s.zhuangDi === true, // 庄底加分开关（默认关闭：开启时仅庄家胡牌单边加分，非自摸+5 / 自摸+10）
    };
  }

  _seatPlayer(room, p) {
    const seat = room.players.findIndex((x) => x === null);
    if (seat < 0) return false;
    room.players[seat] = p;
    p.roomId = room.id;
    p.seat = seat;
    p.score = 0;
    p.roundScore = 0;
    p.hosted = false;
    p._autoToken = 0; p._autoGen = 0; p._autoActing = false;
    return true;
  }

  _unseatPlayer(room, p) {
    if (p.seat != null && room.players[p.seat] === p) room.players[p.seat] = null;
    this._clearDisconnectTimer(p);
    p.roomId = null;
    p.seat = null;
  }

  _destroyRoom(room) {
    for (const pl of room.players) {
      if (pl) {
        // 掉线超时（disconnectTimer 已触发且未重连）的真人已无重连可能，可安全从全局移除
        const timedOut = !pl.isAI && !pl.connected && pl.disconnectTimer === null;
        pl.roomId = null;
        pl.seat = null;
        pl.hosted = false;
        pl._autoToken = 0; pl._autoGen = 0; pl._autoActing = false;
        pl._autoRetry = 0;
        this._clearDisconnectTimer(pl);
        // AI 与掉线超时玩家无重连可能：从全局 players 移除，避免内存泄漏；在线/短暂离线真人保留可重连
        if (pl.isAI || timedOut) {
          this.players.delete(pl.id);
          this.wsPlayers.delete(pl.ws);
        }
        this._send(pl, { type: 'room_state', room: null });
        this._sendLobbyState(pl);
      }
    }
    // 旁观者：解散房间时一并清出（无座位、无重连需求）
    for (const v of room.viewers || []) {
      if (!v) continue;
      v.roomId = null;
      v.seat = null;
      v.isViewer = false;
      this._clearDisconnectTimer(v);
      this.players.delete(v.id);
      this.wsPlayers.delete(v.ws);
      this._send(v, { type: 'room_state', room: null });
      this._sendLobbyState(v);
    }
    room.viewers = [];
    for (const t of room.timers.values()) {
      clearTimeout(t);
      this._timers.delete(t);
    }
    room.timers.clear();
    this.rooms.delete(room.id);
    this._broadcastLobby();
  }

  _setTimer(room, key, ms, fn) {
    this._clearTimer(room, key);
    const t = setTimeout(() => {
      this._timers.delete(t);
      room.timers.delete(key);
      try {
        fn();
      } catch (e) {
        console.error('[game] timer error (' + key + '):', e);
      }
    }, ms);
    room.timers.set(key, t);
    this._timers.add(t);
  }

  _clearTimer(room, key) {
    const t = room.timers.get(key);
    if (t) {
      clearTimeout(t);
      this._timers.delete(t);
      room.timers.delete(key);
    }
  }

  // _log / _logGame / _logPlayers / _maskLogsForViewer / _pName 已拆至 src/game/utils.js（mixin 混入）
  // _broadcastGameState / _broadcastRoomState / _broadcast / _prompt / _sendSettlement /
  // _sendLobbyState / _broadcastLobby / _send / _sendWs / _err 已拆至 src/game/io.js（mixin 混入）

  // ============ 红中麻将流程模块（西安红中：112 张无风、庄14闲13、禁吃、癞子胡、抢杠、扎码；胡牌仅自摸/抢杠） ============

  _isHongZhong(room) {
    return !!(room && room.settings && room.settings.variant === 'hongzhong');
  }

  /** 归一化玩法名（策略表方案：读表前先归一，供 _variantHandlers 等复用） */
  _variantOf(room) {
    return variants.normalizeVariant(room && room.settings ? room.settings.variant : 'koudian');
  }

  /** 取房间对应玩法的 handler 表（AI 决策 / 出牌提示的方法名），供数据驱动分发 */
  _variantHandlers(room) {
    return variants.handlersOf(room);
  }

  /** 数据驱动调用：handler 名可能是 'ai.xxx'（模块函数）或 '_xxx'（this 方法） */
  _variantCall(room, handlerName, ...args) {
    if (handlerName && handlerName.startsWith('ai.')) {
      const fn = handlerName.slice(3);
      return ai[fn](...args);
    }
    return this[handlerName](...args);
  }

  _hzTileTypes(room) {
    if (this._isHongZhong(room)) return rules.getHongZhongTileTypes();
    return rules.getTileTypes();
  }

  /** 正式开局（红中/贴金）：庄家起手 14 张直接进入出牌行动，不再摸牌 */
  _startPlay(room, seat) {
    const g = room.game;
    g.turn = seat;
    g.stage = 'draw';
    // P0 修复：起手第 14 张视为已摸牌，避免 _gang/_hu 因 drawnTile===null 拒绝
    // 导致庄家起手暗杠/胡被拒、座位永久卡死整局（红中约0.9%、贴金约1/800小局）
    g.drawnTile = g.hands[seat][g.hands[seat].length - 1];
    g.lastDiscard = null;
    g.lastAction = null;
    g.newTiles[seat] = null;
    this._afterTurnStart(room, seat);
  }





  /** 胡牌收尾（三玩法统一）：广播状态 + 结算 + 结束本局；贴金玩法额外记录庄家流转 */
  _finishHuRound(room) {
    const g = room.game;
    if (this._isTieJin(room)) {
      room.lastWinner = g.winners ? g.winners.winner : null; // 谁胡谁坐庄（庄胡连庄）
      room.lastFlowHadGang = false;
    }
    this._broadcastGameState(room);
    this._sendSettlement(room);
    this._broadcastRoomState(room);
    this._endRound(room);
  }


  /** 红中行牌提示：胡/杠/出牌（无报听、禁吃） */
  _buildDrawPromptHongZhong(room, seat) {
    const g = room.game;
    const hand = g.hands[seat];
    const actions = ['play'];
    const gangOptions = [];
    // 碰后（未摸牌）：手牌结构不允许胡/杠，只给出牌
    if (g.lastAction && g.lastAction.type === 'peng') {
      return { type: 'draw', actions, gangOptions, canHu: false, canDeclareTing: false, timeoutMs: HUMAN_TIMEOUT_MS };
    }
    const canSelfHu = rules.checkHuHongZhong(hand, g.melds[seat]);
    if (canSelfHu) actions.push('hu');
    const cnt = rules.countTiles(hand);
    for (const [t, c] of cnt) {
      if (c === 4) gangOptions.push({ gangType: 'angang', tile: t });
    }
    for (const m of g.melds[seat]) {
      if (m.type === 'peng' && cnt.get(m.tile) >= 1) {
        gangOptions.push({ gangType: 'bugang', tile: m.tile });
      }
    }
    if (gangOptions.length) actions.push('gang');
    return {
      type: 'draw',
      actions,
      gangOptions,
      canHu: canSelfHu,
      canDeclareTing: false,
      timeoutMs: HUMAN_TIMEOUT_MS,
    };
  }

  // ---- 红中 AI 决策（简易策略：自摸/杠优先，出牌保留红中、优先拆孤张） ----

  _decideHongZhongDrawAction(g, room, seat) {
    const hand = g.hands[seat];
    // 碰后（未摸牌）：手牌结构不允许胡/杠，只能出牌（与 _buildDrawPromptHongZhong 保持一致，防止 AI 卡死）
    if (g.lastAction && g.lastAction.type === 'peng') {
      return { type: 'play', tile: this._chooseHongZhongDiscard(g, room, seat) };
    }
    if (rules.checkHuHongZhong(hand, g.melds[seat])) {
      return { type: 'hu' };
    }
    const cnt = rules.countTiles(hand);
    for (const [t, c] of cnt) {
      if (c === 4) return { type: 'gang', tile: t, gangType: 'angang' };
    }
    for (const m of g.melds[seat]) {
      if (m.type === 'peng' && cnt.get(m.tile) >= 1) {
        return { type: 'gang', tile: m.tile, gangType: 'bugang' };
      }
    }
    return { type: 'play', tile: this._chooseHongZhongDiscard(g, room, seat) };
  }

  _chooseHongZhongDiscard(g, room, seat) {
    // 困难难度：先走「枚举弃牌 → 听口进张 → 风险 → 连接度」，无有效听口时回退下方原启发式
    if (ai.isHard(room)) {
      const picked = ai.hardChooseHongZhongDiscard(g, seat, room);
      if (picked) return picked;
    }
    const cnt = rules.countTiles(g.hands[seat]);
    const candidates = [];
    for (const [t, c] of cnt) {
      if (t === rules.HONG_ZHONG) continue; // 红中万能牌永不出
      if (c === 1) candidates.push(t); // 孤张优先
    }
    if (candidates.length === 0) {
      for (const [t, c] of cnt) {
        if (t === rules.HONG_ZHONG) continue;
        candidates.push(t);
      }
    }
    candidates.sort((a, b) => rules.discardRank(a) - rules.discardRank(b));
    const tile = candidates[0];
    if (tile) return tile;
    return g.hands[seat].find((t) => t !== rules.HONG_ZHONG) || g.hands[seat][0];
  }

  _decideHongZhongResponse(g, room, seat, r) {
    // 困难难度：用「碰掉唯一对子会失去雀头」等牌效判据决定要不要碰，并落盘决策轨迹
    const hardChoice = ai.decideVariantResponse(g, room, seat, r);
    if (hardChoice) return hardChoice;
    if (r.canHu) return 'hu';
    if (r.canGang) return 'gang';
    if (r.canPeng) return 'peng';
    return 'pass';
  }

  // ============ 运城贴金麻将流程模块（variant='tiejin'：136 张、庄14闲13、禁吃可碰杠、金牌万能、亮金/锁金/流局/计分开关） ============

  _isTieJin(room) {
    return !!(room && room.settings && room.settings.variant === 'tiejin');
  }

  /** 贴金流局判定：开关 A=摸完最后一张（剩余<=0）；开关 B=剩 10 墩硬黄（剩余<=20 张） */
  _tieJinWallEnded(room, g) {
    const remain = g.wall.length - g.wallPos;
    if (room.settings && room.settings.drawEndMode === 'B') return remain <= 20;
    return remain <= 0;
  }

  /** 点炮胡资格：
   *  未亮金：只能自摸；亮过金且未被锁：可点炮；被锁定者只能自摸（亮出最后金牌解锁后恢复）。 */
  _tieJinCanDianpao(room, seat) {
    const g = room.game;
    if (!g || !g.goldTile || (g.shangjinCount || [])[seat] <= 0) return false;
    if (g.locked && g.locked[seat]) return false;
    return true;
  }

  /** 「首金未亮」判定：手中握有金牌、而本局个人一张都未亮出。
   *  仅描述手牌事实，不含可用动作语义；动作层面的限制见 _tieJinMustLiangjin。
   *  杠后补牌后手牌可能暂时 >14 张，此处只看手牌中是否仍有金牌，与张数无关。 */
  _tieJinHasUnplayedGold(room, seat) {
    const g = room.game;
    if (!this._isTieJin(room) || !g || !g.goldTile) return false;
    return rules.isFirstGoldUnplayed(g.hands[seat], g.goldTile, (g.shangjinCount || [])[seat] || 0);
  }

  /** 首金强制亮金：「手握首金未亮」且「亮金可行（牌墙未到流局阈值）」→ 亮金是本回合唯一合法操作，
   *  出牌 / 碰 / 杠 / 自摸胡一律禁止，必须先把首金亮出才能做其他操作。
   *  牌墙已尽时亮金本身不可行（亮金要从牌尾补牌），此时返回 false —— 放行所有操作，
   *  避免玩家既不能亮金又不能出牌而整局锁死。 */
  _tieJinMustLiangjin(room, seat) {
    if (!this._tieJinHasUnplayedGold(room, seat)) return false;
    const g = room.game;
    if (!g) return false;
    return !this._tieJinWallEnded(room, g);
  }

  /** 包胡触发判定：牌墙剩「最后 4 张」及以内时点炮/抢杠 → 放炮者（被抢杠者）独赔三家（抢杠胡算点炮，同样触发；仅自摸不触发）。
   *  注意「剩余」= wall.length - wallPos（流局阈值同口径）。 */
  _tieJinIsBaoHu(room, info) {
    if (!this._isTieJin(room) || !info || info.winType === 'zimo') return false;
    const g = room.game;
    if (!g) return false;
    return g.wall.length - g.wallPos <= 4;
  }

  /** 牌墙上是否已进入包胡阶段（剩最后 4 张）：用于牌桌阶段提示 */
  _tieJinInBaoHuZone(room) {
    if (!this._isTieJin(room)) return false;
    const g = room.game;
    if (!g || room.state !== 'playing' || g.winners) return false;
    return g.wall.length - g.wallPos <= 4;
  }






  /** 亮金（摸牌后、出牌前的独立操作）：亮出 1 张金牌放入面前亮金区（不入弃牌堆），
   *  从牌墙尾补 1 张牌，手牌数量保持不变（不轮转，仍处出牌前 draw 阶段，可继续出牌/再亮金/胡）；
   *  免疫锁金唯一条件：本局个人累计上金达到 2 张即免疫，不受锁金限制；
   *  连续亮金达到 2 张自动触发锁金（规则），锁金只锁累计上金不足 2 张的玩家。 */
  _liangjin(p, msg) {
    if (p._autoActing) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (!this._isTieJin(room) || room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.stage !== 'draw' || g.turn !== p.seat) return this._err(p, '当前不能亮金');
    if (!g.goldTile) return this._err(p, '本局无金牌');
    const gold = g.goldTile;
    const hand = g.hands[p.seat];
    if (rules.countGold(hand, gold) <= 0) return this._err(p, '手中没有金牌');
    // 牌墙剩余可补牌数不足（流局阈值已到）时不可亮金
    if (this._tieJinWallEnded(room, g)) return this._err(p, '牌墙已结束，不能再亮金');
    hand.splice(hand.indexOf(gold), 1);
    g.shangjinTiles[p.seat].push(gold);
    g.shangjinCount[p.seat]++;
    // 从牌墙尾（wall 尾部）补一张，手牌数量保持不变
    const bonus = g.wall.pop();
    hand.push(bonus);
    g.lastAction = { type: 'liangjin', tile: gold };
    g.drawnTile = bonus;
    g.newTiles[p.seat] = bonus;
    this._clearTimer(room, 'draw:' + p.seat);
    // 免疫锁金唯一条件：本局累计上金达到 2 张 → 解除锁定
    if (g.locked[p.seat] && g.shangjinCount[p.seat] >= 2) {
      g.locked[p.seat] = false;
      this._log(room, `${this._pName(room, p.seat)} 累计上金两张，免疫锁金！`);
    }
    this._log(room, `${this._pName(room, p.seat)} 亮金 ${rules.tileName(gold)}（亮金区）`);
    this._log(room, `${this._pName(room, p.seat)} 牌尾补入 ${rules.tileName(bonus)}`, p.seat, `${this._pName(room, p.seat)} 亮金补牌`);
    this._logGame(room, 'action', { action: 'liang_jin', seat: p.seat, tile: gold, bonusTile: bonus, goldCount: g.shangjinCount[p.seat], locked: g.locked.slice() });
    // 规则锁金：连续亮金达到 2 张后自动锁金（仅触发一次）；累计上金已满 2 张的玩家免疫，不受锁
    if (g.shangjinCount[p.seat] >= 2 && g.lockSeat === -1) {
      for (let s = 0; s < 4; s++) if (s !== p.seat && g.shangjinCount[s] < 2) g.locked[s] = true;
      g.lockSeat = p.seat;
      this._log(room, `${this._pName(room, p.seat)} 连续亮金两张，自动锁金！未上金两张的玩家只能自摸胡！`);
    }
    // 不轮转：仍由本家出牌/再亮金/胡（重新广播 + 构建出牌前行动提示）
    this._afterTurnStart(room, p.seat);
  }


  /** 贴金行牌提示：出牌/自摸胡/杠/亮金（无报听、禁吃；锁金为自动规则）
   *  「首金必须亮出」：手握首金却一张未亮且亮金可行时，亮金是唯一合法操作 ——
   *  提示里只给亮金（actions=['liangjin']、canHu=false、无 gangOptions），前端据 needLiangjin 强制引导。 */
  _buildDrawPromptTieJin(room, seat) {
    const g = room.game;
    const hand = g.hands[seat];
    const actions = ['play'];
    const gangOptions = [];
    // 首金强制亮金：亮金是本回合唯一可选操作（牌墙已尽无法亮金时不进入此分支）
    if (this._tieJinMustLiangjin(room, seat)) {
      return {
        type: 'draw',
        actions: ['liangjin'],
        gangOptions: [],
        canHu: false,
        canPlay: false, // 前端据此把手牌置为不可点（服务端 _playTile 同样拒绝）
        canLiangjin: true,
        needLiangjin: true,
        canDeclareTing: false,
        timeoutMs: HUMAN_TIMEOUT_MS,
      };
    }
    // 碰后（未摸牌）：手牌结构不允许胡/杠，但持有金牌且牌墙未结束仍可亮金
    if (g.lastAction && g.lastAction.type === 'peng') {
      const goldCountAfterPeng = g.goldTile ? rules.countGold(hand, g.goldTile) : 0;
      const canLiangjinAfterPeng = goldCountAfterPeng > 0 && !this._tieJinWallEnded(room, g);
      const needLiangjinAfterPeng = this._tieJinMustLiangjin(room, seat); // 上方已提前返回，此处恒为 false
      if (canLiangjinAfterPeng) actions.push('liangjin');
      return {
        type: 'draw',
        actions,
        gangOptions,
        canHu: false,
        canLiangjin: canLiangjinAfterPeng,
        needLiangjin: needLiangjinAfterPeng,
        canDeclareTing: false,
        timeoutMs: HUMAN_TIMEOUT_MS,
      };
    }
    // 首金必须亮出：有金未亮且亮金可行时已在上方提前返回；走到这里要么已亮过金，
    // 要么牌墙已尽（亮金不可行）→ 放行出牌/杠/胡，与 _playTile/_hu 的放行口径一致
    const needLiangjin = this._tieJinMustLiangjin(room, seat);
    const canSelfHu = !needLiangjin && rules.checkHuTieJin(hand, g.melds[seat], g.goldTile);
    if (canSelfHu) actions.push('hu');
    const cnt = rules.countTiles(hand);
    for (const [t, c] of cnt) {
      if (c === 4 && !rules.isGold(t, g.goldTile)) gangOptions.push({ gangType: 'angang', tile: t });
    }
    for (const m of g.melds[seat]) {
      if ((m.type === 'peng' || m.type === 'bugang') && (cnt.get(m.tile) || 0) >= 1 && !rules.isGold(m.tile, g.goldTile)) {
        gangOptions.push({ gangType: 'bugang', tile: m.tile });
      }
    }
    if (gangOptions.length) actions.push('gang');
    // 亮金资格：手中有金牌、牌墙仍有可补牌（拥有出牌权即可亮金）
    const goldCount = g.goldTile ? rules.countGold(hand, g.goldTile) : 0;
    const canLiangjin = goldCount > 0 && !this._tieJinWallEnded(room, g);
    if (canLiangjin) actions.push('liangjin');
    return {
      type: 'draw',
      actions,
      gangOptions,
      canHu: canSelfHu,
      canLiangjin,
      needLiangjin: needLiangjin && canLiangjin,
      canDeclareTing: false,
      timeoutMs: HUMAN_TIMEOUT_MS,
    };
  }

  // ---- 贴金 AI 决策（简易策略：胡/杠优先，亮金按收益判断：够 1 张就停，出牌保留金牌） ----

  // 亮金收益判断：跳过零收益分支，够 1 张就停（返回 true 才亮金）
  // 例外：「首金必须亮出」——本家一张未亮且手握金牌时无条件亮金（否则本回合不能出牌/碰/杠/胡）
  _shouldLiangjinTieJin(g, room, seat) {
    const gold = g.goldTile;
    if (!gold) return false;
    const inHand = rules.countGold(g.hands[seat], gold);
    if (inHand <= 0) return false;
    if (this._tieJinWallEnded(room, g)) return false;
    const done = (g.shangjinCount || [])[seat] || 0;
    if (done === 0) return true;                                      // 首金必须亮出：唯一可选操作，无条件亮
    if (done >= 3) return false;                                      // 三金封顶，第 4 张零增益
    if (g.locked && g.locked[seat] && done + inHand < 2) return false; // 亮完累计仍 < 2，拿不到点炮资格
    if (done >= 1 && inHand < 2) return false;                        // 够 1 张就停：保留最后一枚万能牌
    return true;
  }

  _decideTieJinDrawAction(g, room, seat) {
    const hand = g.hands[seat];
    // 首金必须亮出：有金未亮属最高优先级（此时出牌/杠/胡都不允许，也谈不上保留万能牌）
    if (this._shouldLiangjinTieJin(g, room, seat)) {
      return { type: 'liangjin' };
    }
    if (g.lastAction && g.lastAction.type === 'peng') {
      return { type: 'play', tile: this._chooseTieJinDiscard(g, room, seat) };
    }
    if (rules.checkHuTieJin(hand, g.melds[seat], g.goldTile)) {
      return { type: 'hu' };
    }
    const cnt = rules.countTiles(hand);
    for (const [t, c] of cnt) {
      if (c === 4 && !rules.isGold(t, g.goldTile)) return { type: 'gang', tile: t, gangType: 'angang' };
    }
    for (const m of g.melds[seat]) {
      if ((m.type === 'peng' || m.type === 'bugang') && (cnt.get(m.tile) || 0) >= 1 && !rules.isGold(m.tile, g.goldTile)) {
        return { type: 'gang', tile: m.tile, gangType: 'bugang' };
      }
    }
    return { type: 'play', tile: this._chooseTieJinDiscard(g, room, seat) };
  }

  _chooseTieJinDiscard(g, room, seat) {
    // 困难难度：贴金牌型专用听口枚举（金牌万能不参与弃牌），无有效听口时回退原启发式
    if (ai.isHard(room)) {
      const picked = ai.hardChooseTieJinDiscard(g, seat, room);
      if (picked) return picked;
    }
    const cnt = rules.countTiles(g.hands[seat]);
    const candidates = [];
    for (const [t, c] of cnt) {
      if (rules.isGold(t, g.goldTile)) continue; // 金牌万能牌保留
      if (c === 1) candidates.push(t);
    }
    if (candidates.length === 0) {
      for (const [t, c] of cnt) if (!rules.isGold(t, g.goldTile)) candidates.push(t);
    }
    if (candidates.length === 0) {
      return g.hands[seat].find((t) => !rules.isGold(t, g.goldTile)) || g.hands[seat][0];
    }
    candidates.sort((a, b) => rules.discardRank(a) - rules.discardRank(b));
    return candidates[0];
  }

  _decideTieJinResponse(g, room, seat, r) {
    const hardChoice = ai.decideVariantResponse(g, room, seat, r);
    if (hardChoice) return hardChoice;
    if (r.canHu) return 'hu';
    if (r.canGang) return 'gang';
    if (r.canPeng) return 'peng';
    return 'pass';
  }
}

// 阶段一：混入拆分出的 mixin（账号/好友、纯工具、发送广播 I/O）。
// 注意：混入需放在 class 定义之后、导出之前；方法以原型方式共享，this 上下文不变。
Object.assign(GameServer.prototype, accountMixin);
Object.assign(GameServer.prototype, utilsMixin);
Object.assign(GameServer.prototype, ioMixin);

module.exports = { GameServer, HEARTBEAT_INTERVAL_MS, HEARTBEAT_MAX_MISS };
