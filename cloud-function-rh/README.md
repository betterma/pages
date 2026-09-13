# RH Screener 缓存刷新（仅定时触发器）

你这边**不能加 HTTP 触发器**时，用这套方案：

1. 定时云函数拉 DexPaprika（列表 + 日 K）  
2. 写入 GitHub：`RH/cache.json`  
3. 网页 `RH/index.html` **同源读取**缓存 → 无 CORS，也不要 HTTP

## 部署

1. 上传本目录，Handler：`index.handler`，Node.js 18+  
2. **超时建议 120～300 秒**（要拉很多币的日 K）  
3. 只加 **定时触发器**，例如每 15 分钟：`0 */15 * * * *`  
4. 环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `GITHUB_TOKEN` | 是 | 写 `RH/cache.json` |
| `GITHUB_REPO` | 否 | 默认 `betterma/pages` |
| `RH_FDV_MIN` | 否 | 默认 `5000000` |
| `RH_FDV_MAX` | 否 | 默认 `30000000` |
| `RH_LIMIT` | 否 | 默认 `30` |
| `RH_DAYS` | 否 | 默认 `90` |
| `RH_CONCURRENCY` | 否 | 默认 `4` |
| `DEXPAPRIKA_API_KEY` | 否 | 额度不够再填 |

## 网页

打开：`/RH/index.html`  
页面「刷新显示」只是重新读 `cache.json`；**不会**现场打 DexPaprika。  
数据新不新，看定时函数上次有没有跑成功、Pages 有没有更新到最新 commit。

## 首次

部署后可在控制台「测试」手动跑一次，确认仓库出现非空的 `RH/cache.json`。
