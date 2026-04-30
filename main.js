const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const { execFile } = require('child_process');

let mainWindow = null;

const CONFIG_PATH = path.join(__dirname, 'sessions.json');
const LEGACY_CONFIG_PATH = path.join(__dirname, '..', 'claude-sessions', 'sessions.json');

const terminals = new Map();

// Bash-style single-quote escaping — used for text that will be parsed by a
// remote bash shell (e.g. tmux send-keys arguments embedded inside the
// remote command).
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function sanitizeTmuxName(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
}

// Pick a tmux session name that doesn't collide with any currently-active
// terminal in this app. Base = user-provided tmux_name, else `cs-<id>`.
// When another live tab already holds the base, suffix -2, -3, ...
// This restores the "multiple tabs per session" behavior for persistent mode:
// the first tab gets the stable name (so reconnects find it), additional
// tabs get their own persistent sessions instead of mirroring the first.
function chooseTmuxName(session) {
  const base =
    sanitizeTmuxName(session.tmux_name) ||
    `cs-${sanitizeTmuxName(session.id) || 'session'}`;
  const occupied = new Set();
  for (const [, entry] of terminals) {
    if (entry.tmuxName) occupied.add(entry.tmuxName);
  }
  if (!occupied.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const name = `${base}-${i}`;
    if (!occupied.has(name)) return name;
  }
  return `${base}-${Date.now()}`;
}

function loadSessions() {
  for (const p of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.sessions)) return data.sessions;
      }
    } catch (err) {
      console.error(`[sessions] failed to read ${p}:`, err);
    }
  }
  return [];
}

function saveSessions(sessions) {
  const payload = JSON.stringify({ sessions }, null, 2);
  fs.writeFileSync(CONFIG_PATH, payload, 'utf-8');
}

function parsePortForwards(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      // Bare number "14500" -> "14500:localhost:14500"
      // "local:remote" (two parts) -> "local:localhost:remote"
      // "local:host:remote" -> as-is
      if (/^\d+$/.test(spec)) return `${spec}:localhost:${spec}`;
      const parts = spec.split(':');
      if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
        return `${parts[0]}:localhost:${parts[1]}`;
      }
      return spec;
    });
}

function buildRemoteCmd(session, opts = {}) {
  const hasClaude = !!(session.claude_cmd && session.claude_cmd.trim());
  const persistent = !!session.persistent;
  const tmuxName = opts.tmuxName;

  // Build the "work" part: nvm source (claude only), cd, pre_command,
  // and the claude launch command if any. Everything that should run
  // once when the session is first created.
  const setupParts = [];

  // The nvm workaround is only needed when we run claude in a
  // non-interactive shell. Pure-shell mode gets an interactive shell
  // (directly or via tmux) which re-runs .bashrc normally.
  if (hasClaude && !persistent) {
    setupParts.push(
      'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; true'
    );
  }

  if (session.working_dir) setupParts.push(`cd "${session.working_dir}"`);
  if (session.pre_command) setupParts.push(session.pre_command);

  if (hasClaude) {
    const claudeArgs = session.claude_args ? ` ${session.claude_args}` : '';
    setupParts.push(`${session.claude_cmd.trim()}${claudeArgs}`);
  }

  let remoteCmd;

  if (persistent) {
    // Persistent mode: wrap in tmux. If the named session already
    // exists (e.g. from a previous disconnect), just attach — do NOT
    // re-run setup. Otherwise create it detached, send the setup
    // commands to its first window, then attach.
    const name = sanitizeTmuxName(tmuxName) || `cs-${sanitizeTmuxName(session.id) || 'session'}`;
    const setupCmd = setupParts.join(' && ');
    const init = setupCmd
      ? `tmux -u new-session -d -s ${name}; tmux send-keys -t ${name} ${shellQuote(setupCmd)} Enter`
      : `tmux -u new-session -d -s ${name}`;
    remoteCmd =
      `if ! command -v tmux >/dev/null 2>&1; then ` +
      `  echo "[claude-sessions] tmux not found on remote; install it or disable 'persistent'" >&2; ` +
      `  exec "\${SHELL:-bash}" -il; ` +
      `fi; ` +
      `if ! tmux has-session -t ${name} 2>/dev/null; then ${init}; fi; ` +
      `exec tmux -u attach -t ${name}`;
  } else {
    if (!hasClaude) {
      // Pure shell: drop into user's normal login+interactive shell.
      setupParts.push('exec "${SHELL:-bash}" -il');
    }
    remoteCmd = setupParts.join(' && ');
  }

  // ssh non-interactive shells don't source .bashrc/.profile, so LANG/LC_ALL
  // are typically unset. Without a UTF-8 locale, tmux renders multi-byte
  // characters (Chinese, emoji, …) as `_`. Prepend a fallback so the locale
  // is set for both the wrapping shell and any tmux server we spawn.
  return (
    `export LC_ALL="\${LC_ALL:-C.UTF-8}" LANG="\${LANG:-C.UTF-8}"; ` + remoteCmd
  );
}

// Build argv for `ssh` so it can be passed straight to pty.spawn — no local
// shell in between. This is what makes auto-reconnect actually work: when
// ssh exits, the PTY exits, and term.onExit fires. Wrapping ssh in a local
// shell (the previous design) means the shell is still alive after ssh dies
// and the PTY never exits.
function buildSshArgs(session, opts = {}) {
  const args = ['-t'];
  // Surface a dead network as an ssh exit within ~90s instead of hanging on
  // TCP timeout — required for the auto-reconnect path to ever fire.
  args.push('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3');
  for (const spec of parsePortForwards(session.port_forwards)) {
    args.push('-L', spec);
  }
  args.push(session.ssh_host);
  args.push(buildRemoteCmd(session, opts));
  return args;
}

function buildLocalCommand(session) {
  const parts = [];
  if (session.pre_command) parts.push(session.pre_command);
  const hasClaude = !!(session.claude_cmd && session.claude_cmd.trim());
  if (hasClaude) {
    const claudeArgs = session.claude_args ? ` ${session.claude_args}` : '';
    parts.push(`${session.claude_cmd.trim()}${claudeArgs}`);
  }
  // When no claude command, leave the locally-spawned PowerShell as-is
  // (the PTY host is already a usable shell).
  return parts.join('; ');
}

// Auto-reconnect tuning. We only retry persistent ssh sessions, because
// non-persistent ones lose all in-flight work on the remote side anyway —
// silently re-attaching would lie about state. Bail out if the previous
// attempt died too quickly (likely a config error, not a network blip) or
// if we've already retried too many times in a row.
const RECONNECT_MIN_UPTIME_MS = 5000;
const RECONNECT_MAX_RETRIES = 5;
const RECONNECT_DELAY_MS = 1500;

function spawnPtyForTab(tabId, session, cols, rows, tmuxName) {
  const baseOpts = {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    env: { ...process.env },
    useConpty: process.platform === 'win32',
  };

  // SSH sessions: spawn `ssh` directly as the PTY process (no local shell in
  // between). When ssh exits, term.onExit fires — which is what the
  // auto-reconnect logic depends on.
  if (session.type === 'ssh' && session.ssh_host) {
    return pty.spawn('ssh', buildSshArgs(session, { tmuxName }), {
      ...baseOpts,
      cwd: os.homedir(),
    });
  }

  // Local sessions: keep the shell-as-PTY model. The user's pre_command /
  // claude_cmd get typed into that shell after a short delay (see
  // sendStartupCommand). No reconnect logic applies here.
  const cwd =
    session.working_dir && fs.existsSync(session.working_dir)
      ? session.working_dir
      : os.homedir();
  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
  const shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoExit'] : [];
  return pty.spawn(shell, shellArgs, { ...baseOpts, cwd });
}

function sendStartupCommand(term, session) {
  // Only local sessions need this — for ssh sessions, ssh IS the PTY and
  // starts running its remote command immediately.
  if (session.type !== 'local') return;
  setTimeout(() => {
    try {
      const localCmd = buildLocalCommand(session);
      if (localCmd.trim()) term.write(localCmd + '\r');
    } catch (err) {
      console.error('[pty] failed to send startup command:', err);
    }
  }, 800);
}

function attachPtyHandlers(tabId, entry, cols, rows) {
  const { pty: term, session, tmuxName } = entry;

  term.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', tabId, data);
    }
  });

  term.onExit(({ exitCode }) => {
    const current = terminals.get(tabId);
    // If this exit belongs to a stale pty (already replaced by a reconnect),
    // ignore it.
    if (!current || current.pty !== term) return;

    const shouldReconnect =
      !current.userClosed &&
      session.type === 'ssh' &&
      session.persistent &&
      session.ssh_host &&
      Date.now() - current.lastStartAt >= RECONNECT_MIN_UPTIME_MS &&
      current.retries < RECONNECT_MAX_RETRIES;

    if (!shouldReconnect) {
      terminals.delete(tabId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-exit', tabId, exitCode);
      }
      return;
    }

    const attempt = current.retries + 1;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        'terminal-data',
        tabId,
        `\r\n\x1b[33m[connection lost (exit ${exitCode}); reconnecting… attempt ${attempt}/${RECONNECT_MAX_RETRIES}]\x1b[0m\r\n`
      );
    }

    setTimeout(() => {
      const stillThere = terminals.get(tabId);
      if (!stillThere || stillThere.pty !== term || stillThere.userClosed) return;
      try {
        const newTerm = spawnPtyForTab(tabId, session, cols, rows, tmuxName);
        const newEntry = {
          pty: newTerm,
          session,
          tmuxName,
          lastStartAt: Date.now(),
          retries: attempt,
          userClosed: false,
        };
        terminals.set(tabId, newEntry);
        attachPtyHandlers(tabId, newEntry, cols, rows);
        sendStartupCommand(newTerm, session);
      } catch (err) {
        console.error('[reconnect] failed to respawn pty:', err);
        terminals.delete(tabId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal-exit', tabId, exitCode);
        }
      }
    }, RECONNECT_DELAY_MS);
  });
}

function createTerminal(tabId, session, cols, rows) {
  // Pick a tmux name first — spawnPtyForTab needs it to build ssh args for
  // persistent sessions.
  const tmuxName =
    session.type === 'ssh' && session.persistent
      ? chooseTmuxName(session)
      : null;

  // tmuxName has to be reserved before pty.spawn so a second tab opened
  // simultaneously sees this name as occupied. Stash a placeholder.
  if (tmuxName) {
    terminals.set(tabId, { pty: null, session, tmuxName, lastStartAt: 0, retries: 0, userClosed: false });
  }

  const term = spawnPtyForTab(tabId, session, cols, rows, tmuxName);

  const entry = {
    pty: term,
    session,
    tmuxName,
    lastStartAt: Date.now(),
    retries: 0,
    userClosed: false,
  };
  terminals.set(tabId, entry);

  attachPtyHandlers(tabId, entry, cols, rows);
  sendStartupCommand(term, session);

  return { ok: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#1e1e2e',
    title: 'Claude Sessions',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
    autoHideMenuBar: true,
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile('index.html');

  // Route any window.open / link that escapes to the system browser instead
  // of letting Electron spawn a new BrowserWindow.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      require('electron').shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const [, entry] of terminals) {
      try { entry.pty.kill(); } catch (_) {}
    }
    terminals.clear();
  });
}

ipcMain.handle('load-sessions', () => loadSessions());

ipcMain.handle('save-sessions', (_evt, sessions) => {
  try {
    saveSessions(sessions || []);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('create-terminal', (_evt, tabId, session, cols, rows) => {
  try {
    return createTerminal(tabId, session, cols, rows);
  } catch (err) {
    console.error('[create-terminal] failed:', err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.on('terminal-input', (_evt, tabId, data) => {
  const entry = terminals.get(tabId);
  if (entry) {
    try { entry.pty.write(data); } catch (err) { console.error('[terminal-input]', err); }
  }
});

ipcMain.on('terminal-resize', (_evt, tabId, cols, rows) => {
  const entry = terminals.get(tabId);
  if (entry) {
    try { entry.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0)); }
    catch (err) { console.error('[terminal-resize]', err); }
  }
});

ipcMain.handle('kill-terminal', (_evt, tabId) => {
  const entry = terminals.get(tabId);
  if (entry) {
    // Mark before kill() so the onExit handler suppresses auto-reconnect.
    entry.userClosed = true;
    try { entry.pty.kill(); } catch (_) {}
    terminals.delete(tabId);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('get-active-terminals', () => {
  const result = {};
  for (const [tabId, entry] of terminals) {
    result[tabId] = entry.session && entry.session.id;
  }
  return result;
});

ipcMain.handle('paste-clipboard-image', () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const dir = path.join(os.tmpdir(), 'claude-clipboard');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `clip_${ts}.png`);
    fs.writeFileSync(filePath, img.toPNG());
    return filePath;
  } catch (err) {
    console.error('[paste-clipboard-image]', err);
    return null;
  }
});

ipcMain.handle('scp-upload', async (_evt, sshHost, localPath) => {
  if (!sshHost || !localPath) return { ok: false, error: 'missing sshHost or localPath' };
  const remoteName = path.basename(localPath);
  const remoteDir = '/tmp/claude-clipboard';
  const remotePath = `${remoteDir}/${remoteName}`;
  return new Promise((resolve) => {
    execFile('ssh', [sshHost, `mkdir -p ${remoteDir}`], { timeout: 15000 }, (err) => {
      if (err) return resolve({ ok: false, error: `mkdir failed: ${err.message}` });
      execFile('scp', [localPath, `${sshHost}:${remotePath}`], { timeout: 30000 }, (err2) => {
        if (err2) return resolve({ ok: false, error: `scp failed: ${err2.message}` });
        resolve({ ok: true, remotePath });
      });
    });
  });
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
