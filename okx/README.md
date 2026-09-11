# OKX 自选 K 线

对标币安 `kline.html` 的「收藏区」：名单自建，**上涨在上、下跌在下**。

## 页面

- 打开：`okx/kline.html`
- 链：Solana (`501`) · Robinhood (`4663`)
- 自选：`okx/favorites.json`（GitHub，页面可写）
- K 线：OBS `okx-candles-cache.json`（定时云函数写）

## 部署（仅定时触发器）

1. 申请 [OKX Onchain OS](https://web3.okx.com/onchain-os/dev-portal) API Key  
2. 部署 `cloud-function-okx` + 定时触发器  
3. 环境变量：OKX 三件套 + `GITHUB_TOKEN` + 与 monitor 相同的 OBS 密钥  

详见 `cloud-function-okx/README.md`。
