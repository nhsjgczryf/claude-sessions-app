// Web version of the renderer. xterm.js + addons are loaded via UMD
// <script> tags in index.html, so they live on `window` as Terminal,
// FitAddon, WebLinksAddon, Unicode11Addon.

(function () {
'use strict';

const Terminal = window.Terminal;
const FitAddon = window.FitAddon && window.FitAddon.FitAddon;
const WebLinksAddon = window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon;
const Unicode11Addon = window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon;

const THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b7066',
  black: '#45475a',   red: '#f38ba8',
  green: '#a6e3a1',   yellow: '#f9e2af',
  blue: '#89b4fa',    magenta: '#f5c2e7',
  cyan: '#94e2d5',    white: '#bac2de',
  brightBlack: '#585b70',  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',   brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',   brightWhite: '#a6adc8',
};

const LS_WIDTH = 'claude-sessions.sidebarWidth';
const LS_COLLAPSED = 'claude-sessions.sidebarCollapsed';
// Tab list survives page reloads and app-switches. We store minimal
// metadata (persistent id, owning session id, kind) and recreate tabs
// on boot — server keeps PTYs alive for a grace period after the WS
// drops so reattach replays buffered output and resumes input.
const LS_TABS = 'claude-sessions.tabs';

let ws = null;
let sessions = [];
let selectedSessionId = null;
let tabs = [];
let activeTabId = null;

function newPersistentId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 't-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function saveTabsState() {
  try {
    const minimal = tabs.map((t) => ({
      id: t.id,
      sessionId: t.sessionId,
      sessionName: t.sessionName,
      kind: t.kind,
    }));
    localStorage.setItem(LS_TABS, JSON.stringify(minimal));
  } catch (_) {}
}

function readSavedTabs() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_TABS) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
let editingId = null;

// ============================================================================
// Helpers
// ============================================================================

function $(s) { return document.querySelector(s); }
function genId() { return Math.random().toString(36).slice(2, 10); }

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function notify(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let payload;
    try { payload = await res.json(); } catch (_) {}
    const err = new Error((payload && payload.error) || `HTTP ${res.status}`);
    err.status = res.status;
    // 401 on a non-auth endpoint = our session got revoked or expired.
    // Bring the auth screen back. 401 on /api/auth/* (e.g. bad
    // credentials, bad code) is expected; let the form handle it.
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      await showAuthScreen();
    }
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

function bracketedPaste(tabId, text) {
  if (!text) return;
  wsSend({ type: 'input', tabId, data: `\x1b[200~${text}\x1b[201~` });
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sessionInstanceCount(sessionId) {
  return tabs.filter((t) => t.sessionId === sessionId).length;
}

// ============================================================================
// Auth (single-account: register on first run, then login)
// ============================================================================

async function fetchAuthStatus() {
  const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('status: ' + res.status);
  return res.json();
}

function showAuthForm(which) {
  $('#auth-overlay').classList.remove('hidden');
  $('#auth-loading').classList.add('hidden');
  $('#login-form').classList.toggle('hidden', which !== 'login');
  $('#register-form').classList.toggle('hidden', which !== 'register');
  setTimeout(() => {
    const form = which === 'login' ? $('#login-form') : $('#register-form');
    const first = form.querySelector('input');
    if (first) first.focus();
  }, 50);
}

function hideAuthOverlay() {
  $('#auth-overlay').classList.add('hidden');
}

async function showAuthScreen() {
  // Decide which form to show based on server state.
  $('#auth-overlay').classList.remove('hidden');
  $('#auth-loading').classList.remove('hidden');
  $('#login-form').classList.add('hidden');
  $('#register-form').classList.add('hidden');
  let status;
  try { status = await fetchAuthStatus(); }
  catch (_) {
    $('#auth-loading').textContent = 'Server unreachable. Refresh to retry.';
    return;
  }
  if (status.authenticated) {
    hideAuthOverlay();
    bootApp();
    return;
  }
  showAuthForm(status.registered ? 'login' : 'register');
}

async function attemptStart() {
  await showAuthScreen();
}

async function bootApp() {
  try {
    sessions = await api('GET', '/api/sessions');
  } catch (err) {
    if (String(err.message).includes('unauthorized')) return;
    notify('Failed to load sessions: ' + err.message, 'error');
    return;
  }
  renderSessionList();
  // Recreate any tabs the user had open before reload / app-switch.
  // Each terminal tab will send 'create' to the server as soon as the
  // WS is open (via ws.onopen → attachAllTabsToServer) and the server
  // will reattach to its still-alive PTY if it's within the grace
  // window, replaying buffered output transparently.
  restoreTabsFromStorage();
  openWebSocket();
}

function restoreTabsFromStorage() {
  const saved = readSavedTabs();
  if (!saved.length) return;
  // Cap to avoid pathological growth if something went weird previously.
  const list = saved.slice(0, 20);
  for (const t of list) {
    const session = sessions.find((s) => s.id === t.sessionId);
    if (!session) continue;
    const opts = { persistentId: t.id, sessionName: t.sessionName };
    if (t.kind === 'web') launchWebSession(session, opts);
    else launchSession(t.sessionId, opts);
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#login-form .auth-error');
  errEl.textContent = '';
  const fd = new FormData(e.target);
  try {
    await api('POST', '/api/auth/login', {
      username: fd.get('username'),
      password: fd.get('password'),
    });
    hideAuthOverlay();
    bootApp();
  } catch (err) {
    errEl.textContent = err.message || 'Login failed';
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#register-form .auth-error');
  errEl.textContent = '';
  const fd = new FormData(e.target);
  const password = fd.get('password');
  const confirm = fd.get('confirm');
  if (password !== confirm) { errEl.textContent = 'Passwords do not match'; return; }
  try {
    await api('POST', '/api/auth/register', {
      code: (fd.get('code') || '').toString().trim(),
      username: (fd.get('username') || '').toString(),
      password,
    });
    hideAuthOverlay();
    bootApp();
  } catch (err) {
    errEl.textContent = err.message || 'Registration failed';
  }
});

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch (_) {}
  // Tear down active terminals locally and reload to reset all state.
  for (const t of tabs.slice()) closeTab(t.id);
  if (ws) try { ws.close(); } catch (_) {}
  location.reload();
}

// ============================================================================
// WebSocket
// ============================================================================

// After the whole WS dropped (server-side PTYs are gone), let each tab
// recover individually: print a prompt, on 'R' wait for the WS to be back
// up and then issue a fresh `create` with the original session config.
// For persistent SSH this lands back in the same remote tmux session.
function promptRecreateAfterWsLoss(tab) {
  tab.term.write(
    `\r\n\x1b[33m[Connection lost. Press R to reconnect, any other key to close.]\x1b[0m\r\n`
  );
  const disposable = tab.term.onKey(({ domEvent }) => {
    try { disposable.dispose(); } catch (_) {}
    if (!domEvent || (domEvent.key !== 'r' && domEvent.key !== 'R')) {
      closeTab(tab.id);
      return;
    }
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session) {
      tab.term.write(`\r\n\x1b[31m[session config missing — closing]\x1b[0m\r\n`);
      closeTab(tab.id);
      return;
    }
    tab.term.write(`\x1b[33m[waiting for WebSocket…]\x1b[0m\r\n`);
    const fire = () => {
      // Defer alive=true so the in-flight 'r' keypress' onData (xterm may
      // fire it AFTER onKey) doesn't slip through to the server.
      setTimeout(() => {
        tab.alive = true;
        renderTabs();
        renderSessionList();
      }, 0);
      const cols = (tab.term && tab.term.cols) || 120;
      const rows = (tab.term && tab.term.rows) || 30;
      wsSend({ type: 'create', tabId: tab.id, session, cols, rows });
    };
    if (ws && ws.readyState === WebSocket.OPEN) { fire(); return; }
    const started = Date.now();
    const tick = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) { clearInterval(tick); fire(); return; }
      if (Date.now() - started > 15000) {
        clearInterval(tick);
        tab.term.write(`\r\n\x1b[31m[WebSocket never came back. Press any key to close.]\x1b[0m\r\n`);
        const d2 = tab.term.onKey(() => {
          try { d2.dispose(); } catch (_) {}
          closeTab(tab.id);
        });
      }
    }, 250);
  });
}

function openWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Auth comes from the HttpOnly session cookie sent automatically on
  // the WebSocket upgrade — nothing to put in the URL.
  const url = `${proto}://${location.host}/`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    console.log('[ws] open');
    // Re-establish any terminal tabs that aren't already attached.
    // Server keeps PTYs alive for a grace period, so this either
    // reattaches (replays buffer) or spawns fresh — both transparent
    // to the user.
    attachAllTabsToServer();
  };
  ws.onclose = (ev) => {
    console.log('[ws] closed', ev.code);
    // 1006/1015 with no session = auth was revoked or expired.
    // Re-check status; the auth screen will reappear if needed.
    fetchAuthStatus().then((s) => {
      if (!s.authenticated) {
        showAuthScreen();
        return;
      }
      // Server retains PTYs across this disconnect; mark tabs as not
      // alive locally (so stray keystrokes don't queue up) but DON'T
      // show the "Press R" prompt — onopen will auto-reattach.
      for (const t of tabs) {
        if (t.kind !== 'terminal' || !t.alive) continue;
        t.alive = false;
      }
      renderTabs();
      renderSessionList();
      setTimeout(openWebSocket, 1500);
    }).catch(() => {
      setTimeout(openWebSocket, 1500);
    });
  };
  ws.onerror = (e) => console.error('[ws] error', e);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    const tab = tabs.find((t) => t.id === msg.tabId);
    if (!tab || tab.kind !== 'terminal') return;
    if (msg.type === 'data') tab.term.write(msg.data);
    else if (msg.type === 'ready') {
      // Fresh server-side PTY spawned for our tabId.
      tab.alive = true;
      renderTabs();
      renderSessionList();
    } else if (msg.type === 'reattached') {
      // Server still had a PTY for our tabId (kept alive across the
      // brief WS disconnect / page reload). Replay buffer arrives in
      // a separate 'data' frame; if it was exited a follow-up 'exit'
      // frame triggers the R-prompt path.
      tab.alive = !msg.exited;
      tab.term.write(`\x1b[90m[reattached]\x1b[0m `);
      renderTabs();
      renderSessionList();
    } else if (msg.type === 'exit') {
      tab.alive = false;
      tab.term.write(
        `\r\n\x1b[33m[Session ended with code ${msg.exitCode}. Press R to reconnect, any other key to close.]\x1b[0m\r\n`
      );
      const disposable = tab.term.onKey(({ domEvent }) => {
        try { disposable.dispose(); } catch (_) {}
        if (domEvent && (domEvent.key === 'r' || domEvent.key === 'R')) {
          const cols = (tab.term && tab.term.cols) || 120;
          const rows = (tab.term && tab.term.rows) || 30;
          tab.term.write(`\x1b[33m[reconnecting…]\x1b[0m\r\n`);
          // Defer alive=true so this same keypress' onData (which xterm
          // may fire AFTER onKey) sees alive=false and gets dropped —
          // otherwise the literal 'r' slips into the new PTY's input.
          setTimeout(() => {
            tab.alive = true;
            renderTabs();
            renderSessionList();
          }, 0);
          // Include the session config as a fallback: if the server
          // already GC'd this tab's entry (e.g., we were detached for
          // > PTY_GC_MS), it can still respawn using msg.session.
          const session = sessions.find((s) => s.id === tab.sessionId);
          wsSend({ type: 'reconnect', tabId: tab.id, session, cols, rows });
        } else {
          closeTab(tab.id);
        }
      });
      renderTabs();
      renderSessionList();
    } else if (msg.type === 'error') {
      notify('Failed to start: ' + msg.error, 'error');
    }
  };
}

// ============================================================================
// Session persistence (server-backed)
// ============================================================================

async function persistSessions() {
  try {
    const res = await api('POST', '/api/sessions', sessions);
    if (!res || !res.ok) notify('Save failed', 'error');
  } catch (err) {
    notify('Save failed: ' + err.message, 'error');
  }
}

// ============================================================================
// Session list rendering
// ============================================================================

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';

  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:16px;text-align:center;color:var(--fg-dim);font-size:12px';
    empty.textContent = 'No sessions. Click "+ New".';
    list.appendChild(empty);
    return;
  }

  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'session-card';
    if (s.id === selectedSessionId) card.classList.add('selected');
    card.dataset.id = s.id;
    card.draggable = true;

    const count = sessionInstanceCount(s.id);

    const badgeClass = s.type === 'ssh' ? 'ssh' : s.type === 'web' ? 'web' : 'local';
    const badgeText = s.type === 'ssh' ? 'SSH' : s.type === 'web' ? 'WEB' : 'LOCAL';
    card.innerHTML = `
      <div class="session-card-top">
        <span class="drag-handle" title="Drag to reorder">&#x2630;</span>
        <span class="session-name">${escapeHtml(s.name)}</span>
        <span class="badge ${badgeClass}">${badgeText}</span>
        ${count > 0 ? `<span class="badge count">${count}</span>` : ''}
      </div>
      ${s.description ? `<div class="session-desc">${escapeHtml(s.description)}</div>` : ''}
      <div class="session-actions">
        <button data-action="launch">Launch</button>
        <button data-action="edit">Edit</button>
        <button data-action="clone">Clone</button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.matches('button[data-action]')) return;
      selectedSessionId = s.id;
      renderSessionList();
    });
    card.addEventListener('dblclick', (e) => {
      if (e.target.matches('button[data-action]')) return;
      launchSession(s.id);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectedSessionId = s.id;
      renderSessionList();
      showSessionContextMenu(e.clientX, e.clientY, s);
    });
    card.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'launch') launchSession(s.id);
        else if (action === 'edit') openEditor(s.id);
        else if (action === 'clone') cloneSession(s.id);
      });
    });
    attachSessionDragHandlers(card, s.id);
    list.appendChild(card);
  }
}

let draggingSessionId = null;
function attachSessionDragHandlers(el, sessionId) {
  el.addEventListener('dragstart', (e) => {
    if (e.target.matches('button')) { e.preventDefault(); return; }
    draggingSessionId = sessionId;
    el.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', sessionId);
    } catch (_) {}
  });
  el.addEventListener('dragend', () => {
    draggingSessionId = null;
    document.querySelectorAll('.session-card').forEach((c) => {
      c.classList.remove('dragging', 'drop-above', 'drop-below');
    });
  });
  el.addEventListener('dragover', (e) => {
    if (!draggingSessionId || draggingSessionId === sessionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    el.classList.toggle('drop-above', above);
    el.classList.toggle('drop-below', !above);
  });
  el.addEventListener('dragleave', () => {
    el.classList.remove('drop-above', 'drop-below');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const fromId = draggingSessionId;
    const toId = sessionId;
    el.classList.remove('drop-above', 'drop-below');
    if (!fromId || fromId === toId) return;
    const rect = el.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    const fromIdx = sessions.findIndex((s) => s.id === fromId);
    if (fromIdx < 0) return;
    const [moved] = sessions.splice(fromIdx, 1);
    let toIdx = sessions.findIndex((s) => s.id === toId);
    if (toIdx < 0) toIdx = sessions.length;
    if (!above) toIdx += 1;
    sessions.splice(toIdx, 0, moved);
    persistSessions();
    renderSessionList();
  });
}

// ============================================================================
// Context menu
// ============================================================================

function showSessionContextMenu(x, y, session) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  const items = [
    { label: 'Launch', action: () => launchSession(session.id) },
    { label: 'Edit', action: () => openEditor(session.id) },
    { label: 'Clone', action: () => cloneSession(session.id) },
    { sep: true },
    { label: 'Delete', danger: true, action: () => deleteSession(session.id) },
  ];
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const mi = document.createElement('div');
    mi.className = 'menu-item' + (item.danger ? ' danger' : '');
    mi.textContent = item.label;
    mi.addEventListener('click', () => {
      menu.classList.add('hidden');
      item.action();
    });
    menu.appendChild(mi);
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
}
document.addEventListener('click', () => $('#context-menu').classList.add('hidden'));

// ============================================================================
// Session CRUD
// ============================================================================

function openEditor(sessionId) {
  editingId = sessionId || null;
  const form = $('#editor-form');
  form.reset();
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : null;
  const values = session || {
    name: '', type: 'local', ssh_host: '', port_forwards: '', working_dir: '',
    pre_command: '', claude_cmd: '', claude_args: '', description: '',
    persistent: false, url: '', socks_via_ssh: '', socks_port: '',
  };
  for (const key of ['name', 'ssh_host', 'port_forwards', 'working_dir', 'pre_command', 'claude_cmd', 'claude_args', 'description', 'url', 'socks_via_ssh', 'socks_port']) {
    const input = form.elements[key];
    if (input) input.value = values[key] || '';
  }
  if (form.elements['persistent']) form.elements['persistent'].checked = !!values.persistent;
  const typeInput = form.querySelector(`input[name="type"][value="${values.type || 'local'}"]`);
  if (typeInput) typeInput.checked = true;
  updateTypeVisibility();
  $('#editor-title').textContent = session ? 'Edit Session' : 'New Session';
  $('#modal-overlay').classList.remove('hidden');
  setTimeout(() => form.elements['name'].focus(), 50);
}

function closeEditor() {
  $('#modal-overlay').classList.add('hidden');
  editingId = null;
}

function updateTypeVisibility() {
  const form = $('#editor-form');
  const checked = form.querySelector('input[name="type"]:checked');
  const t = checked && checked.value;
  document.querySelectorAll('.ssh-only').forEach((el) => el.classList.toggle('hidden', t !== 'ssh'));
  document.querySelectorAll('.web-only').forEach((el) => el.classList.toggle('hidden', t !== 'web'));
  document.querySelectorAll('.local-only').forEach((el) => el.classList.toggle('hidden', t !== 'local'));
  document.querySelectorAll('.not-web').forEach((el) => el.classList.toggle('hidden', t === 'web'));
}

function saveEditor(e) {
  e && e.preventDefault();
  const form = $('#editor-form');
  const data = new FormData(form);
  const name = (data.get('name') || '').toString().trim();
  if (!name) { notify('Name is required', 'error'); return; }
  const payload = {
    name,
    type: data.get('type') || 'local',
    ssh_host: (data.get('ssh_host') || '').toString().trim(),
    port_forwards: (data.get('port_forwards') || '').toString().trim(),
    working_dir: (data.get('working_dir') || '').toString().trim(),
    pre_command: (data.get('pre_command') || '').toString(),
    claude_cmd: (data.get('claude_cmd') || '').toString().trim(),
    claude_args: (data.get('claude_args') || '').toString(),
    description: (data.get('description') || '').toString(),
    persistent: !!form.elements['persistent'] && form.elements['persistent'].checked,
    url: (data.get('url') || '').toString().trim(),
    socks_via_ssh: (data.get('socks_via_ssh') || '').toString().trim(),
    socks_port: (data.get('socks_port') || '').toString().trim(),
  };
  if (payload.type === 'ssh' && !payload.ssh_host) {
    notify('SSH host is required for SSH sessions', 'error'); return;
  }
  if (payload.type === 'web') {
    if (!payload.url) { notify('URL is required for web sessions', 'error'); return; }
    if (!/^https?:\/\//i.test(payload.url)) {
      notify('URL must start with http:// or https://', 'error'); return;
    }
  }
  if (editingId) {
    const idx = sessions.findIndex((s) => s.id === editingId);
    if (idx >= 0) sessions[idx] = { ...sessions[idx], ...payload };
  } else {
    const newSession = { id: genId(), ...payload };
    sessions.push(newSession);
    selectedSessionId = newSession.id;
  }
  persistSessions();
  renderSessionList();
  closeEditor();
  notify('Saved', 'success');
}

function cloneSession(sessionId) {
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const copy = { ...s, id: genId(), name: `${s.name} (copy)` };
  sessions.push(copy);
  selectedSessionId = copy.id;
  persistSessions();
  renderSessionList();
}

function deleteSession(sessionId) {
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  if (!confirm(`Delete session "${s.name}"?`)) return;
  sessions = sessions.filter((x) => x.id !== sessionId);
  if (selectedSessionId === sessionId) selectedSessionId = null;
  persistSessions();
  renderSessionList();
}

// ============================================================================
// Tabs / Terminal
// ============================================================================

// `opts.persistentId` lets the restore-from-localStorage path reuse the
// same id the server still has a PTY entry for — server will treat the
// follow-up 'create' as a reattach (replays scrollback buffer) instead
// of spawning fresh. Defaults to a fresh UUID for ordinary launches.
function launchSession(sessionId, opts) {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  if (session.type === 'web') return launchWebSession(session, opts);

  const tabId = (opts && opts.persistentId) || newPersistentId();
  const restore = !!(opts && opts.persistentId);
  const existing = sessionInstanceCount(sessionId);
  const displayName =
    (opts && opts.sessionName) ||
    (existing === 0 ? session.name : `${session.name} #${existing + 1}`);

  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.dataset.tabId = tabId;
  container.tabIndex = 0;
  $('#terminal-area').appendChild(container);

  const term = new Terminal({
    theme: THEME,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    fontSize: 14,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon((event, uri) => window.open(uri, '_blank')));
  const u11 = new Unicode11Addon();
  term.loadAddon(u11);
  term.unicode.activeVersion = '11';
  term.open(container);
  fitAddon.fit();

  const tab = {
    id: tabId, sessionId, sessionName: displayName, kind: 'terminal',
    term, fitAddon, container,
    // Until the server confirms reattach/spawn we're not alive — keeps
    // stray onData callbacks (e.g. xterm firing for the initial focus
    // event) from leaking input.
    alive: false,
  };
  tabs.push(tab);

  attachTouchScroll(tab);

  term.onData((data) => {
    if (!tab.alive) return;
    const out = applyCtrlIfArmed(data);
    wsSend({ type: 'input', tabId, data: out });
  });
  term.onResize(({ cols, rows }) => { if (tab.alive) wsSend({ type: 'resize', tabId, cols, rows }); });

  attachKeyboardHandlers(tab);

  if (restore) {
    // A faint placeholder while we wait for the server to either replay
    // the buffer or spawn fresh. Erased by the first incoming data.
    term.write(`\x1b[90m[restoring ${escapeHtml(displayName)}…]\x1b[0m\r\n`);
  }

  saveTabsState();
  attachToServer(tab, session);

  renderTabs();
  switchToTab(tabId);
  renderSessionList();
}

// Send 'create' for a single tab. Server interprets it as reattach if
// it still has a PTY for that tabId, otherwise spawns fresh.
function attachToServer(tab, session) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // ws.onopen will retry
  const cols = (tab.term && tab.term.cols) || 120;
  const rows = (tab.term && tab.term.rows) || 30;
  wsSend({ type: 'create', tabId: tab.id, session, cols, rows });
}

// Send 'create' for every terminal tab whose alive flag is false. Used
// on ws.onopen (initial connect AND reconnect) so the server reattaches
// to live PTYs or spawns fresh ones, transparently. Web tabs are
// independent iframes and don't need server state.
function attachAllTabsToServer() {
  for (const tab of tabs) {
    if (tab.kind !== 'terminal') continue;
    if (tab.alive) continue;
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session) continue;
    attachToServer(tab, session);
  }
}

function launchWebSession(session, opts) {
  const tabId = (opts && opts.persistentId) || newPersistentId();
  const existing = sessionInstanceCount(session.id);
  const displayName =
    (opts && opts.sessionName) ||
    (existing === 0 ? session.name : `${session.name} #${existing + 1}`);

  const container = document.createElement('div');
  container.className = 'terminal-container web-container';
  container.dataset.tabId = tabId;
  $('#terminal-area').appendChild(container);

  // Toolbar with reload + open-in-new-tab
  const toolbar = document.createElement('div');
  toolbar.className = 'web-toolbar';
  toolbar.innerHTML = `
    <button class="web-btn" data-act="reload" title="Reload">&#x21bb;</button>
    <span class="web-url" title="${escapeHtml(session.url)}">${escapeHtml(session.url)}</span>
    <button class="web-btn" data-act="external" title="Open in browser tab">&#x2197;</button>
  `;
  container.appendChild(toolbar);

  const iframe = document.createElement('iframe');
  iframe.className = 'web-iframe';
  // ?port= helps clients like xpra's HTML5 viewer that otherwise read
  // window.location.port (empty on default 80/443) and fall back to a
  // hardcoded internal port. Harmless query param for non-xpra targets.
  const proxyPort = location.port || (location.protocol === 'https:' ? 443 : 80);
  iframe.src = `/p/${encodeURIComponent(session.id)}/?port=${proxyPort}`;
  iframe.referrerPolicy = 'no-referrer';
  container.appendChild(iframe);

  toolbar.querySelector('[data-act=reload]').addEventListener('click', () => {
    try { iframe.contentWindow.location.reload(); }
    catch (_) { iframe.src = iframe.src; } // cross-origin fallback
  });
  toolbar.querySelector('[data-act=external]').addEventListener('click', () => {
    window.open(`/p/${encodeURIComponent(session.id)}/`, '_blank', 'noopener');
  });

  const tab = {
    id: tabId, sessionId: session.id, sessionName: displayName, kind: 'web',
    container, iframe, alive: true,
  };
  tabs.push(tab);

  saveTabsState();
  renderTabs();
  switchToTab(tabId);
  renderSessionList();
}

function switchToTab(tabId) {
  activeTabId = tabId;
  for (const t of tabs) t.container.classList.toggle('active', t.id === tabId);
  const tab = tabs.find((t) => t.id === tabId);
  updateKeybarVisibility();
  if (tab && tab.kind === 'terminal') {
    try {
      tab.fitAddon.fit();
      const { cols, rows } = tab.term;
      if (tab.alive) wsSend({ type: 'resize', tabId, cols, rows });
      tab.term.focus();
    } catch (_) {}
  } else if (tab && tab.kind === 'web') {
    try { tab.iframe && tab.iframe.focus(); } catch (_) {}
  }
  $('#welcome').classList.toggle('hidden', tabs.length > 0);
  renderTabs();
}

function closeTab(tabId) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.kind === 'terminal') {
    // Always send kill on explicit close — even if the local tab is in
    // alive=false state (post-WS-drop), the server-side PTY may still
    // be sitting in its 10min grace window and should be torn down so
    // we don't leak processes.
    wsSend({ type: 'kill', tabId });
    try { tab.term.dispose(); } catch (_) {}
  }
  try { tab.container.remove(); } catch (_) {}
  tabs.splice(idx, 1);
  if (activeTabId === tabId) {
    const next = tabs[idx] || tabs[idx - 1] || null;
    activeTabId = next ? next.id : null;
    if (next) switchToTab(next.id);
  }
  saveTabsState();
  $('#welcome').classList.toggle('hidden', tabs.length > 0);
  renderTabs();
  renderSessionList();
  updateKeybarVisibility();
}

function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = '';
  for (const t of tabs) {
    const div = document.createElement('div');
    div.className = 'tab' + (t.id === activeTabId ? ' active' : '') + (t.alive ? '' : ' dead');
    div.draggable = true;
    div.dataset.tabId = t.id;
    div.innerHTML = `
      <span class="tab-status"></span>
      <span class="tab-name">${escapeHtml(t.sessionName)}</span>
      <span class="tab-close" title="Close (Ctrl+W)">&times;</span>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) closeTab(t.id);
      else switchToTab(t.id);
    });
    div.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t.id); });
    attachTabDragHandlers(div, t.id);
    el.appendChild(div);
  }
}

let draggingTabId = null;
function attachTabDragHandlers(el, tabId) {
  el.addEventListener('dragstart', (e) => {
    draggingTabId = tabId;
    el.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tabId);
    } catch (_) {}
  });
  el.addEventListener('dragend', () => {
    draggingTabId = null;
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('dragging', 'drop-before', 'drop-after');
    });
  });
  el.addEventListener('dragover', (e) => {
    if (!draggingTabId || draggingTabId === tabId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    el.classList.toggle('drop-before', before);
    el.classList.toggle('drop-after', !before);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const fromId = draggingTabId;
    const toId = tabId;
    el.classList.remove('drop-before', 'drop-after');
    if (!fromId || fromId === toId) return;
    const rect = el.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    const fromIdx = tabs.findIndex((t) => t.id === fromId);
    if (fromIdx < 0) return;
    const [moved] = tabs.splice(fromIdx, 1);
    let toIdx = tabs.findIndex((t) => t.id === toId);
    if (toIdx < 0) toIdx = tabs.length;
    if (!before) toIdx += 1;
    tabs.splice(toIdx, 0, moved);
    saveTabsState();
    renderTabs();
  });
}

// ============================================================================
// Keyboard / clipboard
// ============================================================================

function attachKeyboardHandlers(tab) {
  const { term, container, id: tabId } = tab;

  container.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      e.preventDefault(); e.stopPropagation();
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        term.clearSelection();
        notify('Copied', 'success');
      }
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      e.preventDefault(); e.stopPropagation();
      pasteImageToTab(tabId);
      return;
    }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyC') {
      if (term.hasSelection()) {
        e.preventDefault(); e.stopPropagation();
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return;
      }
    }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyV') {
      e.preventDefault(); e.stopPropagation();
      navigator.clipboard.readText().then((t) => { if (t) bracketedPaste(tabId, t); }).catch(() => {});
      return;
    }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyW') {
      e.preventDefault(); e.stopPropagation();
      closeTab(tabId);
      return;
    }
  }, true);

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      notify('Copied', 'success');
    } else {
      navigator.clipboard.readText().then((t) => { if (t) bracketedPaste(tabId, t); }).catch(() => {});
    }
  });

  // Browser-level paste event also catches images dropped via Ctrl+V
  // when the terminal has focus, even when the keydown handler doesn't
  // see them (e.g. some mobile keyboards).
  container.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) uploadImageFile(tabId, file);
        return;
      }
    }
  });
}

// ============================================================================
// Image paste (browser → server → optional SCP)
// ============================================================================

async function pasteImageToTab(tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Try the modern Clipboard API. Falls back to instructing the user
  // (some browsers / contexts don't allow programmatic clipboard read).
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          await uploadImageFile(tabId, blob);
          return;
        }
      }
    } catch (_) {
      // permission denied or no image — fall through
    }
  }
  notify('No image in clipboard (or permission denied)', 'error');
}

async function uploadImageFile(tabId, blobOrFile) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) return;

  // Convert blob -> base64 PNG dataUrl
  const dataUrl = await blobToDataUrl(blobOrFile);

  notify('Uploading image…', 'info');
  let res;
  try {
    res = await api('POST', '/api/paste-image', { dataUrl });
  } catch (err) {
    notify('Upload failed: ' + err.message, 'error'); return;
  }
  if (!res.ok) { notify('Upload failed: ' + res.error, 'error'); return; }

  if (session.type === 'local') {
    bracketedPaste(tabId, res.localPath);
    notify('Pasted image path', 'success');
  } else {
    let scp;
    try { scp = await api('POST', '/api/scp-upload', { sshHost: session.ssh_host, localPath: res.localPath }); }
    catch (err) { notify('SCP failed: ' + err.message, 'error'); return; }
    if (scp && scp.ok) {
      bracketedPaste(tabId, scp.remotePath);
      notify('Uploaded', 'success');
    } else {
      notify('SCP failed: ' + (scp && scp.error), 'error');
    }
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function pasteImageToActiveTab() {
  if (!activeTabId) { notify('No active terminal', 'error'); return; }
  await pasteImageToTab(activeTabId);
}

// ============================================================================
// Global keyboard / buttons / sidebar
// ============================================================================

document.addEventListener('keydown', (e) => {
  const modalOpen = !$('#modal-overlay').classList.contains('hidden');
  if (modalOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); return; }
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); saveEditor(); return; }
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.code === 'KeyN') { e.preventDefault(); openEditor(null); return; }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); pasteImageToActiveTab(); return; }
  if (e.ctrlKey && !e.shiftKey && e.code === 'Tab') {
    e.preventDefault();
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(idx + 1) % tabs.length];
    if (next) switchToTab(next.id);
  }
});

window.addEventListener('resize', () => {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab && tab.kind === 'terminal') {
    try {
      tab.fitAddon.fit();
      const { cols, rows } = tab.term;
      if (tab.alive) wsSend({ type: 'resize', tabId: tab.id, cols, rows });
    } catch (_) {}
  }
});

$('#btn-new').addEventListener('click', () => openEditor(null));
$('#btn-paste-img').addEventListener('click', () => pasteImageToActiveTab());
$('#btn-logout').addEventListener('click', () => {
  if (confirm('Sign out of Claude Sessions?')) logout();
});
$('#editor-close').addEventListener('click', closeEditor);
$('#editor-cancel').addEventListener('click', closeEditor);
$('#editor-form').addEventListener('submit', saveEditor);
document.querySelectorAll('#editor-form input[name="type"]').forEach((el) => {
  el.addEventListener('change', updateTypeVisibility);
});

// Sidebar resize / collapse
const SIDEBAR_MIN = 180, SIDEBAR_MAX = 500, SIDEBAR_DEFAULT = 260;

function setSidebarWidth(px) {
  const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px | 0));
  $('#sidebar').style.width = clamped + 'px';
  try { localStorage.setItem(LS_WIDTH, String(clamped)); } catch (_) {}
  refitActiveTerminal();
}
function setSidebarCollapsed(collapsed) {
  $('#sidebar').classList.toggle('collapsed', !!collapsed);
  $('#sidebar-resizer').classList.toggle('hidden', !!collapsed);
  $('#btn-expand').classList.toggle('hidden', !collapsed);
  try { localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0'); } catch (_) {}
  setTimeout(refitActiveTerminal, 220);
}
function refitActiveTerminal() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab || tab.kind !== 'terminal') return;
  try {
    tab.fitAddon.fit();
    const { cols, rows } = tab.term;
    if (tab.alive) wsSend({ type: 'resize', tabId: tab.id, cols, rows });
  } catch (_) {}
}

(function () {
  try {
    const saved = parseInt(localStorage.getItem(LS_WIDTH), 10);
    if (Number.isFinite(saved)) {
      $('#sidebar').style.width = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, saved)) + 'px';
    } else {
      $('#sidebar').style.width = SIDEBAR_DEFAULT + 'px';
    }
    if (localStorage.getItem(LS_COLLAPSED) === '1') setSidebarCollapsed(true);
  } catch (_) {}
})();

(function wireSidebarResizer() {
  const resizer = $('#sidebar-resizer');
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    if ($('#sidebar').classList.contains('collapsed')) return;
    dragging = true;
    resizer.classList.add('dragging');
    $('#sidebar').classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => { if (dragging) setSidebarWidth(e.clientX); });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    $('#sidebar').classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    refitActiveTerminal();
  });
  resizer.addEventListener('dblclick', () => setSidebarWidth(SIDEBAR_DEFAULT));
})();

$('#btn-collapse').addEventListener('click', () => setSidebarCollapsed(true));
$('#btn-expand').addEventListener('click', () => setSidebarCollapsed(false));

// ============================================================================
// PWA: service worker + install prompt
// ============================================================================

if ('serviceWorker' in navigator) {
  // Register after the page is loaded so we don't compete for resources
  // with the initial render.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => console.warn('[sw] registration failed:', err));
  });
}

let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstall = e;
  ensureInstallChip();
});

function ensureInstallChip() {
  if (!_deferredInstall) return;
  let chip = $('#install-chip');
  if (!chip) {
    chip = document.createElement('button');
    chip.id = 'install-chip';
    chip.type = 'button';
    chip.textContent = 'Install app';
    chip.addEventListener('click', async () => {
      const ev = _deferredInstall;
      if (!ev) return;
      _deferredInstall = null;
      chip.classList.add('hidden');
      try {
        ev.prompt();
        await ev.userChoice;
      } catch (_) {}
    });
    document.body.appendChild(chip);
  } else {
    chip.classList.remove('hidden');
  }
}

window.addEventListener('appinstalled', () => {
  _deferredInstall = null;
  const chip = $('#install-chip');
  if (chip) chip.classList.add('hidden');
});

// ============================================================================
// Mobile keyboard bar
// ============================================================================

// "Primary input is touch" — hover: none + pointer: coarse. We
// intentionally don't use `ontouchstart` alone because that's true on
// Windows hybrid laptops with a mouse, where the keybar would be
// annoying. Users can override by ?keybar=force or ?keybar=off.
function isTouchDevice() {
  const q = new URLSearchParams(location.search);
  if (q.get('keybar') === 'force') return true;
  if (q.get('keybar') === 'off') return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

let ctrlArmed = false;

function setCtrlArmed(armed) {
  ctrlArmed = !!armed;
  const btn = document.querySelector('#keybar button[data-keybar="mod:ctrl"]');
  if (btn) btn.classList.toggle('armed', ctrlArmed);
}

// Transform the data the user just typed/pasted if Ctrl is armed.
// Returns the (possibly transformed) bytes. Disarms Ctrl after one use.
function applyCtrlIfArmed(data) {
  if (!ctrlArmed) return data;
  if (data && data.length === 1) {
    const c = data.charCodeAt(0);
    // Ctrl maps printable ASCII (@ A-Z [ \ ] ^ _ ` a-z { | } ~) to bytes
    // 0–31 by clearing the high three bits. Match what physical Ctrl
    // would have produced.
    if (c >= 0x40 && c <= 0x7E) {
      setCtrlArmed(false);
      return String.fromCharCode(c & 0x1F);
    }
  }
  // Anything that can't be Ctrl-modified just goes through unchanged
  // and we disarm so the user doesn't get stuck in armed state.
  setCtrlArmed(false);
  return data;
}

function keybarBytesFor(action) {
  const idx = action.indexOf(':');
  const kind = action.slice(0, idx);
  const val = action.slice(idx + 1);
  if (kind === 'key') {
    switch (val) {
      case 'Tab':         return '\t';
      case 'Escape':      return '\x1b';
      case 'ArrowUp':     return '\x1b[A';
      case 'ArrowDown':   return '\x1b[B';
      case 'ArrowRight':  return '\x1b[C';
      case 'ArrowLeft':   return '\x1b[D';
      case 'Home':        return '\x1b[H';
      case 'End':         return '\x1b[F';
      case 'PageUp':      return '\x1b[5~';
      case 'PageDown':    return '\x1b[6~';
    }
  } else if (kind === 'ctrl') {
    if (val && val.length === 1) {
      const c = val.toUpperCase().charCodeAt(0);
      if (c >= 0x40 && c <= 0x7E) return String.fromCharCode(c & 0x1F);
    }
  } else if (kind === 'char') {
    return val;
  }
  return null;
}

(function wireKeybar() {
  const bar = $('#keybar');
  if (!bar) return;

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-keybar]');
    if (!btn) return;
    const action = btn.dataset.keybar;

    if (action === 'mod:ctrl') {
      setCtrlArmed(!ctrlArmed);
      return;
    }

    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || tab.kind !== 'terminal' || !tab.alive) return;

    let bytes = keybarBytesFor(action);
    if (bytes == null) return;

    // Special keys / preset ^X disarm Ctrl without applying it (those
    // are already the desired raw sequence). Only typed chars get
    // ctrl-modified.
    if (action.startsWith('char:')) bytes = applyCtrlIfArmed(bytes);
    else if (ctrlArmed) setCtrlArmed(false);

    wsSend({ type: 'input', tabId: tab.id, data: bytes });
    try { tab.term.focus(); } catch (_) {}
  });
})();

// xterm.js v6 has no built-in touch-scroll handling — a finger drag
// inside the terminal area triggers selection instead of scrolling
// the buffer, so on phones you can only ever see the bottom screenful
// of output. We intercept touchmove on the container in the capture
// phase, convert vertical delta into term.scrollLines() calls, and
// preventDefault so xterm's selection logic never starts.
//
// Tap (no movement) still falls through, so xterm-tap-to-focus and
// long-press-to-select still work. Two-finger gestures (pinch zoom on
// the page) are also passed through unchanged.
function attachTouchScroll(tab) {
  if (!isTouchDevice()) return;
  const container = tab.container;
  let lastY = null;
  let totalDy = 0;
  let pxPerLine = 17;
  let scrolling = false;
  const DEADZONE_PX = 10;

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { lastY = null; return; }
    lastY = e.touches[0].clientY;
    totalDy = 0;
    scrolling = false;
    // Re-measure each gesture in case font-size / fit changed.
    const row = container.querySelector('.xterm-rows > div');
    const h = row && row.getBoundingClientRect().height;
    if (h && h > 0) pxPerLine = h;
  }, { passive: true, capture: true });

  container.addEventListener('touchmove', (e) => {
    if (lastY == null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = y - lastY;
    totalDy += dy;
    // Don't hijack short taps — only kick into scroll mode after the
    // finger has moved past the deadzone vertically.
    if (!scrolling && Math.abs(totalDy) < DEADZONE_PX) return;
    scrolling = true;
    lastY = y;
    const lines = -Math.round(dy / pxPerLine);
    if (lines !== 0) {
      try { tab.term.scrollLines(lines); } catch (_) {}
      e.preventDefault();
    }
  }, { passive: false, capture: true });

  const reset = () => { lastY = null; totalDy = 0; scrolling = false; };
  container.addEventListener('touchend', reset, { passive: true, capture: true });
  container.addEventListener('touchcancel', reset, { passive: true, capture: true });
}

function updateKeybarVisibility() {
  const tab = tabs.find((t) => t.id === activeTabId);
  const show = isTouchDevice() && !!tab && tab.kind === 'terminal';
  const bar = $('#keybar');
  if (!bar) return;
  const wasHidden = bar.classList.contains('hidden');
  bar.classList.toggle('hidden', !show);
  if (wasHidden !== !show) {
    // Height of #terminal-area just changed — re-fit so xterm doesn't
    // sit under the keybar.
    setTimeout(refitActiveTerminal, 50);
  }
}

// ============================================================================
// Gallery / file picker for images (touch-first path for /api/paste-image)
// ============================================================================

(function wireImagePicker() {
  const fileInput = $('#image-file-input');
  if (!fileInput) return;
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !activeTabId) return;
    await uploadImageFile(activeTabId, file);
  });
})();

function pickImageFromGallery() {
  if (!activeTabId) { notify('No active terminal', 'error'); return; }
  $('#image-file-input').click();
}

// Replace the desktop-only handler installed earlier in this file
// with a touch-aware one: on phones/tablets we go straight to the
// gallery picker (Android's Clipboard image API is unreliable); on
// desktop we try the clipboard first.
(function rewireImgButton() {
  const btn = $('#btn-paste-img');
  if (!btn) return;
  const fresh = btn.cloneNode(true);
  btn.replaceWith(fresh);
  fresh.title = isTouchDevice() ? 'Pick image from gallery' : 'Paste clipboard image';
  fresh.addEventListener('click', async () => {
    if (isTouchDevice()) {
      pickImageFromGallery();
      return;
    }
    // Desktop: try clipboard first; if nothing usable, fall back to picker.
    if (!activeTabId) { notify('No active terminal', 'error'); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) {
            const blob = await item.getType(type);
            await uploadImageFile(activeTabId, blob);
            return;
          }
        }
      }
    } catch (_) {}
    pickImageFromGallery();
  });
})();

// Boot
attemptStart();

})();
