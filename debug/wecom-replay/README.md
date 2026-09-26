# WeCom 复盘 / 调试材料

企微盯一下通知的归档抽取与动量复盘脚本，便于以后回归测试，**不参与线上页面逻辑**。

## 内容

| 文件 | 说明 |
|------|------|
| `wecom-notify-archive-from-2026-09-24.*` | 从 Git 历史抽出的盯一下文案时间线 |
| `wecom-pin-gain-gt25.*` | 盯幅峰值 ≥25% 的币种 |
| `wecom-flag-leading-analysis.*` | 5m / @@@ 前置密度对比 |
| `wecom-1h-momentum-validation.*` / `wecom-horizon-compare.*` | 近 1h/2h/3h 验证 |
| `wecom-signal-before-breakout.*` | 其它信号扫描产物 |
| `scripts/` | 生成上述文件的 Node 脚本 |

## 常用命令（在仓库根目录执行）

```bash
# 从 Git 重抽企微盯一下文案（默认自 2026-09-24 04:00）
node debug/wecom-replay/scripts/extract-wecom-notify-archive.js

# 扫盯幅 ≥25%
node debug/wecom-replay/scripts/scan-pin-gain-gt25.js

# 5m/@@@ 前置分析
node debug/wecom-replay/scripts/analyze-flag-leading.js

# 近1h 验证 / 1h·2h·3h 对比
node debug/wecom-replay/scripts/validate-1h-momentum.js
node debug/wecom-replay/scripts/compare-1h-2h-3h.js
```

输出默认写在本目录（`debug/wecom-replay/`）。
