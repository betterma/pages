# 假聊天 App（chat-app）

手机网页版演示聊天：启动页 → 会话列表 → 聊天记录。数据存在本目录 `data/`，由后台写入 GitHub；前端只读展示并带加载动效。

## 打开

- 启动页：`chat-app/index.html`（`?skip=1` 可跳过动画）
- 会话列表：`chat-app/chats.html`
- 聊天：`chat-app/chat.html?id=t_demo_1`
- 后台：`chat-app/admin.html`

GitHub Pages 示例：`https://betterma.github.io/pages/chat-app/`

## 数据

| 文件 | 说明 |
|------|------|
| `data/threads.json` | 会话列表 |
| `data/messages/{threadId}.json` | 单会话消息 |

## 后台

1. 打开 `admin.html`
2. 口令默认：`chat-admin`（可在 `chat-store.js` 的 `ADMIN_PASS` 修改）
3. 增删改会话与消息后点保存，写入 GitHub Contents API

Token 与仓库配置见 `chat-store.js`（与仓库其它工具同一 PAT 分段写法）。

## 说明

- 聊天页底部输入框为装饰，演示版不可真实发送。
- 未读角标：进房后仅在本机 sessionStorage 记已读，不清空 GitHub 上的 `unread`（可在后台改）。
