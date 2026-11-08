'use strict';

/**
 * 发送 / 广播 I/O 层（GameServer mixin）
 *
 * 从 game.js 拆出：把「消息序列化并发送到连接」的纯 I/O 逻辑集中于此，
 * 只依赖 this._send / 视图构建方法（仍留在 game.js 核心），不触碰玩法状态机。
 */

const ioMixin = {
  _send(p, obj) {
    if (p && p.ws && p.ws.readyState === 1) {
      try {
        p.ws.send(JSON.stringify(obj));
      } catch (e) {
        console.error('[game] send error:', e);
      }
    }
  },

  _sendWs(ws, obj) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {
        console.error('[game] sendWs error:', e);
      }
    }
  },

  _err(p, message) {
    this._send(p, { type: 'error', message });
    return null;
  },

  _broadcast(room, obj) {
    // 同一消息只序列化一次，全体接收者共用（原实现每个连接各 JSON.stringify 一遍）
    let raw = null;
    const sendRaw = (ws) => {
      if (ws && ws.readyState === 1) {
        try {
          if (raw === null) raw = JSON.stringify(obj);
          ws.send(raw);
        } catch (e) {
          console.error('[game] broadcast error:', e);
        }
      }
    };
    for (const pl of room.players) {
      if (pl && pl.ws) sendRaw(pl.ws);
    }
    // 旁观者也接收广播（聊天/表情/结算等），但不含任何手牌信息
    for (const v of room.viewers || []) {
      if (v && v.ws) sendRaw(v.ws);
    }
  },

  _prompt(room, seat, prompt) {
    const pl = room.players[seat];
    if (pl && pl.ws) this._send(pl, { type: 'action_prompt', prompt });
  },

  _broadcastGameState(room) {
    if (!room.game) return;
    for (let s = 0; s < 4; s++) {
      const pl = room.players[s];
      if (pl && pl.ws) {
        this._send(pl, { type: 'game_state', game: this._buildGameView(room, s) });
      }
    }
    // 旁观者：viewerSeat=-1，看不到任何手牌，仅明牌与流程
    for (const v of room.viewers || []) {
      if (v && v.ws) this._send(v, { type: 'game_state', game: this._buildGameView(room, -1) });
    }
  },

  _broadcastRoomState(room) {
    for (const pl of room.players) {
      if (pl && pl.ws) this._send(pl, { type: 'room_state', room: this._buildRoomView(room, pl.seat) });
    }
    for (const v of room.viewers || []) {
      if (v && v.ws) this._send(v, { type: 'room_state', room: this._buildRoomView(room, -1) });
    }
  },

  _sendSettlement(room, targetPlayer) {
    const g = room.game;
    if (!g || !g.winners) return;
    const msg = {
      type: 'settlement',
      result: g.winners,
      roundNo: g.roundNo,
      settings: room.settings,
    };
    // 携带本局确认状态（确认阶段 / 重连恢复用）
    if (room.settleConfirms) msg.confirms = room.settleConfirms.slice();
    if (targetPlayer) this._send(targetPlayer, msg);
    else this._broadcast(room, msg);
  },

  // 大厅房间列表：仅下发「房间号 / 状态 / 玩法设置 / 创建者昵称 / 人数」，
  // 无任何身份类字段：不含 ownerId、不含任何 playerId、不含 secret（已核对，无需再裁剪）。
  // 房间号保留是因为 public/app.js:425 的「加入」按钮依赖 r.id，砍掉会直接让大厅列表不可用；
  // 加入仍需房间号，且失败限频（JOIN_FAIL_LIMIT）已防暴力枚举。
  _lobbyRoomList() {
    // 大厅仅展示公共局（roomType === 'public'）；好友局只通过邀请进入，不进列表
    return [...this.rooms.values()]
      .filter((r) => r.settings && r.settings.roomType === 'public')
      .map((r) => ({
        id: r.id,
        state: r.state,
        settings: r.settings,
        // 逐座位人机难度（仅公开难度标签，不含任何身份字段）：房间列表可显示混合难度
        aiDifficulties: r.players
          .filter((pl) => pl && pl.isAI)
          .map((pl) => (pl.aiDifficulty === 'hard' ? 'hard' : 'normal')),
        ownerName: r.ownerName, // 创建者名称（房主转让/离开后仍保持原创建者）
        playerCount: r.players.filter(Boolean).length,
      }));
  },

  _sendLobbyState(p) {
    this._send(p, { type: 'lobby_state', rooms: this._lobbyRoomList() });
  },

  _broadcastLobby() {
    // 房间列表构建一次、序列化一次，全体大厅玩家共用（原实现每人各构建+序列化一遍）
    const rooms = this._lobbyRoomList();
    let raw = null;
    for (const p of this.players.values()) {
      if (p.ws && p.connected && !p.roomId && p.ws.readyState === 1) {
        try {
          if (raw === null) raw = JSON.stringify({ type: 'lobby_state', rooms });
          p.ws.send(raw);
        } catch (e) {
          console.error('[game] broadcastLobby error:', e);
        }
      }
    }
  },
};

module.exports = ioMixin;
