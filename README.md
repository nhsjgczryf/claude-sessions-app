# Claude Sessions

基于 Electron + xterm.js 的桌面应用，用于同时管理多个 Claude Code 终端会话（本地 Windows 或 SSH 远程 Linux）。

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
| `working_dir` | 工作目录 |
| `pre_command` | 预执行命令（可选） |
| `claude_cmd` | Claude 命令（留空则用 `claude`） |
| `claude_args` | 附加参数 |
| `description` | 描述文字 |

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
