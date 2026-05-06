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

配置文件：`sessions.json`（应用目录下）。示例：

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
| `persistent` | （SSH 会话）用 tmux 包一层，网络断开或关闭 tab 后远程进程继续跑；下次打开会 `tmux attach` 回到原状态 |
| `working_dir` | 工作目录 |
| `pre_command` | 预执行命令（可选） |
| `claude_cmd` | Claude 命令；**留空则不自动启动任何命令，直接进入 shell**（SSH 会话会 `exec $SHELL -il` 给你一个正常的交互式 shell） |
| `claude_args` | 附加参数 |
| `description` | 描述文字 |

## 持久化（tmux）

SSH 会话勾选 **Persistent** 后，远程命令会被包进一个命名为 `cs-<sessionId>` 的 tmux 会话：

- 第一次连接：`tmux new-session -d -s cs-<id>` 创建后台会话，把 `cd` + `pre_command` + `claude` 用 `tmux send-keys` 推进去，然后 `tmux attach`
- 断网 / 关 tab / 机器重启后再连：检测到 tmux 会话已存在 → 直接 `tmux attach`，不重跑 setup；远端 claude / 构建进程继续跑
- 需要彻底重启：远程手动 `tmux kill-session -t cs-<id>`，下次连接会重新初始化

需要远程机器装了 `tmux`；没装时会打印提示并退回普通 shell，不会中断。

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
