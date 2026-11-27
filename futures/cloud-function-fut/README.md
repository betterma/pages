# 合约只读自动盯（华为云 FunctionGraph）

与现货 `cloud-function-notify` / `kline.html` **完全隔离**：本目录单独上传、单独定时器；只读写仓库里 `futures/` 下的 JSON。

## 行为

1. 拉 U 本位 `exchangeInfo`（永续 + TRADING）+ `/fapi/v1/ticker/24hr`
2. 按 24h 涨幅取前 N（默认 35）→ `futures/fut-watch-pool.json`
3. 相对上轮 zone 快照的**新进**写入 `futures/fut-auto-pins.json`（首次只播种，不整池钉满）
4. 状态：`futures/fut-notify-state.json`；黑名单：`futures/fut-blacklist.json`
5. **不**下单、**不**读持仓、**不**写根目录 `watch-*.json`

## 部署（华为云事件函数）

1. **整包上传**本目录（`index.js` + `auto-pin.js` + `binance-fapi.js` + `github.js`）
2. Handler：`index.handler`，Node.js 18+
3. 超时建议 ≥ 60s；内存 256MB 即可
4. 环境变量：

| 变量 | 说明 |
|------|------|
| `GITHUB_TOKEN` | 可读写本仓库 |
| `GITHUB_REPO` | 默认 `betterma/pages` |
| `FUT_WATCH_POOL_RANK` | 观察池前 N 默认值 `35`；页面写入的 `futures/fut-prefs.json` 优先 |
| `FUT_AUTO_PIN_ENABLED` | 默认开；`0` 关闭 |
| `FAPI_BASE_URLS` | 可选，逗号分隔 fapi 根地址 |

5. **定时触发器**：建议 **5 分钟**（与现货那套分开建函数，不要挂到现货函数上）
6. 不需要 HTTP 触发器，不需要币安 API Key

## 区域注意

若函数部署在大陆节点拉不到币安，把函数放到可访问 `fapi.binance.com` 的区域，或用 `FAPI_BASE_URLS` 配可达镜像。

## 与页面分工

| 动作 | 谁做 |
|------|------|
| 扫市场 / 写池 / 写自动盯 | 本云函数 |
| 展示列表 / 补拉现价 | `futures/index.html` |
