'use strict';

/**
 * 游戏日志模块（Game Logger）
 *
 * 职责：
 *  - 记录每一局牌局的完整详情（round_start / action / round_end），按天落盘到 logs 目录
 *    （logs/game-YYYY-MM-DD.jsonl，JSONL 每行一个事件）
 *  - 单文件超过阈值（默认 20MB）时按大小轮转：game-DAY.jsonl → game-DAY.1.jsonl → .2.jsonl
 *  - 自动清理超过 7 天的旧日志文件（含带序号的分片），仅保留最近 7 天
 *
 * 写入模型：
 *  - append() 只做「拼行 + 入队」，不阻塞事件循环；内部串行化写盘队列保证落盘顺序与调用顺序一致
 *  - flush()（异步）/ flushSync()（同步，退出冲刷用）可强制把队列落盘
 *  - 首次真正写入时才注册进程退出钩子（SIGINT/SIGTERM/beforeExit/exit）做冲刷，空数据时零开销
 *
 * 开关与目录：
 *  - 默认启用（生产/本地运行均落盘）；NODE_ENV === 'test' 或 MARVIS_GAME_LOG === '0' 时静默禁用
 *  - 目录优先取 MARVIS_GAME_LOG_DIR 环境变量（便于测试隔离），否则为项目根 logs 目录
 *  - 切分阈值取 opts.maxFileSize 或 MARVIS_GAME_LOG_MAX_SIZE（字节），默认 20MB
 *  - 文件名前缀取 opts.prefix（默认 'game-'）；AI 复盘日志用 'ai-' 复用同一套轮转/清理能力
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const RETENTION_DAYS = 7; // 日志保留天数
const FILE_PREFIX = 'game-';
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024; // 单文件切分阈值：20MB

// 需要冲刷的活跃日志器；钩子惰性安装（首次产生日志时），避免空载进程被拖慢退出
const registry = new Set();
let hooksInstalled = false;

function nowParts(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return { day: `${y}-${m}-${day}`, ts: `${y}-${m}-${day}T${hh}:${mm}:${ss}.${ms}` };
}

function isEnabled() {
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.MARVIS_GAME_LOG === '0') return false;
  return true;
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function normalizeMaxSize(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_MAX_FILE_SIZE;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_SIZE;
}

/** 注册退出冲刷钩子：SIGINT/SIGTERM 先异步冲刷再退出，beforeExit/exit 做同步兜底 */
function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const flushAllSync = () => {
    for (const l of registry) {
      try {
        l.flushSync();
      } catch {}
    }
  };
  const onSignal = (sig, code) => async () => {
    try {
      for (const l of registry) await l.flush();
    } catch {}
    process.exit(code); // 重新交还终止语义（默认行为已被监听器接管）
  };

  process.once('SIGINT', onSignal('SIGINT', 130));
  process.once('SIGTERM', onSignal('SIGTERM', 143));
  process.on('beforeExit', flushAllSync);
  process.on('exit', flushAllSync);
}

/**
 * 创建游戏日志器实例
 * @param {object} opts
 * @param {string} [opts.dir] 日志目录（默认：MARVIS_GAME_LOG_DIR 或项目 logs）
 * @param {boolean} [opts.enabled] 是否启用（默认按环境自动判断；显式传 false 可强制关闭）
 * @param {number} [opts.maxFileSize] 单文件切分阈值（字节，默认 20MB）
 * @param {string} [opts.prefix] 日志文件名前缀（默认 'game-'）
 */
function createGameLogger(opts = {}) {
  const dir =
    opts.dir ||
    process.env.MARVIS_GAME_LOG_DIR ||
    path.join(__dirname, '..', 'logs');
  const prefix = opts.prefix || FILE_PREFIX;
  const enabled = opts.enabled !== undefined ? !!opts.enabled : isEnabled();
  const maxFileSize = normalizeMaxSize(
    opts.maxFileSize !== undefined ? opts.maxFileSize : process.env.MARVIS_GAME_LOG_MAX_SIZE
  );

  let pending = []; // 待落盘的行（FIFO，保证顺序）
  let draining = false; // 是否有异步写盘在途
  let scheduled = false; // 是否已排定 drain
  let waiters = []; // flush() 的等待者
  let dirReady = false;
  const state = { day: '', index: 0, size: -1 }; // 当前目标分片（天 / 序号 / 已知字节数）

  function filePathFor(day, index = 0) {
    return path.join(
      dir,
      index > 0 ? `${prefix}${day}.${index}.jsonl` : `${prefix}${day}.jsonl`
    );
  }

  function ensureDir() {
    if (dirReady) return;
    fs.mkdirSync(dir, { recursive: true });
    dirReady = true;
  }

  /**
   * 写入前解析目标文件：先按天切换，再按大小轮转（序号递增）
   * 轮转判定发生在真正 append 之前，避免单文件被写超
   */
  function resolveTarget(bytes) {
    const { day } = nowParts();
    if (state.day !== day) {
      state.day = day;
      state.index = 0;
      state.size = -1;
    }
    if (state.size < 0) state.size = sizeOf(filePathFor(day, state.index));
    while (state.size > 0 && state.size + bytes > maxFileSize) {
      state.index += 1;
      state.size = sizeOf(filePathFor(day, state.index));
    }
    state.size += bytes;
    return filePathFor(day, state.index);
  }

  /** 串行化异步写盘：一次只放行一个 appendFile，批内合并、批间有序 */
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length) {
        const batch = pending;
        pending = [];
        const text = batch.join('');
        const target = resolveTarget(Buffer.byteLength(text));
        try {
          await fsp.appendFile(target, text, 'utf8');
        } catch (e) {
          console.error('[game-logger] append failed:', e && e.message);
        }
      }
    } finally {
      draining = false;
      if (waiters.length) {
        const ws = waiters;
        waiters = [];
        for (const r of ws) r();
      }
    }
  }

  function scheduleDrain() {
    if (draining || scheduled || !pending.length) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      drain();
    });
  }

  /** 追加一条事件：{ roomId, roundNo, type, data } → 拼装 JSONL 行并入队（异步落盘） */
  function append(room, type, data) {
    if (!enabled) return false;
    if (!room || !room.id) return false;
    const { ts } = nowParts();
    const entry = {
      ts,
      roomId: room.id,
      roundNo: room.roundNo || 0,
      type,
      data,
    };
    let line;
    try {
      ensureDir();
      line = JSON.stringify(entry) + '\n';
    } catch (e) {
      console.error('[game-logger] append failed:', e && e.message);
      return false;
    }
    pending.push(line);
    registry.add(api);
    installExitHooks();
    scheduleDrain();
    return true;
  }

  /** 异步冲刷：Promise 在队列清空且最后一批落盘后 resolve；无数据时立即 resolve */
  function flush() {
    if (!enabled) return Promise.resolve();
    if (!draining && !pending.length) return Promise.resolve();
    scheduleDrain();
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  /** 同步冲刷（进程退出兜底）：把剩余队列同步写到盘上 */
  function flushSync() {
    if (!enabled || !pending.length) return;
    const batch = pending;
    pending = [];
    const text = batch.join('');
    try {
      ensureDir();
      fs.appendFileSync(resolveTarget(Buffer.byteLength(text)), text, 'utf8');
    } catch (e) {
      console.error('[game-logger] flushSync failed:', e && e.message);
    }
  }

  /** 关闭日志器：冲刷后从退出钩子注销 */
  async function close() {
    await flush();
    registry.delete(api);
  }

  /** 清理超过 RETENTION_DAYS 天的日志文件，保留最近 7 天（含 .N 分片） */
  function cleanup() {
    if (!enabled) return { removed: 0, kept: 0 };
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    let kept = 0;
    // 只清理本日志器自己的前缀，避免误删同目录下的其他日志（如 ai-*.jsonl）
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp('^' + escaped + '(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.jsonl$');
    try {
      if (!fs.existsSync(dir)) return { removed, kept };
      const files = fs.readdirSync(dir);
      for (const f of files) {
        // 处理 PREFIX-YYYY-MM-DD.jsonl 及其分片 PREFIX-YYYY-MM-DD.N.jsonl
        const m = nameRe.exec(f);
        if (!m) continue;
        const dayTs = new Date(m[1] + 'T00:00:00').getTime();
        if (Number.isNaN(dayTs)) continue;
        if (dayTs < cutoff) {
          try {
            fs.unlinkSync(path.join(dir, f));
            removed++;
          } catch (e) {
            console.error('[game-logger] cleanup failed for ' + f + ':', e && e.message);
          }
        } else {
          kept++;
        }
      }
    } catch (e) {
      console.error('[game-logger] cleanup error:', e && e.message);
    }
    return { removed, kept };
  }

  const api = { append, cleanup, flush, flushSync, close, enabled, dir, maxFileSize };
  return api;
}

module.exports = {
  createGameLogger,
  RETENTION_DAYS,
  FILE_PREFIX,
  DEFAULT_MAX_FILE_SIZE,
};
