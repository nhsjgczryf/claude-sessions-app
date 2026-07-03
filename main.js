const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

const {
  shellQuote,
  loadSessions,
  saveSessions,
  loadWorkspaces,
  saveWorkspaces,
  parsePortForwards,
  buildLocalCommand,
  scpUpload,
  saveImageToTemp,
} = require('./lib/session-runtime');
const { acquireTunnel } = require('./lib/socks-tunnel');

let mainWindow = null;
const terminals = new Map();

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

// Resolve the absolute path of `ssh` on the local machine. node-pty's
// Windows backend (winpty/conpty) does not search PATH the way CreateProcess
// does — passing a bare 'ssh' yields "File not found". On Windows we look
// in the standard OpenSSH location plus every PATH entry; on POSIX we just
// trust PATH (pty.spawn there resolves correctly). Cached after the first
// successful resolution.
let _cachedSshPath = null;
function resolveSshPath() {
  if (_cachedSshPath) return _cachedSshPath;
  if (process.platform !== 'win32') {
    _cachedSshPath = 'ssh';
    return _cachedSshPath;
  }
  const candidates = [];
  if (process.env.SystemRoot) {
    candidates.push(path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe'));
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    candidates.push(path.join(dir, 'ssh.exe'));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { _cachedSshPath = c; return c; } } catch (_) {}
  }
  // Last resort: hand the bare name back and let pty.spawn fail loudly.
  return 'ssh';
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

// Auto-reconnect tuning. We only retry persistent ssh sessions, because
// non-persistent ones lose all in-flight work on the remote side anyway —
// silently re-attaching would lie about state. Bail out if the previous
// attempt died too quickly (likely a config error, not a network blip) or
// if we've already retried too many times in a row.
const RECONNECT_MIN_UPTIME_MS = 5000;
const RECONNECT_MAX_RETRIES = 5;
const RECONNECT_DELAY_MS = 1500;

// Build the env vars that point a locally-spawned process at our SSH SOCKS
// bridge. We set both upper- and lower-case forms because the Node and
// Python ecosystems disagree on which to honor. ALL_PROXY uses socks5h so
// DNS resolution happens on the remote side (the whole point of "use the
// remote box's network"); HTTPS_PROXY uses the HTTP bridge so anything
// that doesn't grok socks5:// (incl. undici / claude-code) still works.
function makeSocksProxyEnv(tunnel) {
  const http = `http://127.0.0.1:${tunnel.bridgePort}`;
  const socks = `socks5h://127.0.0.1:${tunnel.socksPort}`;
  return {
    HTTP_PROXY: http, HTTPS_PROXY: http,
    http_proxy: http, https_proxy: http,
    ALL_PROXY: socks, all_proxy: socks,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };
}

// Async: may need to await an SSH SOCKS tunnel for local sessions that opted
// in. Returns `{ pty, releaseTunnel }` — callers MUST call releaseTunnel()
// when the PTY exits, or the underlying ssh -D process leaks.
async function spawnPtyForTab(tabId, session, cols, rows, tmuxName) {
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
    const term = pty.spawn(resolveSshPath(), buildSshArgs(session, { tmuxName }), {
      ...baseOpts,
      cwd: os.homedir(),
    });
    return { pty: term, releaseTunnel: null };
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

  let env = baseOpts.env;
  let releaseTunnel = null;
  const socksHost = (session.socks_via_ssh || '').trim();
  if (socksHost) {
    const port = parseInt(session.socks_port, 10) || 1080;
    const tun = await acquireTunnel(socksHost, port);
    env = { ...env, ...makeSocksProxyEnv(tun) };
    releaseTunnel = () => tun.release();
  }

  const term = pty.spawn(shell, shellArgs, { ...baseOpts, env, cwd });
  return { pty: term, releaseTunnel };
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
      // Tunnel (if any) belonged to the dead PTY's env — release before we
      // park the entry so 'press R' starts cleanly with a fresh one.
      if (current.releaseTunnel) {
        try { current.releaseTunnel(); } catch (_) {}
      }
      // Keep the entry around (pty: null, exited: true) so the renderer's
      // "Press R to reconnect" path can re-spawn into the same tabId — and
      // so the reserved tmuxName isn't poached by a sibling tab. Cleared
      // by an explicit kill-terminal IPC.
      terminals.set(tabId, {
        ...current,
        pty: null,
        releaseTunnel: null,
        exited: true,
        lastExitCode: exitCode,
      });
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

    setTimeout(async () => {
      const stillThere = terminals.get(tabId);
      if (!stillThere || stillThere.pty !== term || stillThere.userClosed) return;
      try {
        const { pty: newTerm, releaseTunnel } = await spawnPtyForTab(
          tabId, session, cols, rows, tmuxName
        );
        // Window/tab may have been closed while we awaited the tunnel —
        // drop the freshly-spawned PTY if so to avoid an orphan.
        const after = terminals.get(tabId);
        if (!after || after.userClosed || after.pty !== term) {
          try { newTerm.kill(); } catch (_) {}
          if (releaseTunnel) { try { releaseTunnel(); } catch (_) {} }
          return;
        }
        const newEntry = {
          pty: newTerm,
          session,
          tmuxName,
          releaseTunnel,
          lastStartAt: Date.now(),
          retries: attempt,
          userClosed: false,
        };
        terminals.set(tabId, newEntry);
        attachPtyHandlers(tabId, newEntry, cols, rows);
        sendStartupCommand(newTerm, session);
      } catch (err) {
        console.error('[reconnect] failed to respawn pty:', err);
        // Same fall-through as the !shouldReconnect branch above: keep the
        // entry so the user can manually re-trigger via 'R'.
        const after = terminals.get(tabId);
        if (after) {
          terminals.set(tabId, {
            ...after,
            pty: null,
            releaseTunnel: null,
            exited: true,
            lastExitCode: exitCode,
          });
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal-exit', tabId, exitCode);
        }
      }
    }, RECONNECT_DELAY_MS);
  });
}

async function createTerminal(tabId, session, cols, rows) {
  // Pick a tmux name first — spawnPtyForTab needs it to build ssh args for
  // persistent sessions.
  const tmuxName =
    session.type === 'ssh' && session.persistent
      ? chooseTmuxName(session)
      : null;

  // Reserve the tmux name in `terminals` so a concurrent createTerminal call
  // sees it occupied. We must clear this placeholder if spawn throws —
  // otherwise it leaks into IPC handlers and crashes them with
  // `pty.write`/`pty.resize` on null.
  if (tmuxName) {
    terminals.set(tabId, { pty: null, session, tmuxName, releaseTunnel: null, lastStartAt: 0, retries: 0, userClosed: false });
  }

  let term, releaseTunnel;
  try {
    ({ pty: term, releaseTunnel } = await spawnPtyForTab(tabId, session, cols, rows, tmuxName));
  } catch (err) {
    terminals.delete(tabId);
    throw err;
  }

  const entry = {
    pty: term,
    session,
    tmuxName,
    releaseTunnel,
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      require('electron').shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const [, entry] of terminals) {
      if (entry.pty) {
        try { entry.pty.kill(); } catch (_) {}
      }
      if (entry.releaseTunnel) {
        try { entry.releaseTunnel(); } catch (_) {}
      }
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

ipcMain.handle('load-workspaces', () => loadWorkspaces());

ipcMain.handle('save-workspaces', (_evt, payload) => {
  try {
    saveWorkspaces(payload || {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('create-terminal', async (_evt, tabId, session, cols, rows) => {
  try {
    return await createTerminal(tabId, session, cols, rows);
  } catch (err) {
    console.error('[create-terminal] failed:', err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Re-spawn a PTY for a tab whose previous one exited. Reuses the original
// session config and tmuxName so persistent sessions reattach to the same
// tmux server instead of starting a fresh one.
ipcMain.handle('reconnect-terminal', async (_evt, tabId, cols, rows) => {
  const entry = terminals.get(tabId);
  if (!entry || !entry.exited || entry.pty) {
    return { ok: false, error: 'no exited terminal for this tab' };
  }
  try {
    const { pty: newTerm, releaseTunnel } = await spawnPtyForTab(
      tabId, entry.session, cols, rows, entry.tmuxName
    );
    const newEntry = {
      pty: newTerm,
      session: entry.session,
      tmuxName: entry.tmuxName,
      releaseTunnel,
      lastStartAt: Date.now(),
      retries: 0,
      userClosed: false,
    };
    terminals.set(tabId, newEntry);
    attachPtyHandlers(tabId, newEntry, cols, rows);
    sendStartupCommand(newTerm, entry.session);
    return { ok: true };
  } catch (err) {
    console.error('[reconnect-terminal] failed:', err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.on('terminal-input', (_evt, tabId, data) => {
  const entry = terminals.get(tabId);
  if (entry && entry.pty) {
    try { entry.pty.write(data); } catch (err) { console.error('[terminal-input]', err); }
  }
});

ipcMain.on('terminal-resize', (_evt, tabId, cols, rows) => {
  const entry = terminals.get(tabId);
  if (entry && entry.pty) {
    try { entry.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0)); }
    catch (err) { console.error('[terminal-resize]', err); }
  }
});

ipcMain.handle('kill-terminal', (_evt, tabId) => {
  const entry = terminals.get(tabId);
  if (entry) {
    // Mark before kill() so the onExit handler suppresses auto-reconnect.
    entry.userClosed = true;
    if (entry.pty) {
      try { entry.pty.kill(); } catch (_) {}
    }
    if (entry.releaseTunnel) {
      try { entry.releaseTunnel(); } catch (_) {}
    }
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
    return saveImageToTemp(img.toPNG());
  } catch (err) {
    console.error('[paste-clipboard-image]', err);
    return null;
  }
});

ipcMain.handle('scp-upload', (_evt, sshHost, localPath) => scpUpload(sshHost, localPath));

// Native folder picker for the "open in custom dir" new-tab flow.
// window.prompt() is disabled in Electron, so the web fallback never
// shows. Returns the absolute path, or null if the user canceled.
ipcMain.handle('pick-directory', async (_evt, defaultPath) => {
  const opts = { properties: ['openDirectory'] };
  if (defaultPath && typeof defaultPath === 'string') opts.defaultPath = defaultPath;
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const res = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// Read a file for the read-only preview. Local sessions read straight
// off this machine's fs; SSH sessions run `wc -c` + `head -c | base64`
// on the remote so we read the file the user actually sees in that
// terminal. Returns { base64, size, truncated } (or { error }). Capped
// at maxBytes so a huge file can't blow up the IPC buffer.
ipcMain.handle('read-file', async (_evt, filePath, maxBytes, sshHost) => {
  const HARD_MAX = 16 * 1024 * 1024;
  let max = parseInt(maxBytes, 10);
  if (!Number.isFinite(max) || max <= 0) max = 1024 * 1024;
  max = Math.min(max, HARD_MAX);

  if (sshHost) {
    const { execFile } = require('child_process');
    const q = "'" + String(filePath).replace(/'/g, "'\\''") + "'";
    const remote =
      `wc -c < ${q} 2>/dev/null; printf '__B64__\\n'; head -c ${max} ${q} 2>/dev/null | base64`;
    return new Promise((resolve) => {
      execFile('ssh', [sshHost, remote], { timeout: 30000, maxBuffer: 48 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve({ error: `ssh read failed: ${err.message}` });
          const sep = stdout.indexOf('__B64__\n');
          if (sep < 0) return resolve({ error: 'unexpected remote output' });
          const size = parseInt(stdout.slice(0, sep).trim(), 10);
          if (!Number.isFinite(size)) return resolve({ error: 'file not found or not readable' });
          const base64 = stdout.slice(sep + 8).replace(/\s+/g, '');
          resolve({ base64, size, truncated: size > max });
        });
    });
  }

  try {
    const resolved = path.resolve(filePath);
    const st = fs.statSync(resolved);
    if (!st.isFile()) return { error: 'not a regular file' };
    const size = st.size;
    const toRead = Math.min(size, max);
    const fd = fs.openSync(resolved, 'r');
    try {
      const buf = Buffer.alloc(toRead);
      let read = 0;
      while (read < toRead) {
        const n = fs.readSync(fd, buf, read, toRead - read, read);
        if (n <= 0) break;
        read += n;
      }
      return { base64: buf.subarray(0, read).toString('base64'), size, truncated: size > max };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
});

// Directory browser for the new-tab "custom dir" picker. Local sessions
// list this machine's fs; SSH sessions list the remote host over `ssh`
// (the native folder dialog can only browse the local fs, so SSH used to
// be a typed-path-only flow). Returns { path, parent, dirs } — parent is
// null at the fs root — or { error }. Hidden dotdirs are omitted.
ipcMain.handle('list-dir', async (_evt, dirPath, sshHost) => {
  if (sshHost) {
    const { execFile } = require('child_process');
    const q = "'" + String(dirPath || '').replace(/'/g, "'\\''") + "'";
    // cd into the target (or $HOME when blank), print the resolved abs
    // path, a sentinel, then trailing-slash dir names (ls -p) minus dotdirs.
    const remote =
      `d=${q}; cd "\${d:-\$HOME}" 2>/dev/null || { printf '__ERR__\\n'; exit 0; }; ` +
      `pwd; printf '__DIRS__\\n'; LC_ALL=C ls -1ap 2>/dev/null | grep '/\$' | grep -v '^[.]'`;
    return new Promise((resolve) => {
      execFile('ssh', [sshHost, remote], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve({ error: `ssh list failed: ${err.message}`, path: dirPath });
          if (stdout.startsWith('__ERR__')) return resolve({ error: 'cannot open that folder', path: dirPath });
          const sep = stdout.indexOf('__DIRS__\n');
          if (sep < 0) return resolve({ error: 'unexpected remote output', path: dirPath });
          const resolved = stdout.slice(0, sep).trim();
          const dirs = stdout.slice(sep + '__DIRS__\n'.length)
            .split('\n').map((s) => s.replace(/\/$/, '').trim()).filter(Boolean)
            .sort((a, b) => a.localeCompare(b));
          const parent = path.posix.dirname(resolved);
          resolve({ path: resolved, parent: parent === resolved ? null : parent, dirs });
        });
    });
  }

  try {
    const target = path.resolve(dirPath && String(dirPath).trim() ? dirPath : os.homedir());
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (e.name.startsWith('.')) return false;
        try {
          return e.isDirectory() ||
            (e.isSymbolicLink() && fs.statSync(path.join(target, e.name)).isDirectory());
        } catch (_) { return false; }
      })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    return { path: target, parent: path.dirname(target) === target ? null : path.dirname(target), dirs };
  } catch (err) {
    return { error: String(err && err.message || err), path: dirPath };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
