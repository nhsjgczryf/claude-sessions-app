/*
 * Pure functions for turning a session config into the remote-side
 * command string that gets fed to sshj's shell. Equivalent to the
 * `buildRemoteCmd` half of lib/session-runtime.js — the SSH transport
 * itself is provided by the native plugin, not by spawning the ssh
 * binary, so we only need the remote-command portion (no
 * `ssh -t host '...'` wrapping).
 *
 * Kept in its own file so the rules — tmux wrapping, nvm sourcing,
 * locale fallback — stay readable and stay in sync (mentally) with
 * the desktop/web version.
 */

(function () {
  'use strict';

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function parsePortForwards(raw) {
    if (!raw) return [];
    return String(raw)
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((spec) => {
        if (/^\d+$/.test(spec)) return `${spec}:localhost:${spec}`;
        const parts = spec.split(':');
        if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
          return `${parts[0]}:localhost:${parts[1]}`;
        }
        return spec;
      });
  }

  function sanitizeTmuxName(s) {
    return String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
  }

  // Build the bash command we send to the remote shell *after* sshj
  // opens it (via initialCommand or post-allocation write).
  // Same semantics as the desktop/web `buildRemoteCmd`.
  function buildRemoteCmd(session, opts) {
    opts = opts || {};
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
      const base = sanitizeTmuxName(opts.tmuxName) ||
        `cs-${sanitizeTmuxName(session.id) || 'session'}`;
      const setupCmd = setupParts.join(' && ');
      const init = setupCmd
        ? `tmux -u new-session -d -s ${base}; tmux send-keys -t ${base} ${shellQuote(setupCmd)} Enter`
        : `tmux -u new-session -d -s ${base}`;
      remoteCmd =
        `if ! command -v tmux >/dev/null 2>&1; then ` +
        `  echo "[claude-sessions] tmux not found on remote; install it or disable persistent" >&2; ` +
        `  exec "\${SHELL:-bash}" -il; ` +
        `fi; ` +
        `if ! tmux has-session -t ${base} 2>/dev/null; then ${init}; fi; ` +
        `exec tmux -u attach -t ${base}`;
    } else {
      if (!hasClaude) setupParts.push('exec "${SHELL:-bash}" -il');
      remoteCmd = setupParts.join(' && ');
    }

    return `export LC_ALL="\${LC_ALL:-C.UTF-8}" LANG="\${LANG:-C.UTF-8}"; ${remoteCmd}`;
  }

  window.SessionBuilder = {
    buildRemoteCmd,
    parsePortForwards,
    sanitizeTmuxName,
  };
})();
