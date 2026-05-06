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
  const payload = JSON.stringify({ sessions: sessions || [] }, null, 2);
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
  const parts = [];
  if (session.pre_command) parts.push(session.pre_command);
  const hasClaude = !!(session.claude_cmd && session.claude_cmd.trim());
  if (hasClaude) {
    const claudeArgs = session.claude_args ? ` ${session.claude_args}` : '';
    parts.push(`${session.claude_cmd.trim()}${claudeArgs}`);
  }
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

function saveImageToTemp(buffer) {
  const dir = path.join(os.tmpdir(), 'claude-clipboard');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `clip_${ts}.png`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = {
  shellQuote,
  loadSessions,
  saveSessions,
  parsePortForwards,
  buildSshCommand,
  buildLocalCommand,
  scpUpload,
  saveImageToTemp,
};
