# monitor · 观察池（GitHub 热库）

约每 15 分钟拉币安 24hr，维护 `watch-data.json`（写入 GitHub）。

## 存储

| 目标 | 内容 | 谁读 |
|------|------|------|
| **GitHub**（热库，默认） | 近 48h；价格保留观察池 ∪ 榜前约 120 ∪ 盯一下 ∪ 钉子；名次用紧凑 `r[]`（前约 150 名） | `kline` / `watch` 冲榜雷达 / notify |
| **OBS**（可选备份） | 仅当 `OBS_WRITE=1` 时写入完整档 | 默认不写、页面不读 |

页面与 notify **不再回落 OBS**。名次字段：`history[].r` 为按名次排列的 symbol 数组，读入时展开为 `ranks`（体验与原先一致）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `GITHUB_TOKEN` | 读写 `watch-data.json`（必填） |
| `GH_HISTORY_MS` | 热库历史窗口，默认 48h |
| `GH_SLIM_RANK_KEEP` | 额外保留榜前币种**价格**数，默认 120 |
| `GH_RANK_LIST_KEEP` | 每张快照 `r[]` 名次数，默认 150（勿写全市场，会撑爆 900KB） |
| `GH_MAX_BYTES` | 写入上限，默认 900KB；超限丢最旧快照，仍超则报错 |
| `OBS_WRITE` | 默认 `0`；`1` 时额外写 OBS 备份 |
| `OBS_READ` | 默认 `0`；`1` 时 GitHub **读失败**才回落 OBS |
| `OBS_BOOTSTRAP` | 默认 `1`；仅当 GitHub **空/404** 时用 OBS 种子一次（短暂读失败不会用 OBS 覆盖） |
| `OBS_*` | 仅备份/种子开启时需要 |

## 部署后

1. **整包上传** `cloud-function-monitor`（至少 `monitor.js` + `obs-client.js`）。
2. 等一次跑完，确认 GitHub `watch-data.json` 含 `"source":"github-slim"` 且快照带 `"r":[...]`。
3. 打开 kline「同步池」、冲榜雷达，应显示 GitHub 来源；名次跃升仍可用。
4. 若体积报警，可调短 `GH_HISTORY_MS` / 降低 `GH_RANK_LIST_KEEP`，或提高函数超时。
