# Smoke 测试（真机端到端）

这三个脚本是**真机冒烟测试**，与 `test/` 下的单元测试不同：它们连接一个**真实运行中的 server.js**（默认 `localhost:3100`），覆盖 HTTP + WebSocket 全流程与安全护栏。

## 前置条件

先启动服务端：

```bash
npm start
```

## 运行

```bash
npm run smoke          # 核心冒烟：HTTP + 建房间 + 发牌 + 重连安全 + 限频
node scripts/smoke-auth.js           # 注册/登录/历史/账户关联
node scripts/smoke-history-e2e.js    # 打完一局后历史对局落盘
```

## 各脚本覆盖

| 脚本 | 覆盖点 |
|---|---|
| `smoke-real.js` | HTTP 首页、join_lobby 下发 secret、建房间、发牌、错误/正确 secret 重连、超长消息帧层防御、房间码暴力枚举限频 |
| `smoke-auth.js` | 注册、错误密码登录被拒、token 登录、历史记录、账户昵称覆盖、弱密码被拒 |
| `smoke-history-e2e.js` | 登录用户打完一局后历史对局记录落盘并可查询 |

> 注：端口写死为 `3100`，与 `server.js` 默认 `PORT` 一致。如需改端口，需同步修改脚本内 `URL`/`port` 常量。

## AI 复盘 / 校准（不依赖运行中的服务）

`ai-calibrate.js` 是唯一的非冒烟脚本：直接读取 `logs/ai-*.jsonl`（也兼容 `game-*.jsonl` 里的 AI 事件），不需要启动服务端。

```bash
npm run ai:stats                         # 只读：分玩法/难度的局数、胜率、放铳率、净得分
npm run ai:calibrate                     # 按全量历史重算困难档参数并写入 data/ai-calibration.json
node scripts/ai-calibrate.js --dry-run   # 预览判定与建议参数，不写文件
node scripts/ai-calibrate.js --json --min-rounds 20 --log-dir ./logs
node scripts/ai-calibrate.js --reset     # 回滚到默认参数
```

服务端自己也会在累计满 40 条困难档「AI 座位·局」记录后自动校准（可用 `MARVIS_AI_CALIBRATION_MIN_ROUNDS` 调整、`MARVIS_AI_CALIBRATION=0` 关闭）。CLI 主要用于人工复盘、重算与回滚；参数边界、样本门槛与设计约束见 `README.md` 的「AI 胜率复盘与自动校准」。

## AI 批量模拟（纯内存，不需要启动服务）

`ai-simulate.js` 直接驱动真实 `GameServer`，把 AI 代打的 80ms 定时器换成同步队列、广播与日志置空，用可复现种子批量打完整对局；`ai-simulate-analyze.js` 做配对 bootstrap 检验并生成 Markdown 报告。

```bash
npm run ai:sim -- --games 10000                          # 混合难度 2v2 同桌对抗（默认扣点点）
npm run ai:sim -- --games 2000 --mode uniform            # 全普通 / 全困难镜像对照
npm run ai:sim -- --games 10000 --calibration on         # 开启在线校准的长跑
npm run ai:sim -- --games 1000 --variant hongzhong       # 换玩法
npm run ai:sim:report -- reports/ai-mixed-10000.json --uniform reports/ai-uniform-2000.json --calib reports/ai-calib-10000.json
```

常用参数：`--workers`（并行进程数）、`--seed-base`（随机种子起点）、`--out`（结果 JSON 路径）。结果默认写到 `reports/`，该目录已 gitignore，不会把几 MB 的明细提交进仓库。

实验设计：每个房间连打 4 局，同一 seed 跑两个房间并**对调难度分配**（`NHNH` ↔ `HNHN`），消除座位与庄家偏差；显著性用按 seed 聚类的 bootstrap，避免把同桌 4 家的相关性当作独立样本。模拟器还会统计困难内核的真实调用次数（全普通房间应为 0），用来验证难度注入确实生效。
