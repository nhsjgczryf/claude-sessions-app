# Claude Sessions — Web 版

把 Electron 桌面版的功能搬进浏览器：一个 Node 后端跑 PTY/SSH/SCP，前端用 xterm.js，手机/平板浏览器都能直接用。**单账号**，密码登录，安全配置已经默认到位。

## 启动

```bash
# 第一次：装依赖（包含 express + ws）
npm install

# 默认绑 127.0.0.1:3000
npm run web

# 局域网 / 手机访问（推荐配合反向代理 + HTTPS）
HOST=0.0.0.0 PORT=3000 npm run web
```

## 首次注册

启动时如果没有账号，控制台会打印一段一次性 **注册码**：

```
============================================================
 [claude-sessions] No account exists yet.
 Register on the web UI with this one-time code:

   REGISTRATION CODE: aB3xK9pqRz7sUv2L

 (Code is invalidated after first successful registration
  or whenever the server restarts.)
============================================================
```

打开 `http://server:3000`，会出现注册表单。填注册码 + 用户名 + 密码（≥ 12 位）即可。注册成功后：

- 写入 `auth.json`（权限 0600，包含 scrypt 哈希后的密码，**绝不**包含明文）
- 注册码立即失效；后续访问只显示登录表单
- 当前浏览器自动收到 session cookie，免重复登录

**忘了密码 / 想换账号**：删除 `auth.json` 和 `auth-sessions.json`，重启服务，会重新生成注册码。

## 安全设计

| 层面 | 做法 |
|------|------|
| 密码哈希 | `crypto.scrypt`，参数 N=2¹⁵, r=8, p=1，每密码 16-byte 随机 salt（OWASP 推荐档） |
| 密码长度 | 强制 ≥ 12 字符（≤ 256） |
| 用户名 | `[A-Za-z0-9._-]`，1–64 字符 |
| 比较 | 全程 `crypto.timingSafeEqual`，用户名不匹配也跑一遍 dummy hash 防时序枚举 |
| Session | 32-byte 随机 ID（base64url），存在内存 + 持久化到 `auth-sessions.json`，TTL 7 天，过期自动清理 |
| Cookie | `HttpOnly`、`SameSite=Strict`、`Path=/`、`Max-Age=7d`；HTTPS 时自动加 `Secure` |
| WebSocket | 升级握手时校验同一个 cookie，不再走 query string（避免泄漏到日志/referer） |
| 限流 | 注册 + 登录共用：每 IP 15 分钟 5 次，超出 429 |
| 注册防抢注 | 一次性注册码（控制台打印，重启重新生成），不知道码就无法注册 |
| 文件权限 | `auth.json` / `auth-sessions.json` 写入时 mode 0600 |
| `.gitignore` | 已加入 auth 文件，避免误提交 |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `3000` | 监听端口 |
| `TRUST_PROXY` | *（未设）* | 设为 `1` 时信任 `X-Forwarded-Proto` / `X-Forwarded-For`，给 Cookie 自动加 `Secure`，限流读真实 IP |

## 部署模板

### 本机用

```bash
npm run web
# 浏览器开 http://localhost:3000
```

### 局域网 / 手机用（推荐）

前面套 [Caddy](https://caddyserver.com/) 拿免费 HTTPS：

```Caddyfile
sessions.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
TRUST_PROXY=1 HOST=127.0.0.1 PORT=3000 npm run web
```

`HOST=127.0.0.1` 让 Node 只监听本地，外面靠 Caddy 转发；这样 Node 永远拿不到非 HTTPS 流量，cookie 全程 `Secure`。

### 不想搞 HTTPS 的私网

```bash
HOST=0.0.0.0 npm run web
```

只在 Tailscale / VPN / 公司内网 等可信网络里访问；http 没有 `Secure` 也能用，但 token 不会出现在 URL 里，最大泄露风险是中间人嗅探，请评估你的网络可信度。

## 与桌面版的关系

`sessions.json` 和 `lib/session-runtime.js` 都是共享的——你在 Web 版编辑会话、桌面版重新打开就能看到，反之亦然。SSH 命令构造（tmux 持久化、port forwards、nvm 兜底、纯 shell 模式）在两端**完全一致**。

```
┌──── browser (phone/desktop) ────┐
│  index.html + xterm.js + WS      │
└──┬──────────────────┬────────────┘
   │ /api/* (REST)    │ ws://… (terminal data)
   │  + cookie        │  + cookie
┌──▼──────────────────▼────────────┐
│  web/server.js                    │
│   ├─ /api/auth/*                  │
│   ├─ /api/sessions / paste-image  │
│   ├─ ws: terminal I/O             │
│   └─ node-pty: spawn shell + ssh  │
└──┬───────────────────────────────┘
   │ uses
┌──▼───────────────────────────────┐
│  lib/auth.js          (scrypt)    │
│  lib/session-runtime.js (ssh/scp) │
└───────────────────────────────────┘
```
