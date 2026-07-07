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

// A claude launch command counts as "really claude" only if its first token's
// basename is `claude`. The claude_cmd field is free text, so a user could put
// `bash`, `codex`, or some wrapper in it — those must never get session flags.
function looksLikeClaude(cmd) {
  const first = String(cmd || '').trim().split(/\s+/)[0] || '';
  return first.split('/').pop() === 'claude';
}

// The user is already driving session lifetime themselves if their command
// names any resume/continue/session flag — leave those untouched.
const CLAUDE_SESSION_FLAG_RE =
  /(?:^|\s)(?:-r|--resume|-c|--continue|--session-id|--fork-session)(?:[=\s]|$)/;

// Inject a stable session id into a claude launch command so the conversation
// survives an app restart / reconnect instead of starting over. `sessionId` is
// a uuid we own: passed via `--session-id` on the first launch, `--resume` on
// every relaunch. The resume form falls back to `--session-id` (grouped so the
// `||` binds only to the two claude invocations) so a missing transcript
// degrades to a fresh session on the same id rather than a dead
// "No conversation found" terminal. No-op when the command isn't claude, when
// the user already manages the session, or when no id was supplied (persistent
// / non-claude tabs pass none).
function withClaudeResume(claudeCmd, sessionId, resume) {
  if (!sessionId || !looksLikeClaude(claudeCmd) || CLAUDE_SESSION_FLAG_RE.test(claudeCmd)) {
    return claudeCmd;
  }
  if (!resume) return `${claudeCmd} --session-id ${sessionId}`;
  return `{ ${claudeCmd} --resume ${sessionId} || ${claudeCmd} --session-id ${sessionId}; }`;
}

function buildSshCommand(session) {
  const hasClaude = !!(session.claude_cmd && session.claude_cmd.trim());
  const persistent = !!session.persistent;
  const setupParts = [];

  if (hasClaude && !persistent) {
    // Belt-and-braces: even inside `bash -lc` some setups don't put nvm in
    // .bash_profile / profile.d, so keep the explicit source. Harmless if
    // login already provided a node.
    setupParts.push(
      'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; true'
    );
  }

  if (session.working_dir) setupParts.push(`cd "${session.working_dir}"`);
  if (session.pre_command) setupParts.push(session.pre_command);

  if (hasClaude) {
    const claudeArgs = session.claude_args ? ` ${session.claude_args}` : '';
    const raw = `${session.claude_cmd.trim()}${claudeArgs}`;
    // Persistent (tmux) sessions keep claude alive across reconnects on their
    // own, so only non-persistent ones need session-id/resume injection.
    setupParts.push(
      persistent ? raw : withClaudeResume(raw, session._claude_session_id, session._resume)
    );
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
  } else if (hasClaude) {
    // `ssh host cmd` runs a non-interactive, non-login shell — so /etc/profile,
    // /etc/profile.d/*.sh, and ~/.bash_profile never fire, and the claude
    // process inherits a bare $PATH / no PYENV_ROOT / no proxy vars.
    //
    // Just `-l` isn't enough: many profile.d scripts start with
    //   [ -z "$PS1" ] && return
    // or
    //   case $- in *i*) ;; *) return;; esac
    // so under a non-interactive login shell they still short-circuit. Adding
    // `-i` makes bash mark itself interactive (sets $-'s i flag and $PS1) so
    // those guards let the body through. We have a real pty from `ssh -t`, so
    // no "cannot set terminal process group" complaints.
    const inner = setupParts.join(' && ');
    remoteCmd = `exec bash -ilc ${shellQuote(inner)}`;
  } else {
    // Plain shell: `bash -il` already loads login + interactive rc files.
    setupParts.push('exec "${SHELL:-bash}" -il');
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
  // tmux persistence (the local persistent path below) keeps claude alive, so
  // only the non-tmux case loses its process on restart and needs injection.
  const useTmux = persistent && process.platform !== 'win32';
  if (hasClaude) {
    const claudeArgs = session.claude_args ? ` ${session.claude_args}` : '';
    const raw = `${session.claude_cmd.trim()}${claudeArgs}`;
    parts.push(
      useTmux ? raw : withClaudeResume(raw, session._claude_session_id, session._resume)
    );
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
  withClaudeResume,
  scpUpload,
  saveImageToTemp,
};
