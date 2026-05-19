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
  // First-run seed. The APK bundles its own Alpine Linux + proot
  // (~50 MB; extracted to filesDir on first launch), giving the user
  // a local shell with node/npm/tmux/git ready to go. claude-code is
  // NOT pre-installed — in restricted-network regions the user needs
  // to set HTTPS_PROXY before installing anyway, and we don't ship
  // a pre-installed binary that won't work until they do. The
  // welcome banner inside the shell tells them how.
  if (!sessions.length) {
    sessions = [
      {
        id: newPersistentId(),
        name: 'Local Linux (bundled)',
        type: 'local',
        host: '',
        port: 22,
        username: '',
        authType: 'password',
        password: '',
        privateKey: '',
        privateKeyPassphrase: '',
        port_forwards: '',
        persistent: false,         // tmux-on-phone is a Phase 4+ story
        working_dir: '',
        pre_command: '',
        claude_cmd: '',
        claude_args: '',
        description: 'Alpine Linux shell on this phone (node/npm/tmux/git preinstalled). First launch extracts the bundled rootfs (~30s).',
      },
      {
        id: newPersistentId(),
        name: 'Example VPS',
        type: 'ssh',
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
        description: 'Edit me with your VPS host / credentials, then Launch. claude on the remote inside tmux survives disconnects.',
      },
    ];
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
    // HTML5 drag on Android WebView can swallow taps while it waits
    // for a long-press to begin a drag. Touch users reorder rarely
    // (and can use long-press → drag if we add it later); for now
    // prefer reliable taps over drag.
    card.draggable = !isTouchDevice();
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

// Android keyboards shrink visualViewport.height when they appear,
// but the modal is sized against window.innerHeight by default — so
// the bottom half of the editor falls behind the keyboard. Watch
// visualViewport and re-cap the modal's max-height, and on focusin
// scroll the target field into view inside the form's own scroll
// container.
function adaptEditorToViewport() {
  const overlay = $('#modal-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  const editor = $('#session-editor');
  if (!editor) return;
  const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  editor.style.maxHeight = Math.max(120, h - 16) + 'px';
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', adaptEditorToViewport);
  window.visualViewport.addEventListener('scroll', adaptEditorToViewport);
}

function openEditor(sessionId) {
  editingId = sessionId || null;
  const form = $('#editor-form');
  form.reset();
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : null;
  const values = session || {
    name: '', type: 'ssh', host: '', port: 22, username: 'root',
    authType: 'password', password: '', privateKey: '', privateKeyPassphrase: '',
    port_forwards: '', working_dir: '', pre_command: '',
    claude_cmd: 'claude', claude_args: '', description: '', persistent: false,
  };
  for (const key of SESSION_FIELDS) {
    const input = form.elements[key];
    if (input) input.value = values[key] != null ? values[key] : '';
  }
  if (form.elements['persistent']) form.elements['persistent'].checked = !!values.persistent;
  const sessionType = values.type || 'ssh';
  const typeRadio = form.querySelector(`input[name="type"][value="${sessionType}"]`);
  if (typeRadio) typeRadio.checked = true;
  const authType = values.authType || 'password';
  const authRadio = form.querySelector(`input[name="authType"][value="${authType}"]`);
  if (authRadio) authRadio.checked = true;
  updateAuthVisibility();
  updateTypeVisibility();

  $('#editor-title').textContent = session ? 'Edit Session' : 'New Session';
  $('#modal-overlay').classList.remove('hidden');
  adaptEditorToViewport();
  setTimeout(() => form.elements['name'].focus(), 50);
}

function updateTypeVisibility() {
  const form = $('#editor-form');
  const checked = form.querySelector('input[name="type"]:checked');
  const isSsh = !checked || checked.value === 'ssh';
  document.querySelectorAll('.ssh-only').forEach((el) => el.classList.toggle('hidden', !isSsh));
  // When type=local, auth-* are hidden by ssh-only already; don't
  // also let updateAuthVisibility re-show them. So short-circuit:
  if (!isSsh) {
    document.querySelectorAll('.auth-password, .auth-key').forEach((el) => el.classList.add('hidden'));
  }
}

// Whenever a field inside the editor gets focus (typically via tap →
// soft keyboard pops up), scroll that field into view inside the
// form's own scroll container so the user can see what they're
// typing instead of it being behind the keyboard.
(function wireEditorFocusScroll() {
  const form = $('#editor-form');
  if (!form) return;
  form.addEventListener('focusin', (e) => {
    const target = e.target;
    if (!target || !target.scrollIntoView) return;
    // Wait for the keyboard to actually appear and visualViewport
    // to settle before measuring; 280ms covers most Android IMEs.
    setTimeout(() => {
      try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      catch (_) {}
    }, 280);
  });
})();

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
  const type = (data.get('type') || 'ssh').toString();
  const host = (data.get('host') || '').toString().trim();
  if (type === 'ssh' && !host) { notify('Host is required for SSH sessions', 'error'); return; }
  const username = (data.get('username') || '').toString().trim();
  if (type === 'ssh' && !username) { notify('Username is required for SSH sessions', 'error'); return; }
  const authType = (data.get('authType') || 'password').toString();
  const payload = {
    name,
    type,
    host: type === 'ssh' ? host : '',
    port: parseInt((data.get('port') || '22').toString(), 10) || 22,
    username: type === 'ssh' ? username : '',
    authType,
    password: type === 'ssh' && authType === 'password' ? (data.get('password') || '').toString() : '',
    privateKey: type === 'ssh' && authType === 'key' ? (data.get('privateKey') || '').toString() : '',
    privateKeyPassphrase: type === 'ssh' && authType === 'key' ? (data.get('privateKeyPassphrase') || '').toString() : '',
    port_forwards: type === 'ssh' ? (data.get('port_forwards') || '').toString().trim() : '',
    working_dir: type === 'ssh' ? (data.get('working_dir') || '').toString().trim() : '',
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

// Pick the bridge (SSH plugin vs LocalShell plugin) based on the
// tab's session type. tab.kind is set at launch time and is the
// authoritative discriminator afterwards (the session config itself
// might be edited, but the tab keeps using whichever bridge it
// originally launched with).
function bridgeFor(tab) {
  return tab && tab.kind === 'local' ? LocalShellBridge : SshBridge;
}

async function launchSession(sessionId, opts) {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const sessionType = session.type || 'ssh';
  if (sessionType === 'ssh' && !session.host) {
    notify('Edit this session to set a host first', 'error');
    openEditor(sessionId);
    return;
  }
  // Loud, in-your-face diagnostic when the relevant native plugin
  // didn't register. Without this the connect silently no-ops and
  // the user stares at "[connecting…]" forever.
  const bridgeReady = sessionType === 'local'
    ? LocalShellBridge.available
    : SshBridge.available;
  if (!bridgeReady) {
    notify(`Native ${sessionType === 'local' ? 'LocalShell' : 'SSH'} plugin not loaded — APK build is broken.`, 'error');
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
    kind: sessionType,           // 'ssh' or 'local' — picks the bridge
    term, fitAddon, container, alive: false,
  };
  tabs.push(tab);
  attachTouchScroll(tab);
  attachSoftKeyboardFix(tab);

  term.onData((data) => {
    if (!tab.alive) return;
    // If our compositionend handler just force-wrote this same text,
    // drop the xterm.js-pathway duplicate. See attachSoftKeyboardFix.
    if (tab._suppressOnData && tab._suppressOnData(data)) return;
    const out = applyCtrlIfArmed(data);
    // Inside a full-screen TUI (claude-code / vim / less in
    // alt-screen mode), IME-composed non-ASCII input (Chinese typed
    // via Pinyin, etc.) only gets handled correctly when it arrives
    // as a single bracketed-paste burst. Ink-based input widgets
    // process plain bytes as individual keypresses and silently drop
    // anything that doesn't look like ASCII printable. Wrapping in
    // \x1b[200~…\x1b[201~ flips them into "this is a paste, insert
    // verbatim" mode.
    //
    // Gated on alt-screen because vanilla bash WITHOUT readline's
    // bracketed-paste-mode enabled would otherwise echo "[200~你好
    // [201~" literally. Modern TUIs all enable paste mode on entry,
    // and they all use alt-screen, so the two are well-correlated.
    const altScreen = tab.term.buffer && tab.term.buffer.active &&
      tab.term.buffer.active.type === 'alternate';
    const nonAscii = /[^\x00-\x7F]/.test(out);
    const payload = (altScreen && nonAscii) ? `\x1b[200~${out}\x1b[201~` : out;
    bridgeFor(tab).write(tabId, payload).catch((err) => console.warn('[write]', err));
  });
  term.onResize(({ cols, rows }) => {
    if (tab.alive) bridgeFor(tab).resize(tabId, cols, rows).catch(() => {});
  });
  attachKeyboardHandlers(tab);

  if (!bridgeReady) {
    const plug = sessionType === 'local' ? 'LocalShell' : 'SSH';
    term.write(
      `\r\n\x1b[31m[FATAL] Capacitor ${plug} plugin not loaded — APK is missing the\r\n` +
      `        native module. Open an issue with the APK version code.\r\n\x1b[0m`,
    );
  }
  if (sessionType === 'local') {
    term.write(`\x1b[90m[starting local shell…]\x1b[0m\r\n`);
  } else {
    term.write(`\x1b[90m[connecting ${session.username}@${session.host}…]\x1b[0m\r\n`);
  }

  // tmux name disambiguation: when this is the Nth tab for the same
  // session, suffix the name so additional tabs aren't all mirrored
  // onto a single tmux. Stored on the tab so reconnects target the
  // exact same tmux session and pick up where they left off.
  tab.tmuxName = existing === 0
    ? `cs-${SessionBuilder.sanitizeTmuxName(session.id) || 'session'}`
    : `cs-${SessionBuilder.sanitizeTmuxName(session.id) || 'session'}-${existing + 1}`;

  saveTabsState();
  renderTabs();
  switchToTab(tabId);
  renderSessionList();

  // initialAttempt=true so connect failure on the very first try
  // also feeds into the persistent-session retry path (so "wifi
  // just came up" is forgiving). For non-persistent sessions, the
  // catch falls through to the manual "Press R" prompt.
  await connectOrRetry(tab, /*isInitial*/ true);
}

// Single connect attempt against the session config. Reads everything
// off the tab so the same function can be reused by initial launch,
// auto-reconnect, and the R-keypress fallback.
async function attemptConnect(tab) {
  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) throw new Error('session config missing');
  const { cols, rows } = tab.term;

  if (tab.kind === 'local') {
    // Local shell: just spawn /system/bin/sh (Phase 1) or PRoot+
    // Alpine (Phase 2+) via the LocalShell plugin. No host/auth.
    // Initial command lets the user pre-set claude_cmd / pre_command
    // for an "auto-start claude after shell opens" effect.
    const initParts = [];
    if (session.pre_command) initParts.push(session.pre_command);
    if (session.claude_cmd && session.claude_cmd.trim()) {
      const args = session.claude_args ? ` ${session.claude_args}` : '';
      initParts.push(`${session.claude_cmd.trim()}${args}`);
    }
    const initialCommand = initParts.join('; ');
    await LocalShellBridge.connect({
      tabId: tab.id,
      cols, rows,
      initialCommand: initialCommand || null,
    });
    tab.alive = true;
    renderTabs();
    renderSessionList();
    return;
  }

  // SSH path (existing).
  const initialCommand = SessionBuilder.buildRemoteCmd(session, { tmuxName: tab.tmuxName });
  const portForwards = SessionBuilder.parsePortForwards(session.port_forwards);
  await SshBridge.connect({
    tabId: tab.id,
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
}

// Persistent sessions automatically retry on connect failure or
// mid-session disconnect. We use bounded exponential backoff so a
// permanent error (auth wrong, host down) eventually gives up and
// hands off to the manual Press-R prompt.
const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];

async function connectOrRetry(tab, isInitial) {
  const session = sessions.find((s) => s.id === tab.sessionId);
  const persistent = !!(session && session.persistent);
  tab.reconnecting = true;

  try {
    await attemptConnect(tab);
    tab.reconnecting = false;
    if (!isInitial) tab.term.write(`\x1b[32m[reconnected]\x1b[0m\r\n`);
    return;
  } catch (err) {
    if (!persistent) {
      tab.term.write(`\r\n\x1b[31m[connect failed: ${err && err.message || err}]\x1b[0m\r\n`);
      tab.alive = false;
      tab.reconnecting = false;
      renderTabs();
      renderSessionList();
      promptReconnect(tab);
      return;
    }
    tab.term.write(`\r\n\x1b[33m[connect failed: ${err && err.message || err}]\x1b[0m\r\n`);
  }

  // Persistent retry loop. Each iteration writes a status line and
  // sleeps; if the tab is gone (user closed it) or no longer in the
  // reconnecting state (manual cancel), bail out.
  for (let i = 0; i < RECONNECT_DELAYS_MS.length; i++) {
    if (!tabs.includes(tab) || !tab.reconnecting) return;
    const delay = RECONNECT_DELAYS_MS[i];
    tab.term.write(
      `\x1b[33m[retrying in ${delay / 1000}s — attempt ${i + 1}/${RECONNECT_DELAYS_MS.length}]\x1b[0m\r\n`,
    );
    await sleep(delay);
    if (!tabs.includes(tab) || !tab.reconnecting) return;
    try {
      await attemptConnect(tab);
      tab.reconnecting = false;
      tab.term.write(`\x1b[32m[reconnected]\x1b[0m\r\n`);
      return;
    } catch (err) {
      tab.term.write(`\x1b[31m[retry ${i + 1} failed: ${err && err.message || err}]\x1b[0m\r\n`);
    }
  }

  // Exhausted: hand off to manual prompt.
  tab.reconnecting = false;
  tab.alive = false;
  tab.term.write(
    `\r\n\x1b[33m[auto-reconnect gave up. Press R to retry manually, any other key to close.]\x1b[0m\r\n`,
  );
  renderTabs();
  renderSessionList();
  promptReconnect(tab);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
      if (tab.alive) bridgeFor(tab).resize(tabId, cols, rows).catch(() => {});
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
    bridgeFor(tab).close(tabId).catch(() => {});
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
    // Skip draggable on touch (see comment in renderSessionList) —
    // Android WebView's drag-vs-tap arbitration eats short taps.
    div.draggable = !isTouchDevice();
    div.dataset.tabId = t.id;
    div.innerHTML = `
      <span class="tab-status"></span>
      <span class="tab-name">${escapeHtml(t.sessionName)}</span>
      <span class="tab-close" title="Close (or long-press the tab)">&times;</span>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeTab(t.id);
        return;
      }
      switchToTab(t.id);
    });
    div.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t.id); });

    // Long-press (>500ms) anywhere on the tab also closes it. Belt-
    // and-braces in case the small X is still hard to hit on touch,
    // or in case Android WebView's drag-vs-tap arbitration still eats
    // the X's click.
    let pressTimer = null;
    let pressStartX = 0, pressStartY = 0;
    let pressMoved = false;
    div.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      pressMoved = false;
      pressStartX = e.touches[0].clientX;
      pressStartY = e.touches[0].clientY;
      pressTimer = setTimeout(() => {
        if (!pressMoved) {
          // Visual ack — flash the tab red briefly before closing
          // so the user knows the long-press registered.
          div.style.background = 'var(--red)';
          setTimeout(() => closeTab(t.id), 80);
        }
      }, 500);
    }, { passive: true });
    div.addEventListener('touchmove', (e) => {
      if (!pressTimer || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - pressStartX;
      const dy = e.touches[0].clientY - pressStartY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        pressMoved = true;
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    }, { passive: true });
    const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    div.addEventListener('touchend', cancelPress, { passive: true });
    div.addEventListener('touchcancel', cancelPress, { passive: true });

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

// Data flows in from EITHER bridge depending on the tab's kind.
// They never overlap because plugins emit events keyed by tabId
// which is unique per tab AND the bridges register independent
// listeners — but to be safe we always dispatch via the tab itself.
function onAnyData(ev) {
  const tab = tabs.find((t) => t.id === ev.tabId);
  if (tab) tab.term.write(ev.data);
}
function onAnyExit(ev) {
  const tab = tabs.find((t) => t.id === ev.tabId);
  if (!tab) return;
  tab.alive = false;
  const session = sessions.find((s) => s.id === tab.sessionId);
  // Persistent SSH sessions auto-retry: remote tmux is still alive,
  // reconnecting reattaches transparently. Local persistent sessions
  // currently don't have an equivalent (no tmux on the phone yet —
  // that's Phase 2 in the PRoot+Alpine bundle), so fall through to
  // manual prompt.
  if (tab.kind === 'ssh' && session && session.persistent && !tab.reconnecting) {
    tab.term.write(
      `\r\n\x1b[33m[connection lost (exit ${ev.exitCode}) — auto-reconnecting…]\x1b[0m\r\n`,
    );
    renderTabs();
    renderSessionList();
    connectOrRetry(tab, /*isInitial*/ false);
    return;
  }
  tab.term.write(
    `\r\n\x1b[33m[Session ended (exit ${ev.exitCode}). Press R to reconnect, any other key to close.]\x1b[0m\r\n`,
  );
  promptReconnect(tab);
  renderTabs();
  renderSessionList();
}

SshBridge.onData(onAnyData);
SshBridge.onExit(onAnyExit);
LocalShellBridge.onData(onAnyData);
LocalShellBridge.onExit(onAnyExit);

SshBridge.onWarning((ev) => {
  notify(ev.error || JSON.stringify(ev), 'error');
});

// Phase markers during connect so the user knows we're not frozen
// when sshj's TCP / auth handshakes take a while, or while the
// local-shell bootstrap is extracting Alpine on first launch.
function onAnyStatus(ev) {
  const tab = tabs.find((t) => t.id === ev.tabId);
  if (!tab) return;
  // "Ready" is the last status before the shell takes over — don't
  // print it (the prompt itself signals readiness).
  if (ev.status === 'Ready') return;
  tab.term.write(`\x1b[90m[${ev.status}]\x1b[0m\r\n`);
}
SshBridge.onStatus(onAnyStatus);
LocalShellBridge.onStatus(onAnyStatus);

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
  bridgeFor(tab).write(tabId, `\x1b[200~${text}\x1b[201~`).catch(() => {});
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

// Android soft keyboards (Gboard, Sogou, Chinese IMEs) and even some
// hardware-keyboard drivers don't fire reliable keydown events for
// Backspace inside a WebView. Two related symptoms we've seen:
//   - Single tap on Backspace inside xterm: deletes nothing.
//   - Holding Backspace: deletes only some of the characters (1 per
//     2-3 presses) because keydown autorepeat is missing.
//
// xterm's hidden textarea is involved either way — depending on the
// IME we get keydown OR beforeinput OR both. Listen to both, dedup
// with a tiny window so a press that fires both events only sends
// one DEL byte.
function attachSoftKeyboardFix(tab) {
  const ta = tab.term && tab.term.textarea;
  if (!ta) return;

  // Hint to the WebView that this textarea wants a standard text
  // IME. Without this hint, some Android WebView builds skip the
  // IME's composition wiring for elements they treat as non-text.
  try {
    ta.setAttribute('inputmode', 'text');
    ta.setAttribute('enterkeyhint', 'send');
  } catch (_) {}

  let lastSent = 0;
  const DEDUP_MS = 30;

  function sendBackspace() {
    if (!tab.alive) return;
    const now = Date.now();
    if (now - lastSent < DEDUP_MS) return;
    lastSent = now;
    bridgeFor(tab).write(tab.id, '\x7f').catch(() => {});
  }
  function sendForwardDelete() {
    if (!tab.alive) return;
    const now = Date.now();
    if (now - lastSent < DEDUP_MS) return;
    lastSent = now;
    bridgeFor(tab).write(tab.id, '\x1b[3~').catch(() => {});
  }

  // Path 1: hardware / mature keyboards fire keydown for Backspace.
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      sendBackspace();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      sendForwardDelete();
    }
  }, true);

  // Path 2: Android soft keyboards fire beforeinput with these
  // inputTypes instead of keydown. Same dedup applies.
  ta.addEventListener('beforeinput', (e) => {
    const t = e.inputType;
    if (t === 'deleteContentBackward' || t === 'deleteWordBackward') {
      e.preventDefault();
      sendBackspace();
    } else if (t === 'deleteContentForward') {
      e.preventDefault();
      sendForwardDelete();
    }
  }, true);

  // Path 3: IME compositionend backup. xterm.js v6's
  // CompositionHelper SHOULD pick this up and call onData, but
  // Android WebView sometimes delivers compositionend in a way that
  // xterm.js's handler misses (especially after we move the hidden
  // textarea on-screen via the CSS workaround — xterm.js wasn't
  // designed around the textarea being visible). To make Chinese
  // input reliable, we ALSO listen here in the capture phase and
  // force-send the composed text via the bridge. To avoid
  // double-input on platforms where xterm.js's path DOES fire, we
  // record the text + timestamp, and suppress duplicate onData calls
  // for the same text within a tight window.
  const recentComposed = { text: '', at: 0 };
  ta.addEventListener('compositionend', (e) => {
    if (!tab.alive) return;
    const text = e.data || '';
    if (!text) return;
    // Only force-write when composed text contains non-ASCII (IME)
    // chars — ASCII falls through to term.onData naturally.
    // recentComposed is only stamped INSIDE this branch, so an
    // ASCII composition doesn't cause us to suppress xterm.js's
    // legitimate write.
    if (/[^\x00-\x7F]/.test(text)) {
      bridgeFor(tab).write(tab.id, text).catch(() => {});
      recentComposed.text = text;
      recentComposed.at = Date.now();
    }
  }, true);
  // Belt-and-suspenders: some Android IMEs deliver committed text
  // via `input` (inputType=insertCompositionText / insertText)
  // WITHOUT firing compositionend. Listen here too. Same recent-
  // Composed stamp dedupes against the compositionend path so we
  // don't double-send when both happen to fire.
  ta.addEventListener('input', (e) => {
    if (!tab.alive) return;
    if (e.isComposing) return;  // mid-composition; not the commit
    const t = e.inputType;
    if (t !== 'insertText' && t !== 'insertCompositionText' &&
        t !== 'insertFromComposition') return;
    const val = e.data || '';
    if (!val || !/[^\x00-\x7F]/.test(val)) return;  // ASCII path is fine
    if (val === recentComposed.text && Date.now() - recentComposed.at < 200) {
      return;  // already handled via compositionend
    }
    bridgeFor(tab).write(tab.id, val).catch(() => {});
    recentComposed.text = val;
    recentComposed.at = Date.now();
  }, true);

  // Filter for the matching term.onData burst. xterm.js's
  // CompositionHelper fires _coreService.triggerDataEvent shortly
  // after compositionend with the same text — without this we'd
  // send each Chinese character twice.
  tab._suppressOnData = (data) => {
    if (!data) return false;
    if (data !== recentComposed.text) return false;
    if (Date.now() - recentComposed.at > 200) return false;
    return true;
  };
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
    if (lines === 0) return;

    // tmux / vim / less / claude take over the screen with the
    // "alternate" buffer — at that point xterm.js's own scrollback
    // is empty and scrollLines() does nothing. Translate the swipe
    // into SGR mouse-wheel events instead, which tmux with
    // `set -g mouse on` (and most TUIs with mouse support) honor as
    // scrollback navigation. Capped to ±3 events per touchmove so
    // a single swipe doesn't fly past the user's target.
    const altScreen = tab.term.buffer && tab.term.buffer.active &&
      tab.term.buffer.active.type === 'alternate';
    if (altScreen && tab.alive) {
      const n = Math.min(3, Math.abs(lines));
      const code = lines < 0 ? 64 : 65;   // 64 = wheel up, 65 = wheel down
      const seq = `\x1b[<${code};1;1M`.repeat(n);
      bridgeFor(tab).write(tab.id, seq).catch(() => {});
    } else {
      try { tab.term.scrollLines(lines); } catch (_) {}
    }
    e.preventDefault();
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
      case 'PageUp': return '\x1b[5~';
      case 'PageDown': return '\x1b[6~';
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
    bridgeFor(tab).write(tab.id, bytes).catch(() => {});
    // Don't call tab.term.focus() here. Focusing the hidden textarea
    // triggers Android to (re)open the IME — even for navigation
    // taps like PgUp/PgDn/arrows where the user has no intention to
    // type. The button itself "blurs" the textarea on tap, which is
    // a feature for navigation actions; if the user wants to type
    // next they'll tap the terminal again. Char-injecting buttons
    // (Tab, |, /, etc.) lose the soft keyboard too, which is a fair
    // tradeoff for the rest of the row not flashing the IME.
  });
})();

function updateKeybarVisibility() {
  const tab = tabs.find((t) => t.id === activeTabId);
  const show = isTouchDevice() && !!tab;
  const bar = $('#keybar');
  const inputBar = $('#mobile-input-bar');
  let layoutChanged = false;
  if (bar) {
    const wasHidden = bar.classList.contains('hidden');
    bar.classList.toggle('hidden', !show);
    if (wasHidden !== !show) layoutChanged = true;
  }
  if (inputBar) {
    const wasHidden = inputBar.classList.contains('hidden');
    inputBar.classList.toggle('hidden', !show);
    if (wasHidden !== !show) layoutChanged = true;
  }
  if (layoutChanged) setTimeout(refitActiveTerminal, 50);
}

// ============================================================================
// Mobile composition input bar
// ============================================================================
//
// Android WebView's InputConnection has been observed to drop ALL
// composition / batched-input events on xterm.js's hidden helper
// textarea — even after the CSS workaround that brings it on-screen
// at non-zero size. The user-visible symptom is: Chinese (Pinyin)
// commits don't appear, AND English words typed with Gboard's
// autocomplete don't appear, AND only single-tap-then-pause input
// makes it through.
//
// Routing text through a normal, fully-visible <input> at the bottom
// of the screen sidesteps the whole class of bugs. compositionend
// fires reliably on a real input element. We stream each commit
// (single char OR full IME-composed string) straight to the active
// tab's PTY and clear the input so the next typing starts fresh.
//
// Hardware-keyboard users — Bluetooth keyboards attached to the
// phone, tablet keyboard cases, etc. — still hit the xterm.js
// textarea path because they tap the canvas to focus and their
// keystrokes generate direct keydown events that xterm handles.
(function attachMobileInput() {
  const bar = $('#mobile-input-bar');
  const input = $('#mobile-input');
  if (!bar || !input) return;

  let composing = false;

  function activeTab() { return tabs.find((t) => t.id === activeTabId); }

  function sendChars(text) {
    const tab = activeTab();
    if (!tab || !tab.alive || !text) return;
    bridgeFor(tab).write(tab.id, text).catch((err) => console.warn('[input-bar]', err));
  }

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', (e) => {
    composing = false;
    const text = e.data || '';
    if (text) sendChars(text);
    // Clear AFTER the browser finishes its own compositionend
    // bookkeeping; clearing synchronously trips some IMEs into a
    // weird state where the next compositionstart never fires.
    setTimeout(() => { input.value = ''; }, 0);
  });

  input.addEventListener('input', (e) => {
    // Skip mid-composition — the compositionend handler will deliver
    // the final committed text. Skip insertCompositionText specifically
    // because some IMEs fire input with that inputType during
    // composition even when compositionstart was already dispatched.
    if (composing) return;
    if (e.inputType === 'insertCompositionText') return;
    const val = input.value;
    if (!val) return;
    sendChars(val);
    input.value = '';
  });

  // Keys that aren't text: Enter / Backspace / Tab go straight to the
  // PTY as control bytes. Arrows / Esc / Ctrl-* still use the keybar.
  input.addEventListener('keydown', (e) => {
    if (composing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChars('\r');
    } else if (e.key === 'Backspace' && !input.value) {
      // Only forward Backspace when the input is empty — otherwise
      // we'd let it delete a char locally AND send a backspace to
      // the PTY, doubling the delete.
      e.preventDefault();
      sendChars('\x7f');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      sendChars('\t');
    }
  });
})();

function refitActiveTerminal() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return;
  try {
    tab.fitAddon.fit();
    const { cols, rows } = tab.term;
    if (tab.alive) bridgeFor(tab).resize(tab.id, cols, rows).catch(() => {});
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
document.querySelectorAll('#editor-form input[name="type"]').forEach((el) => {
  el.addEventListener('change', updateTypeVisibility);
});

// Show/hide toggle for password + passphrase fields. The button stays
// "shown" (eye highlighted) while the input is type=text so the user
// can tell at a glance whether it's visible.
document.querySelectorAll('.password-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.for;
    const input = document.querySelector(`#editor-form input[name="${name}"]`);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.classList.toggle('shown', !showing);
  });
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
