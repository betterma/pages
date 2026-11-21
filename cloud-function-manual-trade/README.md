# 手动买卖 HTTP 云函数（Cloudflare Workers）

## 设计原则

- **完全独立**：不读写 `trade-bot-state.json`，不影响华为云的 5 分钟定时器、自动买、自动卖，那些逻辑原样运行。
- **只做即时成交**：收到请求 → 立即按现价下币安市价单 → 返回成交结果。手动单不纳入自动仓位管理。
- **密钥隔离**：用**单独一套**币安 API Key（只开现货交易、关提现），和华为云自动那套分开，避免两边同时操作同一仓位打架。

## 文件

- `worker.js` — 完整 Worker 代码（约 250 行，ESM 格式）

## 部署（Cloudflare Workers 免费版）

1. 注册 Cloudflare → Workers & Pages → Create Worker → 直接把 `worker.js` 内容粘进去部署。
   - 或装 wrangler：`npx wrangler deploy` （可配 `wrangler.toml`）。
2. 在 Worker 的 **Settings → Variables & Secrets** 添加 3 个 Secret：

| Secret | 值 |
|---|---|
| `BINANCE_API_KEY` | 手动单专用 Key |
| `BINANCE_API_SECRET` | 对应 Secret |
| `MANUAL_TRADE_TOKEN` | 你自己设的口令，例如一串随机字母数字 |

3. 记下 Worker 的 URL，如 `https://manual-trade.<你的子域>.workers.dev`。

免费额度：10 万请求/天、10ms CPU/次（fetch 等待不计），这个场景连零头都用不到，无需信用卡。

## 调用方式

统一鉴权头：`Authorization: Bearer <MANUAL_TRADE_TOKEN>`

**买入**（按 USDT 金额）：

```bash
curl -X POST https://<你的worker域名>/buy \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","quote":100}'
```

**卖出**（按数量，自动按 stepSize 取整）：

```bash
curl -X POST https://<你的worker域名>/sell \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","quantity":0.001}'
```

**健康检查**：

```bash
curl https://<你的worker域名>/ping -H "Authorization: Bearer <TOKEN>"
```

返回示例：

```json
{
  "ok": true,
  "action": "manual_buy",
  "order": {
    "orderId": 123456,
    "symbol": "BTCUSDT",
    "side": "BUY",
    "status": "FILLED",
    "executedQty": 0.0012,
    "cummulativeQuoteQty": 100.0,
    "avgPrice": 83333.33
  }
}
```

手机快捷方式：把 `/buy` 或 `/sell` 的 curl 存成 iOS 快捷指令 / Android Termux 脚本，即可一键下单。

## 安全提醒

- `MANUAL_TRADE_TOKEN` 别写进代码、别发聊天里；只放 Worker Secrets。
- 币安 Key 只开现货交易、**关提现**；建议 IP 白名单先不设（Workers 出口 IP 不固定）。
- 默认 `quoteOrderQty` 最小 5 USDT；卖出数量会按币安 `stepSize` 向下取整并校验 `minQty`。
- 手动单和自动单**互不知晓仓位**：手动买完，华为云定时器不会给它设止损；手动卖的币如果同时是自动仓位的 symbol，两边会各自独立操作。若要避免冲突，手动单尽量用自动仓位之外的币，或先paring自动检测。

## 与定时器的关系

| 体系 | 部署位置 | 触发器 | 状态文件 | 是否改动 |
|---|---|---|---|---|
| 原自动买/卖 | 华为云 `cloud-function-trade` | 5min 定时 | `trade-bot-state.json` | **完全不动** |
| 手动买/卖 | Cloudflare Workers（本目录） | HTTP 请求 | 无（只下单+返回） | 新增 |

两者并行，互不干扰。
