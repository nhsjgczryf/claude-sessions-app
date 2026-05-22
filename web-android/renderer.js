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

// Clipboard helper. navigator.clipboard.* on Android WebView is
// gated by user-gesture / permission policies that vary by Android
// version + WebView build, and frequently fails silently (the
// Promise resolves but writeText doesn't put anything on the system
// clipboard). Capacitor's @capacitor/clipboard plugin talks to
// android.content.ClipboardManager directly, which Just Works. We
// route through it when present, fall back to navigator.clipboard
// (desktop dev / Electron / web) otherwise.
const ClipboardPlugin = window.Capacitor && window.Capacitor.Plugins &&
  window.Capacitor.Plugins.Clipboard;
const Clip = {
  async write(text) {
    if (ClipboardPlugin) {
      try { await ClipboardPlugin.write({ string: text }); return true; }
      catch (e) { console.warn('[clip.write] native', e); }
    }
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) { console.warn('[clip.write] dom', e); return false; }
  },
  async read() {
    if (ClipboardPlugin) {
      try { const r = await ClipboardPlugin.read(); return (r && r.value) || ''; }
      catch (e) { console.warn('[clip.read] native', e); }
    }
    try { return await navigator.clipboard.readText(); }
    catch (e) { console.warn('[clip.read] dom', e); return ''; }
  },
};

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
    const stype = s.type || 'ssh';
    const badge = stype === 'local'
      ? '<span class="badge local">LOCAL</span>'
      : stype === 'remote'
        ? '<span class="badge web">AGENT</span>'
        : '<span class="badge ssh">SSH</span>';
    const subline = stype === 'remote'
      ? (s.agent_url ? `<div class="session-desc">${escapeHtml(s.agent_url)}</div>` : '')
      : (s.host ? `<div class="session-desc">${escapeHtml(s.username || '')}@${escapeHtml(s.host)}${s.port && s.port !== 22 ? ':' + s.port : ''}</div>` : '');
    card.innerHTML = `
      <div class="session-card-top">
        <span class="drag-handle" title="Drag to reorder">&#x2630;</span>
        <span class="session-name">${escapeHtml(s.name)}</span>
        ${badge}
        ${count > 0 ? `<span class="badge count">${count}</span>` : ''}
      </div>
      ${subline}
      ${s.description ? `<div class="session-desc">${escapeHtml(s.description)}</div>` : ''}
      <div class="session-actions">
        <button data-action="launch">Launch</button>
        <button data-action="edit">Edit</button>
        <button data-action="clone">Clone</button>
        ${(s.type === 'remote') ? '<button data-action="live">Live</button>' : ''}
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
        else if (action === 'live') openLiveSessions(s);
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
  'agent_url', 'agent_password', 'run_as', 'remote_working_dir',
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
  // remote_working_dir is the form field; the stored field is the
  // shared working_dir. Mirror it in for remote sessions.
  if (form.elements['remote_working_dir']) {
    form.elements['remote_working_dir'].value = values.working_dir || '';
  }
  if (form.elements['persistent']) form.elements['persistent'].checked = !!values.persistent;
  if (form.elements['skip_permissions']) form.elements['skip_permissions'].checked = !!values.skip_permissions;
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
  // While the editor modal is up, IME typing must reach the form's
  // <input> fields — NOT the active terminal. Tear down native input
  // routing; closeEditor re-arms it.
  syncNativeInputRoute();
}

function updateTypeVisibility() {
  const form = $('#editor-form');
  const checked = form.querySelector('input[name="type"]:checked');
  const type = checked ? checked.value : 'ssh';
  const isSsh = type === 'ssh';
  const isRemote = type === 'remote';
  document.querySelectorAll('.ssh-only').forEach((el) => el.classList.toggle('hidden', !isSsh));
  document.querySelectorAll('.remote-only').forEach((el) => el.classList.toggle('hidden', !isRemote));
  // When type != ssh, auth-* are hidden by ssh-only already; don't
  // let updateAuthVisibility re-show them. So short-circuit:
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
  // Re-arm native IME → PTY routing for the active tab (the modal was
  // suppressing it so typing in form fields wouldn't get rerouted).
  syncNativeInputRoute();
}

// Directory picker for remote-agent sessions: browse the VPS's
// filesystem via the agent's /api/fs/list and fill remote_working_dir.
(function wireDirBrowse() {
  const btn = $('#btn-browse-dir');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const form = $('#editor-form');
    const agentUrl = (form.elements['agent_url'] && form.elements['agent_url'].value || '').trim();
    const password = (form.elements['agent_password'] && form.elements['agent_password'].value) || '';
    if (!agentUrl) { notify('Set the Agent URL first', 'error'); return; }
    const start = (form.elements['remote_working_dir'] && form.elements['remote_working_dir'].value || '').trim();
    openDirPicker(agentUrl, password, start, (chosen) => {
      if (form.elements['remote_working_dir']) form.elements['remote_working_dir'].value = chosen;
    });
  });
})();

function openDirPicker(agentUrl, password, startPath, onPick) {
  let overlay = $('#dir-picker');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'dir-picker';
    overlay.innerHTML =
      '<div class="dir-picker-box">' +
      '<div class="dir-picker-path"></div>' +
      '<div class="dir-picker-list"></div>' +
      '<div class="dir-picker-actions">' +
      '<button type="button" data-act="cancel">Cancel</button>' +
      '<button type="button" data-act="select">Select this dir</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
  }
  overlay.classList.remove('hidden');
  let current = startPath || '';
  const pathEl = overlay.querySelector('.dir-picker-path');
  const listEl = overlay.querySelector('.dir-picker-list');

  async function load(path) {
    pathEl.textContent = 'Loading…';
    listEl.innerHTML = '';
    try {
      const r = await WebSocketBridge.apiGet(agentUrl, password, '/api/fs/list', path ? { path } : {});
      current = r.path;
      pathEl.textContent = r.path;
      const rows = [];
      if (r.parent) rows.push({ name: '.. (up)', path: r.parent });
      for (const d of r.dirs) rows.push({ name: d, path: (r.path.endsWith('/') ? r.path : r.path + '/') + d });
      listEl.innerHTML = '';
      for (const row of rows) {
        const div = document.createElement('div');
        div.className = 'dir-picker-item';
        div.textContent = row.name;
        div.addEventListener('click', () => load(row.path));
        listEl.appendChild(div);
      }
      if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dir-picker-item dim';
        empty.textContent = '(no subdirectories)';
        listEl.appendChild(empty);
      }
    } catch (err) {
      pathEl.textContent = 'Error: ' + (err && err.message || err);
    }
  }

  overlay.querySelector('[data-act="cancel"]').onclick = () => overlay.classList.add('hidden');
  overlay.querySelector('[data-act="select"]').onclick = () => {
    overlay.classList.add('hidden');
    if (onPick) onPick(current);
  };
  load(startPath);
}

// Live-sessions browser: shows the agent's currently-alive cs-* tmux
// sessions (independent of whether any client is attached), with
// Attach (open a tab reattached to that exact tmux) and Kill. This is
// the "see what's alive on the server" view — the agent is the source
// of truth, queried via /api/tmux/sessions.
async function openLiveSessions(session) {
  const agentUrl = (session.agent_url || '').trim();
  const password = session.agent_password || '';
  if (!agentUrl) { notify('This session has no agent URL', 'error'); return; }

  let overlay = $('#live-sessions');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'live-sessions';
    overlay.innerHTML =
      '<div class="dir-picker-box">' +
      '<div class="dir-picker-path">Live sessions on agent</div>' +
      '<div class="dir-picker-list"></div>' +
      '<div class="dir-picker-actions">' +
      '<button type="button" data-act="refresh">Refresh</button>' +
      '<button type="button" data-act="close">Close</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
  }
  overlay.classList.remove('hidden');
  const listEl = overlay.querySelector('.dir-picker-list');

  async function load() {
    listEl.innerHTML = '<div class="dir-picker-item dim">Loading…</div>';
    try {
      const r = await WebSocketBridge.apiGet(agentUrl, password, '/api/tmux/sessions');
      const list = (r && r.sessions) || [];
      listEl.innerHTML = '';
      if (!r.tmux) {
        listEl.innerHTML = '<div class="dir-picker-item dim">tmux not available on the agent host.</div>';
        return;
      }
      if (list.length === 0) {
        listEl.innerHTML = '<div class="dir-picker-item dim">No live cs-* sessions.</div>';
        return;
      }
      for (const s of list) {
        const ageMin = s.created ? Math.round((Date.now() / 1000 - s.created) / 60) : 0;
        const item = document.createElement('div');
        item.className = 'live-session-item';
        item.innerHTML =
          `<div class="live-session-meta">` +
          `<div class="live-session-name">${escapeHtml(s.name)}</div>` +
          `<div class="live-session-sub">${s.attached ? '● attached' : '○ detached'} · ${s.windows} win · ${ageMin}m</div>` +
          `</div>` +
          `<div class="live-session-btns">` +
          `<button type="button" data-act="attach">Attach</button>` +
          `<button type="button" data-act="kill">Kill</button>` +
          `</div>`;
        item.querySelector('[data-act="attach"]').onclick = () => {
          overlay.classList.add('hidden');
          launchSession(session.id, { attachTmux: s.name, sessionName: s.name });
        };
        item.querySelector('[data-act="kill"]').onclick = async () => {
          if (!confirm(`Kill ${s.name}? This ends the claude session on the server.`)) return;
          try {
            await WebSocketBridge.apiPost(agentUrl, password, '/api/tmux/kill', { name: s.name });
            notify(`Killed ${s.name}`, 'success');
          } catch (err) {
            notify('Kill failed: ' + (err && err.message || err), 'error');
          }
          load();
        };
        listEl.appendChild(item);
      }
    } catch (err) {
      listEl.innerHTML = `<div class="dir-picker-item dim">Error: ${escapeHtml(String(err && err.message || err))}</div>`;
    }
  }

  overlay.querySelector('[data-act="refresh"]').onclick = load;
  overlay.querySelector('[data-act="close"]').onclick = () => overlay.classList.add('hidden');
  load();
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
  const agentUrl = (data.get('agent_url') || '').toString().trim();
  if (type === 'remote' && !agentUrl) { notify('Agent URL is required for remote sessions', 'error'); return; }
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
    // working_dir is shared; for remote sessions it comes from the
    // browsable remote_working_dir field instead of the ssh one.
    working_dir: type === 'remote'
      ? (data.get('remote_working_dir') || '').toString().trim()
      : (data.get('working_dir') || '').toString().trim(),
    // Remote-agent transport fields.
    agent_url: type === 'remote' ? agentUrl : '',
    agent_password: type === 'remote' ? (data.get('agent_password') || '').toString() : '',
    run_as: type === 'remote' ? (data.get('run_as') || '').toString().trim() : '',
    pre_command: (data.get('pre_command') || '').toString(),
    claude_cmd: (data.get('claude_cmd') || '').toString().trim(),
    claude_args: (data.get('claude_args') || '').toString(),
    description: (data.get('description') || '').toString(),
    persistent: !!form.elements['persistent'] && form.elements['persistent'].checked,
    skip_permissions: !!form.elements['skip_permissions'] && form.elements['skip_permissions'].checked,
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
  if (!tab) return SshBridge;
  if (tab.kind === 'local') return LocalShellBridge;
  if (tab.kind === 'remote') return WebSocketBridge;
  return SshBridge;
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
  if (sessionType === 'remote' && !session.agent_url) {
    notify('Edit this session to set the agent URL first', 'error');
    openEditor(sessionId);
    return;
  }
  // Loud, in-your-face diagnostic when the relevant transport isn't
  // available. Without this the connect silently no-ops and the user
  // stares at "[connecting…]" forever.
  const bridgeReady =
    sessionType === 'local' ? LocalShellBridge.available
      : sessionType === 'remote' ? WebSocketBridge.available
        : SshBridge.available;
  if (!bridgeReady) {
    const which = sessionType === 'local' ? 'LocalShell' : sessionType === 'remote' ? 'WebSocket' : 'SSH';
    notify(`${which} transport not available — APK build is broken.`, 'error');
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
    // When attaching to a discovered tmux session, this is its name
    // (cs-XXX); the remote attemptConnect uses it to reattach to that
    // exact server-side tmux instead of keying on the tab id.
    attachTmux: (opts && opts.attachTmux) || null,
    term, fitAddon, container, alive: false,
  };
  tabs.push(tab);
  attachTouchScroll(tab);
  attachSoftKeyboardFix(tab);
  attachTerminalLongPress(tab);

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
  } else if (sessionType === 'remote') {
    term.write(`\x1b[90m[connecting to agent ${session.agent_url}…]\x1b[0m\r\n`);
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

// Effective claude args = the configured args plus the
// --dangerously-skip-permissions flag when the session opted into it.
// Skipping permission prompts speeds up claude a lot (it stops asking
// before every file edit / command) but lets it act without
// confirmation — only sensible in environments you trust.
function effectiveClaudeArgs(session) {
  let a = (session.claude_args || '').trim();
  if (session.skip_permissions) {
    a = (a + ' --dangerously-skip-permissions').trim();
  }
  return a;
}

// Single connect attempt against the session config. Reads everything
// off the tab so the same function can be reused by initial launch,
// auto-reconnect, and the R-keypress fallback.
async function attemptConnect(tab) {
  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) throw new Error('session config missing');
  // Fit NOW — the keybar + compose bar were just shown by switchToTab,
  // shrinking the terminal. Without this the first cols/rows we hand
  // the PTY are the pre-bar (too tall) size, and the 50ms follow-up
  // refit then resizes again — two sizes back-to-back make a remote
  // tmux reflow twice and can leave duplicate lines. One correct size
  // up front avoids that.
  try { tab.fitAddon.fit(); } catch (_) {}
  const { cols, rows } = tab.term;

  if (tab.kind === 'local') {
    // Local shell: just spawn /system/bin/sh (Phase 1) or PRoot+
    // Alpine (Phase 2+) via the LocalShell plugin. No host/auth.
    // Initial command lets the user pre-set claude_cmd / pre_command
    // for an "auto-start claude after shell opens" effect.
    const initParts = [];
    if (session.pre_command) initParts.push(session.pre_command);
    if (session.claude_cmd && session.claude_cmd.trim()) {
      const args = effectiveClaudeArgs(session);
      initParts.push(`${session.claude_cmd.trim()}${args ? ' ' + args : ''}`);
    }
    const initialCommand = initParts.join('; ');
    await LocalShellBridge.connect({
      tabId: tab.id,
      cols, rows,
      initialCommand: initialCommand || null,
    });
    tab.alive = true;
    // Plugin now has a session entry under this tabId; arm the
    // native input routing if this is still the active tab.
    if (tab.id === activeTabId) syncNativeInputRoute();
    renderTabs();
    renderSessionList();
    return;
  }

  if (tab.kind === 'remote') {
    // Remote agent: hand a `local` session config to web/server.js so
    // claude runs on the VPS, wrapped in a persistent tmux. The agent
    // owns the PTY; we just stream over WebSocket. persistent:true is
    // what triggers the server's tmux-attach path (buildLocalCommand).
    const serverSession = {
      // Server-side tmux name becomes cs-<id> (buildLocalCommand adds
      // the cs- prefix). Keying on the persistent tab id means the
      // same tab always reattaches to the same tmux session, while a
      // fresh launch gets a fresh one.
      // Attaching to a discovered tmux → use its name (minus the cs-
      // prefix the server re-adds) so `tmux new -A` reattaches to it.
      // Otherwise key on the tab id (one tmux per tab).
      id: tab.attachTmux ? tab.attachTmux.replace(/^cs-/, '') : tab.id,
      type: 'local',
      persistent: true,
      pre_command: session.pre_command || '',
      claude_cmd: session.claude_cmd || '',
      claude_args: effectiveClaudeArgs(session),
      working_dir: session.working_dir || '',
      run_as: session.run_as || '',     // server su's into this Linux user
    };
    await WebSocketBridge.connect({
      tabId: tab.id,
      agentUrl: session.agent_url,
      password: session.agent_password || '',
      session: serverSession,
      cols, rows,
    });
    tab.alive = true;
    renderTabs();
    renderSessionList();
    return;
  }

  // SSH path (existing). Fold skip-permissions into claude_args via a
  // shallow copy so buildRemoteCmd picks it up.
  const sshSession = { ...session, claude_args: effectiveClaudeArgs(session) };
  const initialCommand = SessionBuilder.buildRemoteCmd(sshSession, { tmuxName: tab.tmuxName });
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
  syncNativeInputRoute();
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
    if (next) {
      switchToTab(next.id);
    } else {
      // No tab left; tear down native IME routing so the WebView's
      // InputConnection wrapper stops trying to forward to a dead PTY.
      syncNativeInputRoute();
    }
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
  // If this was the active tab, clear native input routing so the
  // "Press R to reconnect" prompt's xterm.js onKey listener can
  // receive the next keypress (the WebView's default InputConnection
  // routes IME / hardware-key input to whatever DOM element is
  // focused, which is xterm's helper textarea — the path the prompt
  // reads from). syncNativeInputRoute would re-arm us against the
  // dead tab, so we bypass it.
  if (tab.id === activeTabId) {
    if (typeof SshBridge !== 'undefined' && SshBridge.available)
      SshBridge.setActiveTab(null).catch(() => {});
    if (typeof LocalShellBridge !== 'undefined' && LocalShellBridge.available)
      LocalShellBridge.setActiveTab(null).catch(() => {});
  }
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
WebSocketBridge.onData(onAnyData);
WebSocketBridge.onExit(onAnyExit);

SshBridge.onWarning((ev) => {
  notify(ev.error || JSON.stringify(ev), 'error');
});
WebSocketBridge.onWarning((ev) => {
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
WebSocketBridge.onStatus(onAnyStatus);

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
        Clip.write(sel);
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
        Clip.write(term.getSelection());
        term.clearSelection();
        return;
      }
    }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyV') {
      e.preventDefault(); e.stopPropagation();
      Clip.read().then((t) => { if (t) bracketedPaste(tabId, t); });
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
      Clip.write(term.getSelection());
      term.clearSelection();
      notify('Copied', 'success');
    } else {
      Clip.read().then((t) => { if (t) bracketedPaste(tabId, t); });
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
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  bridgeFor(tab).write(tabId, `\x1b[200~${text}\x1b[201~`).catch(() => {});
}

// Read the visible viewport (or full selection) as plain text. Touch
// selection in xterm.js only grabs a single line/word, so for "copy
// the command output" the reliable path is to grab the whole visible
// screen. Trailing blank lines are trimmed.
function readViewportText(term) {
  try {
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < term.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  } catch (_) { return ''; }
}

// Long-press menu on the terminal: reliable copy/paste actions that
// don't depend on the fiddly touch text-selection handles.
function showTerminalMenu(x, y, tab) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  const term = tab.term;
  const items = [];
  if (term.hasSelection()) {
    items.push({ label: 'Copy selection', action: () => {
      Clip.write(term.getSelection()); term.clearSelection(); notify('Copied', 'success');
    }});
  }
  items.push({ label: 'Copy screen', action: () => {
    const text = readViewportText(term);
    if (text) { Clip.write(text); notify('Copied screen', 'success'); }
  }});
  items.push({ label: 'Paste', action: () => {
    Clip.read().then((t) => { if (t) bracketedPaste(tab.id, t); });
  }});
  items.push({ label: 'Select all', action: () => { try { term.selectAll(); } catch (_) {} }});
  for (const it of items) {
    const mi = document.createElement('div');
    mi.className = 'menu-item';
    mi.textContent = it.label;
    mi.addEventListener('click', () => { menu.classList.add('hidden'); it.action(); });
    menu.appendChild(mi);
  }
  // Clamp to viewport so the menu doesn't overflow off-screen.
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - 160) + 'px';
  menu.style.top = Math.min(y, vh - 180) + 'px';
  menu.classList.remove('hidden');
}

function attachTerminalLongPress(tab) {
  if (!isTouchDevice()) return;
  const el = tab.container;
  let timer = null, startX = 0, startY = 0;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { clear(); return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    clear();
    timer = setTimeout(() => {
      timer = null;
      showTerminalMenu(startX, startY, tab);
    }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) clear();
  }, { passive: true });
  el.addEventListener('touchend', clear, { passive: true });
  el.addEventListener('touchcancel', clear, { passive: true });
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

  // inputmode=none: xterm focuses this hidden textarea whenever the
  // user taps the terminal (for selection / scroll), and on Android
  // that focus pops up the soft keyboard / IME — covering half the
  // screen for no reason, since all real typing now goes through the
  // visible compose box. `none` lets the element keep focus without
  // summoning the keyboard. Hardware keyboards still deliver keydown.
  try {
    ta.setAttribute('inputmode', 'none');
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
      case 'ShiftTab': return '\x1b[Z';   // CSI Z = back-tab; claude cycles modes
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

    // Backspace is special: text lives in the compose box, so when it
    // has content we delete a char there (reliable, doesn't depend on
    // the IME's flaky delete). Only when the box is empty do we send a
    // real backspace byte to the PTY (for TUIs doing their own line
    // editing). This is the "reliable delete key" the user asked for.
    if (action === 'key:Backspace') {
      if (composeBackspace()) return;
      bridgeFor(tab).write(tab.id, '\x7f').catch(() => {});
      return;
    }

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
// Visible composition input bar (the working IME path)
// ============================================================================
//
// Background — three attempts at fixing Chinese (Pinyin) and Gboard
// English-autocomplete input died one after another:
//
//   1. CSS hack to size + on-screen xterm.js's hidden helper-textarea
//      (see the @reference comment about xterm.js PR #3251). Made the
//      textarea "visible enough" to IMEs, but Android WebView's IME
//      delivery is still inconsistent.
//   2. JavaScript belt-and-suspenders compositionend + input listeners
//      to catch what xterm.js's CompositionHelper missed. WebView
//      simply didn't fire either event on the off-screen textarea.
//   3. Native InputConnectionWrapper subclass of WebView. The Cordova
//      pattern says this should work, but modern Chromium WebView
//      delegates IME to its private internal ContentView class — our
//      override of WebView.onCreateInputConnection is never reached
//      for the routes IMEs actually use.
//
// What works, reliably, on every Android WebView version: a normal,
// fully-visible <input> at the bottom of the screen. compositionend
// + input events fire on it correctly — same as in regular browser
// pages. We stream each commit / keystroke to the active PTY.
//
// This is the JuiceSSH / Termius-mobile UX. Termux gets away without
// it because Termux is a native Android app with its own TerminalView;
// we're a WebView app and have to take the visible-input route.
(function attachMobileInput() {
  const bar = $('#mobile-input-bar');
  const input = $('#mobile-input');
  if (!bar || !input) return;

  function activeTab() { return tabs.find((t) => t.id === activeTabId); }
  function send(text) {
    const tab = activeTab();
    if (!tab || !tab.alive || !text) return;
    bridgeFor(tab).write(tab.id, text).catch((err) => console.warn('[mobile-input]', err));
  }

  // Compose model (claude-code oriented). Typing is LOCAL — nothing
  // is sent to the PTY until the user submits. This is the right fit
  // for claude (you compose a message, then send it) and it sidesteps
  // every per-keystroke IME headache we fought with the streaming /
  // mirror approaches: backspace just edits the box, composition only
  // matters at submit time.
  //
  // The box is a multi-line auto-growing textarea so a long prompt is
  // fully visible (wraps) instead of scrolling off a single-line
  // field — that was the "can't see what I typed" complaint.
  const MAX_PX = 152;   // ~6 lines; matches the CSS max-height
  let composing = false;
  // Toggling height to 'auto' to measure scrollHeight forces a reflow
  // that, on Android WebView, snaps the caret to the END of the
  // textarea. That's the "insert Chinese in the middle → caret jumps
  // to the end" bug. We save the caret before the reflow and restore
  // it after — but NOT while an IME composition is active, because
  // setSelectionRange would break the composition region. During
  // composition we skip the resize entirely and catch up on
  // compositionend.
  function autoGrow() {
    if (composing) return;
    const s = input.selectionStart;
    const e = input.selectionEnd;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, MAX_PX) + 'px';
    try { input.setSelectionRange(s, e); } catch (_) {}
  }
  function clearBox() { input.value = ''; input.style.height = 'auto'; }

  // Send the composed text, then a carriage return so the shell / TUI
  // executes it. Multi-line content is wrapped in bracketed paste so
  // claude / readline insert it atomically as one block rather than
  // treating each embedded newline as a separate submit.
  function submitLine() {
    const text = input.value;
    if (text) {
      if (text.includes('\n')) {
        send(`\x1b[200~${text}\x1b[201~`);
      } else {
        send(text);
      }
    }
    send('\r');
    clearBox();
  }

  input.addEventListener('input', autoGrow);
  input.addEventListener('compositionstart', () => { composing = true; });

  // Enter submits; Shift+Enter inserts a newline (default textarea
  // behavior — we just let it through and re-grow). Enter pressed
  // WHILE composing (Gboard has the word underlined as a candidate)
  // fires keydown with isComposing=true and the IME swallows it to
  // commit the candidate; we defer the submit to compositionend so
  // "/clear" + Enter still executes.
  let pendingEnter = false;
  input.addEventListener('compositionend', () => setTimeout(() => {
    composing = false;
    autoGrow();
    if (pendingEnter) { pendingEnter = false; submitLine(); }
  }, 0));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.isComposing) { pendingEnter = true; return; }
      submitLine();
    }
    // Shift+Enter and all other keys: default textarea handling
    // (local edit). Special terminal keys come from the keybar.
  });

  // Explicit Send button — immune to the Enter/composition race.
  const sendBtn = $('#mobile-input-send');
  if (sendBtn) {
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      submitLine();
      try { input.focus(); } catch (_) {}
    });
  }

  // Reliable backspace for the compose box, used by the keybar ⌫ key
  // (the soft-keyboard's own delete is flaky on some Android IMEs).
  // Deletes the selection if any, else the char before the caret.
  // Returns true if it acted (box had content), false if empty.
  window.__composeBackspace = function () {
    if (!input.value) return false;
    let s = input.selectionStart, e = input.selectionEnd;
    if (typeof s !== 'number') { s = e = input.value.length; }
    if (s === e) {
      if (s === 0) return false;
      input.value = input.value.slice(0, s - 1) + input.value.slice(s);
      s = s - 1;
    } else {
      input.value = input.value.slice(0, s) + input.value.slice(e);
    }
    // Set the caret for when the box next has focus; don't force
    // focus() here — that would pop the soft keyboard on a plain ⌫ tap.
    try { input.setSelectionRange(s, s); } catch (_) {}
    autoGrow();
    return true;
  };
})();

function composeBackspace() {
  return typeof window.__composeBackspace === 'function' && window.__composeBackspace();
}

// ============================================================================
// Native input routing
// ============================================================================
//
// The APK's WebView is a ClaudeSessionsWebView subclass whose
// onCreateInputConnection wraps the standard WebView IC with
// TerminalInputConnection. That wrapper consults a process-global
// InputRouter to decide whether to route IME / soft-keyboard text
// into a terminal PTY or pass through to the default WebView
// behavior (regular form input typing).
//
// IMPORTANT: with the visible compose box as the input path, the
// native InputConnection routing must stay OFF. If it were active and
// TerminalInputConnection actually got reached on some device, typing
// into the compose box would be intercepted and force-fed to the PTY
// instead of accumulating in the box — breaking compose mode. So we
// always deactivate routing on both plugins. The native WebView /
// InputRouter machinery stays in the tree (harmless; it just delegates
// to the default IC), but it never steals compose-box input now.
function syncNativeInputRoute() {
  if (typeof SshBridge !== 'undefined' && SshBridge.available)
    SshBridge.setActiveTab(null).catch(() => {});
  if (typeof LocalShellBridge !== 'undefined' && LocalShellBridge.available)
    LocalShellBridge.setActiveTab(null).catch(() => {});
}

// Debounced. Keyboard show/hide, layout swaps (keybar/input bar
// appearing), and sidebar drags can fire many resize events in quick
// succession. Forwarding every intermediate size to a remote tmux
// makes it reflow + redraw repeatedly, which is a prime source of the
// "duplicate lines" artifacts. We coalesce to a single fit + resize
// once things settle (~90ms), and only send the resize when the
// dimensions actually changed.
let _refitTimer = null;
const _lastSize = new Map();   // tabId -> "colsxrows"
function refitActiveTerminal() {
  if (_refitTimer) clearTimeout(_refitTimer);
  _refitTimer = setTimeout(doRefit, 90);
}
function doRefit() {
  _refitTimer = null;
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return;
  try {
    tab.fitAddon.fit();
    const { cols, rows } = tab.term;
    if (!cols || !rows) return;
    const key = `${cols}x${rows}`;
    if (_lastSize.get(tab.id) === key) return;   // no real change
    _lastSize.set(tab.id, key);
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
