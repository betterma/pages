# RH Screener 代理（可选）

给 `RH/index.html` 用：浏览器直连 DexPaprika 若遇 CORS，就把请求转到本函数。

## 部署（华为云函数示例）

1. 上传本目录，运行时 Node.js 18+
2. Handler：`index.handler`
3. 超时 ≥ 30 秒
4. 创建 **HTTP 触发器**（公开）
5. 环境变量（均可选）：
   - `DEXPAPRIKA_BASE` 默认 `https://api.dexpaprika.com`
   - `DEXPAPRIKA_API_KEY` 有 Pro/免费 key 再填

## 路由

假设触发器地址为 `https://xxx/rh`：

| 路径 | 说明 |
|------|------|
| `GET .../health` | 探活 |
| `GET .../tokens?fdvMin=&fdvMax=&limit=` | 代币列表 |
| `GET .../pools?token=` | 某币流动性最好的池 |
| `GET .../ohlcv?pool=&days=90` | 日 K |

页面「代理」框填触发器根地址（能访问 `/health` 的那一层）。
