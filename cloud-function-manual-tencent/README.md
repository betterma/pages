# 腾讯云 SCF —— 手动现价买/卖

给持有页「现价买入 / 现价卖出」用的 HTTP 后端。  
与华为云 5 分钟定时器、`cloud-function-trade` **完全独立**，不读写状态文件。

## 文件

- `index.js` — `main_handler`（API 网关集成响应）
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
2. 地域建议：**广州 / 上海 / 新加坡**（先测币安，不通再换）
3. **新建** → 事件函数（不是 Web 函数也行）
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

### 4. 触发器（API 网关）

函数 → 触发器 → 创建触发器 → **API 网关触发器**：

- 新建 API 服务（或选已有）
- 请求方法：建议 **ANY**（或分别配 GET/POST）
- 发布环境：`发布`
- 鉴权方式：**免鉴权**（鉴权用函数内 Bearer Token）
- **开启集成响应**（重要）

创建后复制访问路径，形如：

`https://service-xxxx-xxxxxx.gz.apigw.tencentcs.com/release/`

持有页「函数 URL」填这个**去掉末尾路径后的可拼 `/ping` 的前缀**。  
若触发器路径已是 `/release/ping`，则 URL 填到 `/release` 为止，前端会再拼 `/buy` `/sell`。

更稳妥：在 API 网关里建三条路径 `/ping` `/buy` `/sell` 都指同一函数；或一条 `/` + 路径匹配。本函数按**路径最后一段**识别 `ping|buy|sell`。

### 5. 先测币安出网

```bash
curl "https://你的网关前缀/ping" -H "Authorization: Bearer <TOKEN>"
```

期望：

```json
{ "ok": true, "service": "manual-tencent-scf", "binanceOk": true, ... }
```

- `binanceOk: false` 且报 403 HTML → 换地域再试  
- `401` → Token / 环境变量问题  

### 6. 填持有页

持有 → 齿轮 → 现价交易：

- URL = 上一步网关前缀  
- Token = `MANUAL_TRADE_TOKEN`  

## 调用约定（与华为 HTTP 版相同）

```bash
curl -X POST "https://.../buy" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","quote":10}'

curl -X POST "https://.../sell" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","quantity":0.001}'
```

## 注意

- 不要用 Cloudflare Workers 版（币安封 CF 出口）
- 华为共享 APIG 已难新建；腾讯 API 网关个人用量通常够用
- 币安 Key 建议只开现货、关提现；可与华为定时器那套隔离
