'use strict';

/**
 * 纯工具方法（GameServer mixin）
 *
 * 从 game.js 拆出：名称清洗、日志（UI 日志 + 游戏落盘日志）、玩家快照、脱敏等。
 * 零游戏状态依赖（仅引用 nowTime / MAX_LOGS），通过 Object.assign 混入。
 */

const MAX_LOGS = 200;

function nowTime() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

const utilsMixin = {
  _sanitizeName(name) {
    if (typeof name !== 'string') return '';
    let n = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (n.length > 12) n = n.slice(0, 12);
    return n;
  },

  _log(room, text, privateFor, maskedText) {
    if (!room) return;
    const entry = { time: nowTime(), text };
    if (typeof privateFor === 'number') entry.privateFor = privateFor;
    if (typeof maskedText === 'string') entry.maskedText = maskedText;
    room.logs.push(entry);
    if (room.logs.length > MAX_LOGS) room.logs.shift();
  },

  /** 游戏日志落盘：结构化记录本局事件（round_start / action / round_end），与 UI 日志 _log 互不影响 */
  _logGame(room, type, data) {
    if (!this.gameLogger) return;
    this.gameLogger.append(room, type, data);
  },

  /** 玩家列表快照（seat / name / isAI / 累计积分 / 本局积分） */
  _logPlayers(room) {
    return (room.players || [])
      .filter(Boolean)
      .map((pl) => ({
        seat: pl.seat,
        name: pl.name,
        isAI: !!pl.isAI,
        aiDifficulty: pl.aiDifficulty === 'hard' ? 'hard' : 'normal',
        score: pl.score || 0,
        roundScore: pl.roundScore || 0,
      }));
  },

  /** 按查看者视角脱敏日志：私有日志（privateFor）仅本人见完整文本，他人见 maskedText */
  _maskLogsForViewer(logs, viewerSeat) {
    return (logs || []).map((e) => {
      if (e && e.privateFor !== undefined && e.privateFor !== viewerSeat && typeof e.maskedText === 'string') {
        return { time: e.time, text: e.maskedText };
      }
      return e;
    });
  },

  _pName(room, seat) {
    const pl = room.players[seat];
    return pl ? pl.name : '空位';
  },

  _seatRef(pl) {
    return pl && pl.seat != null ? 's' + pl.seat : '';
  },

  /** 房间视图中的玩家 id：本人为真实 playerId，他人为座位代称 */
  _idForViewer(pl, viewerSeat) {
    if (!pl) return null;
    return pl.seat === viewerSeat ? pl.id : this._seatRef(pl);
  },
};

module.exports = utilsMixin;
