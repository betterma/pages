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
| `BINANCE_API_KEY` | 币安 API Key（可与华为云同一套） |
| `BINANCE_API_SECRET` | HMAC Secret，**或**自行生成的 Ed25519/RSA **PEM 私钥全文**（含 `BEGIN/END`；与华为云相同） |
| `MANUAL_TRADE_TOKEN` | 你自己设的口令，例如一串随机字母数字 |

PEM 可多行粘贴进 Cloudflare Secret；若被收成一行，Worker 会按华为云同款逻辑还原换行。

3. 记下 Worker 的 URL，如 `https://manual-trade.<你的子域>.workers.dev`。
4. 在持有页设置里填入 Worker URL + Token（页面 localStorage `kline-manual-trade-worker-v1`）。

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

**账户余额**（即时拉币安现货，供持有页「刷新」）：

```bash
curl https://<你的worker域名>/balances -H "Authorization: Bearer <TOKEN>"
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

持有页「现价买入」成功后，会用返回的 `avgPrice` 写入成本价 P，并重挂 -3%/-5% 止损任务，随后由华为云定时器接管止损执行。Worker 本身仍不读写任何状态文件。

## 安全提醒

- `MANUAL_TRADE_TOKEN` 别写进代码、别发聊天里；只放 Worker Secrets。
- 币安 Key 只开现货交易、**关提现**；建议 IP 白名单先不设（Workers 出口 IP 不固定）。
- 默认 `quoteOrderQty` 最小 5 USDT；卖出数量会按币安 `stepSize` 向下取整并校验 `minQty`。
- 手动卖的币如果同时挂着自动仓位任务，两边会各自独立操作；注意避免冲突。

## 与定时器的关系

| 体系 | 部署位置 | 触发器 | 状态文件 | 是否改动 |
|---|---|---|---|---|
| 原自动买/卖 | 华为云 `cloud-function-trade` | 5min 定时 | `trade-bot-state.json` | **完全不动** |
| 手动买/卖 | Cloudflare Workers（本目录） | HTTP 请求 | 无（只下单+返回） | 新增 |

两者并行；成本/止损由持有页在现价买入成功后写入 GitHub JSON，再交定时器执行。
