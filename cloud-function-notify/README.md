# 破点高 / 自动盯回暖 · 企业微信推送

定时事件函数：默认每 5 分钟读取 GitHub 盯一下、记住、持仓，拉币安现价。

## 推送内容

1. **持仓文案（仅网页）**  
   - **不再发企业微信**  
   - 仍生成持仓报告（含跌破买入价 5% 告警文案），写入 `lastPositionNotify`  
   - K 线页「企微」浮窗右侧照常显示  

2. **盯一下文案（仅网页）**  
   - **不再发企业微信**  
   - 仍按「当前 4h 窗口上涨」生成原文案，写入 `lastPinNotify`  
   - K 线页「企微」浮窗左侧照常显示  

3. **破点高**（原盯一下企微通道 → `WECOM_WEBHOOK_PINS`）  
   - 范围：盯住 ∪ 记住；基准优先最新记住价，否则盯住价；触发后抬升基准  
   - **10 分钟**冷却（`BREAK_HIGH_COOLDOWN_MS`）  
   - 有命中：名单 + K 线拼图；无命中：`无符合条件`  
   - 状态写入 `watch-break-high.json`  

4. **新自动盯 / 回暖**（原持仓警告群 → `WECOM_WEBHOOK_POSITIONS`）  
   - 云端边沿触发时发短讯：`【新自动盯】` / `【回暖】` + 名单  
   - 可用 `AUTO_PIN_WECOM=0` 关闭  
   - 主反馈仍在网页「日志 / 置顶」  

**顺序**：自动盯/回暖企微 → 写持仓网页文案 → 写盯一下网页文案 → 破点高企微。

## 部署

1. 上传本目录，Handler：`index.handler`，Node.js 18+  
2. **超时建议 ≥ 60～120 秒**  
3. 定时触发器：`0 */5 * * * *`  
4. 环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `WECOM_WEBHOOK_PINS` | 二选一* | **破点高**群 Webhook |
| `WECOM_WEBHOOK_POSITIONS` | 二选一* | **自动盯 / 回暖**群 Webhook（原持仓警告群） |
| `WECOM_WEBHOOK_URL` | 否 | 兼容旧配置 |
| `GITHUB_TOKEN` | 是 | 读写 GitHub JSON |
| `BREAK_HIGH_COOLDOWN_MS` | 否 | 默认 `600000`（10 分钟） |
| `BREAK_HIGH_CHART_MAX` | 否 | 破点高拼图上限，默认 `12` |
| `AUTO_PIN_WECOM` | 否 | 默认 `1`；`0` 关闭自动盯/回暖企微 |

\* 至少配置一个可用 Webhook。

## 数据文件（GitHub）

| 文件 | 说明 |
|------|------|
| `watch-pins.json` | 盯一下 |
| `watch-mom-notes.json` | 记住点 |
| `watch-positions.json` | 持仓 |
| `watch-break-high.json` | 破点高基准 / 冷却 / 最近命中 |
| `watch-notify-state.json` | 跌破冷却、`lastPinNotify` / `lastPositionNotify`（网页） |

## 双群建议

- 群 A（原盯一下群）→ `WECOM_WEBHOOK_PINS`：破点高  
- 群 B（原持仓警告群）→ `WECOM_WEBHOOK_POSITIONS`：新自动盯 / 回暖  
