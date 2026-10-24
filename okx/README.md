# OKX 自选 K 线

对标币安 `kline.html` 的「收藏区」：名单自建，**上涨在上、下跌在下**。

## 页面

- 打开：`okx/kline.html`
- 链：Solana (`501`) · Robinhood (`4663`)
- 自选：`okx/favorites.json`（GitHub，页面可写）
- K 线：`okx/candles-cache.json`（GitHub，定时云函数写，紧凑格式）

## UI 规范：异步操作要有 loading

- 刷新 / 添加 / 批量添加 / 移出 / 改评分等网络写入或读取，必须用全屏 `busyGate`（`setPageBusy`）提示「处理中」，并禁用相关按钮，防止连点。
- 保存后再刷新列表时复用同一层 loading（内层 `quiet`），只更新文案。
- Cursor 规则：`.cursor/rules/okx-loading.mdc`

## 部署（仅定时触发器）

1. 申请 [OKX Onchain OS](https://web3.okx.com/onchain-os/dev-portal) API Key  
2. 部署 `cloud-function-okx` + 定时触发器  
3. 环境变量：OKX 三件套 + `GITHUB_TOKEN`（读写 favorites + candles-cache）  

详见 `cloud-function-okx/README.md`。
