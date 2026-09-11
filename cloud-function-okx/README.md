# OKX DEX K 线缓存（定时事件函数）

**只需要定时触发器**，不需要 HTTP。

| 数据 | 存哪 |
|------|------|
| 自选名单 `okx/favorites.json` | GitHub（页面增删） |
| K 线缓存 `okx-candles-cache.json` | **OBS**（与 `watch-data.json` 同桶） |

定时：读 GitHub 自选 → 调 OKX → 写 OBS。页面读 OBS 公开 URL。

## 部署

1. 上传本目录，Handler：`index.handler`，Node.js 18+
2. 添加**定时触发器**（建议 5～15 分钟）
3. 环境变量：

| 变量 | 说明 |
|------|------|
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | Onchain OS |
| `GITHUB_TOKEN` | 读 `okx/favorites.json` |
| `GITHUB_REPO` | 默认 `betterma/pages` |
| `OBS_ACCESS_KEY` / `OBS_SECRET_KEY` | 与 monitor 相同即可 |
| `OBS_BUCKET` | 默认 `mpctest` |
| `OBS_ENDPOINT` | 默认 `obs.cn-north-4.myhuaweicloud.com` |
| `OBS_OKX_CANDLES_PATH` | 可选，默认 `okx-candles-cache.json` |
| `OKX_CANDLE_BARS` | 可选，默认 `15m,2H,4H,1D,3D,1W` |
| `OKX_LIMIT_15m` 等 | 可选，覆盖各周期根数上限 |

## 说明

- 新加自选后，等下一次定时才有 K 线
- 近 3 天 / 近 10 天在前端截取
- 多周期改为**串行**请求，避免 OKX 429；失败会尽量沿用上一轮 OBS 缓存
