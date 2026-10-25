# monitor · 观察池（GitHub 热库）

约每 15 分钟拉币安 24hr，维护 `watch-data.json`（**只写 GitHub**，与 OBS 无关）。

## 存储

| 目标 | 内容 | 谁读 |
|------|------|------|
| **GitHub** `watch-data.json` | 近 48h；价格保留观察池 ∪ 榜前约 120 ∪ 盯一下 ∪ 钉子；名次用紧凑 `r[]`（前约 150 名）；含 `alertState`（Top20 去重） | `kline` / `watch` / notify |

名次字段：`history[].r` 为按名次排列的 symbol 数组，读入时展开为 `ranks`。

> 观察池入池规则：现货 **24h 涨幅前 30**（可配）即进，跌出前 30 / 拉黑则出；**不要求**当前 4h 窗涨。  
> 热库仍不做「全市场 × 多日」以控制体积。  
> **缺价回填**：先更新观察池，再对「新池 ∪ 榜前 ∪ 盯/钉」用 15m K 线补近约 6h（至少盖住当前 4h 窗起点）；旧逻辑先回填再入池，新进榜币窗起点容易一直空着。

## 环境变量

| 变量 | 说明 |
|------|------|
| `GITHUB_TOKEN` | 读写 `watch-data.json`（必填） |
| `GH_HISTORY_MS` | 热库历史窗口，默认 48h |
| `GH_SLIM_RANK_KEEP` | 额外保留榜前币种**价格**数，默认 120 |
| `GH_RANK_LIST_KEEP` | 每张快照 `r[]` 名次数，默认 150 |
| `GH_MAX_BYTES` | 写入上限，默认 900KB；超限丢最旧快照，仍超则报错 |
| `GH_BACKFILL_MS` | 缺价回填回看时长，默认 6h（覆盖 4h 窗口） |
| `GH_BACKFILL_CONCURRENCY` | K 线回填并发，默认 4 |

## 部署后

1. **整包上传** `cloud-function-monitor`（至少 `monitor.js`；`obs-client.js` 可留着不用）。
2. 云函数环境变量里如仍有 `OBS_*` / `OBS_READ` / `OBS_WRITE` / `OBS_BOOTSTRAP`，可删掉，代码已不再读取。
3. 等一次跑完，确认 GitHub `watch-data.json` 含 `"source":"github-slim"` 且快照带 `"r":[...]`。
4. 打开 kline「同步池」、冲榜雷达，应显示 GitHub 来源。
