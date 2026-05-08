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

## Web 标签页（在 app 里 iframe 远程网页）

会话类型选 `Web` 后填一个 URL，这个 URL **从服务器视角**可达即可——浏览器（含手机）会被服务器代理到那个 URL。这就解决了"手机的 localhost 不是服务器的 localhost"的问题，也是把"SSH 隧道转发出来的内部端口"暴露给手机用的关键。

典型组合（同一个 SSH session + 一个 Web session 一组）：

| Session | 字段 |
|---------|------|
| **SSH (xpra)** | `ssh_host: my-server`, `port_forwards: 14500`, `pre_command: xpra start --start=google-chrome-stable --bind-tcp=0.0.0.0:14500 --html=on :100 \|\| true`, `claude_cmd:` *（空，进入 shell）* |
| **Web (xpra UI)** | `url: http://localhost:14500` |

启动两个标签页，xpra HTML5 界面就直接出现在 app 里。同理还能套 Grafana / Jupyter / code-server / n8n / DevTools 调试页 / 内网 dashboard。

### 工作原理

```
browser ── /p/<sessionId>/...  ──▶  web/server.js
                                       │
                                       ▼
                           http-proxy-middleware
                                       │
                          target = session.url (e.g. http://localhost:14500)
                                       │
                                       ▼
                              upstream service
```

- **HTTP + WebSocket 双向代理**：xpra / Jupyter / code-server 这种大量用 WS 的服务也能转发。
- **`X-Frame-Options` / `frame-ancestors` 自动剥除**：让原本"禁止 iframe"的内部页也能嵌进来。
- **Cookie 路径重写**：上游设的 cookie 会被 scope 到 `/p/<id>`，多个 Web 标签互不污染。
- **3xx 重定向重写**：上游 `Location: http://internal/x` 会被改成 `/p/<id>/x`，避免跳出代理。
- **同一套 cookie 鉴权**：未登录 → 401；登录的用户能访问所有自己配置的 Web session。

### 已知限制

- **HTML 内的绝对路径不会被改写**。比如上游页面里有 `<a href="/dashboard">`，点了之后浏览器会跳到 `http://你的服务器/dashboard` 而不是 `/p/<id>/dashboard`，落到我们 app 的 404。Grafana / Jupyter / code-server 等支持 subpath 部署的应用都用相对路径，没问题；遇到不友好的应用，建议改用子域名反代（手动用 nginx/Caddy）。
- **跨标签页登录态隔离不完美**。两个 web session 都是同源 (`你的服务器:3000`)，所以 `localStorage`、`window.opener` 等会共享。一般问题不大，但**别拿这个代理跑一个公开网站和一个私有后台**，避免共享存储被滥用。
- **WebRTC / 一些深度集成 native API 的页面**（比如 Google Meet 在 iframe 里的限制）依然受浏览器 iframe 沙箱影响，代理解决不了。

---

## 长时间不操作 / 后台挂起会断吗？

**短答**：

- 服务端有 30s 一次的 WebSocket ping/pong 心跳，能挡掉大多数中间链路（NAT、Caddy/nginx、Cloudflare）的 idle 超时。
- 真的断了（手机锁屏几分钟、网络切换、隧道掐了），客户端会自动重连，但**非持久 SSH / Local session 的 PTY 已经在断开的瞬间被杀，重连后是空终端**。
- **任何你不希望被打断的工作都勾上 Persistent**：tmux 在远端把 shell 包了一层，重连的时候 `tmux attach` 接回原状态，claude 的对话历史、跑到一半的命令都还在。

### 详细排错

如果你即使勾了心跳也频繁断开，常见原因：

1. **反向代理的 WebSocket 超时太短**
   - **nginx**：默认 `proxy_read_timeout 60s`。WS 连接里 60 秒没数据就断。改成：
     ```nginx
     location / {
         proxy_pass http://127.0.0.1:3000;
         proxy_http_version 1.1;
         proxy_set_header Upgrade $http_upgrade;
         proxy_set_header Connection "upgrade";
         proxy_read_timeout 1h;     # 别用默认值
         proxy_send_timeout 1h;
     }
     ```
   - **Caddy**：默认 WS 不超时，不需要改。
   - **Cloudflare**：免费版 WS idle 上限 100s，我们 30s ping 在内，正常。

2. **手机浏览器后台冻结**：iOS Safari / Chrome 在 tab 后台几分钟后会冻结 JS，WS 也会被 OS 关掉。回到前台时客户端会自动重连——这是浏览器本身的限制，没法绕，所以 Persistent 是真正的兜底。

3. **运营商 NAT 超时**：某些 4G/5G 网络对 idle TCP 连接有 5–15 分钟超时。30s 心跳够用了。

很多任务（登录、过 captcha、装扩展、点 OAuth 同意按钮）必须有真实浏览器界面。这个 recipe 把三件事拼起来：

1. **远程 headed Chrome**（跑在 Xvfb 虚拟显示上，无需真实显示器）
2. **xpra HTML5** 把 Chrome 的画面流式推到你的浏览器里 → 你看到 Claude 的每一步操作；点 / 输入会回传到远程 Chrome → 你可以随时手动接管
3. **MCP browser server**（[`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) 或 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)）通过 CDP 端口 9222 控制同一个 Chrome → Claude 通过 MCP 工具调用驱动浏览器

三件事**都连接到同一个 Chrome 实例**：xpra 渲染显示，MCP 控制行为，你和 Claude 都看的是同一个画面。

### 一次性准备（在远程服务器上）

```bash
# 1. 装系统依赖
sudo apt install xpra xvfb google-chrome-stable

# 2. 装一个 MCP browser server（任选其一）
npm install -g @playwright/mcp@latest
# 或
# npm install -g chrome-devtools-mcp@latest

# 3. 让 Claude Code 知道这个 MCP server
mkdir -p ~/.claude
cat > ~/.claude/mcp.json <<'EOF'
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--cdp-endpoint", "http://127.0.0.1:9222"
      ]
    }
  }
}
EOF
```

> `--cdp-endpoint` 让 MCP server 不自己起浏览器，而是 attach 到我们已经跑起来的那个 Chrome（CDP 暴露在 9222）。`chrome-devtools-mcp` 用法类似，参考它的 README。

### 在 app 里建两个会话

**Session 1：SSH（启动 xpra+Chrome 并跑 Claude）**

| 字段 | 值 |
|------|----|
| Type | `SSH` |
| Name | `Claude+Browser` |
| ssh_host | `my-server` |
| port_forwards | `14500` |
| persistent | ✅（推荐：tmux 包一层，Claude 长任务不会被断网中断） |
| pre_command | （见下） |
| claude_cmd | `claude` |
| claude_args | `--mcp-config ~/.claude/mcp.json` *（如果你的 Claude Code 版本支持；不支持则上一步的全局 mcp.json 会被自动加载）* |

`pre_command`（一行，分号分隔；首次连接会通过 `tmux send-keys` 在 tmux 里执行）：

```bash
( pgrep -f "xpra.*:100" >/dev/null || xpra start --start='google-chrome-stable --remote-debugging-port=9222 --no-sandbox --disable-features=Translate --user-data-dir=/tmp/chrome-claude' --bind-tcp=0.0.0.0:14500 --html=on --exit-with-children=no :100 >/dev/null 2>&1 ) ; sleep 1
```

要点：
- `pgrep` 先检查 xpra 是不是已经在跑（持久化场景下重连不需要重新起）
- `--remote-debugging-port=9222` **本地** 监听（不要 `0.0.0.0:9222`，CDP 没鉴权，**绝对不能暴露**），靠 SSH 隧道到本地 app server 即可
- `--no-sandbox` 是 Chrome 跑在 root 下必须；非 root 可以不加
- `--user-data-dir=/tmp/chrome-claude` 给一个独立的 profile，避免和别的 Chrome 冲突
- `--start=` 用单引号包住——通过 app 启动时单引号会被 `shellQuote` 保护，安全到达远端 bash

**Session 2：Web（看 Chrome）**

| 字段 | 值 |
|------|----|
| Type | `Web` |
| Name | `Browser View` |
| url | `http://localhost:14500` |

### 用法

1. 启动 Session 1（SSH 终端 tab，里面跑着 Claude，已经能调 `browser_*` 这一组 MCP tools）
2. 启动 Session 2（Web tab，里面是 xpra 渲染的远程 Chrome）
3. 跟 Claude 说"帮我登录 example.com 然后下载这个月的报表" → Claude 调 MCP 的 `browser_navigate`、`browser_type`、`browser_click` → 你在 Session 2 里**看到 Claude 真的在点**
4. 遇到 Google 验证码 / 短信 OTP / Passkey？**直接在 Session 2 的 iframe 里手动操作完**，xpra 是双向的，Claude 这边等待，然后告诉它"我登好了，继续"

### 安全提示

- 9222 永远只绑 `127.0.0.1`。CDP 给任何能连到的人 = 任意代码执行。我们的反代不暴露 9222，只暴露 14500。
- 14500（xpra HTML5）通过 app 的 `/p/<id>/` 反代，**自动**继承 cookie 鉴权（账号没登录 → 401），所以即使你绑 `0.0.0.0` 也不是裸奔。
- 用持久化 + tmux 时注意 Chrome 的用户态会留在 `/tmp/chrome-claude`——里面**会有登录 cookie 和登录态**。只在你信任的服务器上跑。

### 进阶：Claude 看截图 vs Claude 看 DOM

`@playwright/mcp` 默认走 DOM (accessibility tree) 操作，token 便宜、响应快、不容易被反爬识别。如果想让 Claude **看截图** 决策（像 Anthropic 的 computer-use 那样），加 `--vision` 启用：

```json
"args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9222", "--vision"]
```

混合模式效果通常最好：DOM 优先，识别不出来的页面（canvas、weird shadow DOM）才截图给视觉模型看。

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
