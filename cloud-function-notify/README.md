# 持仓 / 破点高 · 企业微信推送

定时事件函数：默认每 5 分钟读取 GitHub 盯一下、记住、持仓，拉币安现价。

## 推送内容

1. **持仓**（不变）  
   - 企微持仓群：每轮推买入价→现价；跌破买入价 **5%** 时附告警（同币 **2 小时**冷却）  
   - 同时写入 `lastPositionNotify`，K 线页「企微」浮窗右侧显示  

2. **盯一下文案（仅网页）**  
   - **不再发企业微信**  
   - 仍按「当前 4h 窗口上涨」生成原文案，写入 `lastPinNotify`，K 线页「企微」浮窗左侧照常显示  
   - 含短线抬高染色、`@@@`（相对上次**网页公布**现价）等原逻辑  

3. **破点高**（原盯一下企微通道）  
   - 走 `WECOM_WEBHOOK_PINS`  
   - 范围：盯住 ∪ 记住；基准优先最新记住价，否则盯住价；触发后抬升基准  
   - **10 分钟**冷却（`BREAK_HIGH_COOLDOWN_MS`，与网页一致；函数仍可每 5 分钟跑，冷却内跳过破点高）  
   - 有命中：名单 markdown + K 线拼图  
   - 无命中：推送 `【破点高】…\n无符合条件`  
   - 状态写入 `watch-break-high.json`（与网页共用）  

4. **云端自动盯 / 回暖**（可选短讯仍可发盯一下群）  
   - 逻辑同前；主反馈在网页日志 / 置顶  

**先发持仓，再写盯一下网页文案，再破点高企微**，避免拼图拖死持仓。

## 部署

1. 上传本目录，Handler：`index.handler`，Node.js 18+  
2. **超时建议 ≥ 60～120 秒**  
3. 定时触发器：`0 */5 * * * *`（每 5 分钟；破点高内部 10 分钟门闩）  
4. 环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `WECOM_WEBHOOK_PINS` | 二选一* | **破点高**（及可选自动盯短讯）群 Webhook |
| `WECOM_WEBHOOK_POSITIONS` | 二选一* | **持仓**群 Webhook |
| `WECOM_WEBHOOK_URL` | 否 | 兼容旧配置 |
| `GITHUB_TOKEN` | 是 | 读写 GitHub JSON |
| `BREAK_HIGH_COOLDOWN_MS` | 否 | 默认 `600000`（10 分钟） |
| `BREAK_HIGH_CHART_MAX` | 否 | 破点高拼图上限，默认 `12` |
| `AUTO_PIN_WECOM` | 否 | 默认 `1`；`0` 关闭自动盯短企微 |

\* 至少配置一个可用 Webhook。

## 数据文件（GitHub）

| 文件 | 说明 |
|------|------|
| `watch-pins.json` | 盯一下 |
| `watch-mom-notes.json` | 记住点 |
| `watch-positions.json` | 持仓 |
| `watch-break-high.json` | 破点高基准 / 冷却 / 最近命中 |
| `watch-notify-state.json` | 跌破冷却、上次公布价、`lastPinNotify`（网页）、`lastPositionNotify` |

## 双群建议

- 群 A（原盯一下群）→ `WECOM_WEBHOOK_PINS`：破点高  
- 群 B（持仓群）→ `WECOM_WEBHOOK_POSITIONS`：持仓 / 预警  
