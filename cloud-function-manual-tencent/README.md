# 腾讯云 SCF —— 手动现价买/卖

给持有页「现价买入 / 现价卖出」用的 HTTP 后端。  
与华为云 5 分钟定时器、`cloud-function-trade` **完全独立**，不读写状态文件。

## 文件

- `index.js` — `main_handler`（函数 URL / 集成响应）
- `binance.js` — 币安签名与下单

## 部署步骤（控制台）

### 1. 打 ZIP

本目录两个文件打进 zip **根目录**：

```powershell
cd C:\Users\punk_\Documents\pages\cloud-function-manual-tencent
Compress-Archive -Path index.js,binance.js -DestinationPath ..\manual-tencent.zip -Force
```

### 2. 创建云函数

1. 打开 [腾讯云 SCF](https://console.cloud.tencent.com/scf)
2. 地域：**新加坡**（广州出网打币安会超时）
3. **新建** → 事件函数
4. 运行环境：**Node.js 18**
5. 提交方法：本地上传 zip
6. 执行方法：`index.main_handler`
7. 内存 128–256MB，超时 **20–60s**

### 3. 环境变量

| 变量 | 说明 |
|---|---|
| `MANUAL_TRADE_TOKEN` | 自定义口令（持有页 Token 同一串） |
| `BINANCE_API_KEY` | 币安 API Key |
| `BINANCE_API_SECRET` | Secret 或 PEM 私钥 |
| `BINANCE_API_BASE` | 可选，默认 `https://api.binance.com` |

### 4. 函数 URL

函数 → 函数 URL → 新建：

- 公网访问 ✓
- CORS ✓：`Allow-Origin=*`，Methods=`*` 或 `GET/POST/OPTIONS`，Headers=`Authorization,Content-Type`
- 授权类型：**开放**
- 参数兼容 ✓

复制 HTTPS 地址，形如：

`https://1305206018-xxxx.ap-singapore.tencentscf.com`

持有页填这个前缀；前端会拼 `/ping` `/buy` `/sell`。路径按**最后一段**识别。

浏览器直接打开根路径会强制下载 / `ERR_INVALID_RESPONSE`，属正常；用 curl 测。

### 5. 先测币安出网

```powershell
curl.exe -s "https://你的函数URL/ping" -H "Authorization: Bearer <TOKEN>"
curl.exe -s "https://你的函数URL/balances" -H "Authorization: Bearer <TOKEN>"
```

期望：

```json
{ "ok": true, "service": "manual-tencent-scf", "binanceOk": true, ... }
{ "ok": true, "action": "balances", "balances": { "USDT": { "free": ..., "locked": ..., "at": ... }, ... } }
```

- `binanceOk: false` / 超时 → 确认地域是新加坡，或试 `BINANCE_API_BASE=https://api1.binance.com`
- `401` → Token / 环境变量问题
- `/balances` 失败 → 检查 `BINANCE_API_KEY` / `BINANCE_API_SECRET`（支持 HMAC 与 PEM）

### 6. 填持有页

持有 → 齿轮 → 现价交易：

- URL = 上一步函数 URL 前缀  
- Token = `MANUAL_TRADE_TOKEN`

配置后，持有页「刷新」会先 `GET /balances` 写回 `watch-holdings.json`，再刷现价/任务（不必等华为云 5 分钟定时）。

## 调用约定

```bash
curl -X POST "https://.../buy" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","quote":10}'

curl -X POST "https://.../sell" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","quantity":0.001}'
```

## 注意

- 只用本目录；已废弃 Cloudflare Workers / 华为 HTTP 手动交易包
- 币安 Key 建议只开现货、关提现；可与华为定时器那套隔离
