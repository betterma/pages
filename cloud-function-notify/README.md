# 自动盯 · 微信 PushPlus

定时事件函数：默认每 5 分钟读取 GitHub 盯一下、记住、持仓，拉币安现价。  
观察池 `watch-data`：**优先 GitHub 瘦身版**，失败再回落 OBS。

## 微信（新自动盯）

未盯币**新进入窗口上涨**时发 PushPlus 一对一微信（`新盯 FIL`），并写入 `watch-action-log.json`。同时用**同一时刻、同一盯住价**写入 `watch-mom-notes.json` 记一笔。  
已盯币**掉出窗口上涨**只写捕捉日志（`掉出窗口`），不推微信。  
**已取消回暖**：已盯币再次进区不会改钉价、不写回暖日志、不推送。

盯一下离开方式只有两种：

1. **触底退出**（周期低点自动清钉）
2. **用户手动取消盯一下**

- `PUSHPLUS_TOKEN`：一对一 token，只放云函数环境变量，不要写入仓库。
- `AUTO_PIN_PUSHPLUS`：默认 `1`；`0` 关闭微信推送（日志仍写）。
- `AUTO_PIN_WECOM`：默认 `0`。需要同时发企微时设为 `1`，并保留 `WECOM_WEBHOOK_POSITIONS`。

网页刷新不再单独自动盯。

## 排序动态（notes-rank 快照）

云函数在 **5 分钟定时**里检查：距上一帧 ≥ **约 30 分钟** 则对「记一笔 ∪ 盯一下」（去拉黑）拍快照，写入 `watch-notes-rank-snaps.json`；与上一帧对比后写动作日志 `rank-new` / `rank-up`（「排序动态」，保留 1 天）。**不依赖网页打开。**

排序维度读 `watch-notes-rank-prefs.json`（网页改 notes-rank 表头多选时写入；与页面同一套 hitCount + 主序逻辑）。默认：`keys=["change2h","noteAt","change1h"]`，`last="change2h"`（近2h + 记时 + 近1h，优先近2h）。需要 1h/2h 时拉 15m K 线计算。

- `NOTES_RANK_SNAP_ENABLED`：默认 `1`；`0` 关闭。
- `NOTES_RANK_SNAP_INTERVAL_MS`：默认 `1800000`（30 分钟）。

## 仅网页、不推微信

1. **持仓** → `lastPositionNotify`（企微浮窗右侧）
2. **盯一下上涨文案** → `lastPinNotify`（企微浮窗左侧）
3. **破点高** → `watch-break-high.json`（动态浮窗右侧；10 分钟冷却照旧）
4. **排序动态** → 读 `watch-action-log.json`（由云函数写入）

## 部署

1. **整包上传**本目录全部 `.js`（至少 `index.js` + `notify.js` + `auto-pin.js` + `github-wecom.js` + `kline-chart.js` + `break-high.js` + `notes-rank-snap.js`）。只更新 `index.js` 会出现 `main is not a function`。
2. Handler：`index.handler`，Node.js 18+
3. **超时建议 ≥ 60～120 秒**
4. 定时触发器：`0 */5 * * * *`
5. 环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `PUSHPLUS_TOKEN` | 是* | PushPlus 一对一 token |
| `GITHUB_TOKEN` | 是 | 读写 GitHub JSON |
| `AUTO_PIN_PUSHPLUS` | 否 | 默认 `1` |
| `AUTO_PIN_WECOM` | 否 | 默认 `0` |
| `WECOM_WEBHOOK_POSITIONS` | 否 | 仅当 `AUTO_PIN_WECOM=1` |
| `NOTES_RANK_SNAP_ENABLED` | 否 | 默认 `1` |

\* `AUTO_PIN_PUSHPLUS=0` 时可空。
