# 华为云 FunctionGraph HTTP 函数 —— 手动现价买/卖

零依赖（只用 Node 内置模块），直接上传即可。与 `cloud-function-trade`（5min 定时器）**完全独立**，原有自动买/卖逻辑一个字不改。

## 文件

- `index.js` — 常驻 HTTP 服务，监听 `127.0.0.1:8000`，路由 `/ping` `/buy` `/sell`
- `binance.js` — 币安签名与下单（从 `cloud-function-trade/binance.js` 原样复用）
- `bootstrap` — 启动脚本（根目录）

## 部署步骤（FunctionGraph 控制台）

1. 创建函数 → **类型选「HTTP 函数」**（不是事件函数）→ Node.js 18+ → 区域随意（币安能通即可）。
2. 代码上传方式选「**手动上传 ZIP**」，把本目录 **3 个文件**（`index.js`、`binance.js`、`bootstrap`）打包成 zip，**bootstrap 在 zip 根目录**（打开 zip 就能直接看到这三个文件，不要多套一层文件夹）。
   - **Windows 注意**：`bootstrap` 必须是 Unix 换行（LF）。若用记事本改过，会变成 CRLF，运行时报 `cd: /opt/function/code\r: No such file`。用仓库里已修好的文件打包，或打包前确保 LF。
3. 内存建议 256MB；超时 60s。
4. 环境变量：

| 变量 | 说明 |
|---|---|
| `MANUAL_TRADE_TOKEN` | 自定义口令，前端调用时带 `Authorization: Bearer <它>` |
| `BINANCE_API_KEY` | 手动单专用 Key（只开现货交易、关提现） |
| `BINANCE_API_SECRET` | 对应 Secret |
| `BINANCE_API_BASE` | 可选，默认 `https://api.binance.com` |
| `TRADE_FEE_RATE` | 可选，默认 0.001（仅用于返回 fee 估算） |

5. 创建触发器 → **API 网关（APIG）→ 共享版**（免费）→ 认证方式「无认证」→ 保存后拿到公网 URL。
6. 测试：`GET <公网URL>/ping` 带鉴权头，应返回 `{"ok":true,...}`。

## 调用

```bash
# 健康检查
curl https://<apig-url>/ping -H "Authorization: Bearer <TOKEN>"

# 现价买入（按 USDT 金额，最小 5）
curl -X POST https://<apig-url>/buy \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","quote":100}'

# 现价卖出（按数量，自动按 stepSize 取整）
curl -X POST https://<apig-url>/sell \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","quantity":0.001}'
```

返回示例：

```json
{
  "ok": true,
  "action": "manual_market_buy",
  "spotBefore": 83333.1,
  "order": {
    "orderId": 123456,
    "side": "BUY",
    "status": "FILLED",
    "executedQty": 0.0012,
    "cummulativeQuoteQty": 100.0,
    "avgPrice": 83333.33,
    "fee": 0.1
  }
}
```

前端（持有页设置）填入 APIG 公网 URL + Token（本机 `kline-manual-trade-url-v1` / `kline-manual-trade-token-v1`）。
拿到 `order.avgPrice` 后写成本价 P（`source:'market'`）并重挂 -3%/-5% 止损。

**不要用** `cloud-function-manual-trade/`（Cloudflare Workers）：币安已封 CF 出口。

## 收费与限制

- 免费额度：**100 万次调用/月 + 40 万 GB-s/月**（全账号函数共用），共享版 APIG 免费；闲置不调用不收费。
- **函数出公网流量单独计费**（无免费包）——但本函数只调币安 API，一天几次、每次几百字节，费用可忽略（约 ¥0.01/月级别）。
- 预留实例不要开（常驻计费），普通自用不需要。
- HTTP 函数返回 body 上限 6MB；单请求超时有上限（设 60s 足够）。

## 安全

- `MANUAL_TRADE_TOKEN` 只放环境变量和前端本机配置，别写进仓库聊天记录。
- 币安 Key 只开现货交易、关提现；建议和华为云自动那套用**不同 Key**，避免两边同时操作同一仓位。
- 共享版 APIG 有 QPS 限流，个人手动点单完全够用。
