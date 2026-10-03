# 自动盯 / 回暖 · 企业微信推送

定时事件函数：默认每 5 分钟读取 GitHub 盯一下、记住、持仓，拉币安现价。

## 企业微信（只发这一类）

**新自动盯 / 回暖** → `WECOM_WEBHOOK_POSITIONS`（原持仓警告群）  
云端边沿触发时发短讯：`【新自动盯】` / `【回暖】` + 名单。可用 `AUTO_PIN_WECOM=0` 关闭。

## 仅网页、不发企微

1. **持仓** → `lastPositionNotify`（企微浮窗右侧）  
2. **盯一下上涨文案** → `lastPinNotify`（企微浮窗左侧）  
3. **破点高** → `watch-break-high.json`（动态浮窗右侧；10 分钟冷却照旧）

## 部署

1. 上传本目录，Handler：`index.handler`，Node.js 18+  
2. **超时建议 ≥ 60～120 秒**  
3. 定时触发器：`0 */5 * * * *`  
4. 环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `WECOM_WEBHOOK_POSITIONS` | 是* | **自动盯 / 回暖**群 Webhook（原持仓警告群） |
| `WECOM_WEBHOOK_URL` | 否 | 未填 POSITIONS 时的兼容回退 |
| `WECOM_WEBHOOK_PINS` | 否 | 已不再发企微，可留空 |
| `GITHUB_TOKEN` | 是 | 读写 GitHub JSON |
| `AUTO_PIN_WECOM` | 否 | 默认 `1`；`0` 关闭自动盯/回暖企微 |

\* 或填 `WECOM_WEBHOOK_URL`。
