# Claude Sessions — Web 版

把 Electron 桌面版的功能搬进浏览器：一个 Node 后端跑 PTY/SSH/SCP，前端用 xterm.js，手机/平板浏览器都能直接用。

## 启动

```bash
# 第一次：装依赖（包含 express + ws）
npm install

# 默认绑 127.0.0.1:3000，本机访问
npm run web

# 局域网 / 手机访问，必须设 TOKEN
HOST=0.0.0.0 PORT=3000 TOKEN=$(openssl rand -hex 16) npm run web
```

启动后控制台会打印访问地址；手机浏览器打开 `http://<server-ip>:3000`，第一次会让你输入 token，记在 localStorage 里下次免输。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `127.0.0.1` | 监听地址。绑非 loopback 时**必须**设 `TOKEN`，否则启动失败（防止把别人的 shell 服务暴露到公网） |
| `PORT` | `3000` | 监听端口 |
| `TOKEN` | *（空）* | 接口与 WebSocket 的 bearer token；空表示不鉴权（仅 loopback 安全） |

## 架构

```
┌──── browser (phone/desktop) ────┐
│  index.html + xterm.js + WS      │
└──┬──────────────────┬────────────┘
   │ /api/* (REST)    │ ws://… (terminal data)
┌──▼──────────────────▼────────────┐
│  web/server.js                    │
│   ├─ Express: sessions / image    │
│   ├─ ws: terminal I/O             │
│   └─ node-pty: spawn shell + ssh  │
└──┬───────────────────────────────┘
   │ uses
┌──▼───────────────────────────────┐
│  lib/session-runtime.js           │
│   buildSshCommand / scp / sessions│
└───────────────────────────────────┘
```

`sessions.json` 与桌面版**共用**——两个版本编辑后看到的是同一份数据。`lib/session-runtime.js` 是抽出来的共享模块，桌面版 `main.js` 和 Web 版 `web/server.js` 都依赖它，所以 SSH 命令构造、tmux 持久化、port forwards 行为完全一致。

## 与桌面版的功能对照

| 功能 | 桌面版 | Web 版 |
|------|--------|--------|
| 本地 / SSH 会话 | ✅ | ✅ |
| 多标签页 | ✅ | ✅ |
| 持久化（tmux） | ✅ | ✅ |
| Port forwards | ✅ | ✅ |
| 剪贴板图片粘贴 | Electron clipboard API | 浏览器 Clipboard API（需 HTTPS 或 localhost；用户首次会被询问权限） |
| 终端 URL 点击 | `shell.openExternal` | `window.open(_, '_blank')` 新标签 |
| 拖拽重排（会话/标签） | ✅ | ✅（桌面浏览器；手机上拖拽体验有限） |
| 多端同步 | 单机 | ✅（多个浏览器连同一服务器） |

## 安全注意事项

这个进程实质上是**远程执行任意命令**的服务，按以下原则保护：

1. **永远别裸奔到公网**。绑 `0.0.0.0` 时 `TOKEN` 必填；要从外网访问，前面套个反向代理（nginx + HTTPS + basic auth / OAuth），或者只通过 Tailscale / WireGuard / SSH 隧道访问。
2. Token 走 query string 用于 WebSocket（浏览器 WebSocket 不支持自定义 header），所以要走 HTTPS（`wss`）才不会被中间人看到。
3. SCP 上传用的是服务器自己 `~/.ssh/config` 的连接信息，意味着任何能访问 web 服务的人都能调用服务器的 SSH 凭证去操作配置里的远程主机——同样的攻击面收紧靠 token + HTTPS。
