# 假聊天 App（chat-app）

手机网页版演示聊天：启动页 → 会话列表 → 聊天记录。数据在 `data/`，读写 GitHub。

## 打开

- 启动页：`chat-app/index.html`（`?skip=1` 可跳过动画）
- 会话列表：`chat-app/chats.html`
- 聊天：`chat-app/chat.html?id=t_demo_1`
- 后台：`chat-app/admin.html`

GitHub Pages 示例：`https://betterma.github.io/pages/chat-app/`

## 能力

- **单聊 / 群聊**：群聊可配置成员；气泡按发送成员显示彩色字头像
- **头像字**：三字姓名取后两字，两字全取；背景色按成员 id 固定配色
- **可发送**：聊天页发送会写入 GitHub（`messages/{id}.json` + `threads.json`），冲突自动重试
- **已读**：进房把当前身份标为已读。单聊自己的消息显示「已读 / 未读」；群聊显示「已读 N人 · 未读 M人」
- **身份切换**：聊天顶栏「以某某发送」，可扮演不同成员发消息、记已读

## 数据

| 文件 | 说明 |
|------|------|
| `data/threads.json` | 会话：`type`、`members[]`、`unreadBy` |
| `data/messages/{threadId}.json` | 消息：`senderId`、`readBy[]` |

本机身份固定为 `u_me`（名称「我」）。

## 后台

1. 打开 `admin.html`
2. 口令默认：`chat-admin`
3. 可改类型、成员、消息发送者，保存写入 GitHub

## 安装成 APK

同一套页面可用 Capacitor 打安卓包，见目录内 Capacitor 配置。聊天数据仍走 GitHub，不必重新打包即可更新剧本。
