// Shared logic between the Electron main process (main.js) and the web
// server (web/server.js). Anything related to constructing the actual
// commands to send to a PTY, plus session.json IO and SCP upload helpers,
// lives here so the two front-ends stay in lockstep.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'sessions.json');
const LEGACY_CONFIG_PATH = path.join(ROOT, '..', 'claude-sessions', 'sessions.json');

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Reads the full sessions.json object (sessions[] + optional workspaces[]).
// Legacy files that only had { sessions: [...] } round-trip cleanly.
function readConfigFile() {
  for (const p of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') return data;
      }
    } catch (err) {
      console.error(`[sessions] failed to read ${p}:`, err);
    }
  }
  return {};
}

function loadSessions() {
  const data = readConfigFile();
  return Array.isArray(data.sessions) ? data.sessions : [];
}

function saveSessions(sessions) {
  // Preserve any other top-level keys (workspaces, active_workspace_id, …)
  // so a save from an older codepath doesn't wipe workspace state.
  const existing = readConfigFile();
  const payload = JSON.stringify(
    { ...existing, sessions: sessions || [] },
    null,
    2
  );
  fs.writeFileSync(CONFIG_PATH, payload, 'utf-8');
}

function loadWorkspaces() {
  const data = readConfigFile();
  return {
    workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
    active_workspace_id: typeof data.active_workspace_id === 'string'
      ? data.active_workspace_id
      : null,
  };
}

function saveWorkspaces({ workspaces, active_workspace_id }) {
  const existing = readConfigFile();
  const payload = JSON.stringify(
    {
      ...existing,
      workspaces: Array.isArray(workspaces) ? workspaces : [],
      active_workspace_id: active_workspace_id || null,
    },
    null,
    2
  );
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
      // "local:remote"     -> "local:localhost:remote"
      // "local:host:remote"-> as-is
      if (/^\d+$/.test(spec)) return `${spec}:localhost:${spec}`;
      const parts = spec.split(':');
      if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
        return `${parts[0]}:localhost:${parts[1]}`;
      }
      return spec;
    });
}

function buildSshCommand(session) {
  const hasClaude = !!(session.claude_cmd && session.claude_cmd.trim());
  const persistent = !!session.persistent;
  const setupParts = [];

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
    const safeId = String(session.id || 'session').replace(/[^A-Za-z0-9_-]/g, '');
    const tmuxName = `cs-${safeId}`;
    const setupCmd = setupParts.join(' && ');
    const init = setupCmd
      ? `tmux new-session -d -s ${tmuxName}; tmux send-keys -t ${tmuxName} ${shellQuote(setupCmd)} Enter`
      : `tmux new-session -d -s ${tmuxName}`;
    remoteCmd =
      `if ! command -v tmux >/dev/null 2>&1; then ` +
      `  echo "[claude-sessions] tmux not found on remote; install it or disable 'persistent'" >&2; ` +
      `  exec "\${SHELL:-bash}" -il; ` +
      `fi; ` +
      `if ! tmux has-session -t ${tmuxName} 2>/dev/null; then ${init}; fi; ` +
      `exec tmux attach -t ${tmuxName}`;
  } else {
    if (!hasClaude) setupParts.push('exec "${SHELL:-bash}" -il');
    remoteCmd = setupParts.join(' && ');
  }

  const forwards = parsePortForwards(session.port_forwards)
    .map((spec) => `-L ${spec}`)
    .join(' ');
  const forwardFlags = forwards ? ` ${forwards}` : '';
  return `ssh -t${forwardFlags} ${session.ssh_host} ${shellQuote(remoteCmd)}`;
}

function buildLocalCommand(session) {
  const persistent = !!session.persistent;
  const parts = [];
  if (session.pre_command) parts.push(session.pre_command);
  const hasClaude = !!(session.claude_cmd && session.claude_cmd.trim());
  if (hasClaude) {
    const claudeArgs = session.claude_args ? ` ${session.claude_args}` : '';
    parts.push(`${session.claude_cmd.trim()}${claudeArgs}`);
  }

  // Persistent for local sessions: wrap in a local tmux. Same model as
  // the SSH path — first launch creates 'cs-<id>' detached and pushes
  // the setup commands to it via send-keys; subsequent launches just
  // attach. Closing the browser kills the bash that exec'd into tmux,
  // but the tmux server keeps the session alive and re-attach picks
  // up exactly where you left off.
  //
  // Limited to non-Windows because tmux isn't a thing on PowerShell;
  // the flag is silently a no-op on Windows local sessions.
  if (persistent && process.platform !== 'win32') {
    const safeId = String(session.id || 'session').replace(/[^A-Za-z0-9_-]/g, '');
    const tmuxName = `cs-${safeId}`;
    const setupCmd = parts.join(' && ');
    const init = setupCmd
      ? `tmux new-session -d -s ${tmuxName}; tmux send-keys -t ${tmuxName} ${shellQuote(setupCmd)} Enter`
      : `tmux new-session -d -s ${tmuxName}`;
    return (
      `if ! command -v tmux >/dev/null 2>&1; then ` +
      `echo "[claude-sessions] tmux not found locally; install it or disable Persistent" >&2; ` +
      `else ` +
      `if ! tmux has-session -t ${tmuxName} 2>/dev/null; then ${init}; fi; ` +
      `exec tmux attach -t ${tmuxName}; ` +
      `fi`
    );
  }

  // When no claude command, leave the locally-spawned shell as-is
  // (the PTY host is already a usable shell).
  return parts.join('; ');
}

function scpUpload(sshHost, localPath) {
  if (!sshHost || !localPath) {
    return Promise.resolve({ ok: false, error: 'missing sshHost or localPath' });
  }
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
}

// `ext` defaults to 'png' to preserve the original Electron callers'
// behavior (electron.clipboard.readImage().toPNG() always returns PNG).
// Web callers can pass 'jpg', 'webp', 'heic', etc. when they upload a
// gallery image whose mime type isn't PNG.
function saveImageToTemp(buffer, ext) {
  const dir = path.join(os.tmpdir(), 'claude-clipboard');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const safeExt = String(ext || 'png').replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'png';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `clip_${ts}.${safeExt}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = {
  shellQuote,
  loadSessions,
  saveSessions,
  loadWorkspaces,
  saveWorkspaces,
  parsePortForwards,
  buildSshCommand,
  buildLocalCommand,
  scpUpload,
  saveImageToTemp,
};
