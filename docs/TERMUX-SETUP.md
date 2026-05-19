# Termux + Claude Sessions APK 一次性配置

目标：让 Claude Sessions APK 能连到**手机本机的 Termux** 当作一个 bash tab 用——和远端 SSH session 平级混用。

配置一次，**之后开机自动跑**，你基本不用再管它。

---

## 前置

- **Termux 必须从 [F-Droid](https://f-droid.org/en/packages/com.termux/) 装**。Google Play 上那个 Termux 4 年没更新了，包仓库连不上。
- 同样从 F-Droid 装 [Termux:Boot](https://f-droid.org/en/packages/com.termux.boot/)（开机自启需要）。

---

## 步骤 1：Termux 里跑一次

打开 Termux，跑下面这一段（直接复制粘贴）：

```bash
pkg update -y
pkg install -y openssh

# 设密码（输两遍）
passwd

# 看一下你的用户名（待会儿要填到 APK 的 session 里）
whoami
```

记下 `whoami` 输出的字符串——比如 `u0_a234`，**这就是 APK 里要填的 username**。

---

## 步骤 2：让 sshd 开机自启 + 保活

还在 Termux 里：

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-sshd <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sshd
EOF
chmod +x ~/.termux/boot/start-sshd
```

这个脚本做两件事：

- `termux-wake-lock`：让 Termux 在通知栏放一个常驻通知。Android 看到这个通知就不会随便杀 Termux 进程。
- `sshd`：起 OpenSSH 服务，默认监听 `127.0.0.1:8022`。

Termux:Boot 插件检测到 `~/.termux/boot/` 下的脚本，**每次开机自动执行**。

最后手动跑一次让它立刻生效（不用等下次重启）：

```bash
~/.termux/boot/start-sshd
```

通知栏应该会出现一个"Termux Wake Lock"灰色通知——这是好事，**别把它划掉**。

---

## 步骤 3：Claude Sessions APK 里建 session

打开 APK，里面应该已经有一个预设 `Termux (this phone)` session。点 Edit：

| 字段 | 填什么 |
|------|--------|
| Name | `Termux (this phone)`（默认就是） |
| Host | `127.0.0.1`（默认就是） |
| Port | `8022`（默认就是） |
| Username | 步骤 1 里 `whoami` 输出的字符串，比如 `u0_a234` |
| Auth | Password |
| Password | 步骤 1 里 `passwd` 设的密码 |
| Persistent | ✅ 勾上（远端用 tmux 包，断开重连接回原状态） |
| Claude Cmd | *（留空，进 bash）* 或者填 `claude` 自动启动 |

保存 → Launch → 应该 2 秒内进入 Termux 的 bash。

第一次进去**装 tmux**（Persistent 用到）：

```bash
pkg install -y tmux
```

之后这个 tab 就是你"手机本机的 bash 入口"，跟远端 SSH tab 完全等价。

---

## 怎么验证一切对了

- 通知栏有 `Termux Wake Lock` 常驻通知 ✓
- APK 里这个 session 能 Launch 上 ✓
- 进去之后 `pwd` 显示 `/data/data/com.termux/files/home` ✓
- 重启手机后**不用先打开 Termux**，直接打开 APK 这个 session 也能连上 ✓（这一步证明 Termux:Boot 起作用了）

---

## 维护

- **手机内存紧张时**：Android 仍可能杀 Termux。重新打开 Termux 一次（不需要操作）就重新起来；APK 那边 Persistent 重连机制会自动 attach 回 tmux。
- **"清空最近任务"全部清掉**：会同时清掉 Termux。打开 Termux 应用一次它就回来了。
  - 想完全规避：系统设置 → 应用 → Termux → 锁定到最近任务 / 不能清理（具体名字按厂商）。
- **升级 Termux 或 packages 之后**：`pkg upgrade` 完通常会保留 sshd 设置；如果不工作，再跑一次步骤 1。

---

## 故障排查

| 现象 | 原因 / 修法 |
|------|------|
| APK 连上 Termux 但提示 "auth failed" | 用户名拼错或密码不对。在 Termux 里再跑 `whoami` / `passwd` 核对 |
| Connect 卡住超时 | Termux 没在跑 / sshd 没起来。打开 Termux 跑 `sshd`（如果脚本没自启的话） |
| 几小时不用之后断开 | 通常是 Android 把 Termux 杀了。检查通知栏 wake-lock 还在不在；如果没了说明 Termux 被清了，打开它即可重新建立 |
| `pkg install` 报"无法解析仓库" | Termux 是 Play Store 版本（已停更）。换 F-Droid 版本，必须 |

更深入的 Termux 配置参考 [Termux Wiki](https://wiki.termux.com/wiki/Main_Page)。
