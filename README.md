# Claude Sessions

基于 Electron + xterm.js 的桌面应用，用于同时管理多个终端会话（本地 Windows 或 SSH 远程 Linux）。每个会话可以自动启动 Claude Code，也可以只是一个纯 SSH/本地 shell，方便在同一窗口里切换远程运维和 Claude 工作流。

> **也支持 Web 版**：相同后端 + xterm.js 浏览器前端，手机浏览器直接打开就能用 SSH + Claude Code，详见 [`web/README.md`](web/README.md)。`npm run web` 启动。

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

**这个 APK 不是套壳——它自己就是 SSH 客户端**。手机上跑 Capacitor + WebView（bundled xterm.js + 我们的多 tab UI），底层 SSH 由原生 Kotlin plugin 用 [sshj](https://github.com/hierynomus/sshj) 在 JVM 里维护。**不依赖外部 server**——目标 SSH 主机就是 SSH 主机，不需要在任何地方跑 `npm run web`。

### 获取 APK

1. **从 Releases 下载**：push 到 `main` 自动构建 rolling latest；打 tag 创建版本化 release。
   - Latest URL: `https://github.com/<owner>/<repo>/releases/download/latest/claude-sessions-latest.apk`
2. **本地编译**（需要 JDK 21 + Android SDK）：
   ```bash
   npm install
   npm run android:build
   # 产物：android/app/build/outputs/apk/debug/app-debug.apk
   ```

### 用法

1. 装 APK 打开（首次会让你允许"未知来源"）
2. 编辑 Sessions 列表里的占位 session：填 host、username、password 或 PEM 私钥；勾上 Persistent（远端用 tmux 包 shell）；`claude_cmd: claude` 让 SSH 进去就启动 claude
3. Launch → 直接 SSH 到目标主机；多 tab 并发，每个连接独立

会话存在 Capacitor Preferences（应用沙盒，卸载一起删）。**不会跨设备同步**——多设备共享需要手动 export / import（暂未做 UI）。

### 功能对照（vs 桌面/Web 版）

| 功能 | APK |
|---|---|
| 多 tab SSH 会话 | ✅ |
| tmux 持久化 (`persistent`) | ✅（tmux 在远端起，逻辑跟桌面版一致） |
| Port forwards (`-L`) | ✅（sshj 的 `LocalPortForwarder`） |
| 图片粘贴到远端 | ✅（系统相册 → SFTP 直接 PUT 到 `/tmp/claude-clipboard/`） |
| 键盘工具条（Ctrl/Tab/方向键/...） | ✅ |
| 后台保活 | ✅（foreground service + 持久通知） |
| 重连提示（Press R） | ✅ |
| 触屏滚动 scrollback | ✅ |
| ProxyJump | ❌（计划中） |
| Web tab (iframe 反代) | ❌（APK 没有反代后端） |
| 凭证用 Android Keystore 加密 | ❌（当前明文存 Preferences，下个迭代加） |

### 架构图

```
┌──── Android APK ─────────────────────────────────────────┐
│                                                           │
│  WebView (Capacitor)                                      │
│   ├── xterm.js (bundled)                                  │
│   ├── renderer.js (sessions + multi-tab UI)               │
│   └── ssh-bridge.js  ◄── JS-side wrapper                  │
│         │                                                 │
│         ▼ Capacitor JS ↔ Native bridge                    │
│                                                           │
│  SshPlugin.kt (com.hierynomus.sshj)                       │
│   ├── connect / write / resize / close                    │
│   ├── sftpPut（图片上传）                                  │
│   ├── port forwards (LocalPortForwarder)                  │
│   └── ForegroundService（持久通知 → 进程保活）              │
│         │                                                 │
│         ▼ TCP / SSH                                       │
└─────────│─────────────────────────────────────────────────┘
          │
   任何 SSH 主机（VPS / dev box / 内网机器）
```

### 安全注意

- **私钥/密码当前明文存 Capacitor Preferences**（应用沙盒）。root 过的手机的 root 用户能读到。下版本上 Android Keystore。
- **Host key 当前不验证**（用了 `PromiscuousVerifier`），有中间人攻击风险。下版本加 `known_hosts` 校验。
- Debug 签名，第一次安装 Android 会唠叨"未知来源"——sideload 装即可。

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
├── package.json
├── main.js            # Electron 主进程
├── preload.js         # contextBridge API（为未来安全模式准备）
├── renderer.js        # UI 核心逻辑
├── index.html
├── style.css          # Catppuccin Mocha
├── sessions.json      # 用户会话配置
└── docs/TECHNICAL.md  # 技术文档
```

## License

MIT
