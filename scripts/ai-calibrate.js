#!/usr/bin/env node
'use strict';

/**
 * AI 胜率复盘 / 校准 CLI
 *
 *   npm run ai:stats            查看分玩法 / 难度的胜率、放铳率、净得分（只读）
 *   npm run ai:calibrate        按历史胜率重新校准困难 AI 参数并写盘
 *   node scripts/ai-calibrate.js --dry-run --min-rounds 20 --log-dir ./logs
 *   node scripts/ai-calibrate.js --reset
 *
 * 数据源：logs/ai-YYYY-MM-DD[.N].jsonl（ai-journal 产出）；
 *         同时兼容 logs/game-*.jsonl 中的 ai_decision / ai_round_result 事件。
 * 输出文件：data/ai-calibration.json（运行时产物，已 gitignore）。
 * 服务端在线校准会在累计够局数时自动写同一个文件，本脚本用于人工复盘 / 重算 / 回滚。
 */

const fs = require('fs');
const path = require('path');
const calibration = require('../src/ai-calibration');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);

function flag(name) {
  return args.includes('--' + name);
}

function value(name, fallback) {
  const i = args.indexOf('--' + name);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) return fallback;
  return args[i + 1];
}

function pct(v) {
  return (v * 100).toFixed(1) + '%';
}

function signed(v) {
  return (v > 0 ? '+' : '') + v;
}

function logDir() {
  return path.resolve(
    value('log-dir', process.env.MARVIS_AI_LOG_DIR || process.env.MARVIS_GAME_LOG_DIR || path.join(ROOT, 'logs'))
  );
}

function calibFile() {
  return path.resolve(value('file', process.env.MARVIS_AI_CALIBRATION_FILE || calibration.DEFAULT_FILE));
}

/** 读取两类日志文件中的 AI 事件；单条坏行跳过，不影响整体统计 */
function readEvents(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^(?:ai|game)-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(f))
    .sort();
  const events = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e && typeof e.type === 'string' && e.type.startsWith('ai_')) events.push(e);
    }
  }
  return events;
}

/** 展开成「一局 × 一个 AI 座位」的记录，并按 玩法/难度 分组 */
function buildGroups(events) {
  const groups = new Map();
  const keyOf = (v, d) => `${v}/${d}`;
  const ensure = (v, d) => {
    const k = keyOf(v, d);
    if (!groups.has(k)) groups.set(k, { variant: v, difficulty: d, records: [], decisions: 0 });
    return groups.get(k);
  };

  for (const e of events) {
    const d = e.data || {};
    const variant = ['koudian', 'hongzhong', 'tiejin'].includes(d.variant) ? d.variant : 'koudian';
    const difficulty = d.difficulty === 'hard' ? 'hard' : 'normal';
    const g = ensure(variant, difficulty);
    if (e.type === 'ai_decision') {
      g.decisions += 1;
      for (const c of d.candidates || []) {
        if (!Number.isFinite(Number(c.shanten))) continue;
        g.shantenSum = (g.shantenSum || 0) + Number(c.shanten);
        g.shantenCount = (g.shantenCount || 0) + 1;
      }
    } else if (e.type === 'ai_round_result') {
      for (const r of d.rows || []) {
        g.records.push({
          win: !!r.win,
          dealIn: !!r.dealIn,
          net: Number(r.net) || 0,
          decisions: Number(r.decisions) || 0,
        });
      }
    }
  }
  return [...groups.values()];
}

function pad(s, n) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, n - s.length));
}

function printGroups(groups) {
  console.log(
    pad('玩法/难度', 20) +
      pad('局数', 8) +
      pad('胡牌', 8) +
      pad('胜率', 9) +
      pad('放铳', 8) +
      pad('放铳率', 9) +
      pad('净得分', 10) +
      pad('均分', 9) +
      '决策数'
  );
  console.log('-'.repeat(88));
  for (const g of groups) {
    const s = calibration.summarize(g.records);
    g.stats = s;
    console.log(
      pad(`${g.variant}/${g.difficulty}`, 20) +
        pad(s.rounds, 8) +
        pad(s.wins, 8) +
        pad(pct(s.winRate), 9) +
        pad(s.dealIns, 8) +
        pad(pct(s.dealInRate), 9) +
        pad(signed(s.netTotal), 10) +
        pad(signed(s.netAvg), 9) +
        g.decisions
    );
  }
}

function main() {
  const file = calibFile();
  const minRounds = Math.max(1, Number(value('min-rounds', calibration.DEFAULT_MIN_ROUNDS)) || calibration.DEFAULT_MIN_ROUNDS);

  if (flag('reset')) {
    calibration.persist(
      { params: { ...calibration.DEFAULTS }, reason: '手工 --reset 回到默认参数', stats: null },
      file
    );
    console.log(`已重置校准参数：${file}`);
    console.log(JSON.stringify(calibration.DEFAULTS));
    return;
  }

  const events = readEvents(logDir());
  const groups = buildGroups(events);
  if (!groups.length) {
    console.log('未找到 AI 复盘日志。先开启困难难度打若干局，或检查 --log-dir 路径。');
    console.log(`日志目录：${logDir()}`);
    return;
  }

  printGroups(groups);

  // 校准只针对困难档；普通档策略固定，仅展示统计
  const hardRecords = groups.filter((g) => g.difficulty === 'hard').flatMap((g) => g.records);
  const stats = calibration.summarize(hardRecords);
  const previous = calibration.getParams();
  const result = calibration.calibrate(stats, previous, { minRounds });
  result.previous = previous;

  console.log('\n困难档汇总：');
  console.log(
    `  ${stats.rounds} 局 | 胜率 ${pct(stats.winRate)}（目标 ${pct(calibration.TARGETS.winRate)}）` +
      ` | 放铳率 ${pct(stats.dealInRate)}（上限 ${pct(calibration.TARGETS.dealInRate)}）` +
      ` | 净得分 ${signed(stats.netTotal)}`
  );
  console.log(`  校准判定：${result.reason}`);
  console.log(`  当前参数：${JSON.stringify(previous)}`);
  console.log(`  建议参数：${JSON.stringify(result.params)}`);

  if (flag('json')) {
    console.log('\n' + JSON.stringify({ groups: groups.map((g) => ({ ...g, records: undefined })), stats, result }, null, 2));
  }

  if (flag('apply')) {
    calibration.persist(result, file);
    console.log(`\n已写入 ${file}（服务端下一次决策即生效；无需重启）`);
  } else {
    console.log('\n只读预览。加 --apply 写入校准文件。');
  }
}

main();
