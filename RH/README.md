# Robinhood 日 K 浏览

打开一张网页，按 FDV 浏览 Robinhood 代币日线。

## 使用

`RH/index.html`（同源读 `RH/cache.json`）

页面筛选只在**已缓存数据**上过滤；不直连外部 API，因此**没有 CORS 问题**。

## 数据怎么来

华为云函数 `cloud-function-rh`（**只要定时触发器**）：

1. 调 DexPaprika 筛 FDV、拉日 K  
2. 写回 GitHub `RH/cache.json`  
3. 你的 Pages 站点自动带上新缓存

**不需要 HTTP 触发器，不需要 API Key（免费档）。**

详见 `cloud-function-rh/README.md`。
