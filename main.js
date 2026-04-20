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

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
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

function buildSshCommand(session) {
  const remoteParts = [];
  remoteParts.push(
    'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; true'
  );
  if (session.working_dir) remoteParts.push(`cd "${session.working_dir}"`);
  if (session.pre_command) remoteParts.push(session.pre_command);
  const claudeCmd = (session.claude_cmd && session.claude_cmd.trim()) || 'claude';
  const claudeArgs = session.claude_args ? ` ${session.claude_args}` : '';
  remoteParts.push(`${claudeCmd}${claudeArgs}`);
  const remoteCmd = remoteParts.join(' && ');
  return `ssh -t ${session.ssh_host} ${shellQuote(remoteCmd)}`;
}

function buildLocalCommand(session) {
  const parts = [];
  if (session.pre_command) parts.push(session.pre_command);
  const claudeCmd = (session.claude_cmd && session.claude_cmd.trim()) || 'claude';
  const claudeArgs = session.claude_args ? ` ${session.claude_args}` : '';
  parts.push(`${claudeCmd}${claudeArgs}`);
  return parts.join('; ');
}

function createTerminal(tabId, session, cols, rows) {
  const cwd =
    session.type === 'local'
      ? session.working_dir && fs.existsSync(session.working_dir)
        ? session.working_dir
        : os.homedir()
      : os.homedir();

  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
  const shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoExit'] : [];

  const term = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd,
    env: { ...process.env },
    useConpty: process.platform === 'win32',
  });

  terminals.set(tabId, { pty: term, session });

  term.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', tabId, data);
    }
  });

  term.onExit(({ exitCode }) => {
    terminals.delete(tabId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exit', tabId, exitCode);
    }
  });

  setTimeout(() => {
    try {
      if (session.type === 'local') {
        const localCmd = buildLocalCommand(session);
        if (localCmd.trim()) term.write(localCmd + '\r');
      } else if (session.type === 'ssh' && session.ssh_host) {
        const sshCmd = buildSshCommand(session);
        term.write(sshCmd + '\r');
      }
    } catch (err) {
      console.error('[pty] failed to send startup command:', err);
    }
  }, 800);

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
