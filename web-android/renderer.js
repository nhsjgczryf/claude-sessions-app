/*
 * Android APK renderer. Diverges from web/public/renderer.js in three
 * places:
 *   - SSH transport: SshBridge (Capacitor plugin) replaces the
 *     WebSocket-to-Node-server channel. Each tab opens its own
 *     SSH connection via sshj on the JVM side.
 *   - Storage: Store wraps Capacitor Preferences (or localStorage
 *     for desktop testing) instead of /api/sessions REST.
 *   - No auth screen: this is a single-user sideloaded app; the
 *     SSH credentials per session ARE the auth.
 *
 * Everything else — multi-tab UI, tmux persistence semantics, image
 * paste via SFTP, port forwards, keyboard bar, touch scroll — is
 * preserved with the same UX as the web version.
 */

(function () {
'use strict';

const Terminal = window.Terminal;
const FitAddon = window.FitAddon && window.FitAddon.FitAddon;
const WebLinksAddon = window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon;
const Unicode11Addon = window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon;

const THEME = {
  background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
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
const KEY_SESSIONS = 'sessions';   // List of session configs
const KEY_TABS = 'tabs';           // Persistent tab list

let sessions = [];
let selectedSessionId = null;
let tabs = [];
let activeTabId = null;
let editingId = null;

function $(s) { return document.querySelector(s); }

function newPersistentId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 't-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function notify(message, type) {
  const el = document.createElement('div');
  el.className = `notification ${type || 'info'}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function sessionInstanceCount(sessionId) {
  return tabs.filter((t) => t.sessionId === sessionId).length;
}

// ============================================================================
// Storage (Capacitor Preferences via window.Store)
// ============================================================================

async function loadSessions() {
  const arr = (await Store.get(KEY_SESSIONS)) || [];
  sessions = Array.isArray(arr) ? arr : [];
  // Inject a friendly empty-state seed on first run so users have a
  // template to edit.
  if (!sessions.length) {
    sessions = [{
      id: newPersistentId(),
      name: 'My VPS',
      host: '',
      port: 22,
      username: 'root',
      authType: 'password',
      password: '',
      privateKey: '',
      privateKeyPassphrase: '',
      port_forwards: '',
      persistent: true,
      working_dir: '',
      pre_command: '',
      claude_cmd: 'claude',
      claude_args: '',
      description: 'Edit this — host/username/password are blank.',
    }];
  }
}

async function persistSessions() {
  try { await Store.set(KEY_SESSIONS, sessions); }
  catch (err) { notify('Save failed: ' + err.message, 'error'); }
}

async function loadSavedTabs() {
  const arr = (await Store.get(KEY_TABS)) || [];
  return Array.isArray(arr) ? arr.slice(0, 20) : [];
}

async function saveTabsState() {
  const minimal = tabs.map((t) => ({
    id: t.id, sessionId: t.sessionId, sessionName: t.sessionName,
  }));
  await Store.set(KEY_TABS, minimal);
}

// ============================================================================
// Session list rendering
// ============================================================================

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';
  if (!sessions.length) {
    const e = document.createElement('div');
    e.style.cssText = 'padding:16px;text-align:center;color:var(--fg-dim);font-size:12px';
    e.textContent = 'No sessions. Tap "+ New".';
    list.appendChild(e);
    return;
  }
  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'session-card';
    if (s.id === selectedSessionId) card.classList.add('selected');
    card.dataset.id = s.id;
    card.draggable = true;
    const count = sessionInstanceCount(s.id);
    card.innerHTML = `
      <div class="session-card-top">
        <span class="drag-handle" title="Drag to reorder">&#x2630;</span>
        <span class="session-name">${escapeHtml(s.name)}</span>
        <span class="badge ssh">SSH</span>
        ${count > 0 ? `<span class="badge count">${count}</span>` : ''}
      </div>
      ${s.host ? `<div class="session-desc">${escapeHtml(s.username || '')}@${escapeHtml(s.host)}${s.port && s.port !== 22 ? ':' + s.port : ''}</div>` : ''}
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
    try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
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
    const r = el.getBoundingClientRect();
    const above = e.clientY < r.top + r.height / 2;
    el.classList.toggle('drop-above', above);
    el.classList.toggle('drop-below', !above);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-above', 'drop-below'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    const fromId = draggingSessionId;
    const toId = sessionId;
    el.classList.remove('drop-above', 'drop-below');
    if (!fromId || fromId === toId) return;
    const r = el.getBoundingClientRect();
    const above = e.clientY < r.top + r.height / 2;
    const fromIdx = sessions.findIndex((s) => s.id === fromId);
    if (fromIdx < 0) return;
    const [moved] = sessions.splice(fromIdx, 1);
    let toIdx = sessions.findIndex((s) => s.id === toId);
    if (toIdx < 0) toIdx = sessions.length;
    if (!above) toIdx += 1;
    sessions.splice(toIdx, 0, moved);
    await persistSessions();
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
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; menu.appendChild(s); continue; }
    const mi = document.createElement('div');
    mi.className = 'menu-item' + (it.danger ? ' danger' : '');
    mi.textContent = it.label;
    mi.addEventListener('click', () => { menu.classList.add('hidden'); it.action(); });
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

const SESSION_FIELDS = [
  'name', 'host', 'port', 'username',
  'password', 'privateKey', 'privateKeyPassphrase',
  'port_forwards', 'working_dir', 'pre_command',
  'claude_cmd', 'claude_args', 'description',
];

function openEditor(sessionId) {
  editingId = sessionId || null;
  const form = $('#editor-form');
  form.reset();
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : null;
  const values = session || {
    name: '', host: '', port: 22, username: 'root',
    authType: 'password', password: '', privateKey: '', privateKeyPassphrase: '',
    port_forwards: '', working_dir: '', pre_command: '',
    claude_cmd: 'claude', claude_args: '', description: '', persistent: false,
  };
  for (const key of SESSION_FIELDS) {
    const input = form.elements[key];
    if (input) input.value = values[key] != null ? values[key] : '';
  }
  if (form.elements['persistent']) form.elements['persistent'].checked = !!values.persistent;
  const authType = values.authType || 'password';
  const authRadio = form.querySelector(`input[name="authType"][value="${authType}"]`);
  if (authRadio) authRadio.checked = true;
  updateAuthVisibility();

  $('#editor-title').textContent = session ? 'Edit Session' : 'New Session';
  $('#modal-overlay').classList.remove('hidden');
  setTimeout(() => form.elements['name'].focus(), 50);
}

function closeEditor() {
  $('#modal-overlay').classList.add('hidden');
  editingId = null;
}

function updateAuthVisibility() {
  const form = $('#editor-form');
  const checked = form.querySelector('input[name="authType"]:checked');
  const isKey = checked && checked.value === 'key';
  document.querySelectorAll('.auth-password').forEach((el) => el.classList.toggle('hidden', isKey));
  document.querySelectorAll('.auth-key').forEach((el) => el.classList.toggle('hidden', !isKey));
}

async function saveEditor(e) {
  if (e) e.preventDefault();
  const form = $('#editor-form');
  const data = new FormData(form);
  const name = (data.get('name') || '').toString().trim();
  if (!name) { notify('Name is required', 'error'); return; }
  const host = (data.get('host') || '').toString().trim();
  if (!host) { notify('Host is required', 'error'); return; }
  const username = (data.get('username') || '').toString().trim();
  if (!username) { notify('Username is required', 'error'); return; }
  const authType = (data.get('authType') || 'password').toString();
  const payload = {
    name,
    host,
    port: parseInt((data.get('port') || '22').toString(), 10) || 22,
    username,
    authType,
    password: authType === 'password' ? (data.get('password') || '').toString() : '',
    privateKey: authType === 'key' ? (data.get('privateKey') || '').toString() : '',
    privateKeyPassphrase: authType === 'key' ? (data.get('privateKeyPassphrase') || '').toString() : '',
    port_forwards: (data.get('port_forwards') || '').toString().trim(),
    working_dir: (data.get('working_dir') || '').toString().trim(),
    pre_command: (data.get('pre_command') || '').toString(),
    claude_cmd: (data.get('claude_cmd') || '').toString().trim(),
    claude_args: (data.get('claude_args') || '').toString(),
    description: (data.get('description') || '').toString(),
    persistent: !!form.elements['persistent'] && form.elements['persistent'].checked,
  };
  if (editingId) {
    const idx = sessions.findIndex((s) => s.id === editingId);
    if (idx >= 0) sessions[idx] = { ...sessions[idx], ...payload };
  } else {
    const ns = { id: newPersistentId(), ...payload };
    sessions.push(ns);
    selectedSessionId = ns.id;
  }
  await persistSessions();
  renderSessionList();
  closeEditor();
  notify('Saved', 'success');
}

async function cloneSession(sessionId) {
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const copy = { ...s, id: newPersistentId(), name: `${s.name} (copy)` };
  sessions.push(copy);
  selectedSessionId = copy.id;
  await persistSessions();
  renderSessionList();
}

async function deleteSession(sessionId) {
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  if (!confirm(`Delete session "${s.name}"?`)) return;
  sessions = sessions.filter((x) => x.id !== sessionId);
  if (selectedSessionId === sessionId) selectedSessionId = null;
  await persistSessions();
  renderSessionList();
}

// ============================================================================
// Tabs / SSH
// ============================================================================

async function launchSession(sessionId, opts) {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  if (!session.host) {
    notify('Edit this session to set a host first', 'error');
    openEditor(sessionId);
    return;
  }

  const tabId = (opts && opts.persistentId) || newPersistentId();
  const existing = sessionInstanceCount(sessionId);
  const displayName =
    (opts && opts.sessionName) ||
    (existing === 0 ? session.name : `${session.name} #${existing + 1}`);

  // Build the terminal UI first; SSH connect runs in the background.
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
    id: tabId, sessionId, sessionName: displayName,
    term, fitAddon, container, alive: false,
  };
  tabs.push(tab);
  attachTouchScroll(tab);

  term.onData((data) => {
    if (!tab.alive) return;
    const out = applyCtrlIfArmed(data);
    SshBridge.write(tabId, out).catch((err) => console.warn('[write]', err));
  });
  term.onResize(({ cols, rows }) => {
    if (tab.alive) SshBridge.resize(tabId, cols, rows).catch(() => {});
  });
  attachKeyboardHandlers(tab);

  term.write(`\x1b[90m[connecting ${session.username}@${session.host}…]\x1b[0m\r\n`);

  // tmux name disambiguation: when this is the Nth tab for the same
  // session, suffix the name so additional tabs aren't all mirrored
  // onto a single tmux.
  const tmuxName = existing === 0
    ? `cs-${SessionBuilder.sanitizeTmuxName(session.id) || 'session'}`
    : `cs-${SessionBuilder.sanitizeTmuxName(session.id) || 'session'}-${existing + 1}`;

  const initialCommand = SessionBuilder.buildRemoteCmd(session, { tmuxName });
  const portForwards = SessionBuilder.parsePortForwards(session.port_forwards);
  const { cols, rows } = term;

  saveTabsState();
  renderTabs();
  switchToTab(tabId);
  renderSessionList();

  try {
    await SshBridge.connect({
      tabId,
      host: session.host,
      port: session.port || 22,
      username: session.username,
      password: session.authType === 'password' ? session.password : '',
      privateKey: session.authType === 'key' ? session.privateKey : '',
      privateKeyPassphrase: session.authType === 'key' ? session.privateKeyPassphrase : '',
      cols, rows,
      initialCommand,
      portForwards,
    });
    tab.alive = true;
    renderTabs();
    renderSessionList();
  } catch (err) {
    term.write(`\r\n\x1b[31m[connect failed: ${err && err.message || err}]\x1b[0m\r\n`);
    tab.alive = false;
    renderTabs();
    renderSessionList();
    promptReconnect(tab);
  }
}

function promptReconnect(tab) {
  tab.term.write(
    `\r\n\x1b[33m[Press R to reconnect, any other key to close.]\x1b[0m\r\n`
  );
  const d = tab.term.onKey(({ domEvent }) => {
    try { d.dispose(); } catch (_) {}
    if (domEvent && (domEvent.key === 'r' || domEvent.key === 'R')) {
      tab.term.write(`\x1b[33m[reconnecting…]\x1b[0m\r\n`);
      // Defer alive update so the 'r' keypress' onData (xterm fires
      // AFTER onKey) sees alive=false and gets swallowed.
      const sessionId = tab.sessionId;
      const sessionName = tab.sessionName;
      const id = tab.id;
      setTimeout(() => {
        closeTab(id, { skipSshClose: true });
        launchSession(sessionId, { persistentId: id, sessionName });
      }, 0);
    } else {
      closeTab(tab.id);
    }
  });
}

function switchToTab(tabId) {
  activeTabId = tabId;
  for (const t of tabs) t.container.classList.toggle('active', t.id === tabId);
  const tab = tabs.find((t) => t.id === tabId);
  updateKeybarVisibility();
  if (tab) {
    try {
      tab.fitAddon.fit();
      const { cols, rows } = tab.term;
      if (tab.alive) SshBridge.resize(tabId, cols, rows).catch(() => {});
      tab.term.focus();
    } catch (_) {}
  }
  $('#welcome').classList.toggle('hidden', tabs.length > 0);
  renderTabs();
}

function closeTab(tabId, opts) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (!(opts && opts.skipSshClose)) {
    SshBridge.close(tabId).catch(() => {});
  }
  try { tab.term.dispose(); } catch (_) {}
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
      <span class="tab-close" title="Close">&times;</span>
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
  el.addEventListener('dragstart', () => {
    draggingTabId = tabId;
    el.classList.add('dragging');
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
    const r = el.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
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
    const r = el.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
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
// SSH event hookup
// ============================================================================

SshBridge.onData((ev) => {
  const tab = tabs.find((t) => t.id === ev.tabId);
  if (tab) tab.term.write(ev.data);
});

SshBridge.onExit((ev) => {
  const tab = tabs.find((t) => t.id === ev.tabId);
  if (!tab) return;
  tab.alive = false;
  tab.term.write(
    `\r\n\x1b[33m[Session ended (exit ${ev.exitCode}). Press R to reconnect, any other key to close.]\x1b[0m\r\n`
  );
  promptReconnect(tab);
  renderTabs();
  renderSessionList();
});

SshBridge.onWarning((ev) => {
  notify(ev.error || JSON.stringify(ev), 'error');
});

// ============================================================================
// Keyboard handlers (Ctrl-arm, copy, paste, close)
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
  container.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) uploadImageBlob(tabId, file);
        return;
      }
    }
  });
}

function bracketedPaste(tabId, text) {
  if (!text) return;
  SshBridge.write(tabId, `\x1b[200~${text}\x1b[201~`).catch(() => {});
}

// ============================================================================
// Image paste (gallery → SFTP)
// ============================================================================

async function uploadImageBlob(tabId, blob) {
  const remoteName = `clip_${new Date().toISOString().replace(/[:.]/g, '-')}.${
    (blob.type && blob.type.split('/')[1]) || 'png'
  }`;
  const remoteDir = '/tmp/claude-clipboard';
  const remotePath = `${remoteDir}/${remoteName}`;
  notify('Uploading…', 'info');
  try {
    await SshBridge.sftpPut(tabId, remotePath, blob);
    bracketedPaste(tabId, remotePath);
    notify('Pasted remote path', 'success');
  } catch (err) {
    notify('SFTP failed: ' + (err && err.message || err), 'error');
  }
}

async function pasteImageToTab(tabId) {
  // On Android we always go straight to the file picker — programmatic
  // clipboard image read is unreliable across vendors.
  if (!activeTabId) { notify('No active terminal', 'error'); return; }
  $('#image-file-input').click();
}

// ============================================================================
// Touch scrolling + keyboard bar + sidebar — same as web version
// ============================================================================

function isTouchDevice() {
  const q = new URLSearchParams(location.search);
  if (q.get('keybar') === 'force') return true;
  if (q.get('keybar') === 'off') return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function attachTouchScroll(tab) {
  if (!isTouchDevice()) return;
  const container = tab.container;
  let lastY = null, totalDy = 0, pxPerLine = 17, scrolling = false;
  const DEADZONE = 10;
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { lastY = null; return; }
    lastY = e.touches[0].clientY;
    totalDy = 0; scrolling = false;
    const row = container.querySelector('.xterm-rows > div');
    const h = row && row.getBoundingClientRect().height;
    if (h && h > 0) pxPerLine = h;
  }, { passive: true, capture: true });
  container.addEventListener('touchmove', (e) => {
    if (lastY == null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = y - lastY;
    totalDy += dy;
    if (!scrolling && Math.abs(totalDy) < DEADZONE) return;
    scrolling = true;
    lastY = y;
    const lines = -Math.round(dy / pxPerLine);
    if (lines !== 0) { try { tab.term.scrollLines(lines); } catch (_) {} e.preventDefault(); }
  }, { passive: false, capture: true });
  const reset = () => { lastY = null; totalDy = 0; scrolling = false; };
  container.addEventListener('touchend', reset, { passive: true, capture: true });
  container.addEventListener('touchcancel', reset, { passive: true, capture: true });
}

let ctrlArmed = false;
function setCtrlArmed(armed) {
  ctrlArmed = !!armed;
  const btn = document.querySelector('#keybar button[data-keybar="mod:ctrl"]');
  if (btn) btn.classList.toggle('armed', ctrlArmed);
}
function applyCtrlIfArmed(data) {
  if (!ctrlArmed) return data;
  if (data && data.length === 1) {
    const c = data.charCodeAt(0);
    if (c >= 0x40 && c <= 0x7E) { setCtrlArmed(false); return String.fromCharCode(c & 0x1F); }
  }
  setCtrlArmed(false);
  return data;
}
function keybarBytesFor(action) {
  const idx = action.indexOf(':');
  const kind = action.slice(0, idx);
  const val = action.slice(idx + 1);
  if (kind === 'key') {
    switch (val) {
      case 'Tab': return '\t';
      case 'Escape': return '\x1b';
      case 'ArrowUp': return '\x1b[A';
      case 'ArrowDown': return '\x1b[B';
      case 'ArrowRight': return '\x1b[C';
      case 'ArrowLeft': return '\x1b[D';
      case 'Home': return '\x1b[H';
      case 'End': return '\x1b[F';
    }
  } else if (kind === 'ctrl' && val && val.length === 1) {
    const c = val.toUpperCase().charCodeAt(0);
    if (c >= 0x40 && c <= 0x7E) return String.fromCharCode(c & 0x1F);
  } else if (kind === 'char') return val;
  return null;
}

(function wireKeybar() {
  const bar = $('#keybar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-keybar]');
    if (!btn) return;
    const action = btn.dataset.keybar;
    if (action === 'mod:ctrl') { setCtrlArmed(!ctrlArmed); return; }
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || !tab.alive) return;
    let bytes = keybarBytesFor(action);
    if (bytes == null) return;
    if (action.startsWith('char:')) bytes = applyCtrlIfArmed(bytes);
    else if (ctrlArmed) setCtrlArmed(false);
    SshBridge.write(tab.id, bytes).catch(() => {});
    try { tab.term.focus(); } catch (_) {}
  });
})();

function updateKeybarVisibility() {
  const tab = tabs.find((t) => t.id === activeTabId);
  const show = isTouchDevice() && !!tab;
  const bar = $('#keybar');
  if (!bar) return;
  const wasHidden = bar.classList.contains('hidden');
  bar.classList.toggle('hidden', !show);
  if (wasHidden !== !show) setTimeout(refitActiveTerminal, 50);
}

function refitActiveTerminal() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return;
  try {
    tab.fitAddon.fit();
    const { cols, rows } = tab.term;
    if (tab.alive) SshBridge.resize(tab.id, cols, rows).catch(() => {});
  } catch (_) {}
}

// ============================================================================
// Sidebar collapse / resize (mirrors web/public)
// ============================================================================

const SIDEBAR_MIN = 180, SIDEBAR_MAX = 500, SIDEBAR_DEFAULT = 260;
function setSidebarWidth(px) {
  const c = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px | 0));
  $('#sidebar').style.width = c + 'px';
  try { localStorage.setItem(LS_WIDTH, String(c)); } catch (_) {}
  refitActiveTerminal();
}
function setSidebarCollapsed(collapsed) {
  $('#sidebar').classList.toggle('collapsed', !!collapsed);
  $('#sidebar-resizer').classList.toggle('hidden', !!collapsed);
  $('#btn-expand').classList.toggle('hidden', !collapsed);
  try { localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0'); } catch (_) {}
  setTimeout(refitActiveTerminal, 220);
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

// ============================================================================
// Global keyboard, buttons, image picker
// ============================================================================

document.addEventListener('keydown', (e) => {
  const modalOpen = !$('#modal-overlay').classList.contains('hidden');
  if (modalOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); return; }
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); saveEditor(); return; }
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.code === 'KeyN') { e.preventDefault(); openEditor(null); return; }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); pasteImageToTab(activeTabId); return; }
  if (e.ctrlKey && !e.shiftKey && e.code === 'Tab') {
    e.preventDefault();
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(idx + 1) % tabs.length];
    if (next) switchToTab(next.id);
  }
});

window.addEventListener('resize', () => refitActiveTerminal());

$('#btn-new').addEventListener('click', () => openEditor(null));
$('#btn-paste-img').addEventListener('click', () => pasteImageToTab(activeTabId));
$('#editor-close').addEventListener('click', closeEditor);
$('#editor-cancel').addEventListener('click', closeEditor);
$('#editor-form').addEventListener('submit', saveEditor);
document.querySelectorAll('#editor-form input[name="authType"]').forEach((el) => {
  el.addEventListener('change', updateAuthVisibility);
});
$('#btn-collapse').addEventListener('click', () => setSidebarCollapsed(true));
$('#btn-expand').addEventListener('click', () => setSidebarCollapsed(false));

$('#image-file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !activeTabId) return;
  uploadImageBlob(activeTabId, file);
});

// ============================================================================
// Boot
// ============================================================================

async function boot() {
  await loadSessions();
  renderSessionList();
  // Tab restoration: walks saved tab list, asks the plugin which IDs
  // are still alive (only relevant if the WebView reloaded but the
  // foreground service kept the JVM process up), reconnects fresh for
  // the rest. For now we always reconnect — restoring an alive PTY
  // without buffer replay would look stuck. Future: hook
  // listActive() and replay scrollback from the JVM side.
  const saved = await loadSavedTabs();
  // Clear stored tabs so a fresh launch doesn't infinitely restore
  // tabs that we're about to recreate via launchSession.
  tabs = [];
  for (const t of saved) {
    const s = sessions.find((x) => x.id === t.sessionId);
    if (s) launchSession(t.sessionId, { persistentId: t.id, sessionName: t.sessionName });
  }
}

boot();

})();
