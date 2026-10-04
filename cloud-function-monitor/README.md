# monitor · 观察池双写

约每 15 分钟拉币安 24hr，维护 `watch-data.json`。

## 存储

| 目标 | 内容 | 谁读 |
|------|------|------|
| **OBS**（完整冷库） | 全市场快照 × 约 3 天 | 仅云函数备份 / 回落 |
| **GitHub**（瘦身热库） | 近 48h；价格只保留观察池 ∪ 榜前约 80 ∪ 当前盯一下 | `kline` / `watch` / notify 优先读 |

GitHub 写入失败**不会**回滚 OBS；日志里会有 `GitHub slim write skipped`。

## 环境变量

| 变量 | 说明 |
|------|------|
| `GITHUB_TOKEN` | 写瘦身 `watch-data.json` |
| `OBS_*` | 写完整档（与现网一致） |
| `GH_HISTORY_MS` | 瘦身历史窗口，默认 48h |
| `GH_SLIM_RANK_KEEP` | 额外保留榜前币种数，默认 80 |

## 部署后

1. 等一次 monitor 跑完，确认 GitHub 上 `watch-data.json` 变小且含 `"source": "github-slim"`。
2. 打开 kline「同步池」，状态应出现 `GitHub刚更新` / `GitHub N分钟前`。
3. notify 无需改 OBS 环境变量；会自动先读 GitHub。

若 GitHub 仍是旧全量（无 `github-slim`、或 `savedAt` 超过约 2 小时），页面 / notify 会**自动回落 OBS**，避免 3 天 prune 后窗口涨跌全判失败、盯一下全部掉进「隐藏」。
