# Claude Sessions 技术文档

> 本文档详细描述 Claude Sessions 应用的完整实现细节，目标是让开发者能够仅凭此文档从零重建整个应用。

---

## 目录

1. [项目概述](#1-项目概述)
2. [架构设计](#2-架构设计)
3. [关键技术决策及原因](#3-关键技术决策及原因)
4. [node-pty 在 Windows 上的构建问题](#4-node-pty-在-windows-上的构建问题)
5. [数据流](#5-数据流)
6. [SSH 命令构造](#6-ssh-命令构造)
7. [文件结构](#7-文件结构)
8. [已知限制与未来工作](#8-已知限制与未来工作)

---

## 1. 项目概述

### 1.1 是什么

Claude Sessions 是一个基于 Electron 的桌面应用，用于管理多个 Claude Code 终端会话。它允许用户：

- 定义多个会话配置（本地 Windows 或 SSH 远程 Linux）
- 同时启动多个终端标签页，每个运行独立的 Claude Code 实例
- 通过侧边栏管理会话的增删改查（CRUD）
- 支持剪贴板图片粘贴（本地路径或 SCP 上传到远程）
- 使用 Catppuccin Mocha 暗色主题的美观 UI

### 1.2 架构总览（文字架构图）

```
┌──────────────────────────────────────────────────────────────┐
│                    Electron Application                       │
│                                                              │
│  ┌─────────────────────┐    IPC     ┌──────────────────────┐ │
│  │   Main Process       │◄─────────►│  Renderer Process     │ │
│  │   (main.js)          │           │  (renderer.js)        │ │
│  │                      │           │                       │ │
│  │  ┌────────────────┐  │           │  ┌─────────────────┐  │ │
│  │  │  node-pty       │  │  IPC:    │  │  xterm.js        │  │ │
│  │  │  PTY 实例管理   │  │  terminal│  │  终端渲染        │  │ │
│  │  │  (Map<tabId,    │  │  -data   │  │                  │  │ │
│  │  │   {pty,session}>│  │  ------► │  │  term.write()    │  │ │
│  │  │                 │  │          │  │                  │  │ │
│  │  │  pty.write()  ◄─┤──┤──────────┤──┤  term.onData()   │  │ │
│  │  └────────────────┘  │  terminal │  └─────────────────┘  │ │
│  │                      │  -input   │                       │ │
│  │  ┌────────────────┐  │           │  ┌─────────────────┐  │ │
│  │  │  sessions.json  │  │  save/   │  │  Session CRUD    │  │ │
│  │  │  读写           │  │  load    │  │  Modal Editor    │  │ │
│  │  └────────────────┘  │  sessions │  └─────────────────┘  │ │
│  │                      │           │                       │ │
│  │  ┌────────────────┐  │  scp-     │  ┌─────────────────┐  │ │
│  │  │  clipboard →    │  │  upload   │  │  Tab 管理        │  │ │
│  │  │  PNG → SCP      │  │  paste-   │  │  键盘快捷键     │  │ │
│  │  └────────────────┘  │  image    │  └─────────────────┘  │ │
│  └─────────────────────┘           └──────────────────────┘ │
│                                                              │
│  Shell 进程: PowerShell → (可选) ssh -t host 'command'       │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 技术栈

| 组件 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Electron | ^41.2.1 |
| 终端模拟器 | @xterm/xterm | ^6.0.0 |
| xterm 插件 | @xterm/addon-fit, addon-unicode11, addon-web-links | ^0.11.0 / ^0.9.0 / ^0.12.0 |
| PTY 后端 | node-pty | ^1.1.0 |
| 原生模块重建 | @electron/rebuild | ^4.0.3 |
| 数据存储 | JSON 文件 (sessions.json) | - |
| UI 主题 | Catppuccin Mocha (手工 CSS) | - |
| Shell | PowerShell (本地 + SSH 的宿主 shell) | - |

---

## 2. 架构设计

### 2.1 Electron Main Process (main.js)

主进程负责四大职责：窗口创建、PTY 管理、IPC handlers、SCP 上传、剪贴板图片处理、会话配置的持久化。详细实现见 `main.js`。

### 2.2 Preload (preload.js)

当前状态：preload.js 中定义了完整的 `contextBridge` API，但由于 `nodeIntegration=true` 且 `contextIsolation=false`，renderer.js 实际上直接通过 `require('electron').ipcRenderer` 访问 IPC，并未使用 `window.api`。preload.js 保留作为未来可能切换到安全模式的准备。

### 2.3 Renderer Process (renderer.js)

渲染进程是应用的核心 UI 逻辑，负责 xterm.js 终端渲染、Session CRUD、Tab 管理、键盘处理、Bracketed Paste。

### 2.4 UI (index.html + style.css)

使用 Catppuccin Mocha 主题的手工 CSS；CSS 变量定义全局色板；侧边栏 + 标签栏 + 终端区域三栏布局。

---

## 3. 关键技术决策及原因

- **nodeIntegration=true + contextIsolation=false**：xterm.js 及其 addon 需要 `require()` 在 renderer 中加载；本地工具不加载远程内容。
- **统一以 PowerShell 作为 shell**：保留 SSH 认证提示可见性，连接失败后仍有可用 shell。
- **直接 source nvm.sh**：绕过 `.bashrc` 的 non-interactive guard。
- **捕获阶段 DOM 监听器处理 Ctrl+C/V**：比 xterm 的 `customKeyEventHandler` 更可靠。
- **Bracketed Paste**：防止多行粘贴被 shell 逐行执行。
- **单层 shellQuote + 内部双引号**：避免嵌套转义。
- **setMenu(null)**：移除 Electron Edit 菜单的 Ctrl+C/V 全局加速键。

---

## 4. node-pty 在 Windows 上的构建问题

1. winpty.gyp GetCommitHash.bat 失败 → 硬编码 hash 为 `'none'`。
2. GenVersion.h 缺失 → 手动创建包含 `#define GenVersion_Version "none"` / `#define GenVersion_Commit "none"` 的头文件。
3. Spectre 缓解 MSB8040 错误 → 在两个 `.gyp` 文件中设置 `SpectreMitigation: "false"`。
4. 修复后运行 `npx @electron/rebuild`。

---

## 5. 数据流

- **会话启动**：用户双击 → `launchSession` → 创建 xterm → IPC `create-terminal` → `pty.spawn(powershell)` → 延迟 800ms 后写入启动命令。
- **用户输入**：xterm `onData` → IPC `terminal-input` → `pty.write`。
- **图片粘贴（SSH）**：`paste-clipboard-image` 保存 PNG → `scp-upload` 上传到远程 `/tmp/claude-clipboard/` → bracketed paste 路径。
- **大小调整**：`fitAddon.fit()` → IPC `terminal-resize` → `pty.resize`。

---

## 6. SSH 命令构造

```
ssh -t <ssh_host> '<nvm_source> && cd "<working_dir>" && <pre_command> && <claude_cmd> <claude_args>'
```

- 始终以 nvm 初始化开头（末尾 `; true` 保证即使 nvm.sh 不存在也不失败）。
- cd 路径使用双引号包裹。
- 最外层用 `shellQuote()` 单引号包裹，内部单引号做 `'\''` 转义。
- `-t` 强制分配 TTY。

---

## 7. 文件结构

```
claude-sessions-app/
├── package.json
├── main.js               # Electron 主进程
├── preload.js            # contextBridge（当前未生效）
├── renderer.js           # UI 核心逻辑
├── index.html            # HTML 骨架
├── style.css             # Catppuccin Mocha 样式
├── sessions.json         # 用户会话配置
├── docs/TECHNICAL.md     # 本文档
└── node_modules/
```

---

## 8. 已知限制与未来工作

- Ctrl+C 复制在极少数时序边缘情况下可能失效——右键或 Ctrl+Shift+C 可靠兜底。
- 实例计数仅基于当前 app 内的 tab 数量。
- 启动命令延迟硬编码为 800ms（未检测 shell prompt）。
- 无分屏、无终端内搜索、无标签页重排。
- 可迁移到 contextIsolation=true 安全模式（preload.js 已备好 API）。

---

## 附录 A：依赖安装与启动

```bash
npm install
# 若 node-pty 构建失败，参考第 4 节修复后：
npx @electron/rebuild
npm start
```

## 附录 B：快捷键一览

| 快捷键 | 上下文 | 功能 |
|--------|--------|------|
| `Ctrl+N` | 全局 | 新建会话 |
| `Ctrl+W` | 全局/终端 | 关闭当前标签页 |
| `Ctrl+Tab` | 全局 | 切换到下一个标签页 |
| `Ctrl+C` | 终端（有选中） | 复制选中文本 |
| `Ctrl+C` | 终端（无选中） | 发送 SIGINT (\x03) |
| `Ctrl+Shift+C` | 终端 | 强制复制选中文本 |
| `Ctrl+V` | 终端 | 粘贴文本（bracketed paste） |
| `Ctrl+Shift+V` | 全局 | 粘贴剪贴板图片 |
| `右键` | 终端（有选中） | 复制选中文本 |
| `右键` | 终端（无选中） | 粘贴文本（bracketed paste） |
| `双击` | 会话卡片 | 启动会话 |
| `右键` | 会话卡片 | 打开上下文菜单 |
| `Escape` | 模态框 | 关闭编辑器 |
| `Ctrl+Enter` | 模态框 | 保存并关闭 |
