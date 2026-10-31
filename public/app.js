'use strict';
/* 运城麻将 - 前端渲染与交互 */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // 存储安全封装：部分 WebView / 严格隐私模式禁用 localStorage，裸访问抛 SecurityError
  // 会让本文件顶层初始化直接崩溃 → 整页白屏。降级为内存 Map（会话内可用，刷新即失）。
  const store = (() => {
    try {
      const ls = window.localStorage;
      const probe = '__kd_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch (e) {
      const mem = new Map();
      return {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => { mem.set(k, String(v)); },
        removeItem: (k) => { mem.delete(k); },
      };
    }
  })();

  const state = {
    ws: null,
    playerId: store.getItem('kd.playerId') || '',
    // 重连凭据第二因子：由服务端 hello 下发一次并持久化，reconnect 时必须回传
    secret: store.getItem('kd.secret') || '',
    name: store.getItem('kd.name') || '',
    // 登录账户：token 由服务端登录/注册下发，join_lobby 时回传以关联账户（历史对局归因）
    token: store.getItem('kd.token') || '',
    username: store.getItem('kd.username') || '',
    displayName: store.getItem('kd.displayName') || '',
    lobby: null,
    room: null,
    game: null,
    prompt: null,
    tingPick: false, // 听口选牌状态：点击手牌表示报听
    selectedIndex: null, // 手牌选中交互：当前选中的手牌索引（默认模式，开关关闭时生效）
    _lastTurn: null, // 最近一次 game_state 的 turn，用于检测轮次变化并清除选中态
    _selfHosted: null, // 自己最近一次托管状态，用于只提示一次托管原因
    _hostedRequestAt: 0, // 主动托管请求时间，用于区分手动托管与超时托管
    reconnectAttempts: 0,
    countdownTimer: null,
    countdownEnd: 0,
    lastSettlementShown: null,
  };

  // ================= WS =================
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    state.ws = ws;
    ws.onopen = () => {
      state.reconnectAttempts = 0;
      hideConnMask();
      // 已有登录 token：开连接即用 token 自动重登（刷新页面后无需重新输入账号）
      if (state.token) send({ type: 'login', token: state.token });
      if (state.playerId) {
        send({ type: 'reconnect', playerId: state.playerId, secret: state.secret, name: state.name });
      }
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = () => {
      state.connected = false;
      voiceDisable();
      if (!state.room) {
        // 大厅中：显示重连遮罩但不打扰（自动恢复）
      }
      showConnMask('连接断开，正在重连…');
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(1.6, state.reconnectAttempts), 8000);
    state.reconnectAttempts++;
    setTimeout(connect, delay);
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(obj));
    } else {
      toast('连接未就绪，请稍候', true);
    }
  }

  // ================= 消息处理 =================
  function handleMessage(msg) {
    switch (msg.type) {
      case 'hello':
        state.playerId = msg.playerId;
        state.name = msg.name;
        // secret 由服务端在首次加入 / 重连成功两条路径的 hello 中下发；仅在有值时写入，
        // 避免任何未携带 secret 的 hello 把本地凭据清空
        if (msg.secret) {
          state.secret = msg.secret;
          store.setItem('kd.secret', msg.secret);
        }
        store.setItem('kd.playerId', state.playerId);
        store.setItem('kd.name', state.name);
        $('#nick-input').value = state.name;
        break;
      case 'lobby_state':
        state.lobby = msg;
        if (!state.room) renderLobby();
        break;
      case 'room_state':
        if (msg.room === null) {
          state.room = null;
          state.game = null;
          state.prompt = null;
          state.selectedIndex = null;
          state._lastTurn = null;
          state._selfHosted = null;
          state._hostedRequestAt = 0;
          hideConnMask();
          resetVoiceBaseline();
          voiceDisable();
          // 回到大厅，重新同步昵称与大厅状态
          renderLobby();
          return;
        }
        syncHostedNoticeFromRoom(msg.room);
        const prevState = state.room && state.room.state;
        state.room = msg.room;
        renderRoomView();
        // 不在确认阶段时清理结算确认区，避免跨局/跨房间残留
        if (!msg.room.settleConfirms) {
          $('#settle-confirm').classList.add('hidden');
          $('#settle-confirm-btn').classList.add('hidden');
          $('#settle-close').classList.remove('hidden');
        }
        // 仅在「从进行中打到 settled 那一刻」弹一次总结算弹窗；新加入/人员变动广播 room_state 不重复弹
        if (state.room.state === 'settled' && prevState === 'playing') {
          showSettleModal();
        }
        break;
      case 'game_state':
        syncHostedNotice(msg.game && msg.game.players && msg.game.players[msg.game.yourSeat]);
        state.game = msg.game;
        state.tingPick = false;
        // 旁观者：固定 0 号座位视角，隐藏手牌与操作（后端下发 yourSeat=-1）
        if (state.room && state.room.isViewer && state.game) {
          state.game.yourSeat = 0;
          state.game.isDrawTurn = false;
        }
        // 手牌选中态：轮次变化 / 自己不可出牌 / 本局结束任一条件满足即清除，避免残留
        if (state.selectedIndex != null) {
          const stillMine = !!msg.game.isDrawTurn && msg.game.turn === msg.game.yourSeat && !msg.game.winners;
          const turnChanged = state._lastTurn != null && state._lastTurn !== msg.game.turn;
          if (!stillMine || turnChanged) state.selectedIndex = null;
        }
        state._lastTurn = msg.game.turn;
        // 重连兜底：若轮到本玩家出牌或本玩家有未决定的碰/杠/胡响应权，
        // 但服务端未（或消息已丢失）下发 action_prompt，则按 game_state 自行补齐，
        // 避免手牌/操作按钮不可点导致整局卡死
        if (msg.game.isDrawTurn) {
          if (!state.prompt || state.prompt.type !== 'draw') {
            state.prompt = { type: 'draw', actions: ['play'], gangOptions: [], canHu: false, canDeclareTing: false };
          }
        } else if (msg.game.pending) {
          const r = msg.game.pending.responders.find((x) => x.seat === msg.game.yourSeat);
          if (r && r.choice === null) {
            if (!state.prompt || state.prompt.type !== 'response') {
              state.prompt = {
                type: 'response',
                actions: ['pass'],
                canHu: r.canHu,
                canGang: r.canGang,
                canPeng: r.canPeng,
                tile: msg.game.pending.tile,
                pendingType: msg.game.pending.type,
                timeoutMs: 20000,
              };
            }
          } else {
            state.prompt = null;
          }
        } else {
          state.prompt = null;
        }
        if (msg.game.logs && state.room) state.room.logs = msg.game.logs;
        // 杠分即时结算只广播 game_state，不广播 room_state；
        // 这里同步 players 的 score/roundScore，保证积分榜与实时牌局一致
        if (msg.game.players && state.room && state.room.players) {
          for (const p of msg.game.players) {
            if (p && state.room.players[p.seat]) {
              state.room.players[p.seat].score = p.score;
              state.room.players[p.seat].roundScore = p.roundScore;
            }
          }
        }
        if (state.room && state.room.state === 'playing') {
          checkSpeakEvents(msg.game);
          renderTable();
          renderSidePanel();
        }
        // 新一局开始（非结算阶段）时关闭结算弹窗
        if (msg.game.stage !== 'over') hideModal('settle-modal');
        break;
      case 'action_prompt':
        state.prompt = msg.prompt;
        state.tingPick = false;
        state.selectedIndex = null;
        renderActions();
        break;
      case 'settlement':
        if (state.room && state.room.state === 'settled') break; // 总结算弹窗已含最后一局摘要
        state.lastSettlementShown = (state.game && state.game.roundNo) || 0;
        showSettlement(msg.result);
        // 处于确认阶段（含重连恢复）：渲染确认状态并确保弹窗可见
        if (msg.confirms) {
          renderSettleConfirm(msg.confirms);
          showModal('settle-modal');
        }
        break;
      case 'settlement_confirm':
        if (state.room && state.room.state === 'settled') break;
        if (msg.confirms) {
          renderSettleConfirm(msg.confirms);
          showModal('settle-modal');
        }
        break;
      case 'draw_notice':
        // 摸牌提示：显示摸到的具体牌（含字牌）。draw_notice 仅发给摸牌者本人，
        // 需据此决策，故延长到 4s（默认 2.6s 一闪而过容易错过）。
        toast('摸到 ' + tileText(msg.tile), false, 4000);
        break;
      case 'room_notice':
        // 房间级广播提示（如房主离线超时，本局结束后解散房间）
        toast(msg.text || '', true);
        break;
      case 'chat':
        // 同步 state.room.chat，避免 game_state 重绘侧栏时用旧快照把聊天记录打回原形
        if (state.room) state.room.chat = msg.chat || [];
        renderChat(state.room && state.room.chat);
        {
          const cm = (msg.chat && msg.chat.length) ? msg.chat[msg.chat.length - 1] : null;
          if (cm) showChatBubble(cm.from, cm.text);
        }
        break;
      case 'emoji':
        // 对局表情互动：收到他人表情后桌面浮动展示
        if (msg.emoji && msg.emoji.emoji) showEmojiFloat(msg.emoji.emoji, msg.emoji.from);
        break;
      case 'error':
        // 服务端结构化错误码：凭据失效（老用户本地无 secret / secret 不匹配）→ 走自愈，不重复弹普通错误
        if (msg.code === 'AUTH_FAILED') { _handleAuthFailed(); break; }
        // 登录类错误：账号相关错误码单独提示，文案已由服务端给出
        if (msg.code === 'AUTH_INVALID' || msg.code === 'AUTH_EXISTS' || msg.code === 'AUTH_WEAK') {
          // token 失效（多为服务端重启后内存会话清空）：清掉本地 token，回退游客，避免每次重连都弹错
          if (msg.code === 'AUTH_INVALID' && state.token) {
            state.token = '';
            store.removeItem('kd.token');
            renderAuthBar();
          }
          showAuthError(msg.message || '操作失败');
          break;
        }
        toast(msg.message || '操作失败', true);
        break;
      case 'registered':
      case 'logged_in':
        state.token = msg.token;
        state.username = msg.user.username;
        state.displayName = msg.user.displayName;
        state.name = msg.user.displayName;
        store.setItem('kd.token', msg.token);
        store.setItem('kd.username', msg.user.username);
        store.setItem('kd.displayName', msg.user.displayName);
        store.setItem('kd.name', msg.user.displayName);
        hideModal('auth-modal');
        renderAuthBar();
        syncNickInput();
        toast('已登录：' + msg.user.displayName);
        break;
      case 'logged_out':
        clearAuthIdentity(false);
        renderAuthBar();
        syncNickInput();
        break;
      case 'change_name_result':
        if (msg.ok && msg.user) {
          state.displayName = msg.user.displayName;
          state.name = msg.user.displayName;
          store.setItem('kd.displayName', msg.user.displayName);
          store.setItem('kd.name', msg.user.displayName);
          renderAuthBar();
          syncNickInput();
          hideModal('account-modal');
          toast('昵称已更新');
        } else {
          showAccountError(msg.message || '修改昵称失败');
        }
        break;
      case 'change_password_result':
        if (msg.ok) {
          hideModal('account-modal');
          toast('密码已修改');
        } else {
          showAccountError(msg.message || '修改密码失败');
        }
        break;
      case 'delete_account_result':
        if (msg.ok) {
          // 回到游客态：清空登录身份与昵称（本地仍保留大厅玩家身份 playerId/secret）
          clearAuthIdentity(true);
          hideModal('account-modal');
          renderAuthBar();
          syncNickInput();
          const nick = $('#nick-input');
          if (nick) nick.value = '';
          toast('账号已注销');
        } else {
          showAccountError(msg.message || '注销账号失败');
        }
        break;
      case 'history':
        renderHistory(msg.records || [], !!msg.guest);
        break;
      case 'stats':
        renderStatsSummary(msg.guest ? null : (msg.stats || null));
        break;
      case 'leaderboard':
        renderLeaderboard(msg.list || []);
        break;
      case 'friend_list':
        renderFriends(msg.guest ? null : (msg.friends || []), msg.guest ? null : (msg.requests || []));
        break;
      case 'friend_result':
        if (msg.ok) toast(msg.autoAccepted ? '已互为好友' : (msg.accepted ? '已添加好友' : '好友请求已发送'));
        else if (msg.message) toast(msg.message, true);
        if (msg.ok) send({ type: 'friend_list', token: state.token });
        break;
      case 'friend_update':
        // 好友关系变更推送：若好友面板开着则刷新
        if (!$('#friends-modal').classList.contains('hidden')) send({ type: 'friend_list', token: state.token });
        break;
      case 'online_list':
        renderInviteList(msg.friends || [], msg.lobby || []);
        break;
      case 'invite_received':
        showInviteReceive(msg);
        break;
      case 'invite_result':
        if (msg.ok && msg.name) toast(`已邀请 ${msg.name}`);
        else if (msg.declined) { /* 对方拒绝，静默 */ }
        break;
      case 'voice_signal':
        handleVoiceSignal(msg);
        break;
      default:
        break;
    }
  }

  // 凭据失效自愈：收到 AUTH_FAILED 时清除本地身份（localStorage + state），回到大厅重新登录。
  // 不清身份会带着旧 playerId 在 ws.onopen 里无限重连，用户卡在"正在重连"遮罩里出不来。
  // 清理后 onopen 不再发 reconnect（state.playerId 为空），重连风暴自然停止。
  function _handleAuthFailed() {
    state.playerId = '';
    state.secret = '';
    state.room = null;
    state.game = null;
    state.prompt = null;
    state.selectedIndex = null;
    state._lastTurn = null;
    state._selfHosted = null;
    state._hostedRequestAt = 0;
    state.reconnectAttempts = 0;
    store.removeItem('kd.playerId');
    store.removeItem('kd.secret');
    hideConnMask();
    resetVoiceBaseline();
    voiceDisable();
    renderLobby(); // 内部会切到 lobby-view
    toast('登录状态已失效，请重新进入大厅', true);
  }

  // ================= 实时语音对讲（WebRTC mesh） =================
  let voiceEnabled = false; // 语音开关状态
  let voiceLocalStream = null; // 本地麦克风音轨
  const voicePcs = new Map(); // targetId -> RTCPeerConnection
  const voiceAudioEls = new Map(); // targetId -> <audio>
  const speakingSeats = new Set(); // 正在说话的座位号

  // 房间内其他真人玩家（排除自己与 AI）
  function roomHumanPeers() {
    const out = [];
    if (!state.room || !state.room.players) return out;
    for (const pl of state.room.players) {
      if (pl && pl.id !== state.playerId && !pl.isAI && pl.connected) out.push(pl);
    }
    return out;
  }

  function seatOfPlayerId(pid) {
    if (!state.room || !state.room.players) return null;
    for (let s = 0; s < state.room.players.length; s++) {
      const pl = state.room.players[s];
      if (pl && pl.id === pid) return s;
    }
    return null;
  }

  // 开启语音：校验安全上下文 -> 取麦克风 -> 对每个真人对手建 pc/offer
  async function voiceEnable() {
    if (voiceEnabled) return;
    if (!window.isSecureContext) {
      const host = location.hostname || 'IP';
      toast('语音对讲需通过 https://' + host + ':3443 访问', true);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('当前浏览器不支持麦克风，请使用 Chrome/Safari 等现代浏览器', true);
      return;
    }
    try {
      voiceLocalStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      toast('无法获取麦克风权限，请检查浏览器授权', true);
      return;
    }
    voiceEnabled = true;
    updateVoiceBtn();
    for (const peer of roomHumanPeers()) {
      await voiceCreatePeer(peer);
    }
  }

  async function voiceCreatePeer(peer) {
    if (!voiceEnabled || !voiceLocalStream || voicePcs.has(peer.id)) return;
    const pc = new RTCPeerConnection();
    voicePcs.set(peer.id, pc);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        send({ type: 'voice_signal', target: peer.id, sig: { kind: 'ice', candidate: ev.candidate } });
      }
    };
    pc.ontrack = (ev) => voiceOnTrack(peer.id, ev);
    voiceLocalStream.getTracks().forEach((t) => pc.addTrack(t, voiceLocalStream));
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'voice_signal', target: peer.id, sig: { kind: 'offer', sdp: pc.localDescription } });
    } catch (e) {
      console.error('[voice] createOffer error:', e);
      voiceRemovePeer(peer.id);
    }
  }

  function voiceOnTrack(fromId, ev) {
    const seat = seatOfPlayerId(fromId);
    if (seat == null) return;
    let audio = voiceAudioEls.get(fromId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      document.body.appendChild(audio);
      voiceAudioEls.set(fromId, audio);
      audio.addEventListener('play', () => { speakingSeats.add(seat); syncSpeaking(); });
      audio.addEventListener('pause', () => { speakingSeats.delete(seat); syncSpeaking(); });
      audio.addEventListener('ended', () => { speakingSeats.delete(seat); syncSpeaking(); });
    }
    audio.srcObject = ev.streams[0];
    audio.play().catch(() => {});
  }

  function voiceRemovePeer(targetId) {
    const pc = voicePcs.get(targetId);
    if (pc) {
      try { pc.close(); } catch (e) { /* ignore */ }
      voicePcs.delete(targetId);
    }
    const audio = voiceAudioEls.get(targetId);
    if (audio) {
      try { audio.pause(); audio.srcObject = null; audio.remove(); } catch (e) { /* ignore */ }
      voiceAudioEls.delete(targetId);
    }
    const seat = seatOfPlayerId(targetId);
    if (seat != null) { speakingSeats.delete(seat); syncSpeaking(); }
  }

  // 收到信令：offer -> 建 pc + answer；answer -> setRemoteDescription；ice -> addIceCandidate
  async function handleVoiceSignal(msg) {
    const fromId = msg.from;
    const sig = msg.sig || {};
    if (!fromId || !sig || typeof sig !== 'object') return;
    if (sig.kind === 'offer') {
      if (!voiceEnabled || !voiceLocalStream) return; // 未开启语音则忽略对端邀请
      let pc = voicePcs.get(fromId);
      if (!pc) {
        pc = new RTCPeerConnection();
        voicePcs.set(fromId, pc);
        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            send({ type: 'voice_signal', target: fromId, sig: { kind: 'ice', candidate: ev.candidate } });
          }
        };
        pc.ontrack = (ev) => voiceOnTrack(fromId, ev);
        voiceLocalStream.getTracks().forEach((t) => pc.addTrack(t, voiceLocalStream));
      }
      try {
        await pc.setRemoteDescription(sig.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'voice_signal', target: fromId, sig: { kind: 'answer', sdp: pc.localDescription } });
      } catch (e) {
        console.error('[voice] answer error:', e);
        voiceRemovePeer(fromId);
      }
    } else if (sig.kind === 'answer') {
      const pc = voicePcs.get(fromId);
      if (pc && sig.sdp) {
        try { await pc.setRemoteDescription(sig.sdp); } catch (e) { console.error('[voice] setRemote error:', e); }
      }
    } else if (sig.kind === 'ice') {
      const pc = voicePcs.get(fromId);
      if (pc && sig.candidate) {
        try { await pc.addIceCandidate(sig.candidate); } catch (e) { /* 竞态忽略 */ }
      }
    }
  }

  // 关闭语音：关闭所有 pc、停止本地音轨、清空说话指示
  function voiceDisable() {
    if (!voiceEnabled && voicePcs.size === 0 && !voiceLocalStream) return;
    voiceEnabled = false;
    for (const id of [...voicePcs.keys()]) voiceRemovePeer(id);
    if (voiceLocalStream) {
      voiceLocalStream.getTracks().forEach((t) => t.stop());
      voiceLocalStream = null;
    }
    speakingSeats.clear();
    syncSpeaking();
    updateVoiceBtn();
  }

  function updateVoiceBtn() {
    const btn = $('#btn-voice');
    if (!btn) return;
    btn.classList.toggle('voice-on', voiceEnabled);
    btn.textContent = voiceEnabled ? '语音开' : '语音';
  }

  // renderTable 重绘后恢复"正在说话"指示
  function syncSpeaking() {
    const seats = document.querySelectorAll('#table-wrap .seat[data-seat]');
    seats.forEach((el) => {
      const card = el.querySelector('.player-card');
      if (!card) return;
      const seat = Number(el.getAttribute('data-seat'));
      card.classList.toggle('pc-speaking', speakingSeats.has(seat));
    });
  }

  // ================= 视图切换 =================
  function showView(name) {
    $('#lobby-view').classList.toggle('hidden', name !== 'lobby');
    $('#room-view').classList.toggle('hidden', name !== 'room');
  }

  // ================= 大厅 =================
  function renderLobby() {
    showView('lobby');
    applyVariantChrome('lobby'); // 大厅固定展示多玩法文案，不随玩法回退为扣点点
    const list = $('#room-list');
    const rooms = (state.lobby && state.lobby.rooms) || [];
    if (!rooms.length) {
      list.innerHTML = '<div class="empty">暂无房间，点击「创建房间」开一桌～</div>';
      return;
    }
    list.innerHTML = rooms.map((r) => {
      const hz = isHongZhongOf(r);
      const tj = !!(r.settings && r.settings.variant === 'tiejin');
      const playing = r.state === 'playing';
      const joinable = r.state === 'waiting' && r.playerCount < 4;
      return `
      <div class="room-card">
        <div class="rc-id">房间 ${r.id}</div>
        <div class="rc-meta">
          <span class="badge ${r.state}">${roomStateText(r.state)}</span>
          <span class="badge public">公共局</span>
          <span>${r.playerCount}/4 人</span>
          <span>创建者 ${esc(r.ownerName || '未知')}</span>
          <span>${hz ? '112张·红中麻将' : tj ? '136张·贴金麻将' : '136张·带风带箭'}</span>
          <span>${r.settings.aiFill ? 'AI补位' : '无AI'}</span>
          <span>${hz ? '癞子红中' : tj ? '金牌万能' : '报听必开'}</span>
          <span>${roundsText(r.settings.totalRounds)}</span>
        </div>
        ${playing
          ? `<button class="btn small" data-spectate="${r.id}">观战</button>`
          : `<button class="btn small primary" data-join="${r.id}" ${joinable ? '' : 'disabled'}>加入</button>`}
      </div>`;
    }).join('');
  }

  function roomStateText(s) {
    return s === 'playing' ? '游戏中' : s === 'settled' ? '已结算' : '等待中';
  }
  function roundsText(v) { return v === 0 ? '不限局数' : v + ' 局'; }
  // 玩法识别：settings.variant（优先）或 game.variant 兜底
  function isHongZhongOf(s) { return !!(s && ((s.settings && s.settings.variant === 'hongzhong') || s.variant === 'hongzhong')); }
  function variantLabel(settings) { return settings && settings.variant === 'hongzhong' ? '红中麻将' : settings && settings.variant === 'tiejin' ? '贴金麻将' : '扣点点'; }
  // 页面标题/Logo/Slogan 随玩法切换：koudian 默认，tiejin/hongzhong 各自文案
  function variantChrome(variant) {
    if (variant === 'lobby') return { title: '运城麻将 · 扣点点 / 红中 / 贴金', logo: '🀄 运城麻将', slogan: '三种玩法，一局开打：扣点点 · 红中 · 贴金' };
    if (variant === 'tiejin') return { title: '运城贴金麻将', logo: '🀄 运城贴金麻将', slogan: '贴金 · 金牌万能 · 亮金锁金' };
    if (variant === 'hongzhong') return { title: '红中麻将', logo: '🀄 红中麻将', slogan: '红中癞子 · 自摸抢杠 · 扎码翻倍' };
    return { title: '运城麻将 · 扣点点', logo: '🀄 运城麻将 · 扣点点', slogan: '扣点点 · 只碰不吃 · 胡牌自摸' };
  }
  function applyVariantChrome(variant) {
    const c = variantChrome(variant);
    document.title = c.title;
    const logo = $('.logo');
    const slogan = $('.slogan');
    if (logo) logo.textContent = c.logo;
    if (slogan) slogan.textContent = c.slogan;
  }

  // ================= 房间视图 =================
  function renderRoomView() {
    showView('room');
    fitViewportHeight();
    const room = state.room;
    applyVariantChrome(room.settings && room.settings.variant || 'koudian');
    $('#room-id-text').textContent = room.id;
    const roomTypeName = (room.roomType || (room.settings && room.settings.roomType)) === 'public' ? '公共局' : '好友局';
    $('#room-state-text').textContent =
      `${roomTypeName} · ${variantLabel(room.settings)} · ${roomStateText(room.state)}` +
      (room.roundNo ? ` · 第 ${room.roundNo} 局` : '') +
      (room.settleConfirms && !room.settleConfirms.every(Boolean) ? ' · 等待确认' : '') +
      ` · ${roundsText(room.settings.totalRounds)}`;
    renderHeaderBtns();
    if (room.state === 'playing' && state.game) {
      renderTable();
    } else if (room.state === 'settled') {
      renderSettledRoom();
    } else {
      renderWaitingRoom();
    }
    renderSidePanel();
  }

  function renderHeaderBtns() {
    const room = state.room;
    const isOwner = room.ownerId === state.playerId;
    const full = room.players.filter(Boolean).length === 4;
    const box = $('#header-btns');
    // 旁观者：仅显示「退出观战」+ 声音控制，无任何房间操作
    if (room.isViewer) {
      box.innerHTML = `<span class="viewer-badge">👁 观战中</span>
        <button class="btn small" id="btn-leave">退出观战</button>${roomAudioBtnsHtml()}`;
      const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
      on('btn-leave', () => send({ type: 'leave_room' }));
      bindRoomAudioBtns();
      return;
    }
    let html = '';
    if (isOwner && (room.state === 'waiting' || room.state === 'settled')) {
      if (!full) html += `<button class="btn small" id="btn-add-ai">＋ AI 补位</button>`;
      if (!full) html += `<button class="btn small" id="btn-invite">邀请</button>`;
      html += `<button class="btn small primary" id="btn-start">${room.state === 'settled' ? '再来一轮' : '开始游戏'}</button>`;
    }
    if (isOwner) {
      html += `<button class="btn small" id="btn-dissolve">解散房间</button>`;
    } else {
      html += `<button class="btn small" id="btn-leave">退出房间</button>`;
    }
    box.innerHTML = html + roomAudioBtnsHtml();
    const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
    on('btn-add-ai', () => send({ type: 'add_ai' }));
    on('btn-start', () => send({ type: 'start_game' }));
    on('btn-dissolve', () => {
      if (confirm('确定解散房间吗？所有玩家都会被移出。')) send({ type: 'dissolve' });
    });
    on('btn-leave', () => send({ type: 'leave_room' }));
    on('btn-invite', () => openInvite());
    bindRoomAudioBtns();
  }

  // 房间头部声音按钮（语音对讲 / 音效）：房主、普通玩家、旁观者三处共用
  function roomAudioBtnsHtml() {
    return `<button class="btn small${voiceEnabled ? ' voice-on' : ''}" id="btn-voice">${voiceEnabled ? '语音开' : '语音'}</button>` +
      `<button class="btn small${sfxOn ? ' sfx-on' : ''}" id="btn-sfx">${sfxOn ? '音效开' : '音效'}</button>`;
  }

  function bindRoomAudioBtns() {
    const voice = $('#btn-voice');
    if (voice) voice.onclick = () => { if (voiceEnabled) voiceDisable(); else voiceEnable(); };
    const sfx = $('#btn-sfx');
    if (sfx) sfx.onclick = () => setSfxOn(!sfxOn);
  }

  function renderWaitingRoom() {
    const room = state.room;
    const wrap = $('#table-wrap');
    const isOwner = room.ownerId === state.playerId;
    const full = room.players.filter(Boolean).length === 4;
    let html = '<div class="waiting-grid">';
    for (let s = 0; s < 4; s++) {
      const pl = room.players[s];
      if (pl) {
        html += `<div class="wait-card">
          <div class="nm">${esc(pl.name)}${pl.id === state.playerId ? '（我）' : ''}</div>
          <div>${pl.isAI ? '🤖 AI' : '真人'}${pl.id === room.ownerId ? ' · 房主' : ''}</div>`;
        if (isOwner && pl.id !== state.playerId) {
          html += `<button class="btn small kick-btn" data-kick="${pl.id}">踢出</button>`;
        }
        html += '</div>';
      } else {
        html += `<div class="wait-card empty-card"><div class="nm">空位</div><div>等待加入…</div></div>`;
      }
    }
    html += '</div>';
    html += `<div class="wait-hint">${
      isOwner
        ? (full ? '人员已齐，点击「开始游戏」开局。' : '点击「开始游戏」开局；开启 AI 补位时不足 4 人将自动补位，也可点「＋ AI 补位」手动加入机器人。')
        : '等待房主开始游戏…'
    }</div>`;
    wrap.innerHTML = html;
    if (isOwner) {
      wrap.querySelectorAll('.kick-btn').forEach((b) => {
        b.onclick = () => send({ type: 'kick_player', targetId: b.dataset.kick });
      });
    }
  }

  // 按积分降序的总排行行：房间内结算区与总结算弹窗共用（行间距由 .settle-final 上下文控制）
  function settleRankRowsHtml(players) {
    return [...players].filter(Boolean).sort((a, b) => b.score - a.score).map((p, i) => `
      <div class="settle-player">
        <span>${i + 1}.</span>
        <span class="nm">${esc(p.name)}${p.id === state.playerId ? '（我）' : ''}</span>
        <span class="delta ${p.score >= 0 ? 'up' : 'down'}">${p.score >= 0 ? '+' : ''}${p.score}</span>
      </div>`).join('');
  }

  function renderSettledRoom() {
    const room = state.room;
    const wrap = $('#table-wrap');
    const isOwner = room.ownerId === state.playerId;
    const full = room.players.filter(Boolean).length === 4;
    wrap.innerHTML = `
      <div class="settle-final">
        <div class="wait-hint settle-final-title">🏆 全部 ${room.settings.totalRounds} 局结束</div>
        ${settleRankRowsHtml(room.players)}
        <div class="wait-hint">本局已结束，可自由换人后再开新一轮：</div>
        <div class="settle-actions">${settleActionBtns(room, isOwner, full)}</div>
      </div>`;
    bindSettleActions(room, isOwner);
  }

  // 结算界面人员变动按钮：房主可补 AI / 踢人，所有非旁观者可退出
  function settleActionBtns(room, isOwner, full) {
    const btns = [];
    if (isOwner) {
      if (!full) btns.push(`<button class="btn small" id="btn-settle-add-ai">＋ AI 补位</button>`);
      for (const pl of room.players) {
        if (pl && pl.id !== state.playerId) {
          btns.push(`<button class="btn small kick-btn" data-kick="${pl.id}">踢出 ${esc(pl.name)}</button>`);
        }
      }
      btns.push(`<button class="btn small primary" id="btn-settle-restart">再来一轮</button>`);
    }
    btns.push(`<button class="btn small" id="btn-settle-leave">退出房间</button>`);
    return btns.join('');
  }

  function bindSettleActions(room, isOwner) {
    const wrap = $('#table-wrap');
    if (!wrap) return;
    const addAi = wrap.querySelector('#btn-settle-add-ai');
    if (addAi) addAi.onclick = () => send({ type: 'add_ai' });
    wrap.querySelectorAll('.kick-btn').forEach((b) => {
      b.onclick = () => send({ type: 'kick_player', targetId: b.dataset.kick });
    });
    const restart = wrap.querySelector('#btn-settle-restart');
    if (restart) restart.onclick = () => send({ type: 'start_game' });
    const leave = wrap.querySelector('#btn-settle-leave');
    if (leave) leave.onclick = () => send({ type: 'leave_room' });
  }

  // ================= 牌桌 =================
  function renderTable() {
    const game = state.game;
    if (!game) return;
    const wrap = $('#table-wrap');
    const d = (seat) => (seat - game.yourSeat + 4) % 4;
    const POS = ['bottom', 'right', 'top', 'left'];
    let html = '<div class="table">';
    const tjGold = game.goldMother && game.goldTile
      ? `<div class="gold-mother">金母 <b>${tileHtml(game.goldMother, 'small', 0, false, false, undefined, false, game.goldMother)}</b> · 金牌 <b>${tileHtml(game.goldTile, 'small', 0, false, false, undefined, false, game.goldTile)}</b></div>`
      : '';
    // 包胡阶段提示：牌墙剩最后 4 张，此时点炮由放炮者独赔三家
    const baoHuTip = game.baoHuZone
      ? `<div class="bao-hu-tip">⚠️ 包胡阶段（牌墙剩 ${game.wallRemain} 张）：此时点炮由放炮者独赔三家，谨慎出牌</div>`
      : '';
    const turnSt = turnTextState();
    html += `<div class="table-center">
      ${tjGold}
      ${baoHuTip}
      <div class="wall-count">牌墙 <b>${game.wallCount}</b></div>
      <div class="turn-info${turnSt.mine ? ' my-turn' : ''}">${turnSt.text}</div>
      <div class="action-bar" id="action-bar"></div>
    </div>`;
    for (let seat = 0; seat < 4; seat++) {
      const p = game.players[seat];
      if (!p) continue;
      const pos = POS[d(seat)];
      html += `<div class="seat seat-${pos}" data-seat="${seat}">`;
      // 旁观者：无自己的手牌，所有座位统一按明牌（对手）视角渲染
      const isViewer = state.room && state.room.isViewer;
      html += (pos === 'bottom' && !isViewer) ? renderPlayerCard(p, seat, { self: true }) : renderPlayerCard(p, seat);
      html += '</div>';
    }
    html += '</div>';
    // 保留已弹出的聊天气泡层（renderTable 整桌重绘，气泡需跨重绘存活）
    const layers = [...wrap.querySelectorAll('.bubble-layer')];
    wrap.innerHTML = html;
    for (const l of layers) wrap.appendChild(l);
    bindTileClicks();
    bindCancelHosted();
    applyWeakHighlight();
    renderActions();
    syncBubbleLayers();
    syncSpeaking();
  }

  /**
   * 托管按钮点击：事件委托到静态容器 #table-wrap，监听 pointerdown 而非 click。
   * 原因：renderTable() 每次 game_state 都会整桌 innerHTML 重建（AI 连续行动时每 ~80ms 一次），
   *      桌面端鼠标 click 依赖 mousedown 与 mouseup 在同一节点——按下时按钮还在旧节点、
   *      抬起时已被重建替换成新节点，click 完全不合成，委托收不到；移动端 touch 则
   *      在 touchend 时向共同祖先合成 click，故旧版委托只对移动端有效。
   *      改用 pointerdown：按下瞬间立即响应，不依赖合成，桌面/移动均稳定命中。
   */
  function bindCancelHosted() {
    const wrap = $('#table-wrap');
    if (!wrap || wrap.dataset.hostedBound === '1') return;
    wrap.dataset.hostedBound = '1';
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 仅左键/触摸/笔
      const t = e.target.closest('.btn-cancel-hosted, .btn-hosted');
      if (!t) return;
      e.preventDefault();
      const canceling = t.classList.contains('btn-cancel-hosted');
      state._hostedRequestAt = canceling ? 0 : Date.now();
      send({ type: canceling ? 'cancel_hosted' : 'set_hosted' });
    });
  }

  // 托管状态由 room_state / game_state 交替下发；只在 false → true 时提示一次原因
  function syncHostedNotice(me) {
    if (!me) return;
    const hosted = !!me.hosted;
    if (state._selfHosted === false && hosted) {
      const manuallyRequested = state._hostedRequestAt && Date.now() - state._hostedRequestAt < 5000;
      toast(manuallyRequested ? '已开启托管，AI 将代你操作' : '超时未操作，已由 AI 代打', false);
    }
    state._selfHosted = hosted;
    if (!hosted) state._hostedRequestAt = 0;
  }

  // room_state 往往比超时后的 AI 动作更早到达，同步到当前牌局可立即显示托管状态
  function syncHostedNoticeFromRoom(room) {
    if (!room || !room.players) return;
    let seat = state.game ? state.game.yourSeat : -1;
    if (seat == null || seat < 0 || !room.players[seat]) {
      seat = room.players.findIndex((pl) => pl && pl.id === state.playerId);
    }
    const me = seat >= 0 ? room.players[seat] : null;
    if (!me) return;
    syncHostedNotice(me);
    if (state.game && state.game.players && state.game.players[seat]) {
      state.game.players[seat].hosted = !!me.hosted;
    }
  }

  // 计算中央提示文案；第二个返回值标记是否「轮到本人」，供调用方加醒目样式
  function turnTextState() {
    const game = state.game;
    if (!game) return { text: '', mine: false };
    if (game.stage === 'response' && game.pending) {
      const who = game.players[game.pending.discarder];
      return { text: `${who ? who.name : '?'} 打出，等待响应…`, mine: false };
    }
    if (game.winners) {
      return { text: game.winners.type === 'draw' ? '流局' : '本局结束', mine: false };
    }
    const cur = game.players[game.turn];
    if (!cur) return { text: '', mine: false };
    const you = game.yourSeat === game.turn;
    if (you) return { text: cur.ting ? '你已报听，摸牌即打（只能杠，不能碰/换牌）' : '轮到你出牌', mine: true };
    return { text: cur.ting ? `等待 ${cur.name} 摸打（报听）…` : `等待 ${cur.name} 出牌…`, mine: false };
  }

  function hostedActionText(seat) {
    const game = state.game;
    if (!game || game.winners) return 'AI 已完成本局代打';
    if (game.stage === 'response' && game.pending && game.pending.responders) {
      const responder = game.pending.responders.find((r) => r.seat === seat);
      if (responder && responder.choice === null) return 'AI 正在判断碰、杠或胡';
    }
    if (game.turn === seat) return 'AI 正在代你选择出牌';
    return 'AI 正在等待其他玩家操作';
  }

  /**
   * 玩家卡片公共骨架：座位状态标记（庄/AI/离线/托管/报听/锁金）+ 亮金区 + 明牌区 + 弃牌区。
   * 自己与对手的差异只有：手牌区、托管按钮/托管状态、离线标记、昵称后缀，
   * 均由 opts.self 决定，避免两份模板各自演化后出现显示不一致。
   */
  function renderPlayerCard(p, seat, opts = {}) {
    const game = state.game;
    const self = !!opts.self;
    const isTurn = game.turn === seat && !game.winners;
    const goldTile = game.goldTile || null;
    const tj = game.goldTile != null;
    const shangjin = (tj && game.shangjinTiles && game.shangjinTiles[seat]) || null;
    const lockedBadge = tj && game.locked && game.locked[seat] ? '<span class="pc-lock">锁金</span>' : '';
    const discards = (p.discards || []).map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, goldTile)).join('');
    return `<div class="player-card ${isTurn ? 'active-turn' : ''}">
      <div class="pc-top">
        ${p.isDealer ? '<span class="pc-dealer">庄</span>' : ''}
        ${p.isAI ? '<span class="pc-ai">AI</span>' : ''}
        ${!self && !p.connected ? '<span class="pc-off">离线</span>' : ''}
        ${p.hosted ? `<span class="pc-host">${self ? 'AI托管中' : '托管'}</span>` : ''}
        ${p.ting ? '<span class="pc-ting">报听</span>' : ''}
        ${!self && p.handCount != null ? `<span class="pc-hand">手牌${p.handCount}</span>` : ''}
        ${lockedBadge}
        <span class="pc-name">${esc(p.name)}${self ? '（我）' : ''}</span>
        <span class="pc-score">${p.score}</span>
        ${self && !p.hosted ? '<button class="btn-hosted">托管</button>' : ''}
      </div>
      ${self && p.hosted ? `<div class="hosted-status" aria-live="polite"><span>${hostedActionText(seat)}</span><button class="btn-cancel-hosted">取消托管</button></div>` : ''}
      ${shangjin ? `<div class="shangjin-area" title="亮金区（${shangjin.length}/3）">${shangjin.map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, goldTile)).join('')}</div>` : ''}
      <div class="melds">${renderMelds(p.melds, self, goldTile)}</div>
      ${self ? `<div class="hand">${state.tingPick ? '<div class="ting-pick-hint">请选择要扣的牌报听（需听牌中含 ≥6 点牌，灰色不可选）</div>' : ''}<div class="hand-tiles${state.tingPick ? ' ting-pick' : ''}">${renderSelfHand(p)}</div></div>` : ''}
      <div class="discard-area">${discards}</div>
    </div>`;
  }

  // 单张手牌 HTML：听口/新摸牌/选中态判定，供全量重绘与选中重绘共用
  function selfTileHtml(p, t, i) {
    const game = state.game;
    // tingHints[t] 未定义 = 打出后听口不含 ≥6 点牌（不可报听）；为 0 = 绝听但可报听（仅角标显示剩余 0 张）
    const tH = game.tingHints ? game.tingHints[t] : undefined;
    const ting = tH === undefined ? 0 : tH;
    // 报听选牌阶段：仅进入提示列表（含 ≥6 点听口）的选项可点击，未进入置灰；绝听（tH===0）仍可报听
    // 首金必须亮出：服务端下发 canPlay:false，此时亮金是唯一操作，手牌置为不可点
    // （前端只是视觉禁用，真正拦截以服务端 _playTile 为准）
    const pr = state.prompt;
    const forcedNoPlay = !!(pr && pr.type === 'draw' && pr.canPlay === false);
    const canDiscard = state.tingPick ? tH !== undefined : !forcedNoPlay;
    // 新摸牌标志：仅加低亮边框（样式见 .tile.new-tile），置右 + 空格占位展示见 renderSelfHand；
    // 服务端出牌后清除 newTile，自动回原位
    const isNew = game.newTile === t && p.hand.indexOf(t) === i;
    // 选中态：普通出牌受「单击直接出牌」开关影响（开启时不选中）；报听阶段始终走选中交互，不受开关影响
    const selected = (state.tingPick || !isTapToDiscard()) && state.selectedIndex === i;
    return tileHtml(t, '', ting, canDiscard, isNew, i, selected, game.goldTile);
  }

  // 手牌渲染：新摸牌（game.newTile）不高亮，单独放到最右并在其前留一个空格占位；
  // newTile 由服务端在出牌/碰/杠/报听后清除，届时自动回到原排序位置
  function renderSelfHand(p) {
    const game = state.game;
    const hand = p.hand || [];
    const nt = game.newTile;
    if (nt) {
      const ntIdx = hand.indexOf(nt);
      if (ntIdx >= 0) {
        const html = [];
        for (let i = 0; i < hand.length; i++) {
          if (i === ntIdx) continue;
          html.push(selfTileHtml(p, hand[i], i));
        }
        html.push('<span class="tile hand-gap"></span>');
        html.push(selfTileHtml(p, hand[ntIdx], ntIdx));
        return html.join('');
      }
    }
    return hand.map((t, i) => selfTileHtml(p, t, i)).join('');
  }

  const TILE_BACK = '<span class="tile tiny back"></span>';

  // 明牌区：暗杠在自家人视角（isMine）与结算公开时亮 1 张真牌 + 3 张牌背（用于查杠），
  // 他人视角一律 4 张牌背。结算公开复用 isMine=true，避免维护第二份模板。
  function renderMelds(melds, isMine = false, goldTile) {
    if (!melds || !melds.length) return '';
    return melds.map((m) => {
      const tiles = m.type === 'angang'
        ? (isMine
          ? tileHtml(m.tiles[0], 'tiny', 0, false, false, undefined, false, goldTile) + TILE_BACK + TILE_BACK + TILE_BACK
          : TILE_BACK + TILE_BACK + TILE_BACK + TILE_BACK)
        : m.tiles.map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, goldTile)).join('');
      return `<div class="meld">${tiles}</div>`;
    }).join('');
  }

  const HONOR_NAMES = { e: '東', s: '南', x: '西', n: '北', z: '中', f: '發', p: '白', z0: '中' };

  function tileHtml(tile, size, ting, discardable, isNew, idx, selected, goldTile) {
    if (!tile) return '';
    if (tile === 'back') return `<span class="tile ${size} back"></span>`;
    const suit = tile[0];
    const isHonor = HONOR_NAMES[tile];
    const isGold = goldTile != null && tile === goldTile;
    const cls = `tile ${size} ${suitClass(suit)}` +
      (isHonor ? ' honor' : '') +
      (isGold ? ' gold-tile' : '') +
      (discardable ? ' discardable' : '') +
      (ting ? ' ting-mark' : '') +
      (isNew ? ' new-tile' : '') +
      (selected ? ' selected' : '');
    const idxAttr = idx != null ? ` data-idx="${idx}"` : '';
    const attr = ting ? ` data-ting="${ting}张"` : '';
    const inner = isHonor ? honorFace(tile) : suitFace(tile);
    return `<span class="${cls}" data-tile="${tile}"${idxAttr}${attr}>${inner}</span>`;
  }

  // ===== 传统麻将图案牌面（纯 CSS/HTML，无图片资源）=====
  // 筒子 1-9 传统圆点布局（百分比坐标：左%, 顶%）
  const PIP_LAYOUT = {
    '1': [[50, 50]],
    '2': [[30, 30], [70, 70]],
    '3': [[30, 30], [50, 50], [70, 70]],
    '4': [[30, 30], [70, 30], [30, 70], [70, 70]],
    '5': [[30, 30], [70, 30], [50, 50], [30, 70], [70, 70]],
    '6': [[30, 25], [70, 25], [30, 58], [70, 58], [30, 82], [70, 82]],
    '7': [[30, 22], [50, 32], [70, 42], [30, 64], [70, 64], [30, 86], [70, 86]],
    '8': [[28, 12], [28, 37], [28, 63], [28, 88], [72, 12], [72, 37], [72, 63], [72, 88]],
    '9': [[17, 17], [50, 17], [83, 17], [17, 50], [50, 50], [83, 50], [17, 83], [50, 83], [83, 83]]
  };
  // 条子 2-9 竖条布局（与筒子传统排列对应）
  const BAR_LAYOUT = {
    '2': [[50, 30], [50, 70]],
    '3': [[50, 25], [30, 75], [70, 75]],
    '4': [[30, 25], [70, 25], [30, 75], [70, 75]],
    '5': [[30, 20], [70, 20], [50, 50], [30, 80], [70, 80]],
    '6': [[30, 30], [50, 30], [70, 30], [30, 70], [50, 70], [70, 70]],
    '7': [[30, 22], [50, 32], [70, 42], [30, 64], [70, 64], [30, 86], [70, 86]],
    '8': [[20, 20], [40, 20], [60, 20], [80, 20], [20, 80], [40, 80], [60, 80], [80, 80]],
    '9': [[17, 17], [50, 17], [83, 17], [17, 50], [50, 50], [83, 50], [17, 83], [50, 83], [83, 83]]
  };

  function suitFace(tile) {
    const suit = tile[0];
    const num = tile.slice(1);
    if (suit === 'w') {
      return `<span class="wan-face"><b>${num}</b><i>萬</i></span>`;
    }
    if (suit === 't') {
      if (num === '1') {
        return `<span class="tiao-mark"><svg viewBox="0 0 42 60"><circle cx="21" cy="18" r="7" stroke="#007830" stroke-width="2" fill="none"/><circle cx="24" cy="17" r="2" fill="#007830"/><path d="M28 18 L33 16" stroke="#007830" stroke-width="2"/><path d="M21 25 L21 38" stroke="#007830" stroke-width="2"/><path d="M21 29 L12 34" stroke="#007830" stroke-width="2"/><path d="M21 29 L30 34" stroke="#007830" stroke-width="2"/><path d="M21 38 L16 54 M21 38 L26 54" stroke="#007830" stroke-width="2"/></svg></span>`;
      }
      if (num === '8') {
        return `<span class="tiao-mark"><svg viewBox="0 0 42 60"><path d="M7 12 L14 24 L21 12 L28 24 L35 12" stroke="#007830" stroke-width="2" fill="none"/><path d="M7 48 L14 36 L21 48 L28 36 L35 48" stroke="#007830" stroke-width="2" fill="none"/></svg></span>`;
      }
      if (num === '7') {
        // 7 条按用户指定 SVG：上方 1 竖条（红）+ 上排 3 条 + 下排 3 条（绿 #007830）
        return `<span class="tiao-mark"><svg viewBox="0 0 42 60"><path d="M21 12 L21 22" stroke="#c8102e" stroke-width="3" stroke-linecap="round"/><path d="M12 26 L12 36 M21 26 L21 36 M30 26 L30 36" stroke="#007830" stroke-width="3" stroke-linecap="round"/><path d="M12 40 L12 50 M21 40 L21 50 M30 40 L30 50" stroke="#007830" stroke-width="3" stroke-linecap="round"/></svg></span>`;
      }
      const pts = BAR_LAYOUT[num] || [];
      return `<span class="bars">${pts.map((p) => `<i style="left:${p[0]}%;top:${p[1]}%;${p[2] ? 'background:' + p[2] : ''}"></i>`).join('')}</span>`;
    }
    if (suit === 'b') {
      const pts = PIP_LAYOUT[num] || [];
      // 7 筒按参考图：上 3 绿点斜排 + 下 4 红点 2×2；6 筒按参考图：上 2 绿点横排 + 下 4 红点 2×2
      let colored = pts;
      let pipsCls = 'pips';
      if (num === '7' || num === '6') {
        const greenN = num === '7' ? 3 : 2;
        colored = pts.map((p, idx) => idx < greenN ? [p[0], p[1], '#1e8449'] : [p[0], p[1], '#c0392b']);
        if (num === '6') pipsCls = 'pips with-core';
      }
      // 9 筒：中间一排（y=50 的三个点）为红色，上下两排保持默认色
      if (num === '9') {
        colored = pts.map((p, idx) => (idx >= 3 && idx <= 5) ? [p[0], p[1], '#c0392b'] : p);
      }
      return `<span class="${pipsCls}">${colored.map((p) => `<i style="left:${p[0]}%;top:${p[1]}%;${p[2] ? 'background:' + p[2] : ''}"></i>`).join('')}</span>`;
    }
    return '';
  }

  function honorFace(tile) {
    const ch = HONOR_NAMES[tile];
    if (tile === 'z') return `<span class="honor-face hz">${ch}</span>`;
    if (tile === 'z0') return `<span class="honor-face hz hz-wild">${ch}</span>`;
    if (tile === 'f') return `<span class="honor-face hf">${ch}</span>`;
    if (tile === 'p') return `<span class="honor-face hp"></span>`;
    return `<span class="honor-face hw">${ch}</span>`;
  }

  function suitClass(s) {
    if (s === 'w') return 'wan';
    if (s === 't') return 'tiao';
    if (s === 'b') return 'tong';
    return 'honor';
  }

  function tileText(t) {
    if (!t) return '';
    if (t === 'z0') return '红中';
    if (HONOR_NAMES[t]) return HONOR_NAMES[t];
    const num = t.slice(1);
    const s = t[0];
    const suit = s === 'w' ? '万' : s === 't' ? '条' : '筒';
    return `${num}${suit}`;
  }

  // ===== 手牌选中交互（默认模式，开关关闭时生效）=====
  // 清除选中态：清空索引并移除 .selected / .weak-highlight 视觉
  function clearTileSelection() {
    state.selectedIndex = null;
    $$('#table-wrap .tile.selected').forEach((el) => el.classList.remove('selected'));
    // 同时清掉弃牌区与明牌区（碰/明杠/暗杠真牌/补杠）的弱高亮
    $$('#table-wrap .tile.weak-highlight').forEach((el) => el.classList.remove('weak-highlight'));
  }

  // 弃牌区与明牌区同种牌弱高亮：对当前选中牌同 tile 值的已打出牌与明牌区牌加 .weak-highlight，
  // 一眼看全该牌已见张数（弃牌区+碰/杠区；暗杠他人视角为牌背无 data-tile，自动跳过）
  function applyWeakHighlight() {
    $$('#table-wrap .tile.weak-highlight').forEach((el) => el.classList.remove('weak-highlight'));
    const sel = state.selectedIndex;
    if (sel == null) return;
    const game = state.game;
    if (!game) return;
    const p = game.players && game.players[game.yourSeat];
    if (!p || !p.hand || p.hand[sel] == null) return;
    const tile = p.hand[sel];
    $$('#table-wrap .discard-area .tile, #table-wrap .melds .meld .tile').forEach((el) => {
      if (el.dataset.tile === tile) el.classList.add('weak-highlight');
    });
  }

  // 选中/切换选中后局部重绘：只更新手牌区与弱高亮，不整桌重绘（避免重置倒计时/操作区）
  function renderSelfHandAndHighlight() {
    const game = state.game;
    if (!game) return;
    const wrap = $('#table-wrap');
    const seat = game.yourSeat;
    const card = wrap.querySelector(`.seat[data-seat="${seat}"] .player-card`);
    if (!card) return;
    const p = game.players && game.players[seat];
    if (!p) return;
    const handTilesBox = card.querySelector('.hand-tiles');
    if (handTilesBox) handTilesBox.innerHTML = renderSelfHand(p);
    applyWeakHighlight();
    bindTileClicks();
  }

  function bindTileClicks() {
    const wrap = $('#table-wrap');
    const tiles = wrap.querySelectorAll('.hand-tiles .tile.discardable');
    tiles.forEach((el) => {
      el.onclick = () => {
        const tile = el.dataset.tile;
        const idx = Number(el.dataset.idx);
        const game = state.game;
        if (!game || !game.isDrawTurn) return;
        if (!state.prompt || state.prompt.type !== 'draw') return;
        if (state.tingPick) {
          // 听口：先选中（.selected），再次点击同一张确认报听；仅听口含 ≥6 点牌的选项有效
          // 注意：tingHints[t] 为 0（该听口牌 4 张已全见，绝听）也算有效可报听，只有未进入提示列表（undefined）才拒绝
          const h = game.tingHints && game.tingHints[tile];
          if (h === undefined || h === null) {
            toast('打出这张后听口不含 ≥6 点牌，不能报听', true);
            return;
          }
          if (state.selectedIndex === idx) {
            clearTileSelection();
            send({ type: 'ting', tile });
          } else {
            state.selectedIndex = idx;
            renderSelfHandAndHighlight();
          }
          return;
        }
        // 已报听：摸牌即打，不进入选中交互（与报听阶段语义一致，不受开关影响）
        const me = game.players && game.players[game.yourSeat];
        if (me && me.ting) {
          send({ type: 'play_tile', tile });
          return;
        }
        // 单击直接出牌开关：一次点击直接打出（给熟手提速）
        if (isTapToDiscard()) {
          send({ type: 'play_tile', tile });
          return;
        }
        // 默认选中交互：首次点击选中，再次点击同一张出牌，点击其他张切换选中
        if (state.selectedIndex === idx) {
          clearTileSelection();
          send({ type: 'play_tile', tile });
        } else {
          state.selectedIndex = idx;
          renderSelfHandAndHighlight();
        }
      };
    });
  }

  // ================= 操作区 =================
  function renderActions() {
    const bar = $('#action-bar');
    if (!bar) return;
    // 旁观者：无操作区
    if (state.room && state.room.isViewer) { bar.innerHTML = ''; return; }
    const p = state.prompt;
    if (!p) { bar.innerHTML = ''; return; }
    let btns = '';
    let guideText = '';
    if (p.type === 'draw') {
      if (p.canHu) btns += `<button class="act act-hu" data-act="hu">胡</button>`;
      if (p.actions && p.actions.includes('pass')) btns += `<button class="act act-pass" data-act="pass">过</button>`;
      if (p.gangOptions && p.gangOptions.length) btns += `<button class="act act-gang" data-act="gang">杠</button>`;
      if (p.actions && p.actions.includes('liangjin')) {
        // 「首金必须亮出」：手握首金未亮时亮金是唯一可选操作 → 按钮加强制样式并写入操作说明
        const force = p.needLiangjin ? ' act-gold-forced' : '';
        btns += `<button class="act act-gold${force}" data-act="liangjin">亮金${p.needLiangjin ? '（必须）' : ''}</button>`;
        if (p.needLiangjin) guideText = '首金必须亮出：点亮金后才能出牌/碰/杠/胡';
      }
      if (p.canDeclareTing && !state.tingPick) btns += `<button class="act act-ting" data-act="ting">报听</button>`;
      // 提示优先级：报听选牌 > 首金必须亮出 > 常规出牌引导
      if (state.tingPick) {
        btns += `<button class="act act-pass" data-act="ting-cancel">取消</button>`;
        guideText = '点击要扣的牌选中，再次点击报听';
      } else if (!p.needLiangjin) {
        guideText = isTapToDiscard() ? '点击手牌出牌' : '点击手牌选中，再次点击出牌';
      }
    } else if (p.type === 'response') {
      if (p.canHu) btns += `<button class="act act-hu" data-act="hu">胡</button>`;
      if (p.canGang) btns += `<button class="act act-gang" data-act="gang">杠</button>`;
      if (p.canPeng) btns += `<button class="act act-peng" data-act="peng">碰</button>`;
      btns += `<button class="act act-pass" data-act="pass">过</button>`;
      const acts = [];
      if (p.canPeng) acts.push('碰');
      if (p.canGang) acts.push('杠');
      if (p.canHu) acts.push('胡');
      const actLabel = acts.length ? acts.join('/') : (p.pendingType === 'qianggang' ? '抢杠胡' : '');
      btns += `<span class="resp-hint">${actLabel ? actLabel + '「' : ''}${tileHtml(p.tile, 'small')}${actLabel ? '」' : ''}</span>`;
    }
    bar.innerHTML = btns;
    if (guideText) {
      // 引导与倒计时使用两个独立节点，避免 startCountdown 覆写操作说明
      const guide = document.createElement('span');
      guide.className = 'action-guide countdown';
      guide.textContent = guideText;
      bar.appendChild(guide);
    }
    if (p.timeoutMs) {
      const timer = document.createElement('span');
      timer.className = 'action-timer';
      timer.setAttribute('aria-live', 'polite');
      bar.appendChild(timer);
      state.countdownEnd = Date.now() + p.timeoutMs;
      startCountdown();
    }
    $$('#action-bar [data-act]').forEach((b) => {
      b.onclick = () => onAction(b.dataset.act);
    });
  }

  function startCountdown() {
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    const cd = () => {
      const remain = Math.max(0, Math.round((state.countdownEnd - Date.now()) / 1000));
      const el = document.querySelector('.action-timer');
      if (!el) { clearInterval(state.countdownTimer); state.countdownTimer = null; return; }
      if (remain > 0) {
        el.textContent = `⏱ ${remain}s`;
        // 最后 5 秒变色告警，提醒即将超时自动托管
        el.classList.toggle('urgent', remain <= 5);
      } else {
        el.textContent = '⏱ 超时，正在自动处理…';
        el.classList.add('urgent');
        clearInterval(state.countdownTimer);
        state.countdownTimer = null; // 到点自停，避免空转
      }
    };
    cd();
    state.countdownTimer = setInterval(cd, 1000);
  }

  function onAction(act) {
    if (act === 'hu') send({ type: 'hu' });
    else if (act === 'peng') send({ type: 'peng' });
    else if (act === 'pass') send({ type: 'pass' });
    else if (act === 'gang') showGangMenu();
    else if (act === 'liangjin') send({ type: 'liangjin' });
    else if (act === 'ting') {
      state.tingPick = true;
      state.selectedIndex = null;
      renderTable();
    } else if (act === 'ting-cancel') {
      state.tingPick = false;
      state.selectedIndex = null;
      renderTable();
    }
  }

  function showGangMenu() {
    const p = state.prompt;
    if (!p || !p.gangOptions || !p.gangOptions.length) { send({ type: 'gang' }); return; }
    const btn = document.querySelector('[data-act="gang"]');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'gang-menu';
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.min(rect.left, window.innerWidth - 170) + 'px';
    p.gangOptions.forEach((opt) => {
      const label = opt.gangType === 'angang' ? `暗杠 ${tileText(opt.tile)}` : `补杠 ${tileText(opt.tile)}`;
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        document.body.removeChild(menu);
        send({ type: 'gang', tile: opt.tile, gangType: opt.gangType });
      };
      menu.appendChild(b);
    });
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => document.body.removeChild(menu);
    menu.appendChild(cancel);
    document.body.appendChild(menu);
    setTimeout(() => {
      const off = (e) => {
        if (!menu.contains(e.target)) {
          if (menu.parentNode) menu.parentNode.removeChild(menu);
          document.removeEventListener('click', off);
        }
      };
      document.addEventListener('click', off);
    }, 0);
  }

  // ================= 侧栏 =================
  function renderSidePanel() {
    if (!state.room) return;
    renderScoreTab();
    renderLogTab();
    renderChat(state.room.chat);
  }

  function renderScoreTab() {
    const room = state.room;
    const sorted = [...room.players].filter(Boolean).sort((a, b) => b.score - a.score);
    $('#tab-score').innerHTML = sorted.map((p) => `
      <div class="score-row">
        <span class="nm">${esc(p.name)}${p.id === state.playerId ? '（我）' : ''}</span>
        ${p.id === room.ownerId ? '<span class="tag host">房主</span>' : ''}
        ${p.isAI ? '<span class="tag ai">AI</span>' : ''}
        ${!p.connected ? '<span class="tag off">离线</span>' : ''}
        <span class="rs">本局 ${p.roundScore >= 0 ? '+' : ''}${p.roundScore}</span>
        <span class="sc">${p.score >= 0 ? '+' : ''}${p.score}</span>
      </div>`).join('');
  }

  function renderLogTab() {
    const room = state.room;
    $('#tab-log').innerHTML = (room.logs || []).slice().reverse().map((l) => `
      <div class="log-line"><span class="t">${l.time}</span>${esc(l.text)}</div>`).join('') ||
      '<div class="empty">暂无日志</div>';
  }

  function renderChat(chat) {
    const box = $('#chat-messages');
    if (!box) return;
    // 仅当用户本来就在底部附近时才自动滚底，翻看历史时不被新消息强行拽回
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = (chat || []).map((m) => `
      <div class="chat-msg"><span class="who">${esc(m.from)}</span><span class="txt">${esc(m.text)}</span></div>`).join('');
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  // ================= 账号体系 UI =================
  const VARIANT_LABEL = { koudian: '扣点点', hongzhong: '红中', tiejin: '贴金', unknown: '未知' };

  function renderAuthBar() {
    const loggedIn = !!state.token;
    const st = $('#auth-state');
    if (st) st.textContent = loggedIn ? ('👤 ' + (state.displayName || state.username)) : '未登录（游客）';
    const authBtn = $('#auth-btn');
    const histBtn = $('#history-btn');
    const logoutBtn = $('#logout-btn');
    if (authBtn) authBtn.classList.toggle('hidden', loggedIn);
    if (histBtn) histBtn.classList.toggle('hidden', !loggedIn);
    const lbBtn = $('#leaderboard-btn');
    if (lbBtn) lbBtn.classList.toggle('hidden', !loggedIn);
    const frBtn = $('#friends-btn');
    if (frBtn) frBtn.classList.toggle('hidden', !loggedIn);
    const acBtn = $('#account-btn');
    if (acBtn) acBtn.classList.toggle('hidden', !loggedIn);
    if (logoutBtn) logoutBtn.classList.toggle('hidden', !loggedIn);
  }

  // 清空登录身份（token / 用户名 / 昵称）。clearName=true 时一并清掉大厅昵称（注销账号回到游客态）。
  function clearAuthIdentity(clearName) {
    state.token = '';
    state.username = '';
    state.displayName = '';
    store.removeItem('kd.token');
    store.removeItem('kd.username');
    store.removeItem('kd.displayName');
    if (clearName) {
      state.name = '';
      store.removeItem('kd.name');
    }
  }

  function showAuthError(msg) {
    const tip = $('#auth-tip');
    if (!tip) return;
    tip.textContent = msg || '';
    tip.classList.add('err');
  }

  function setAuthMode(mode) {
    $$('#seg-auth .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.value === mode));
    $('#auth-title').textContent = mode === 'register' ? '注册账号' : '登录';
    $('#auth-submit').textContent = mode === 'register' ? '注册并登录' : '登录';
    $('#auth-name').classList.toggle('hidden', mode !== 'register');
    $('#auth-tip').textContent = '';
    $('#auth-tip').classList.remove('err');
  }

  function submitAuth() {
    const mode = $('#seg-auth .seg-item.active').dataset.value;
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const name = $('#auth-name').value.trim();
    if (!username) { showAuthError('请输入用户名'); return; }
    if (!password || password.length < 6) { showAuthError('密码至少 6 位'); return; }
    if (mode === 'register' && !/^[A-Za-z0-9_一-龥]{2,16}$/.test(username)) {
      showAuthError('用户名需 2-16 位（字母/数字/下划线/中文）');
      return;
    }
    if (mode === 'register') send({ type: 'register', username, password, name });
    else send({ type: 'login', username, password });
  }

  function showAccountError(msg) {
    const tip = $('#account-tip');
    if (!tip) return;
    tip.textContent = msg || '';
    tip.classList.add('err');
  }

  function clearAccountTip() {
    const tip = $('#account-tip');
    if (tip) { tip.textContent = ''; tip.classList.remove('err'); }
  }

  function openAccount() {
    clearAccountTip();
    const nameInput = $('#account-name');
    if (nameInput) nameInput.value = state.displayName || state.username || '';
    const oldPwd = $('#account-old-password');
    const newPwd = $('#account-new-password');
    if (oldPwd) oldPwd.value = '';
    if (newPwd) newPwd.value = '';
    showModal('account-modal');
  }

  function submitNameChange() {
    const name = $('#account-name').value.trim();
    if (!name) { showAccountError('请输入新昵称'); return; }
    if (name.length > 12) { showAccountError('昵称最多 12 个字'); return; }
    clearAccountTip();
    send({ type: 'change_name', name, token: state.token });
  }

  function submitPasswordChange() {
    const oldPassword = $('#account-old-password').value;
    const newPassword = $('#account-new-password').value;
    if (!oldPassword) { showAccountError('请输入旧密码'); return; }
    if (!newPassword || newPassword.length < 6) { showAccountError('新密码至少 6 位'); return; }
    clearAccountTip();
    send({ type: 'change_password', oldPassword, newPassword, token: state.token });
  }

  function submitDeleteAccount() {
    if (!confirm('确定注销账号？将永久删除账号、历史对局与好友关系，不可恢复。')) return;
    clearAccountTip();
    send({ type: 'delete_account', token: state.token });
  }

  function renderHistory(records, guest) {
    const box = $('#history-list');
    if (!box) return;
    if (guest) { box.innerHTML = '<div class="empty">登录后可查看你的对局记录</div>'; return; }
    if (!records.length) { box.innerHTML = '<div class="empty">还没有对局记录，快去打一局吧</div>'; return; }
    box.innerHTML = records.map((r) => {
      const d = new Date(r.t);
      const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const delta = (r.delta >= 0 ? '+' : '') + r.delta;
      const total = (r.total >= 0 ? '+' : '') + r.total;
      const badge = r.isWin ? '<span class="h-win">胡</span>' : (r.type === 'draw' ? '<span class="h-draw">流</span>' : '');
      return `<div class="history-item">
        <span class="h-time">${hh}</span>
        <span class="h-variant">${esc(VARIANT_LABEL[r.variant] || r.variant)}</span>
        <span class="h-round">第${r.roundNo}局</span>
        ${badge}
        <span class="h-delta ${r.delta >= 0 ? 'up' : 'down'}">${delta}</span>
        <span class="h-total ${r.total >= 0 ? 'up' : 'down'}">累计 ${total}</span>
      </div>`;
    }).join('');
  }

  function openHistory() {
    showModal('history-modal');
    if (state.token) send({ type: 'get_stats', token: state.token });
    send({ type: 'get_history', limit: 50, token: state.token || undefined });
  }

  // 个人战绩汇总（展示于对局记录弹窗顶部）
  function renderStatsSummary(stats) {
    const box = $('#stats-summary');
    if (!box) return;
    if (!stats) { box.innerHTML = ''; return; }
    const wr = (stats.winRate * 100).toFixed(1);
    const vTags = Object.keys(stats.byVariant || {})
      .map((v) => `${VARIANT_LABEL[v] || v} ${stats.byVariant[v] >= 0 ? '+' : ''}${stats.byVariant[v]}`)
      .join(' · ');
    box.innerHTML = `
      <div class="stats-grid">
        <div class="st"><span class="st-v">${stats.games}</span><span class="st-k">总对局</span></div>
        <div class="st"><span class="st-v">${wr}%</span><span class="st-k">胜率</span></div>
        <div class="st"><span class="st-v ${stats.totalScore >= 0 ? 'up' : 'down'}">${stats.totalScore >= 0 ? '+' : ''}${stats.totalScore}</span><span class="st-k">净积分</span></div>
        <div class="st"><span class="st-v">${stats.bestRound >= 0 ? '+' : ''}${stats.bestRound}</span><span class="st-k">单局最佳</span></div>
      </div>
      <div class="stats-sub">胜 ${stats.wins} · 平 ${stats.draws} · 负 ${stats.losses}${vTags ? '　|　' + vTags : ''}</div>`;
  }

  function openLeaderboard() {
    showModal('leaderboard-modal');
    send({ type: 'get_leaderboard', limit: 20 });
  }

  function renderLeaderboard(list) {
    const box = $('#leaderboard-list');
    if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="empty">还没有战绩数据，快去打几局吧</div>'; return; }
    const medal = ['🥇', '🥈', '🥉'];
    box.innerHTML = list.map((r, i) => {
      const me = state.username && r.username === state.username ? ' me' : '';
      return `<div class="lb-row${me}">
        <span class="lb-rank">${medal[i] || (i + 1)}</span>
        <span class="lb-name">${esc(r.displayName)}</span>
        <span class="lb-score ${r.score >= 0 ? 'up' : 'down'}">${r.score >= 0 ? '+' : ''}${r.score}</span>
        <span class="lb-games">${r.games}局</span>
      </div>`;
    }).join('');
  }

  // ================= 好友系统 =================
  function openFriends() {
    showModal('friends-modal');
    send({ type: 'friend_list', token: state.token });
  }

  function renderFriends(friends, requests) {
    const listBox = $('#friend-list');
    const reqBox = $('#friend-requests');
    if (!listBox) return;
    if (friends === null) { listBox.innerHTML = '<div class="empty">登录后可查看好友</div>'; if (reqBox) reqBox.innerHTML = ''; return; }
    if (requests && requests.length) {
      reqBox.innerHTML = '<div class="fr-title">好友请求</div>' + requests.map((r) =>
        `<div class="fr-row">
          <span class="fr-name">${esc(r.displayName)}</span>
          <button class="btn small primary" data-accept="${esc(r.username)}">接受</button>
          <button class="btn small" data-decline="${esc(r.username)}">忽略</button>
        </div>`).join('');
    } else {
      reqBox.innerHTML = '';
    }
    if (!friends.length) { listBox.innerHTML = '<div class="empty">还没有好友，添加对手的用户名即可</div>'; return; }
    listBox.innerHTML = friends.map((r) =>
      `<div class="fr-row">
        <span class="fr-name">${esc(r.displayName)}</span>
        <button class="btn small danger" data-remove="${esc(r.username)}">删除</button>
      </div>`).join('');
  }

  function addFriend() {
    const input = $('#friend-input');
    const name = input.value.trim();
    if (!name) return;
    send({ type: 'add_friend', username: name, token: state.token });
    input.value = '';
  }

  // ================= 房间邀请分享 =================
  // ================= 房间邀请（在线好友 / 大厅人员） =================
  function openInvite() {
    const room = state.room;
    if (!room) { toast('请先进入房间', true); return; }
    showModal('invite-modal');
    $('#invite-friends-list').innerHTML = '<div class="empty">加载中…</div>';
    $('#invite-lobby-list').innerHTML = '<div class="empty">加载中…</div>';
    send({ type: 'list_online' });
  }

  function renderInviteList(friends, lobby) {
    const renderItem = (item) =>
      `<div class="invite-item">
        <span class="nm">${esc(item.name)}</span>
        <button class="btn small primary" data-invite="${esc(item.key)}">邀请</button>
      </div>`;
    $('#invite-friends-list').innerHTML = friends.length
      ? friends.map(renderItem).join('')
      : '<div class="empty">暂无在线好友</div>';
    $('#invite-lobby-list').innerHTML = lobby.length
      ? lobby.map(renderItem).join('')
      : '<div class="empty">大厅暂无空闲玩家</div>';
    // 事件委托：点击邀请按钮发邀请
    document.querySelectorAll('#invite-modal [data-invite]').forEach((b) => {
      b.onclick = () => {
        send({ type: 'invite_player', key: b.dataset.invite });
        b.textContent = '已邀请';
        b.disabled = true;
      };
    });
  }

  // 被邀请方弹窗：选择是否进入房间
  function showInviteReceive(msg) {
    const variantName = variantLabel({ variant: msg.variant });
    const typeName = msg.roomType === 'public' ? '公共局' : '好友局';
    $('#invite-recv-owner').textContent = msg.ownerName || '未知';
    $('#invite-recv-info').textContent = `${typeName} · ${variantName} · 房间 ${msg.roomId}`;
    showModal('invite-recv-modal');
    // 记录待回应邀请的房间号（接受时带上）
    $('#invite-recv-accept').onclick = () => {
      send({ type: 'invite_reply', roomId: msg.roomId, accept: true });
      hideModal('invite-recv-modal');
    };
    $('#invite-recv-decline').onclick = () => {
      send({ type: 'invite_reply', roomId: msg.roomId, accept: false });
      hideModal('invite-recv-modal');
    };
  }

  // 常用聊天语：点击即发，避免每局都打字；支持自定义增删，本地保存
  const DEFAULT_QUICK_CHATS = [
    '快点出牌~',
    '该你啦',
    '稍等，卡了',
    '慢点，我想想',
    '这把稳了',
    '胡了！',
    '杠！',
    '碰！',
    '不好意思',
    '哈哈',
  ];
  const QUICK_CHATS_KEY = 'kd.quickChats';

  function loadQuickChats() {
    try {
      const raw = store.getItem(QUICK_CHATS_KEY);
      if (!raw) return DEFAULT_QUICK_CHATS.slice();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return DEFAULT_QUICK_CHATS.slice();
      // 过滤非法项 + 去重 + 限长，保留最多 20 条
      const clean = arr.map((t) => String(t).trim().slice(0, 12)).filter(Boolean);
      const uniq = [...new Set(clean)].slice(0, 20);
      return uniq.length ? uniq : DEFAULT_QUICK_CHATS.slice();
    } catch (e) {
      return DEFAULT_QUICK_CHATS.slice();
    }
  }
  let QUICK_CHATS = loadQuickChats();
  let quickChatEditing = false;

  function saveQuickChats() {
    store.setItem(QUICK_CHATS_KEY, JSON.stringify(QUICK_CHATS));
  }

  function renderQuickChat() {
    const box = $('#chat-quick');
    if (!box) return;
    if (quickChatEditing) {
      // 编辑模式：胶囊带删除×，末尾给一个添加输入框
      const edit = $('#chat-quick-edit');
      if (edit) edit.textContent = '完成';
      box.innerHTML = QUICK_CHATS.map((t, i) =>
        `<button class="chat-quick-btn editing" data-idx="${i}" title="点击删除">${esc(t)} ✕</button>`).join('') +
        `<input class="chat-quick-add" maxlength="12" placeholder="＋ 新短语，回车添加" autocomplete="off">`;
      box.querySelectorAll('.chat-quick-btn.editing').forEach((btn) => {
        btn.addEventListener('click', () => {
          QUICK_CHATS.splice(Number(btn.dataset.idx), 1);
          saveQuickChats();
          renderQuickChat();
        });
      });
      const addInput = box.querySelector('.chat-quick-add');
      if (addInput) {
        const commit = () => {
          const v = addInput.value.trim().slice(0, 12);
          if (!v) return;
          if (QUICK_CHATS.length >= 20) { toast('最多 20 条常用语', true); addInput.value = ''; return; }
          if (QUICK_CHATS.includes(v)) { toast('该短语已存在', true); addInput.value = ''; return; }
          QUICK_CHATS.push(v);
          saveQuickChats();
          renderQuickChat();
        };
        addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
        addInput.addEventListener('blur', commit);
      }
      return;
    }
    // 正常模式：点击即发
    const edit = $('#chat-quick-edit');
    if (edit) edit.textContent = '⚙';
    box.innerHTML = QUICK_CHATS.map((t) =>
      `<button class="chat-quick-btn" data-text="${esc(t)}">${esc(t)}</button>`).join('');
    box.querySelectorAll('.chat-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => sendChatText(btn.dataset.text));
    });
  }

  function bindQuickChatEdit() {
    const btn = $('#chat-quick-edit');
    if (btn) btn.onclick = () => {
      quickChatEditing = !quickChatEditing;
      renderQuickChat();
    };
  }

  // 对局表情互动：底部表情条，点击即广播一个白名单 emoji
  const QUICK_EMOJIS = ['👍', '😂', '😅', '😭', '😡', '🤔', '👏', '🎉', '💪', '🀄', '🔥', '💰'];

  function renderEmojiBar() {
    const box = $('#emoji-bar');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    box.innerHTML = QUICK_EMOJIS.map((e) =>
      `<button class="emoji-btn" data-emoji="${e}">${e}</button>`).join('');
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.emoji-btn');
      if (btn) send({ type: 'emoji', emoji: btn.dataset.emoji });
    });
  }

  // 收到他人表情后，在桌面（发送者座位附近，未知则居中）浮动展示
  function showEmojiFloat(emoji, from) {
    const wrap = $('#table-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'emoji-float';
    el.textContent = emoji;
    const seat = seatOfName(from);
    let left = '50%', top = '50%';
    if (seat >= 0) {
      const seatEl = wrap.querySelector(`.seat[data-seat="${seat}"]`);
      if (seatEl) {
        const sr = seatEl.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        left = (sr.left - wr.left + sr.width / 2) + 'px';
        top = (sr.top - wr.top + sr.height / 2) + 'px';
      }
    }
    el.style.left = left;
    el.style.top = top;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }

  // ================= 聊天消息气泡 =================
  // 服务端 chat 只带 from 昵称，按昵称反查座位号挂气泡；
  // 气泡层挂在 table-wrap 顶层，renderTable 重绘时由调用方保留再同步定位
  const bubbleLayers = new Map(); // seat -> 气泡层 DOM

  function seatOfName(name) {
    const pls = state.room && state.room.players;
    if (!pls) return -1;
    for (let i = 0; i < pls.length; i++) {
      if (pls[i] && pls[i].name === name) return i;
    }
    return -1;
  }

  function seatDir(seat) {
    const wrap = $('#table-wrap');
    const el = wrap && wrap.querySelector(`.seat[data-seat="${seat}"]`);
    if (!el) return 'bottom';
    if (el.className.includes('seat-top')) return 'top';
    if (el.className.includes('seat-left')) return 'left';
    if (el.className.includes('seat-right')) return 'right';
    return 'bottom';
  }

  function getBubbleLayer(seat) {
    let layer = bubbleLayers.get(seat);
    if (!layer || !layer.parentNode) {
      layer = document.createElement('div');
      layer.className = 'bubble-layer';
      bubbleLayers.set(seat, layer);
      const wrap = $('#table-wrap');
      if (wrap) wrap.appendChild(layer);
    }
    return layer;
  }

  // 气泡浮在座位朝向牌桌中央的一侧（bottom=上方 / top=下方 / left=右侧 / right=左侧）
  function repositionBubbleLayer(seat, layer) {
    const wrap = $('#table-wrap');
    const seatEl = wrap && wrap.querySelector(`.seat[data-seat="${seat}"]`);
    if (!wrap || !seatEl) return;
    const sr = seatEl.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const cx = sr.left - wr.left + sr.width / 2;
    const cy = sr.top - wr.top + sr.height / 2;
    const cls = seatEl.className;
    if (cls.includes('seat-bottom')) {
      layer.style.left = cx + 'px';
      layer.style.bottom = (wr.bottom - sr.top + 6) + 'px';
      layer.style.top = 'auto';
      layer.style.right = 'auto';
      layer.style.transform = 'translateX(-50%)';
    } else if (cls.includes('seat-top')) {
      layer.style.top = (sr.bottom - wr.top + 6) + 'px';
      layer.style.left = cx + 'px';
      layer.style.bottom = 'auto';
      layer.style.right = 'auto';
      layer.style.transform = 'translateX(-50%)';
    } else if (cls.includes('seat-left')) {
      layer.style.left = (sr.right - wr.left + 6) + 'px';
      layer.style.top = cy + 'px';
      layer.style.bottom = 'auto';
      layer.style.right = 'auto';
      layer.style.transform = 'translateY(-50%)';
    } else { // seat-right
      layer.style.right = (wr.right - sr.left + 6) + 'px';
      layer.style.top = cy + 'px';
      layer.style.bottom = 'auto';
      layer.style.left = 'auto';
      layer.style.transform = 'translateY(-50%)';
    }
  }

  function syncBubbleLayers() {
    const wrap = $('#table-wrap');
    if (!wrap) return;
    for (const [seat, layer] of bubbleLayers) {
      if (!layer.parentNode) wrap.appendChild(layer);
      repositionBubbleLayer(seat, layer);
    }
  }

  function showChatBubble(from, text) {
    if (!state.game) return;
    const seat = seatOfName(from);
    if (seat < 0) return;
    const wrap = $('#table-wrap');
    if (!wrap || !wrap.querySelector(`.seat[data-seat="${seat}"]`)) return;
    const layer = getBubbleLayer(seat);
    // 同一座位最多叠 3 条：超出直接移除最旧（避免遮牌）
    const olds = layer.querySelectorAll('.bubble');
    for (let i = 0; i < olds.length - 2; i++) {
      if (olds[i]._timer) clearTimeout(olds[i]._timer);
      olds[i].remove();
    }
    const b = document.createElement('div');
    b.className = 'bubble dir-' + seatDir(seat);
    b.innerHTML = `<span class="b-who">${esc(from)}</span>${esc(text)}`;
    layer.prepend(b);
    repositionBubbleLayer(seat, layer);
    b._timer = setTimeout(() => {
      b.classList.add('leaving');
      setTimeout(() => { b.remove(); }, 380);
    }, 3000);
  }

  // ================= 结算 =================
  // 统一支付明细表：胡牌支付（自摸三家各付1份 / 点炮已报听三家各出1份 / 点炮未报听独赔3份）
  // + 杠分（明杠/补杠=该牌点数，暗杠=点数×2，字牌=10点；其余三家各付一份）
  // 数据来自后端 winners.payments（[{kind:'hu'|'gang', title, toSeat, toAmount, rows:[{seat,amount,role}]}]）
  function paymentTableHtml(result) {
    const pays = result && result.payments;
    if (!pays || !pays.length) return '';
    const nameOf = (s) => (result.hands && result.hands[s] ? result.hands[s].name : '座位' + s);
    const rowsHtml = pays.map((pay) => {
      const fromTxt = pay.rows.map((r) =>
        `<div class="pay-line">${esc(nameOf(r.seat))} <span class="pay-neg">${r.amount}</span>${r.role ? '<span class="pay-role">（' + esc(r.role) + '）</span>' : ''}${r.formula ? '<span class="pay-formula">' + esc(r.formula) + '</span>' : ''}</div>`
      ).join('');
      const actor = pay.kind === 'gang' ? '杠牌' : '胡牌';
      // 项目列写明谁胡/谁杠/谁点炮：点炮者从付款方行 role 含"放炮者"的行反推
      const discarderRow = pay.rows.find((r) => r.role && r.role.includes('放炮者'));
      let title = pay.title;
      if (pay.kind === 'gang') {
        title = `${nameOf(pay.toSeat)} ${title}`;
      } else {
        title = title
          .replace(/^点炮胡/, `${nameOf(pay.toSeat)} 胡`)
          .replace(/^自摸/, `${nameOf(pay.toSeat)} 自摸`)
          .replace(/^抢杠胡/, `${nameOf(pay.toSeat)} 抢杠胡`);
        if (discarderRow) title = title.replace(/（放炮者[^）]*）/, '').replace(/胡/, `胡（${nameOf(discarderRow.seat)} 点炮）`);
      }
      return `<tr>
        <td class="pay-item">${esc(title)}</td>
        <td class="pay-from">${fromTxt}</td>
        <td class="pay-to"><span class="pay-actor">${actor}</span>${esc(nameOf(pay.toSeat))} <span class="pay-pos">+${pay.toAmount}</span></td>
      </tr>`;
    }).join('');
    return `<div class="settle-gang">
      <div class="settle-sub">支付明细（负数=付出，正数=收入）</div>
      <table class="pay-table">
        <thead><tr><th>项目</th><th>付款方</th><th>收款方</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
  }

  // 结算四家手牌：hu 局显示本局得分；胡牌者标 winnerLabel（单局「（胡）」/房间结算「（赢）」）
  function settleHandsHtml(result, opts = {}) {
    const winSeat = opts.winSeat != null ? opts.winSeat : result.winnerSeat;
    const winnerLabel = opts.winnerLabel || '（胡）';
    const withScore = result.type === 'hu';
    const goldTile = opts.goldTile;
    const rows = (result.hands || []).map((h) => h ? `
        <div class="row">
          <b>${esc(h.name)}${h.seat === winSeat ? winnerLabel : ''}</b>
          ${h.hand.map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, goldTile)).join('')}
          ${h.melds && h.melds.length ? '<span>|</span>' + renderMelds(h.melds, true, goldTile) : ''}
          ${withScore ? `<span class="settle-round-score">${h.roundScore >= 0 ? '+' : ''}${h.roundScore}</span>` : ''}
        </div>` : '').join('');
    return `<div class="settle-hands">${rows}</div>`;
  }

  function settleNameOf(result, seat) {
    return result.hands && result.hands[seat] ? result.hands[seat].name : '座位' + seat;
  }

  function winLabelOf(winType) {
    return winType === 'zimo' ? '自摸' : winType === 'qianggang' ? '抢杠胡' : '点炮胡';
  }

  /** 红中麻将结算详情（variant==='hongzhong'）：番数倍数 + 扎码 + 支付明细 */
  function buildHZSettleHtml(result, opts = {}) {
    const prefix = opts.prefix || '';
    const winnerLabel = opts.winnerLabel || '（胡）';
    const compact = !!opts.compact;
    const nameOf = (s) => settleNameOf(result, s);
    const settleHands = settleHandsHtml(result, { winnerLabel });
    if (result.type === 'draw') {
      const flowLabel = state.room && state.room.settings && state.room.settings.dealerFlow === 'keep' ? '庄家连庄' : '下家接庄';
      if (compact) {
        return `<div class="settle-head"><div class="settle-sub">${prefix}流局（红中 · ${flowLabel}）</div></div>` + settleHands;
      }
      return `
        <div class="settle-head"><div class="settle-sub">牌墙摸完，流局（红中麻将 · ${flowLabel}）</div></div>
        ${paymentTableHtml(result)}
        ${settleHands}`;
    }
    const winner = result.hands && result.hands[result.winnerSeat];
    const winLabel = winLabelOf(result.winType);
    const calcText = '无番制';
    // 扎码牌独立展示：红中 1/5/9 万筒条 及 红中 为中码
    const isZhongMaTile = (t) =>
      t === 'z0' || ((t[0] === 'w' || t[0] === 't' || t[0] === 'b') && ['1', '5', '9'].includes(t[1]));
    const zhaMaBlock = (label, tiles, count, mult) => {
      if (!tiles || !tiles.length) return '';
      const tileSpans = tiles.map((t) =>
        `<span class="zm-tile${isZhongMaTile(t) ? ' zm-hit' : ''}">${tileHtml(t, 'tiny')}</span>`
      ).join('');
      const hitTxt = count > 0 ? `中 ${count} 张 ×${mult || 1}` : '未中';
      return `<div class="settle-zm"><span class="settle-zm-label">${label}（${hitTxt}）</span>${tileSpans}</div>`;
    };
    const zhaBlockMulti = (w) =>
      zhaMaBlock(`${nameOf(w.winnerSeat)} 扎码`, w.zhaMaTiles, w.zhaMaCount || 0, w.zmaMult || 1);
    const zmaBlocks = (result.winners || []).length > 1
      ? result.winners.map(zhaBlockMulti).join('')
      : zhaMaBlock('扎码', result.zhaMaTiles, result.zhaMaCount || 0, result.zmaMult || result.mult || 1);
    const multiText = (result.winners || []).length > 1
      ? `<div class="settle-sub">一炮多响：${result.winners.map((w) =>
          `${nameOf(w.winnerSeat)}（${w.winType === 'zimo' ? '自摸' : w.winType === 'qianggang' ? '抢杠胡' : '点炮胡'}${w.zmaMult ? '，中码×' + w.zmaMult : ''}）`).join('、')}</div>`
      : '';
    if (compact) {
      return `<div class="settle-head">
        <div class="settle-sub">${prefix}${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)} · ${calcText} → ${result.score >= 0 ? '+' : ''}${result.score} 分</div>
      </div>${zmaBlocks}${paymentTableHtml(result)}` + settleHands;
    }
    return `
      <div class="settle-head">
        <div class="settle-big">${result.score >= 0 ? '+' : ''}${result.score}</div>
        <div class="settle-sub">红中麻将 · ${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)}</div>
        <div class="settle-sub">${calcText}</div>
        ${multiText}
      </div>
      ${zmaBlocks}
      ${paymentTableHtml(result)}
      ${settleHands}`;
  }

  /** 运城贴金麻将结算详情（variant==='tiejin'）：金母/金牌/亮金/锁金 + 金分 + 支付明细 */
  function buildTieJinSettleHtml(result, opts = {}) {
    const prefix = opts.prefix || '';
    const winnerLabel = opts.winnerLabel || '（胡）';
    const compact = !!opts.compact;
    const winSeat = result.winner != null ? result.winner : result.winnerSeat;
    const nameOf = (s) => settleNameOf(result, s);
    const settleHands = settleHandsHtml(result, { winSeat, winnerLabel, goldTile: result.goldTile });
    const goldBlock = result.goldMother && result.goldTile
      ? `<div class="settle-sub">金母 ${tileHtml(result.goldMother, 'tiny', 0, false, false, undefined, false, result.goldMother)} → 金牌 ${tileHtml(result.goldTile, 'tiny', 0, false, false, undefined, false, result.goldTile)}（${result.scoreMode === 'B' ? '125体系' : '边趣计分'}）</div>`
      : '';
    const shangjinBlock = (result.shangjinCount || []).map((c, s) =>
      c > 0 ? `<span class="settle-sub settle-shangjin">${esc(nameOf(s))} 亮金 ${c}</span>` : ''
    ).join('');
    const locked = (result.locked || []).some(Boolean);
    const lockBlock = locked
      ? `<div class="settle-sub">锁金状态：${result.locked.map((v, s) => `${esc(nameOf(s))}${v ? '（锁）' : '（解）'}`).join(' ')}${result.lockSeat != null ? ' · 锁家：' + esc(nameOf(result.lockSeat)) : ''}</div>`
      : '';
    // 牌型加番（七小对/豪华七小对）与包胡提示
    const shapeBlock = result.shapeNames && result.shapeNames.length
      ? `<div class="settle-sub">牌型：${esc(result.shapeNames.join('、'))}（加番 ×${result.shapeMult || 1}，仅放胡牌分，金分不翻）</div>`
      : '';
    const baoHuBlock = result.baoHu
      ? `<div class="settle-sub settle-baohu">包胡：牌墙剩最后 4 张放炮，放炮者独赔三家</div>`
      : '';
    const pays = result.payments || [];
    const payBlock = pays.length
      ? `<div class="settle-gang"><div class="settle-sub">支付明细（负数=付出，正数=收入）</div>
          <table class="pay-table">
            <thead><tr><th>项目</th><th>付款方</th><th>收款方</th></tr></thead>
            <tbody>${pays.map((pay) => `
              <tr>
                <td class="pay-item">${esc(pay.role || '胡牌')}${pay.formula ? '<span class="pay-formula">' + esc(pay.formula) + '</span>' : ''}</td>
                <td class="pay-from"><div class="pay-line">${esc(nameOf(pay.from))} <span class="pay-neg">-${pay.amount}</span></div></td>
                <td class="pay-to"><span class="pay-actor">胡牌</span>${esc(nameOf(pay.to))} <span class="pay-pos">+${pay.amount}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`
      : '';
    if (result.type === 'draw') {
      const flowTxt = (result.gangLogs || []).length > 0 ? '，有杠下家坐庄' : '，无杠庄家连庄';
      if (compact) {
        return `<div class="settle-head"><div class="settle-sub">${prefix}流局（运城贴金 · ${flowTxt}）</div></div>${goldBlock}${shangjinBlock}${lockBlock}` + settleHands;
      }
      return `
        <div class="settle-head"><div class="settle-sub">流局（运城贴金麻将${flowTxt}，杠分不计）</div></div>
        ${goldBlock}
        ${shangjinBlock}
        ${lockBlock}
        ${settleHands}`;
    }
    const winner = result.hands && result.hands[winSeat];
    const winLabel = winLabelOf(result.winType);
    if (compact) {
      return `<div class="settle-head">
        <div class="settle-sub">${prefix}${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)} · 亮金 ${result.goldCount || 0} 张 · 金分 ${result.goldScore || 0}${result.shapeNames && result.shapeNames.length ? ' · ' + esc(result.shapeNames.join('、')) + '×' + (result.shapeMult || 1) : ''}${result.baoHu ? ' · 包胡' : ''} → ${result.winnerGain >= 0 ? '+' : ''}${result.winnerGain} 分</div>
      </div>${goldBlock}${shangjinBlock}${lockBlock}${shapeBlock}${baoHuBlock}${payBlock}` + settleHands;
    }
    return `
      <div class="settle-head">
        <div class="settle-big">${result.winnerGain >= 0 ? '+' : ''}${result.winnerGain}</div>
        <div class="settle-sub">运城贴金麻将 · ${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)}</div>
        <div class="settle-sub">亮金 ${result.goldCount || 0} 张（三金封顶）· 金分 ${result.goldScore || 0}${result.huGain ? ' · 胡分 ' + result.huGain : ''}</div>
        ${shapeBlock}
        ${baoHuBlock}
        ${goldBlock}
        ${shangjinBlock}
        ${lockBlock}
      </div>
      ${payBlock}
      ${settleHands}`;
  }

  /**
   * 结算详情公共渲染：单局结算（showSettlement）与房间结算"最后一局"（showSettleModal）共用，
   * 消除约 60+ 行重复模板。内部复用 paymentTableHtml / tileText / tileHtml / renderMelds / esc。
   * @param {object} result 结算数据（type='hu'|'draw'，含 hands/winnerSeat/payments 等）
   * @param {object} [opts]
   * @param {string} [opts.prefix='']  头部前缀，房间结算用"最后一局："
   * @param {string} [opts.winnerLabel='（胡）'] 胜者手牌标记，单局结算"（胡）"、房间结算"（赢）"
   * @param {boolean} [opts.compact=false] 紧凑单行模式（房间结算），hu 分支分数并入首行、放炮者说明用全角括号；
   *                                        draw 分支省略"牌墙剩 6 墩/听牌者/支付明细"细节行
   * @returns {string} settle-head + 支付明细 + settle-hands 的 HTML
   */
  function buildSettleHtml(result, opts = {}) {
    if (result && result.variant === 'hongzhong') return buildHZSettleHtml(result, opts);
    if (result && result.variant === 'tiejin') return buildTieJinSettleHtml(result, opts);
    const prefix = opts.prefix || '';
    const winnerLabel = opts.winnerLabel || '（胡）';
    const compact = !!opts.compact;
    const isAdd = result.scoreModel === 'add';
    const settleHands = settleHandsHtml(result, { winnerLabel });
    if (result.type === 'draw') {
      const ting = (result.tingSeats || []).map((s) => result.hands[s] ? result.hands[s].name : '').join('、');
      const flowLabel = state.room && state.room.settings && state.room.settings.dealerFlow === 'keep' ? '庄家连庄' : '下家接庄';
      if (compact) {
        return `<div class="settle-head"><div class="settle-sub">${prefix}流局（${flowLabel}）${ting ? '，听牌者：' + ting : ''}</div></div>` + settleHands;
      }
      return `
        <div class="settle-head"><div class="settle-sub">牌墙剩 6 墩，流局（无分差，${flowLabel}）</div></div>
        <div class="settle-sub">${ting ? '听牌者：' + ting : '无人听牌'}</div>
          ${paymentTableHtml(result)}
        ${settleHands}`;
    }
    const winner = result.hands && result.hands[result.winnerSeat];
    const winLabel = winLabelOf(result.winType);
    const multText = isAdd
      ? ((result.addNames && result.addNames.length) ? result.addNames.join('、') : '平胡')
      : (result.multNames && result.multNames.length ? result.multNames.join('、') : '平胡');
    const calcText = isAdd
      ? `${result.tilePoints}点${result.winType === 'zimo' ? ' × 2' : ''}${result.addPoints ? ' + ' + result.addPoints + '分' : ''}${result.zhuangBonus ? ' + 庄底' + result.zhuangBonus : ''}`
      : result.winType === 'zimo'
        ? `${result.tilePoints}点 × 2 × ${result.mult}倍${result.zhuangBonus ? ' + 庄底' + result.zhuangBonus : ''}`
        : `${result.tilePoints}点 × ${result.mult}倍${result.zhuangBonus ? ' + 庄底' + result.zhuangBonus : ''}`;
    const shooterNote = result.winType !== 'zimo'
      ? (result.discarderTing ? ' · 放炮者已报听，三家各出1份' : ' · 放炮者未报听，独赔3份')
      : '';
    const shooterNoteParen = result.winType !== 'zimo'
      ? (result.discarderTing ? '（放炮者已报听，三家各出1份）' : '（放炮者未报听，独赔3份）')
      : '';
    if (compact) {
      return `<div class="settle-head">
        <div class="settle-sub">${prefix}${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)} · ${multText} · ${calcText}${shooterNoteParen} → ${result.score >= 0 ? '+' : ''}${result.score} 分</div>
        </div>${paymentTableHtml(result)}` + settleHands;
    }
    return `
      <div class="settle-head">
        <div class="settle-big">${result.score >= 0 ? '+' : ''}${result.score}</div>
        <div class="settle-sub">胡 ${tileText(result.tile)} · ${multText}${isAdd ? `（+${result.addPoints || 0}）` : `（×${result.mult}）`}</div>
        <div class="settle-sub">${calcText}${shooterNote}</div>
        </div>
      ${paymentTableHtml(result)}
      ${settleHands}`;
  }

  function showSettlement(result) {
    if (!result) return;
    const title = $('#settle-title');
    const content = $('#settle-content');
    // ===== 136 张玩法结算：点数 × 牌型倍数（详情统一由 buildSettleHtml 渲染）=====
    if (result.type === 'draw') {
      // 流局：剩 6 墩无人胡，公开听牌者 / 杠分
      title.textContent = '流局';
    } else {
      const ws = result.winner != null ? result.winner : result.winnerSeat;
      const winner = result.hands && result.hands[ws];
      const winLabel = winLabelOf(result.winType);
      title.textContent = `${winner ? winner.name : ''} ${winLabel}！`;
    }
    content.innerHTML = buildSettleHtml(result, { winnerLabel: '（胡）' });
    $('#settle-modal').classList.remove('hidden');
  }

  // 结算确认区：每位玩家「已确认 / 待确认」+ 自己的「确定」按钮
  function renderSettleConfirm(confirms) {
    const wrap = $('#settle-confirm');
    const btn = $('#settle-confirm-btn');
    const close = $('#settle-close');
    const room = state.room;
    if (!room || !confirms) {
      wrap.classList.add('hidden');
      btn.classList.add('hidden');
      close.classList.remove('hidden');
      return;
    }
    // 确认阶段不允许关闭弹窗，必须点「确定」
    close.classList.add('hidden');
    wrap.classList.remove('hidden');
    let mySeat = state.game ? state.game.yourSeat : -1;
    if (mySeat < 0) mySeat = room.players.findIndex((pl) => pl && pl.id === state.playerId);
    const players = room.players || [];
    // 取本局得分用于确认行展示（game.players[s].roundScore 为各家本局分）
    const gp = (state.game && state.game.players) || [];
    wrap.innerHTML =
      `<div class="settle-confirm-title">本局结算确认（全员确认后开始下一局）</div>` +
      players
        .map((pl, s) => {
          if (!pl) return '';
          const rs = gp[s] && typeof gp[s].roundScore === 'number' ? gp[s].roundScore : null;
          const rsHtml = rs === null
            ? ''
            : `<span class="rs ${rs >= 0 ? 'up' : 'down'}">本局 ${rs >= 0 ? '+' : ''}${rs}</span>`;
          return `<div class="settle-confirm-row ${confirms[s] ? 'ok' : 'wait'}">
                 <span class="nm">${esc(pl.name)}${s === mySeat ? '（我）' : ''}</span>
                 ${rsHtml}
                 <span class="st">${confirms[s] ? '已确认' : '待确认'}</span>
               </div>`;
        })
        .join('');
    if (mySeat >= 0 && !confirms[mySeat]) {
      btn.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = '确定';
      btn.onclick = () => {
        send({ type: 'settle_confirm' });
        // 乐观更新：等待服务端广播回写全员状态
        btn.classList.add('hidden');
      };
    } else {
      btn.classList.add('hidden');
    }
  }

  function showSettleModal() {
    // 房间总战绩结算
    const room = state.room;
    const title = $('#settle-title');
    const content = $('#settle-content');
    title.textContent = '🏆 房间结算';
    let html = '';
    const w = state.game && state.game.winners;
    if (w) {
      if (w.type === 'hu') {
        html += buildSettleHtml(w, { prefix: '最后一局：', winnerLabel: '（赢）', compact: true });
      } else {
        html += buildSettleHtml(w, { prefix: '最后一局：', compact: true });
      }
    }
    html += settleRankRowsHtml(room.players);
    content.innerHTML = html;
    $('#settle-modal').classList.remove('hidden');
  }

  // ================= 弹窗 =================
  function showModal(id) { $('#' + id).classList.remove('hidden'); }
  function hideModal(id) { $('#' + id).classList.add('hidden'); }

  // ================= 复盘回放（本局操作日志逐条播放） =================
  const replayState = { steps: [], idx: 0, timer: null };
  function openReplay() {
    const room = state.room;
    const logs = (room && room.logs) || [];
    replayState.steps = logs.slice(); // 正序（服务端已是时间正序追加）
    replayState.idx = 0;
    replayStop();
    renderReplay();
    showModal('replay-modal');
  }
  function replayStop() {
    if (replayState.timer) { clearInterval(replayState.timer); replayState.timer = null; }
  }
  function renderReplay() {
    const steps = replayState.steps;
    const idx = replayState.idx;
    const list = $('#replay-list');
    const prog = $('#replay-progress');
    const playBtn = $('#replay-play');
    if (!steps.length) {
      list.innerHTML = '<div class="empty">本局暂无操作记录</div>';
      if (prog) prog.textContent = '0 / 0';
      if (playBtn) { playBtn.textContent = '播放'; playBtn.disabled = true; }
      return;
    }
    // 高亮当前步，之前步骤已播放、之后步骤待播放
    list.innerHTML = steps.map((l, i) => {
      const cls = i < idx ? 'played' : i === idx ? 'current' : 'pending';
      return `<div class="replay-step ${cls}"><span class="t">${l.time}</span>${esc(l.text)}</div>`;
    }).join('');
    if (prog) prog.textContent = `${idx + 1} / ${steps.length}`;
    if (playBtn) { playBtn.textContent = replayState.timer ? '暂停' : '播放'; playBtn.disabled = false; }
    // 当前步滚动到可见
    const cur = list.querySelector('.replay-step.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function replayStep(delta) {
    const n = replayState.steps.length;
    if (!n) return;
    replayState.idx = Math.max(0, Math.min(n - 1, replayState.idx + delta));
    renderReplay();
  }
  function replayToggle() {
    if (replayState.timer) { replayStop(); renderReplay(); return; }
    // 已到末尾则从头开始
    if (replayState.idx >= replayState.steps.length - 1) replayState.idx = -1;
    replayState.timer = setInterval(() => {
      if (replayState.idx >= replayState.steps.length - 1) { replayStop(); renderReplay(); return; }
      replayState.idx += 1;
      renderReplay();
    }, 900);
    renderReplay();
  }
  function bindReplay() {
    const rb = $('#settle-replay');
    if (rb) rb.onclick = openReplay;
    const prev = $('#replay-prev'); if (prev) prev.onclick = () => replayStep(-1);
    const next = $('#replay-next'); if (next) next.onclick = () => replayStep(1);
    const play = $('#replay-play'); if (play) play.onclick = replayToggle;
    const close = $('#replay-close'); if (close) close.onclick = () => { replayStop(); hideModal('replay-modal'); };
  }

  function initCreateModal() {
    const koudianTip = '未满 4 人时由 AI 自动补位；关闭则需等满 4 名真人开局。136 张民间通用版（万条筒+东南西北中发白）：计分模型可选乘算（点数×牌型倍数）或加算（底分+固定加番，清一色/一条龙/七小对+20、豪七额外+40）；庄底默认关闭（开启后仅庄家胡牌单边加分：非自摸+5/自摸+10，输家不额外扣分；闲家胡无庄底）；报听需听牌中含 6 点及以上牌并扣一张牌上架，报听后禁碰只可杠、摸牌即打；胡牌受点数限制（1/2 点不能胡，3/4/5 点只能自摸，6/7/8/9/字牌=10 点可点炮可自摸）。';
    const hongzhongTip = '红中麻将（112 张，无风）：红中为万能癞子，可代替任意牌；只能自摸或抢杠胡，不能点炮；抢杠仅抢补杠（暗杠不可抢），被抢者按（1手底注+中码数×底注）×3包赔三家；杠牌当场结算（放杠2手、补杠每家1手、暗杠每家2手）；扎码：胡牌后从牌墙翻码，1/5/9 万筒条及红中为中码，每张中码倍数翻一倍；流局庄家连庄。';
    const tiejinTip = '运城贴金麻将（136 张，无花）：翻牌定金母定金牌（序数牌 10-点数、发财即发财、风箭按对牌），金牌亮出为「亮金」独立操作（摸牌后、出牌前亮出金牌摆面前、牌尾补一张、手牌数不变），金牌不可当普通牌打出；首金必须亮出（手握首金未亮时，本回合只能亮金，亮金前不能出牌/碰/杠/胡；牌墙已尽无法亮金时不受此限）；亮金一次才有点炮胡资格，亮金区独立展示，三金封顶；连续亮金两张自动锁金（锁定其他三家只能自摸，被锁者累计上金两张解锁）；可碰可杠不可吃，无报听；牌型支持七小对×2、豪华七小对×4（金牌可当万能凑对，加番只放胡牌分不翻金分）；包胡：牌墙剩最后 4 张时点炮，放炮者独赔三家；点炮可截胡，过胡在获抓牌权前不能再胡；抢杠算点炮胡（明杠可抢、暗杠不可抢）；字牌整副胡只能自摸且金牌不代；流局模式 A 摸完 / B 剩 10 墩，计分 A 边趣 / B 125，流局杠分不计；谁胡谁坐庄。';
    buildSeg('seg-variant', ['koudian', 'hongzhong', 'tiejin'], (v) => (v === 'hongzhong' ? '红中麻将' : v === 'tiejin' ? '贴金麻将' : '扣点点'), (v) => {
      const hz = v === 'hongzhong';
      const tj = v === 'tiejin';
      $('#settings-hz').classList.toggle('hidden', !hz);
      $('#settings-tiejin').classList.toggle('hidden', !tj);
      $('#settings-136').classList.toggle('hidden', hz || tj);
      $('#create-tip').textContent = hz ? hongzhongTip : tj ? tiejinTip : koudianTip;
    });
    buildSeg('seg-rounds', [4, 8, 12, 0], (v) => (v === 0 ? '不限' : v + ' 局'));
    buildSeg('seg-roomtype', ['public', 'friend'], (v) => (v === 'public' ? '公共局（大厅可见）' : '好友局（仅受邀）'));
    buildSeg('seg-score-model', ['multiply', 'add'], (v) => (v === 'add' ? '加分（固定加番）' : '乘算（倍数）'), applyScoreModelPanel);
    applyScoreModelPanel();
    buildSeg('seg-dealer-flow', ['next', 'keep'], (v) => (v === 'keep' ? '连庄' : '下家接庄'));
    buildSeg('seg-zha-ma', [0, 1, 2, 4, 6], (v) => (v === 0 ? '关' : v + ' 张'));
    buildSeg('seg-draw-end', ['A', 'B'], (v) => (v === 'B' ? 'B 剩10墩流局' : 'A 摸完流局'));
    buildSeg('seg-score-mode', ['A', 'B'], (v) => (v === 'B' ? 'B 125体系' : 'A 边趣计分'));
    $('#create-cancel').onclick = () => hideModal('create-modal');
    $('#settle-close').onclick = () => hideModal('settle-modal');
    bindReplay();
    $('#create-confirm').onclick = () => {
      const variant = segValue('seg-variant');
      const totalRounds = segValue('seg-rounds');
      const aiFill = $('#opt-aifill').checked;
      const roomType = segValue('seg-roomtype') === 'public' ? 'public' : 'friend';
      const base = { totalRounds, aiFill, roomType };
      if (variant === 'hongzhong') {
        send({ type: 'create_room', settings: {
          ...base,
          variant: 'hongzhong',
          zhaMa: segValue('seg-zha-ma'),
        } });
      } else if (variant === 'tiejin') {
        send({ type: 'create_room', settings: {
          ...base,
          variant: 'tiejin',
          drawEndMode: segValue('seg-draw-end'),
          scoreMode: segValue('seg-score-mode'),
        } });
      } else {
        const enableQingYiSe = $('#opt-qingyise').checked;
        const enableYiTiaoLong = $('#opt-yitiaolong').checked;
        const enableShiSanYao = $('#opt-shisanyao').checked;
        const dealerFlow = segValue('seg-dealer-flow') === 'keep' ? 'keep' : 'next';
        const scoreModel = segValue('seg-score-model') === 'add' ? 'add' : 'multiply';
        send({ type: 'create_room', settings: {
          ...base,
          variant: 'koudian',
          dealerFlow,
          scoreModel,
          zhuangDi: $('#opt-zhuangdi').checked,
          enableQingYiSe, qingYiSeMult: Number($('#opt-qingyise-mult').value) || 4,
          enableYiTiaoLong, yiTiaoLongMult: Number($('#opt-yitiaolong-mult').value) || 4,
          enableShiSanYao, shiSanYaoMult: Number($('#opt-shisanyao-mult').value) || 8,
        } });
      }
      hideModal('create-modal');
    };
  }

  // 计分模型联动：add=加分（固定加番）时隐藏牌型倍数开关及倍数输入框；multiply=乘算时恢复显示
  function applyScoreModelPanel() {
    const panel = $('#panel-mult-switches');
    if (!panel) return;
    const add = segValue('seg-score-model') === 'add';
    panel.classList.toggle('hidden', add);
  }
  function buildSeg(containerId, values, labelFn, onChange) {
    const c = $('#' + containerId);
    c.innerHTML = values.map((v, i) =>
      `<button class="seg-item ${i === 0 ? 'active' : ''}" data-value="${v}">${labelFn(v)}</button>`).join('');
    c.querySelectorAll('.seg-item').forEach((b) => {
      b.onclick = () => {
        c.querySelectorAll('.seg-item').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        if (onChange) onChange(b.dataset.value);
      };
    });
  }
  function segValue(containerId) {
    const el = $('#' + containerId + ' .seg-item.active');
    if (!el) return '';
    const v = el.dataset.value;
    return /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
  }

  // ================= 其它 UI =================
  let toastTimer = null;
  function toast(text, isError, ms) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 2600);
  }

  function showConnMask(text) {
    $('#conn-text').textContent = text || '连接断开，正在重连…';
    $('#conn-mask').classList.remove('hidden');
  }
  function hideConnMask() {
    $('#conn-mask').classList.add('hidden');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ================= 语音播报 =================
  // 播报走后端预合成缓存：同源 GET /api/tts/audio?text=&voice= 返回已缓存音频 URL（/tts/<voice>/<hash>.mp3），
  // 由麻将 Node 服务在后台调用独立 TTS 服务预合成落盘，前端不再实时跨端口合成，消除出牌播报延迟；
  // 请求失败（服务未启动/网络错误/非 2xx）时降级 Web Speech API（zh-CN）；
  // 出牌报牌名，碰/杠/暗杠/补杠/吃/胡报动作词；
  // 声音选择存 localStorage('kd.voice')：male 男声 / female 女声 / mute 无声，默认无声；
  // 已有用户保存过男声/女声则保持其选择不变（仅影响未设置过的新用户默认值）；
  // 页面加载即 fire-and-forget 触发 /api/tts/warmup 预热常用播报文本；
  // AI（isAI 座位）打牌/碰/杠/胡等动作不播报，仅真人玩家动作播报
  const VOICE_KEY = 'kd.voice';
  const VOICE_GAP_MS = 500; // 同一事件 500ms 内不重复播报
  const ttsCache = new Map(); // key: text|voice -> audio_url，同文本同性别不重复请求
  function readVoiceMode() {
    const v = store.getItem(VOICE_KEY);
    return (v === 'male' || v === 'female' || v === 'mute') ? v : 'mute';
  }
  const voiceState = {
    mode: readVoiceMode(),
    maleVoice: null,
    femaleVoice: null,
    lastSpeakAt: new Map(), // eventKey -> timestamp
    baselineReady: false,
    prevDiscardCounts: [],
    prevMelds: [],
    prevTing: [],
    hadWinners: false,
  };

  const SPEECH_NUM_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const SPEECH_HONOR = { e: '东风', s: '南风', x: '西风', n: '北风', z: '红中', f: '发财', p: '白板' };
  // zh-CN 语音按名称启发式匹配性别：常见女声（Huihui/Yaoyao/Xiaoxiao/Yunxi 等）与男声（YunJian/YunYang 等）
  const SPEECH_FEMALE_RE = /huihui|yaoyao|xiaoxiao|yunxi|xiaoyi|meijia|tingting|female|女/i;
  const SPEECH_MALE_RE = /yunjian|yunyang|kangkang|male|男/i;

  function speechSupported() {
    return !!(window.speechSynthesis && typeof window.speechSynthesis.speak === 'function');
  }

  // 牌码 -> 播报文本："w5" -> "五万"、"z" -> "红中"
  function tileSpeech(t) {
    if (!t || t === 'back') return '';
    if (SPEECH_HONOR[t]) return SPEECH_HONOR[t];
    const num = Number(t.slice(1));
    const suit = t[0] === 'w' ? '万' : t[0] === 't' ? '条' : '筒';
    return (SPEECH_NUM_CN[num] || num) + suit;
  }

  function pickVoice(gender) {
    if (!speechSupported()) return null;
    let voices = [];
    try { voices = window.speechSynthesis.getVoices() || []; } catch (e) { voices = []; }
    const zh = voices.filter((v) => /^zh/i.test(v.lang || ''));
    if (!zh.length) return null;
    const re = gender === 'female' ? SPEECH_FEMALE_RE : SPEECH_MALE_RE;
    return zh.find((v) => re.test(v.name || '')) || zh[0];
  }

  function setVoiceMode(mode) {
    voiceState.mode = (mode === 'male' || mode === 'female' || mode === 'mute') ? mode : 'mute';
    store.setItem(VOICE_KEY, voiceState.mode);
    // 切换后立即刷新目标语音缓存，下次播报即用新声音
    voiceState.femaleVoice = pickVoice('female');
    voiceState.maleVoice = pickVoice('male');
  }

  // 同源请求后端预合成缓存音频并播放；失败时抛出，由调用方降级到 Web Speech。
  // currentTtsAudio：新播报先打断上一条，避免快速连发事件（碰+杠等）声音叠加。
  let currentTtsAudio = null;
  async function playViaTTS(text) {
    const key = text + '|' + voiceState.mode;
    let audioUrl = ttsCache.get(key);
    if (!audioUrl) {
      const resp = await fetch('/api/tts/audio?text=' + encodeURIComponent(text) + '&voice=' + encodeURIComponent(voiceState.mode));
      if (!resp.ok) throw new Error('TTS http ' + resp.status);
      const data = await resp.json();
      if (!data || !data.url) throw new Error('TTS no url');
      audioUrl = data.url;
      ttsCache.set(key, audioUrl);
    }
    if (currentTtsAudio) {
      try { currentTtsAudio.pause(); } catch (e) { /* 打断失败忽略 */ }
    }
    const audio = new Audio(audioUrl);
    currentTtsAudio = audio;
    audio.play().catch(() => { /* 播放失败静默 */ });
  }

  // Web Speech 降级播报
  function speakViaSpeech(text) {
    // 无 Web Speech 支持/无声卡：静默降级，不抛错不阻塞交互
    if (!speechSupported()) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1;
      const v = voiceState.mode === 'female' ? voiceState.femaleVoice : voiceState.maleVoice;
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 静默降级 */ }
  }

  function speakText(text, eventKey) {
    if (!text) return;
    // 无声：全局静默跳过（不占用节流 key，切回后立即恢复）
    if (voiceState.mode === 'mute') return;
    // 页面不可见：静默跳过
    if (document.hidden || document.visibilityState === 'hidden') return;
    // 同一事件 500ms 内不重复
    const now = Date.now();
    if (eventKey) {
      const last = voiceState.lastSpeakAt.get(eventKey);
      if (last != null && now - last < VOICE_GAP_MS) return;
      voiceState.lastSpeakAt.set(eventKey, now);
    }
    // 优先本地 TTS；请求失败降级 Web Speech；两者皆不可用时静默不抛错
    playViaTTS(text).catch(() => speakViaSpeech(text));
  }

  function refreshVoicesCache() {
    voiceState.femaleVoice = pickVoice('female');
    voiceState.maleVoice = pickVoice('male');
  }

  function initVoice() {
    refreshVoicesCache();
    if (speechSupported() && window.speechSynthesis.addEventListener) {
      window.speechSynthesis.addEventListener('voiceschanged', refreshVoicesCache);
    }
    // 页面加载即触发后端预合成预热（fire-and-forget，不等待不阻塞）
    if (window.fetch) {
      fetch('/api/tts/warmup').catch(() => { /* 预热失败静默，播报时按需合成 */ });
    }
    // 大厅声音选择控件（进大厅前选择，默认无声）
    const seg = $('#seg-voice');
    if (seg) {
      seg.querySelectorAll('.seg-item').forEach((b) => {
        b.classList.toggle('active', b.dataset.value === voiceState.mode);
        b.onclick = () => {
          seg.querySelectorAll('.seg-item').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          setVoiceMode(b.dataset.value);
        };
      });
    }
  }

  // ===== 手牌点击设置 =====
  // 「单击直接出牌」个人全局设置：默认关闭（走选中交互），勾选后点击手牌直接打出（给熟手提速）
  const TAP_KEY = 'kd.tapToDiscard';
  function isTapToDiscard() {
    const el = $('#opt-tap-discard');
    return !!(el && el.checked);
  }
  function initTapToDiscard() {
    const el = $('#opt-tap-discard');
    if (!el) return;
    el.checked = store.getItem(TAP_KEY) === '1';
    el.addEventListener('change', () => {
      store.setItem(TAP_KEY, el.checked ? '1' : '0');
      if (el.checked) {
        // 开启直接出牌：移除已有选中态并重绘
        clearTileSelection();
        if (state.room && state.room.state === 'playing' && state.game) renderTable();
      }
    });
  }

  function resetVoiceBaseline() {
    voiceState.baselineReady = false;
    voiceState.prevDiscardCounts = [];
    voiceState.prevMelds = [];
    voiceState.prevTing = [];
    voiceState.hadWinners = false;
  }

  function meldSig(m) {
    return (m.type || '') + ':' + (m.tile || '') + ':' + ((m.tiles || []).join(''));
  }

  // 基于每次 game_state 广播做增量检测：出牌、碰/杠/吃、胡
  function checkSpeakEvents(game) {
    if (!game || !game.players) return;
    if (!voiceState.baselineReady) {
      // 首次进入牌局：只建立基线，不播报历史动作，避免把已发生的出牌/明面全报一遍
      for (let seat = 0; seat < game.players.length; seat++) {
        const p = game.players[seat];
        if (!p) continue;
        voiceState.prevDiscardCounts[seat] = (p.discards || []).length;
        voiceState.prevMelds[seat] = (p.melds || []).map(meldSig);
        voiceState.prevTing[seat] = !!p.ting;
      }
      voiceState.hadWinners = !!game.winners;
      voiceState.baselineReady = true;
      return;
    }
    // 出牌：废牌堆新增非牌背牌（'back' 为报听暗扣，不播报）；AI 动作不播报（音效对所有玩家播）
    for (let seat = 0; seat < game.players.length; seat++) {
      const p = game.players[seat];
      if (!p) continue;
      const discs = p.discards || [];
      const prev = voiceState.prevDiscardCounts[seat] || 0;
      if (discs.length > prev) {
        const last = discs[discs.length - 1];
        if (last && last !== 'back') {
          if (!p.isAI) speakText(tileSpeech(last), 'discard:' + seat + ':' + last);
          playSfx('discard');
        }
      }
      voiceState.prevDiscardCounts[seat] = discs.length;
    }
    // 报听：非 AI 玩家由未报听 -> 报听（ting false -> true）时播报
    for (let seat = 0; seat < game.players.length; seat++) {
      const p = game.players[seat];
      if (!p) continue;
      const nowTing = !!p.ting;
      if (nowTing && !voiceState.prevTing[seat]) {
        if (!p.isAI) speakText('报听', 'ting:' + seat);
        playSfx('ting');
      }
      voiceState.prevTing[seat] = nowTing;
    }
    // 碰/杠/暗杠/补杠/吃：明面新增（补杠表现为同一明面由 peng 转为 bugang）；AI 动作不播报（音效对所有玩家播）
    for (let seat = 0; seat < game.players.length; seat++) {
      const p = game.players[seat];
      if (!p) continue;
      const cur = (p.melds || []).map(meldSig);
      const prev = voiceState.prevMelds[seat] || [];
      for (const cs of cur) {
        if (!prev.includes(cs)) {
          const type = cs.split(':')[0];
          const word = type === 'peng' ? '碰' : type === 'gang' ? '杠' : type === 'angang' ? '暗杠' : type === 'bugang' ? '补杠' : type === 'chi' ? '吃' : '';
          if (word) {
            if (!p.isAI) speakText(word, 'meld:' + seat + ':' + cs);
            playSfx(type === 'peng' ? 'peng' : type === 'gang' || type === 'angang' || type === 'bugang' ? 'gang' : 'click');
          }
        }
      }
      voiceState.prevMelds[seat] = cur;
    }
    // 胡：winners 由无到有（点炮/自摸/抢杠胡）；AI 胡牌不播报（音效对所有玩家播）
    if (game.winners && !voiceState.hadWinners) {
      if (game.winners.type === 'hu') {
        const ws = game.winners.winner != null ? game.winners.winner : game.winners.winnerSeat;
        const winner = game.players[ws];
        const wt = game.winners.winType;
        if (!winner || !winner.isAI) {
          speakText(wt === 'zimo' ? '自摸' : wt === 'qianggang' ? '抢杠胡' : '胡了', 'hu:' + game.roundNo);
        }
        playSfx(wt === 'zimo' ? 'zimo' : 'hu');
      }
    }
    voiceState.hadWinners = !!game.winners;
  }

  // ================= 对局音效（Web Audio 合成，无音频文件） =================
  // 出牌/碰/杠/胡等动作播放短促合成音，增强手感；AI 动作不播报（与语音播报一致）
  // 声音开关独立存 localStorage('kd.sfx')：on 开 / off 关，默认开
  const SFX_KEY = 'kd.sfx';
  let sfxCtx = null; // 懒初始化 AudioContext（首次用户交互后才可发声）
  function readSfxOn() {
    const v = store.getItem(SFX_KEY);
    return v !== 'off'; // 未设置或非 off 一律视为开
  }
  let sfxOn = readSfxOn();
  function sfxEnsureCtx() {
    if (sfxCtx) return sfxCtx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      sfxCtx = new AC();
    } catch (e) { sfxCtx = null; }
    return sfxCtx;
  }
  // 合成一个短音：freq 起始频率 / endFreq 结束频率（滑音）/ dur 时长 / type 波形 / gain 音量
  function sfxTone(freq, endFreq, dur, type, gain) {
    const ctx = sfxEnsureCtx();
    if (!ctx) return;
    try {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (endFreq && endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
      g.gain.setValueAtTime(gain || 0.2, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    } catch (e) { /* 合成失败静默 */ }
  }
  // 各动作音效：出牌=短促中音、碰=双音上行、杠=三音下行、胡=上行琶音、自摸=长上行
  function playSfx(kind) {
    if (!sfxOn) return;
    if (document.hidden || document.visibilityState === 'hidden') return;
    switch (kind) {
      case 'discard': sfxTone(660, 520, 0.08, 'triangle', 0.12); break;
      case 'peng': sfxTone(520, 520, 0.06, 'square', 0.14); setTimeout(() => sfxTone(780, 780, 0.08, 'square', 0.14), 60); break;
      case 'gang': sfxTone(392, 392, 0.06, 'square', 0.16); setTimeout(() => sfxTone(494, 494, 0.06, 'square', 0.16), 70); setTimeout(() => sfxTone(587, 587, 0.09, 'square', 0.16), 140); break;
      case 'ting': sfxTone(880, 880, 0.1, 'sine', 0.15); break;
      case 'hu': sfxTone(523, 784, 0.16, 'triangle', 0.2); setTimeout(() => sfxTone(659, 988, 0.2, 'triangle', 0.2), 120); break;
      case 'zimo': sfxTone(440, 880, 0.28, 'triangle', 0.22); setTimeout(() => sfxTone(554, 1109, 0.3, 'triangle', 0.22), 140); break;
      case 'click': sfxTone(400, 400, 0.04, 'square', 0.08); break;
      default: break;
    }
  }
  // 音效开关：仅切换标记，AudioContext 懒创建（避免自动播放策略拦截）
  function setSfxOn(on) {
    sfxOn = !!on;
    store.setItem(SFX_KEY, sfxOn ? 'on' : 'off');
    updateSfxBtn();
  }
  function updateSfxBtn() {
    const btn = $('#btn-sfx');
    if (btn) btn.classList.toggle('sfx-on', sfxOn);
  }
  function initSfx() {
    updateSfxBtn();
    const btn = $('#btn-sfx');
    if (btn) btn.onclick = () => setSfxOn(!sfxOn);
  }

  // ================= 事件绑定 =================
  function bindEvents() {
    $('#join-lobby-btn').onclick = () => {
      const name = $('#nick-input').value.trim();
      if (!name) { toast('请输入昵称', true); return; }
      state.name = name;
      store.setItem('kd.name', name);
      // 已登录则带 token 关联账户（昵称会被账户 displayName 覆盖）；游客不带
      send({ type: 'join_lobby', name, token: state.token || undefined });
    };
    $('#join-room-btn').onclick = () => {
      const id = $('#join-room-input').value.trim();
      if (!/^\d{4}$/.test(id)) { toast('请输入 4 位房间号', true); return; }
      send({ type: 'join_room', roomId: id });
    };
    $('#nick-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join-lobby-btn').click(); });
    $('#join-room-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join-room-btn').click(); });
    $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    $('#chat-send-btn').onclick = sendChat;
    renderQuickChat();
    bindQuickChatEdit();
    renderEmojiBar();

    // 账号体系 UI 绑定
    $('#auth-btn').onclick = () => { setAuthMode('login'); showModal('auth-modal'); };
    $('#auth-cancel').onclick = () => hideModal('auth-modal');
    $('#auth-submit').onclick = submitAuth;
    $('#history-btn').onclick = openHistory;
    $('#history-close').onclick = () => hideModal('history-modal');
    $('#leaderboard-btn').onclick = openLeaderboard;
    $('#leaderboard-close').onclick = () => hideModal('leaderboard-modal');
    $('#friends-btn').onclick = openFriends;
    $('#friends-close').onclick = () => hideModal('friends-modal');
    $('#friend-add-btn').onclick = addFriend;
    $('#friend-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFriend(); });
    // 好友请求/列表内的接受、忽略、删除（事件委托）
    $('#friends-modal').addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset.accept) send({ type: 'accept_friend', username: t.dataset.accept, token: state.token });
      else if (t.dataset.decline) send({ type: 'decline_friend', username: t.dataset.decline, token: state.token });
      else if (t.dataset.remove) {
        if (confirm('确定删除该好友？')) send({ type: 'remove_friend', username: t.dataset.remove, token: state.token });
      }
    });
    $('#invite-close').onclick = () => hideModal('invite-modal');
    $('#logout-btn').onclick = () => { send({ type: 'logout', token: state.token }); };
    // 账号设置 UI 绑定
    $('#account-btn').onclick = openAccount;
    $('#account-close').onclick = () => hideModal('account-modal');
    $('#account-name-save').onclick = submitNameChange;
    $('#account-password-save').onclick = submitPasswordChange;
    $('#account-delete').onclick = submitDeleteAccount;
    $('#account-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNameChange(); });
    $('#account-new-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPasswordChange(); });
    $$('#seg-auth .seg-item').forEach((b) => { b.onclick = () => setAuthMode(b.dataset.value); });
    $('#auth-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
    renderAuthBar();
    $('#create-room-btn').onclick = () => { applyScoreModelPanel(); showModal('create-modal'); };

    document.addEventListener('click', (e) => {
      const joinBtn = e.target.closest('[data-join]');
      if (joinBtn && !joinBtn.disabled) {
        send({ type: 'join_room', roomId: joinBtn.dataset.join });
      }
      const specBtn = e.target.closest('[data-spectate]');
      if (specBtn) {
        send({ type: 'join_room', roomId: specBtn.dataset.spectate, spectate: true });
      }
      const tab = e.target.closest('.tab');
      if (tab) {
        $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        $$('.tab-content').forEach((c) => c.classList.toggle('active', c.id === 'tab-' + tab.dataset.tab));
      }
    });
  }

  function sendChat() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    sendChatText(text);
    input.value = '';
  }

  function sendChatText(text) {
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    send({ type: 'chat', text });
  }

  // ================= 启动 =================
  // 移动端浏览器工具栏遮挡修复：100vh 在手机浏览器含地址栏/底部工具栏，
  // 用真实可视视口高度（visualViewport / innerHeight）重算 room-body 高度；
  // Android 浏览器（Chrome/微信等）横屏时底部工具栏悬浮覆盖页面，需额外预留空间
  function fitViewportHeight() {
    const body = $('.room-body');
    if (!body) return;
    const header = $('.room-header');
    const vh = (window.visualViewport && window.visualViewport.height) ||
               window.innerHeight || document.documentElement.clientHeight;
    const hh = header ? header.offsetHeight : 52;
    // Android 底部工具栏（含手势条）约 56px；竖屏可随滚动收起，横屏常驻，故横屏必留
    const isAndroid = /Android/i.test(navigator.userAgent || '');
    const isLandscape = window.matchMedia && window.matchMedia('(orientation: landscape)').matches;
    const bottom = (isAndroid && isLandscape) ? 56 : 0;
    body.style.height = Math.max(Math.round(vh - hh - bottom), 200) + 'px';
  }
  window.addEventListener('resize', fitViewportHeight);
  window.addEventListener('orientationchange', () => setTimeout(fitViewportHeight, 300));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewportHeight);
  }

  // 登录后用账号昵称回填大厅昵称框并锁定（服务端 join_lobby 只认 displayName，手填无效）
  // 退出登录后恢复可编辑，游客仍需自行输入昵称
  function syncNickInput() {
    const input = document.getElementById('nick-input');
    if (!input) return;
    const hint = document.getElementById('nick-hint');
    if (state.token) {
      input.value = state.displayName || state.username || '';
      input.disabled = true;
      input.classList.add('from-account');
      input.placeholder = '已使用账号昵称';
      if (hint) { hint.textContent = '昵称取自账号，无需再填'; hint.classList.remove('hidden'); }
    } else {
      input.disabled = false;
      input.classList.remove('from-account');
      input.placeholder = '输入昵称（1-12 个字）';
      if (hint) hint.classList.add('hidden');
    }
  }

  function init() {
    syncNickInput();
    initCreateModal();
    initVoice();
    initSfx();
    initTapToDiscard();
    bindEvents();
    connect();
    // 浏览器工具栏显隐有延迟，多等几次再校准高度，避免刚进入房间时底部被盖
    fitViewportHeight();
    [300, 900, 2000].forEach((ms) => setTimeout(fitViewportHeight, ms));
  }
  init();
})();
