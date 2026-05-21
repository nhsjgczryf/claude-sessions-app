# Claude Sessions

一套围绕 **Claude Code** 的多端终端会话管理工具,核心是用 xterm.js 同时管理多个会话(本地 / SSH 远程 / 远程 agent),每个会话可以自动启动 Claude Code,也可以只是一个纯 shell。三种形态共享同一套会话模型与 UI:

- **桌面版(Electron)**：本地 Windows shell + SSH 远程,可选 SOCKS-via-SSH 让本地 claude 走远端出口。本文主要讲这个。
- **Web 版(自托管)**：`web/server.js` 跑在你的机器/VPS 上,手机或任意浏览器打开即用。服务端持有 PTY(可 tmux-backed),断开/切标签后重连无感。详见 [`web/README.md`](web/README.md)，`npm run web` 启动。
- **Android APK**：手机原生应用,支持三种会话——直连 **SSH**、APK 内置的 **Local Linux**(proot + Alpine + claude-code,完全离线)、以及连接 Web 版服务的 **Remote agent**(WebSocket → VPS 上 tmux 里的 claude,持久化最稳)。详见下方 [Android APK](#android-apk) 一节。

> 选哪个?**重度远程 claude → Remote agent 模式**(服务端持久化,断线自动重连,绕开 SSH 保活的脆弱);**懒得在 VPS 装服务 → 直连 SSH**;**没有 VPS / 想离线 → Local Linux bundle**。

![theme](https://img.shields.io/badge/theme-Catppuccin%20Mocha-cba6f7)
![electron](https://img.shields.io/badge/electron-%5E41.2.1-47848f)
![xterm](https://img.shields.io/badge/xterm.js-%5E6.0.0-000)

## 特性

- **多会话管理**：侧边栏集中管理本地与 SSH 远程会话配置（名称、工作目录、预执行命令、Claude 命令与参数）。
- **多标签页**：每个会话一个独立 PTY，同一会话可启动多个实例。
- **Claude Code 优先**：SSH 会话自动 `source` nvm，绕过非交互式 shell 的 `.bashrc` guard。
- **剪贴板图片粘贴**：`Ctrl+Shift+V` 直接将剪贴板图片保存为 PNG；SSH 会话自动 SCP 上传并插入远程路径。
- **复制/粘贴行为对齐终端习惯**：有选中时 `Ctrl+C` 复制、无选中时发送 SIGINT；`Ctrl+V` 使用 bracketed paste 避免多行被逐行执行。
- **Catppuccin Mocha 暗色主题**。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+N` | 新建会话 |
| `Ctrl+W` | 关闭当前标签页 |
| `Ctrl+Tab` | 切换到下一个标签页 |
| `Ctrl+C` | 有选中→复制；无选中→发送 SIGINT |
| `Ctrl+Shift+C` | 强制复制 |
| `Ctrl+V` | 粘贴文本（bracketed paste） |
| `Ctrl+Shift+V` | 粘贴剪贴板图片 |
| 右键（终端） | 有选中→复制；无选中→粘贴 |
| 双击（会话卡片） | 启动会话 |
| `Esc` / `Ctrl+Enter` | 关闭 / 保存模态编辑器 |

## 布局调整

- **侧边栏宽度**：拖动侧边栏右侧的细竖条调整宽度（范围 180–500px），双击该竖条恢复默认（260px）。
- **折叠侧边栏**：点击侧边栏右上角的 `❮` 按钮完全隐藏；折叠后左上角浮动的 `❯` 按钮展开。
- **标签页重排**：按住标签拖动到其他位置即可调整顺序（出现蓝色指示线提示落点）。

上述状态（宽度、折叠）会保存在 `localStorage` 中。

## 安装与启动

```bash
npm install
# 如果 node-pty 原生模块构建失败，参考 docs/TECHNICAL.md 第 4 节，然后：
npx @electron/rebuild
npm start
```

## 会话配置

配置文件：`sessions.json`（应用目录下，已被 `.gitignore` 忽略）。仓库里只提交了 `sessions.example.json` 作为模板，第一次使用前 `cp sessions.example.json sessions.json` 然后改成你自己的会话即可。示例：

```json
{
  "sessions": [
    {
      "id": "local-default",
      "name": "Local Default",
      "type": "local",
      "working_dir": "D:/Users/me",
      "pre_command": "",
      "claude_cmd": "",
      "claude_args": "",
      "description": "Local home directory"
    },
    {
      "id": "remote-task",
      "name": "Remote Task",
      "type": "ssh",
      "ssh_host": "remote-task",
      "working_dir": "/home/me/work",
      "pre_command": "",
      "claude_cmd": "/path/to/claude-sandbox",
      "claude_args": "",
      "description": "Remote task server"
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识（自动生成） |
| `name` | 显示名称 |
| `type` | `local` 或 `ssh` |
| `ssh_host` | SSH 主机（`~/.ssh/config` 名称或 `user@host`） |
| `port_forwards` | SSH 本地端口转发，每行一条或逗号分隔。`14500` 会展开为 `14500:localhost:14500`；`14500:9222` 会展开为 `14500:localhost:9222`；完整 `local:host:remote` 直接原样传给 `ssh -L` |
| `persistent` | 用 tmux 包一层。SSH 在远端起 tmux，Local 在本地起 tmux（需要装 tmux；Windows 上是 no-op）。关闭 tab / 网络断开后进程继续跑；下次打开 `tmux attach` 回到原状态。 |
| `tmux_name` | （可选，仅 persistent）自定义 tmux 会话基名，默认 `cs-<id>`。同一会话开多个 tab 时自动在基名后追加 `-2`、`-3`，避免彼此 mirror |
| `working_dir` | 工作目录 |
| `pre_command` | 预执行命令（可选） |
| `claude_cmd` | Claude 命令；**留空则不自动启动任何命令，直接进入 shell**（SSH 会话会 `exec $SHELL -il` 给你一个正常的交互式 shell） |
| `claude_args` | 附加参数 |
| `description` | 描述文字 |
| `socks_via_ssh` | （仅 local）`ssh -D` 的远端主机名（`~/.ssh/config` 名称或 `user@host`）。设了之后，本地 shell 的所有出站 HTTP/HTTPS 会经远端 Linux 出口，详见下文。 |
| `socks_port` | （仅 local，配合上者）本地 SOCKS5 端口，默认 `1080`。同一 host:port 在多个 tab 间共享一条 tunnel，refcount 归零时自动关掉。 |

## 持久化（tmux）

SSH 会话勾选 **Persistent** 后，远程命令会被包进一个命名为 `cs-<sessionId>`（或你在 `Tmux Session Name` 里填的名字）的 tmux 会话：

- 第一次连接：`tmux new-session -d -s <name>` 创建后台会话，把 `cd` + `pre_command` + `claude` 用 `tmux send-keys` 推进去，然后 `tmux attach`
- 断网 / 关 tab / 机器重启后再连：检测到 tmux 会话已存在 → 直接 `tmux attach`，不重跑 setup；远端 claude / 构建进程继续跑
- 同一会话开多个 tab：第一个 tab 用基名，后续自动 `-2`、`-3`…每个 tab 是独立的 tmux session，不会互相 mirror
- 需要彻底重启：远程手动 `tmux kill-session -t <name>`，下次连接会重新初始化

需要远程机器装了 `tmux`；没装时会打印提示并退回普通 shell，不会中断。

## 本地 Claude，远端网络（SOCKS via SSH）

适合的场景：你想让 `claude` 在 Windows / macOS 本地跑（读本地文件、用本地 IDE 集成），但又想让它的 API 请求从一台已经做好 SSH 免密的远端 Linux 出去（比如那台机器有公网直连或翻墙能力，本地没有）。

**配置方式**：本地 session 填两个字段：

| 字段 | 值 |
|------|----|
| `type` | `local` |
| `socks_via_ssh` | `remote-linux`（`~/.ssh/config` 里的名字，或 `user@host`） |
| `socks_port` | `1080`（可改；只要本机这个端口空着就行） |
| `claude_cmd` | `claude` |

**工作流程**：

1. 启动 tab 时，app 在本地后台跑 `ssh -D 127.0.0.1:<socks_port> -N <socks_via_ssh>`（开启 `ExitOnForwardFailure=yes` + `BatchMode=yes`，所以没有密钥/不通会立即报错而不是挂住）。
2. 同时启动一个 HTTP 代理桥（127.0.0.1 上随机端口），让那些不认 `socks5://` 协议的工具（包括 Anthropic SDK / claude-code，因为它内部走 undici 不直接支持 SOCKS）也能用。该桥同时支持 `CONNECT`（HTTPS 隧道，claude 走这条）和绝对 URI 的纯 HTTP 转发（`GET http://… HTTP/1.1`，比如 `npm install`、`apt`），所以是个完整的正向代理。
3. PTY 里的 powershell / bash 启动时注入这些环境变量：
   - `HTTP_PROXY` / `HTTPS_PROXY` = `http://127.0.0.1:<bridge>`（HTTP 代理形式，最广兼容）
   - `ALL_PROXY` = `socks5h://127.0.0.1:<socks_port>`（给原生支持 SOCKS 的工具用；`h` 表示 DNS 也在远端解析）
   - `NO_PROXY` = `localhost,127.0.0.1,::1`
4. 关 tab / 应用退出时自动 kill 掉那个 `ssh -D`。多个 tab 共用同一 `host:port` 会共享一条 tunnel，最后一个 tab 关掉才回收。

**前置条件**：

- 本机 `ssh` 命令可用（Windows 10/11 自带 OpenSSH 即可）。
- `ssh <host>` 已经免密（密钥就绪、`~/.ssh/config` 写好）。`BatchMode=yes` 模式下，如果要交互输密码会直接失败。
- 端口 `socks_port` 本机未被占用。

**验证**：tab 里跑 `curl https://api.ipify.org`——返回的应该是那台远端 Linux 的公网 IP，而不是本机的。

## 示例：通过 xpra 查看远程 Chrome

无头服务器上跑可视化 Chrome（登录、装插件等），通过 SSH 隧道用本地浏览器访问：

**远程准备一次即可**：`sudo apt install xpra xvfb google-chrome-stable`

**会话配置**：

| 字段 | 值 |
|------|----|
| `type` | `ssh` |
| `ssh_host` | `your-server` |
| `port_forwards` | `14500` |
| `pre_command` | `xpra start --start=google-chrome-stable --bind-tcp=0.0.0.0:14500 --html=on --exit-with-children=no :100 >/dev/null 2>&1 \|\| true` |
| `claude_cmd` | *(留空，进入纯 shell)* |

启动会话后，本地浏览器打开 <http://localhost:14500> 就能看到并操作远程 Chrome；带宽约 200 KB/s–1 MB/s，登录 / 安装扩展完全够用。

同理可以用 `port_forwards: 9222` + `pre_command: google-chrome --headless=new --remote-debugging-port=9222 >/dev/null 2>&1 &` 来转发 Chrome DevTools Protocol，供本地 Claude / Playwright 调用。

## Android APK

手机上跑 Capacitor + WebView(内置 xterm.js + 多 tab UI),**不是套壳**。三种会话类型并存,按场景选:

| 类型 | 远端要什么 | 怎么跑 claude | 持久化 | 适合 |
|---|---|---|---|---|
| **SSH** | 现成 sshd | 原生 Kotlin 用 [sshj](https://github.com/hierynomus/sshj) 直连,远端 `claude` | 远端 tmux + 回前台重连 | 懒得装服务 |
| **Local Linux** | 无 | APK 内置 proot + Alpine + claude-code,**跑在手机上** | 手机进程(wake-lock) | 离线 / 没 VPS |
| **Remote agent** | VPS 跑 `web/server.js` | WebSocket → 服务端 PTY(tmux)里的 `claude` | **服务端 tmux,断线无感重连** | 主力,体验最稳 |

### 获取 APK

1. **从 Releases 下载**：push 到 `main` 自动构建 rolling latest;打 tag 创建版本化 release。
   - Latest URL: `https://github.com/<owner>/<repo>/releases/download/latest/claude-sessions-latest.apk`
2. **本地编译**(需要 JDK 21 + Android SDK + Docker，bundle 那条用 QEMU 构建 arm64 rootfs)：
   ```bash
   npm install
   npm run android:build
   # 产物：android/app/build/outputs/apk/debug/app-debug.apk
   ```

会话存在 Capacitor Preferences(应用沙盒,卸载一起删),**不跨设备同步**。targetSdk 锁 28——这样 Android 才允许 exec 内置的 proot / 进程,Termux/UserLAnd 同款做法,安装时系统会唠叨一句"为旧版 Android 设计",忽略即可。

### Local Linux(内置 Alpine)

APK 自带一个 arm64 Alpine rootfs(bash / coreutils / tmux / nodejs / npm / git,**不预装 claude-code**)+ 静态 proot。首次启动某个 Local Linux 会话时解压 rootfs 到应用私有目录(~30s 一次性),之后秒进 `alpine:/root#`。

- 装 claude:`HTTPS_PROXY=... npm i -g @anthropic-ai/claude-code`(受限网络先设代理;欢迎横幅里有提示)
- 不预装是因为受限地区没代理装了也用不了,且能省 CI 时间 + APK 体积
- CI 在 QEMU arm64 容器里构建 `alpine-rootfs.tar.zst` + 静态 proot,详见 [`scripts/build-alpine-rootfs.sh`](scripts/build-alpine-rootfs.sh)

> 旧的 "Termux 旁挂 sshd 连 127.0.0.1:8022" 方案([docs/TERMUX-SETUP.md](docs/TERMUX-SETUP.md))已被内置 Local Linux 取代,不再需要装 Termux。

### Remote agent(连 web/server.js)

把持久化的责任放到 24h 不睡的 VPS 上——手机随便断,回来重连 reattach,**不用 wake-lock 硬扛后台**(SSH 模式那条的痛点)。

**VPS 一侧**(一次性):
```bash
git clone … && cd claude-sessions-app && npm install
CS_PASSWORD='挑一个密码' HOST=0.0.0.0 PORT=3000 node web/server.js
# 要用 run_as(以别的 Linux 用户跑会话)就以 root 起这个进程
# 生产环境务必挂 caddy/nginx 上 TLS,或绑内网/VPN
```
`CS_PASSWORD` 跳过一次性注册码流程,直接设密码(可设成跟 SSH 一样那串)。

**APK 一侧**:新建会话选 **Remote agent**,填:
- Agent URL:`wss://你的VPS:3000`(测试可用 `ws://`,targetSdk 28 允许明文)
- Agent password:上面的 `CS_PASSWORD`
- Run as:留空 = agent 自己的用户;填 `root` / 某用户 = 服务端 `su -` 切过去(需 agent 以 root 跑)
- Working Dir:点 **Browse** 浏览 VPS 目录选一个项目
- Claude Cmd:`claude`

Launch → claude 在 VPS 上、指定用户、持久 tmux(`cs-<id>`)里跑。会话卡片上的 **Live** 按钮列出 VPS 上所有活着的 `cs-*` 会话,可 Attach(接回那个确切会话)/ Kill。

### 移动端输入

xterm.js 的隐藏 textarea 在 Android WebView 上 IME(中文等)不可靠(详见 `android-native/TerminalInputConnection.kt` 的注释),所以终端下方有一个**可见的多行输入框**:打字在框里(中文/英文都行)→ Enter 或 ↵ 按钮发送 → `\r` 执行。点终端本身不会弹键盘(走可见框输入)。下面一排 keybar 面向 claude:`Esc · ⇧⇥(切模式) · Tab · 方向键 · PgUp/PgDn · ^C · Ctrl`。

### 功能对照

| 功能 | SSH | Local Linux | Remote agent |
|---|---|---|---|
| 跑 claude | 远端 | 手机本机 | VPS |
| 持久化 | 远端 tmux | 手机进程 | **服务端 tmux** |
| 断线重连 | 回前台重连(SSH 脆) | 不涉及 | **WS 自动 reattach** |
| 多 tab | ✅ | ✅ | ✅ |
| 端口转发 `-L` | ✅(sshj) | — | — |
| 图片上传 | ✅(SFTP) | 本机 | (走服务端) |
| 列服务端活跃会话 | — | — | ✅(Live) |
| 按 Linux 用户跑 | — | — | ✅(run_as) |
| 目录浏览选择 | — | — | ✅(Browse) |

### 安全注意

- **凭证(SSH 密码/私钥、agent 密码)当前明文存 Capacitor Preferences**(应用沙盒)。下版本上 Android Keystore。
- SSH 模式 **host key 当前不验证**(`PromiscuousVerifier`),有中间人风险。下版本加 `known_hosts`。
- **Remote agent 的 `run_as` 需要 agent 以 root 跑**——一个联网的 root 进程,务必 TLS + 强密码 + 最好绑内网/VPN。
- Debug 签名,sideload 安装。

## 技术栈

| 组件 | 技术 |
|------|------|
| 桌面框架 | Electron ^41.2.1 |
| 终端 | @xterm/xterm ^6.0.0 + addon-fit / addon-unicode11 / addon-web-links |
| PTY | node-pty ^1.1.0 |
| 原生模块重建 | @electron/rebuild ^4.0.3 |

## 架构速览

```
┌─────────────────────────────────────────────────────────┐
│           Main Process  ◄── IPC ──►  Renderer Process    │
│           (main.js)                  (renderer.js)        │
│                                                         │
│  node-pty (PowerShell → ssh -t host 'cmd')              │
│  sessions.json 读写                                     │
│  clipboard → PNG → SCP 上传                              │
│                                                         │
│                                      xterm.js 终端      │
│                                      Session CRUD 模态   │
│                                      Tab 管理与快捷键    │
└─────────────────────────────────────────────────────────┘
```

更多设计细节（关键决策、SSH 命令构造、Windows 上 node-pty 的构建问题、数据流）见 [`docs/TECHNICAL.md`](docs/TECHNICAL.md)。

## 文件结构

```
claude-sessions-app/
├── main.js / preload.js / renderer.js / index.html / style.css   # Electron 桌面版
├── lib/
│   ├── session-runtime.js   # 共享的命令构造(SSH/local/tmux 包装),桌面+web 共用
│   ├── auth.js              # web 版单账号鉴权(scrypt + CS_PASSWORD bootstrap)
│   └── socks-tunnel.js      # SOCKS-via-SSH
├── web/
│   ├── server.js            # 自托管 agent:Express + ws,tmux-backed PTY,
│   │                        #   /api/tmux/{sessions,kill}、/api/fs/list、token 鉴权
│   └── public/              # 浏览器前端(xterm.js + WebSocket transport)
├── web-android/             # APK 的 WebView 内容
│   ├── renderer.js          # 多 tab UI + 三种 bridge 的调度
│   ├── ssh-bridge.js / local-shell-bridge.js / ws-bridge.js   # 三种传输
│   └── index.html / style.css
├── android-native/          # 原生 Kotlin + JNI(被 scripts/android-init.js 拷进 Android 工程)
│   ├── SshPlugin.kt         # sshj
│   ├── LocalShellPlugin.kt + Pty.kt + jni/pty.c   # 内置 Alpine 的 PTY
│   ├── ClaudeSessionsWebView.kt + TerminalInputConnection.kt   # WebView IME 拦截
│   └── ForegroundService.kt + KeepAlive.kt        # 后台保活
├── scripts/
│   ├── android-init.js            # 生成/同步 Capacitor Android 工程
│   └── build-alpine-rootfs.sh     # CI 在 QEMU 里构建 proot + Alpine rootfs
├── .github/workflows/build-apk.yml
└── docs/TECHNICAL.md
```

## License

MIT
