const { ipcRenderer, clipboard, shell } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
let SearchAddon = null;
try { SearchAddon = require('@xterm/addon-search').SearchAddon; }
catch (e) { console.warn('[search] @xterm/addon-search not installed:', e && e.message); }
let WebglAddon = null;
try { WebglAddon = require('@xterm/addon-webgl').WebglAddon; }
catch (e) { console.warn('[webgl] @xterm/addon-webgl not installed:', e && e.message); }

// Populate the globals the shared file-preview.js module reads. Under
// Electron's nodeIntegration a UMD <script> would attach to
// module.exports instead of window, so we require() the libs and assign
// them ourselves. Each is optional — the module degrades to plain text.
try {
  const m = require('marked');
  window.marked = m.marked || m;
  const dp = require('dompurify');
  window.DOMPurify = dp && dp.sanitize ? dp : (typeof dp === 'function' ? dp(window) : dp);
  window.katex = require('katex');
  window.renderMathInElement = require('katex/dist/contrib/auto-render.js');
} catch (e) {
  console.warn('[preview] render libs unavailable:', e && e.message);
}

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

let sessions = [];
let selectedSessionId = null;

let tabs = [];
let activeTabId = null;
let tabCounter = 0;

// Workspaces (shared session pool; each workspace is a "collection" of session
// ids + a remembered tab layout). See docs at the top of loadWorkspacesFromDisk.
let workspaces = [];
let activeWorkspaceId = null;
// "全部" view: when true, both the sidebar and the tab bar drop the
// workspace filter (side-by-side with every workspace's live tabs). Launching
// a new tab in this mode assigns it to the workspace the user most plausibly
// means (active tab's workspace when reusing its session, else a workspace
// that contains the session) — see workspaceForNewTab.
let viewAll = false;
// While loading remembered tabs on startup / workspace switch, suppress the
// per-launch snapshot save (we'd be overwriting the snapshot with itself).
let suspendSnapshot = false;

let editingId = null;

// ============================================================================
// Utilities
// ============================================================================

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// A real RFC-4122 uuid for claude's --session-id (which validates the format).
// crypto.randomUUID always exists under Electron's nodeIntegration; the manual
// fallback just guarantees launch never throws on this.
function genUuid() {
  try { return require('crypto').randomUUID(); }
  catch (_) {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

function notify(message, type = 'info', ms = 3000) {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// One loud in-app warning per run when a terminal lands on the slow DOM
// renderer. Console output alone isn't enough: the window has no menu, so
// without the F12 handler (main.js) users can never see the [webgl] logs.
let degradedRendererNotified = false;
async function reportDegradedRenderer(reason) {
  console.warn('[webgl] using DOM renderer (typing/scrolling will feel laggy):', reason);
  if (degradedRendererNotified) return;
  degradedRendererNotified = true;
  try {
    const gpu = await ipcRenderer.invoke('gpu-status');
    console.warn('[gpu] feature status:', JSON.stringify(gpu, null, 2));
  } catch (_) {}
  notify('WebGL 不可用，终端已回落到慢速 DOM 渲染（输入/滚动会卡）。按 F12 看 [gpu] 诊断', 'error', 12000);
}

// Event-loop lag monitor: if the renderer main thread is saturated (e.g. many
// background terminals parsing heavy output), typing and scrolling jank even
// with a healthy GPU renderer. Sustained >200ms drift is the tell — check the
// F12 console for these when diagnosing "everything feels sluggish".
(function monitorEventLoopLag() {
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const lag = now - last - 1000;
    last = now;
    if (lag > 200) {
      console.warn(`[perf] renderer event-loop lag ${Math.round(lag)}ms — main thread saturated`);
    }
  }, 1000);
})();

// window.prompt() is disabled in Electron (returns null synchronously), so
// anywhere we need a one-line text answer we use this in-app modal instead.
// Resolves to the entered string, or null if the user cancels.
function inAppPrompt(title, defaultValue = '', { placeholder = '', okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'prompt-overlay';
    overlay.innerHTML = `
      <div id="prompt-box">
        <div class="editor-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="prompt-x" title="Cancel (Esc)">&times;</button>
        </div>
        <div class="field" style="padding:14px;">
          <input type="text" class="prompt-input" />
        </div>
        <div class="editor-actions" style="padding:0 14px 14px;">
          <button type="button" class="prompt-cancel">Cancel</button>
          <button type="button" class="prompt-ok">${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('.prompt-input');
    input.value = defaultValue || '';
    if (placeholder) input.placeholder = placeholder;
    overlay.querySelector('.prompt-ok').classList.add('primary-btn');

    let done = false;
    const close = (val) => {
      if (done) return;
      done = true;
      overlay.remove();
      resolve(val);
    };
    overlay.querySelector('.prompt-ok').addEventListener('click', () => close(input.value));
    overlay.querySelector('.prompt-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('.prompt-x').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });

    input.focus();
    input.select();
  });
}

function bracketedPaste(tabId, text) {
  if (!text) return;
  const wrapped = `\x1b[200~${text}\x1b[201~`;
  ipcRenderer.send('terminal-input', tabId, wrapped);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sessionInstanceCount(sessionId) {
  return tabs.filter((t) => t.sessionId === sessionId).length;
}

// Smallest instance number (1-based) not taken by a live tab of this session.
// Count-based numbering (`count + 1`) hands out duplicate "#2"s once tabs get
// closed out of order or only part of the pool is restored after a restart.
function nextInstanceNumber(sessionId) {
  const used = new Set(
    tabs.filter((t) => t.sessionId === sessionId).map((t) => t.instanceNum || 1)
  );
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

const LS_LAST_LAUNCHED = 'claude-sessions.lastLaunchedId';
const LS_VIEW_ALL = 'claude-sessions.viewAll';
const LS_COLLAPSED_GROUPS = 'claude-sessions.collapsedGroups';

// Set of sessionIds whose tab-group is currently collapsed in the tab bar.
// Same session across workspaces shares the collapse state (only one workspace
// is visible at a time anyway, so this is fine).
const collapsedGroups = new Set(loadCollapsedGroups());
// Per-group, the last tab within the group that the user focused. When the
// group is collapsed and the user clicks the header, we activate this one.
const lastActiveInGroup = new Map();

function loadCollapsedGroups() {
  try {
    const raw = localStorage.getItem(LS_COLLAPSED_GROUPS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}
function saveCollapsedGroups() {
  try {
    localStorage.setItem(LS_COLLAPSED_GROUPS, JSON.stringify([...collapsedGroups]));
  } catch (_) {}
}

function shortDir(dir) {
  if (!dir) return '';
  const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/');
  return parts[parts.length - 1] || norm;
}

function pickDefaultSessionForNewTab() {
  const active = tabs.find((t) => t.id === activeTabId);
  if (active && sessions.find((s) => s.id === active.sessionId)) return active.sessionId;
  try {
    const last = localStorage.getItem(LS_LAST_LAUNCHED);
    if (last && sessions.find((s) => s.id === last)) return last;
  } catch (_) {}
  return sessions[0] ? sessions[0].id : null;
}

// ============================================================================
// Session persistence
// ============================================================================

async function loadSessionsFromDisk() {
  try {
    sessions = (await ipcRenderer.invoke('load-sessions')) || [];
  } catch (err) {
    console.error(err);
    sessions = [];
  }
  renderSessionList();
}

async function persistSessions() {
  try {
    const res = await ipcRenderer.invoke('save-sessions', sessions);
    if (!res || !res.ok) notify(`Save failed: ${res && res.error}`, 'error');
  } catch (err) {
    notify(`Save failed: ${err.message}`, 'error');
  }
}

// ============================================================================
// Workspaces
// ============================================================================
//
// Sessions are a shared pool: each workspace holds a list of session_ids it
// "shows" in the sidebar; the same session can appear in multiple workspaces.
// Tabs are workspace-scoped (a tab created in workspace X only shows up in
// X's tab bar). Switching workspaces hides the other workspace's tab DOM but
// leaves the PTY alive in the background. `remembered_tabs` is a snapshot of
// what to relaunch when the app opens this workspace on next startup — for
// tmux-persistent sessions the relaunch reattaches to the running claude.

async function loadWorkspacesFromDisk() {
  try {
    const data = await ipcRenderer.invoke('load-workspaces');
    workspaces = (data && Array.isArray(data.workspaces)) ? data.workspaces : [];
    activeWorkspaceId = (data && data.active_workspace_id) || null;
  } catch (err) {
    console.error('[workspaces] load failed:', err);
    workspaces = [];
    activeWorkspaceId = null;
  }
  ensureDefaultWorkspace();
}

// If there are no workspaces yet (fresh install / migrating from pre-workspace
// build), create one that shows every existing session, so the sidebar isn't
// empty on first launch after the upgrade.
function ensureDefaultWorkspace() {
  if (workspaces.length === 0) {
    const ws = {
      id: 'ws-' + genId(),
      name: '默认',
      session_ids: sessions.map((s) => s.id),
      remembered_tabs: [],
    };
    workspaces.push(ws);
    activeWorkspaceId = ws.id;
    persistWorkspaces();
    return;
  }
  if (!activeWorkspaceId || !workspaces.find((w) => w.id === activeWorkspaceId)) {
    activeWorkspaceId = workspaces[0].id;
  }
}

async function persistWorkspaces() {
  try {
    const res = await ipcRenderer.invoke('save-workspaces', {
      workspaces,
      active_workspace_id: activeWorkspaceId,
    });
    if (!res || !res.ok) notify(`Workspace save failed: ${res && res.error}`, 'error');
  } catch (err) {
    notify(`Workspace save failed: ${err.message}`, 'error');
  }
}

function getActiveWorkspace() {
  return workspaces.find((w) => w.id === activeWorkspaceId) || null;
}

function sessionInActiveWorkspace(sessionId) {
  const ws = getActiveWorkspace();
  if (!ws) return true;
  return (ws.session_ids || []).includes(sessionId);
}

// Which workspace a freshly-launched tab should belong to. Outside "全部"
// that's simply the active workspace. Inside "全部" the tab bar mixes every
// workspace, so activeWorkspaceId (= last-selected) is often NOT what the
// user is looking at — prefer, in order: the active tab's workspace when the
// new tab reuses its session (the tab-bar "+" case), the active workspace if
// it contains the session, else the first workspace that contains it.
function workspaceForNewTab(sessionId) {
  if (!viewAll) return activeWorkspaceId;
  const active = tabs.find((t) => t.id === activeTabId);
  if (active && active.sessionId === sessionId
      && workspaces.some((w) => w.id === active.workspaceId)) {
    return active.workspaceId;
  }
  const ws = getActiveWorkspace();
  if (ws && (ws.session_ids || []).includes(sessionId)) return activeWorkspaceId;
  const owner = workspaces.find((w) => (w.session_ids || []).includes(sessionId));
  return owner ? owner.id : activeWorkspaceId;
}

// Save a snapshot of currently-alive tabs in workspace `wsId` so a later
// switch/restart can rehydrate them. Non-persistent tabs will re-spawn fresh;
// persistent (tmux) tabs will reattach to the existing tmux session.
function snapshotWorkspaceTabs(wsId) {
  if (suspendSnapshot) return;
  const ws = workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  ws.remembered_tabs = tabs
    .filter((t) => t.workspaceId === wsId && t.alive)
    .map((t) => {
      const snap = { sessionId: t.sessionId };
      if (t.workingDirOverride) snap.workingDirOverride = t.workingDirOverride;
      if (t.claudeSessionId) snap.claudeSessionId = t.claudeSessionId;
      return snap;
    });
  persistWorkspaces();
}

function updateWorkspaceButton() {
  const ws = getActiveWorkspace();
  const el = $('#ws-current-name');
  if (!el) return;
  if (viewAll) {
    el.textContent = `🌐 全部 · ${ws ? ws.name : ''}`;
  } else {
    el.textContent = ws ? ws.name : '默认';
  }
}

// ============================================================================
// Session list rendering
// ============================================================================

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding: 16px; text-align: center; color: var(--fg-dim); font-size: 12px;';
    empty.textContent = 'No sessions. Click "+ New" to create one.';
    list.appendChild(empty);
    return;
  }

  const ws = getActiveWorkspace();
  const memberIds = new Set((ws && ws.session_ids) || []);
  const visible = viewAll
    ? sessions
    : sessions.filter((s) => memberIds.has(s.id));

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding: 16px; text-align: center; color: var(--fg-dim); font-size: 12px; line-height:1.6;';
    empty.innerHTML = '本工作区还没有会话。<br/>点顶部工作区按钮 → "全部"<br/>可以看所有会话并选择加入。';
    list.appendChild(empty);
    return;
  }

  for (const s of visible) {
    const inWs = memberIds.has(s.id);
    const foreign = viewAll && !inWs;

    const card = document.createElement('div');
    card.className = 'session-card' + (foreign ? ' foreign' : '');
    if (s.id === selectedSessionId) card.classList.add('selected');
    card.dataset.id = s.id;
    card.draggable = true;

    const count = sessionInstanceCount(s.id);
    // Which other workspaces this session lives in — shown as small footer
    // text only in "all" scope, so users can see cross-workspace membership.
    const memberOf = workspaces
      .filter((w) => (w.session_ids || []).includes(s.id))
      .map((w) => w.name);
    const badgesHtml = (viewAll && memberOf.length)
      ? `<span class="ws-badges" title="属于工作区: ${escapeHtml(memberOf.join(', '))}">📁 ${escapeHtml(memberOf.join(' · '))}</span>`
      : '';

    card.innerHTML = `
      <div class="session-card-top">
        <span class="drag-handle" title="Drag to reorder">&#x2630;</span>
        <span class="session-name">${escapeHtml(s.name)}</span>
        <span class="badge ${s.type === 'ssh' ? 'ssh' : 'local'}">${s.type === 'ssh' ? 'SSH' : 'WIN'}</span>
        ${count > 0 ? `<span class="badge count">${count}</span>` : ''}
        ${foreign ? `<button class="ws-add-btn" data-action="add-to-ws" title="加入当前工作区">+ 加入</button>` : ''}
      </div>
      ${s.description ? `<div class="session-desc">${escapeHtml(s.description)}</div>` : ''}
      ${badgesHtml ? `<div class="session-desc" style="padding-top:2px;">${badgesHtml}</div>` : ''}
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
        else if (action === 'add-to-ws') addSessionToActiveWorkspace(s.id);
      });
    });

    attachSessionDragHandlers(card, s.id);
    list.appendChild(card);
  }
}

// ============================================================================
// Session card drag-and-drop reordering
// ============================================================================

let draggingSessionId = null;

function attachSessionDragHandlers(el, sessionId) {
  el.addEventListener('dragstart', (e) => {
    // Don't start drag from the action buttons
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
  const ws = getActiveWorkspace();
  const items = [
    { label: 'Launch', action: () => launchSession(session.id) },
    { label: 'Edit', action: () => openEditor(session.id) },
    { label: 'Clone', action: () => cloneSession(session.id) },
    { sep: true },
    ws
      ? { label: `从工作区“${ws.name}”移除`, action: () => removeSessionFromActiveWorkspace(session.id) }
      : null,
    { label: '加入其他工作区…', action: () => openAddToWorkspaceMenu(session.id, x, y) },
    { sep: true },
    { label: 'Delete', danger: true, action: () => deleteSession(session.id) },
  ].filter(Boolean);
  for (const item of items) {
    if (item.sep) {
      const s = document.createElement('div');
      s.className = 'menu-sep';
      menu.appendChild(s);
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

document.addEventListener('click', () => {
  $('#context-menu').classList.add('hidden');
});

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
    persistent: false, tmux_name: '', socks_via_ssh: '', socks_port: '',
  };

  for (const key of ['name', 'ssh_host', 'port_forwards', 'working_dir', 'pre_command', 'claude_cmd', 'claude_args', 'description', 'tmux_name', 'socks_via_ssh', 'socks_port']) {
    const input = form.elements[key];
    if (input) input.value = values[key] || '';
  }
  if (form.elements['persistent']) {
    form.elements['persistent'].checked = !!values.persistent;
  }
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
  const type = form.querySelector('input[name="type"]:checked');
  const t = type && type.value;
  document.querySelectorAll('.ssh-only').forEach((el) => el.classList.toggle('hidden', t !== 'ssh'));
  document.querySelectorAll('.local-only').forEach((el) => el.classList.toggle('hidden', t !== 'local'));
  document.querySelectorAll('.not-web').forEach((el) => el.classList.toggle('hidden', t === 'web'));
}

function saveEditor(e) {
  e && e.preventDefault();
  const form = $('#editor-form');
  const data = new FormData(form);
  const name = (data.get('name') || '').toString().trim();
  if (!name) {
    notify('Name is required', 'error');
    return;
  }
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
    tmux_name: (data.get('tmux_name') || '').toString().trim(),
    socks_via_ssh: (data.get('socks_via_ssh') || '').toString().trim(),
    socks_port: (data.get('socks_port') || '').toString().trim(),
  };

  if (payload.type === 'ssh' && !payload.ssh_host) {
    notify('SSH host is required for SSH sessions', 'error');
    return;
  }

  if (editingId) {
    const idx = sessions.findIndex((s) => s.id === editingId);
    if (idx >= 0) sessions[idx] = { ...sessions[idx], ...payload };
  } else {
    const newSession = { id: genId(), ...payload };
    sessions.push(newSession);
    selectedSessionId = newSession.id;
    const ws = getActiveWorkspace();
    if (ws) {
      ws.session_ids = [...(ws.session_ids || []), newSession.id];
      persistWorkspaces();
    }
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
  const ws = getActiveWorkspace();
  if (ws) {
    ws.session_ids = [...(ws.session_ids || []), copy.id];
    persistWorkspaces();
  }
  persistSessions();
  renderSessionList();
}

function deleteSession(sessionId) {
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  if (!confirm(`Delete session "${s.name}"?`)) return;
  sessions = sessions.filter((x) => x.id !== sessionId);
  if (selectedSessionId === sessionId) selectedSessionId = null;
  // Also purge from every workspace's session_ids and remembered_tabs.
  let touched = false;
  for (const ws of workspaces) {
    const before = (ws.session_ids || []).length;
    ws.session_ids = (ws.session_ids || []).filter((id) => id !== sessionId);
    if (ws.session_ids.length !== before) touched = true;
    const beforeR = (ws.remembered_tabs || []).length;
    ws.remembered_tabs = (ws.remembered_tabs || []).filter((r) => r.sessionId !== sessionId);
    if (ws.remembered_tabs.length !== beforeR) touched = true;
  }
  if (touched) persistWorkspaces();
  persistSessions();
  renderSessionList();
}

// ============================================================================
// Terminal / Tab management
// ============================================================================

function launchSession(sessionId, opts) {
  const baseSession = sessions.find((s) => s.id === sessionId);
  if (!baseSession) return;

  const overrideDir = opts && opts.workingDirOverride ? String(opts.workingDirOverride).trim() : '';
  const session = overrideDir
    ? { ...baseSession, working_dir: overrideDir }
    : baseSession;

  // Own a stable claude session id per tab so the conversation can be resumed
  // after an app restart / reconnect. Reused from the remembered snapshot on
  // restore (resume=true), freshly minted on a normal launch (resume=false).
  const claudeSessionId = (opts && opts.claudeSessionId) || genUuid();
  const resume = !!(opts && opts.resume);

  const tabId = `tab-${++tabCounter}`;
  // Restore passes the target workspace explicitly (the one being rehydrated);
  // interactive launches derive it from the current view.
  const wsId = (opts && opts.workspaceId) || workspaceForNewTab(sessionId);
  const instanceNum = nextInstanceNumber(sessionId);
  const baseName = instanceNum === 1 ? baseSession.name : `${baseSession.name} #${instanceNum}`;
  const displayName = overrideDir ? `${baseName} · ${shortDir(overrideDir)}` : baseName;

  try { localStorage.setItem(LS_LAST_LAUNCHED, sessionId); } catch (_) {}

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
  term.loadAddon(new WebLinksAddon((event, uri) => {
    // Open links in the system default browser, not a new Electron window
    shell.openExternal(uri).catch((err) => console.error('[link] openExternal failed:', err));
  }));
  const unicodeAddon = new Unicode11Addon();
  term.loadAddon(unicodeAddon);
  term.unicode.activeVersion = '11';
  let searchAddon = null;
  if (SearchAddon) {
    try {
      searchAddon = new SearchAddon({
        decorations: {
          matchBackground: 'rgba(249, 226, 175, 0.35)',
          activeMatchBackground: '#fab387',
          matchOverviewRuler: '#f9e2af',
          activeMatchColorOverviewRuler: '#fab387',
        },
      });
      term.loadAddon(searchAddon);
    } catch (_) { searchAddon = null; }
  }

  term.open(container);

  // WebGL renderer — must be loaded AFTER term.open() so the canvas
  // context is available. Falls back silently to the default DOM
  // renderer if WebGL is unavailable (rare; e.g. headless / sw rendering).
  if (WebglAddon) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch (_) {} });
      term.loadAddon(webgl);
      console.info(`[webgl] renderer active for ${tabId}`);
    } catch (e) {
      reportDegradedRenderer(e && e.message);
    }
  } else {
    reportDegradedRenderer('addon not installed');
  }

  fitAddon.fit();

  const tab = {
    id: tabId,
    sessionId,
    sessionName: displayName,
    instanceNum,
    workspaceId: wsId,
    workingDirOverride: overrideDir || null,
    claudeSessionId,
    term,
    fitAddon,
    searchAddon,
    container,
    alive: true,
  };
  tabs.push(tab);

  term.onData((data) => {
    if (tab.alive) ipcRenderer.send('terminal-input', tabId, data);
  });

  term.onResize(({ cols, rows }) => {
    if (tab.alive) ipcRenderer.send('terminal-resize', tabId, cols, rows);
  });

  attachKeyboardHandlers(tab);

  const { cols, rows } = term;
  // Spread into a fresh object so the runtime-only fields never leak back into
  // the persisted session config (session may be baseSession by reference).
  const launchSessionObj = { ...session, _claude_session_id: claudeSessionId, _resume: resume };
  ipcRenderer.invoke('create-terminal', tabId, launchSessionObj, cols, rows).then((res) => {
    if (!res || !res.ok) {
      notify(`Failed to start: ${res && res.error}`, 'error');
    }
  });

  renderTabs();
  switchToTab(tabId);
  renderSessionList();
  snapshotWorkspaceTabs(wsId);
}

function switchToTab(tabId) {
  if (window.TerminalSearch) window.TerminalSearch.close();
  activeTabId = tabId;
  for (const t of tabs) {
    t.container.classList.toggle('active', t.id === tabId);
  }
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) {
    lastActiveInGroup.set(tab.sessionId, tabId);
    try {
      tab.fitAddon.fit();
      const { cols, rows } = tab.term;
      if (tab.alive) ipcRenderer.send('terminal-resize', tabId, cols, rows);
      tab.term.focus();
    } catch (_) {}
  }
  $('#welcome').classList.toggle('hidden', tabsInActiveWorkspace().length > 0);
  renderTabs();
}

function closeTab(tabId) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  if (activeTabId === tabId && window.TerminalSearch) window.TerminalSearch.close();
  const tab = tabs[idx];
  const wsId = tab.workspaceId;
  if (tab.alive) ipcRenderer.invoke('kill-terminal', tabId);
  try { tab.term.dispose(); } catch (_) {}
  try { tab.container.remove(); } catch (_) {}
  tabs.splice(idx, 1);

  if (activeTabId === tabId) {
    // Only look for the "next" tab within the same workspace.
    const wsTabs = tabs.filter((t) => t.workspaceId === wsId);
    const next = wsTabs[0] || null;
    activeTabId = next ? next.id : null;
    if (next) switchToTab(next.id);
  }
  $('#welcome').classList.toggle('hidden', tabsInActiveWorkspace().length > 0);
  renderTabs();
  renderSessionList();
  snapshotWorkspaceTabs(wsId);
}

function tabsInActiveWorkspace() {
  // In "全部" view the tab bar shows every tab regardless of workspace.
  if (viewAll) return tabs.slice();
  return tabs.filter((t) => t.workspaceId === activeWorkspaceId);
}

function renderTabs() {
  updateRunningCount();
  // Keep the panel fresh if it's currently open.
  const panel = document.getElementById('running-panel');
  if (panel && !panel.classList.contains('hidden')) renderRunningPanel();

  const el = $('#tabs');
  el.innerHTML = '';

  // Group active-workspace tabs (or all tabs in 全部 view) by sessionId.
  // Group order = order of the first tab of that session in the `tabs`
  // array, so drag-reorders still control how groups line up.
  const groupsBySession = new Map();
  for (const t of tabs) {
    if (!viewAll && t.workspaceId !== activeWorkspaceId) continue;
    if (!groupsBySession.has(t.sessionId)) groupsBySession.set(t.sessionId, []);
    groupsBySession.get(t.sessionId).push(t);
  }

  for (const [sessionId, groupTabs] of groupsBySession) {
    const session = sessions.find((s) => s.id === sessionId);
    const groupName = session ? session.name : (groupTabs[0].sessionName || 'session');
    const isSingle = groupTabs.length === 1;
    const collapsed = !isSingle && collapsedGroups.has(sessionId);
    const hasActive = groupTabs.some((t) => t.id === activeTabId);

    const groupEl = document.createElement('div');
    groupEl.className = 'tab-group'
      + (collapsed ? ' collapsed' : '')
      + (hasActive ? ' has-active' : '');
    groupEl.dataset.sessionId = sessionId;

    // Header only shown for real clusters (>= 2 tabs).
    if (!isSingle) {
      const header = document.createElement('div');
      header.className = 'tab-group-header';
      header.title = collapsed
        ? `${groupName} — 点击展开 · 组内 ${groupTabs.length} 个标签`
        : `${groupName} — 点击折叠`;
      header.innerHTML = `
        <span class="tg-caret">${collapsed ? '&#x25B8;' : '&#x25BE;'}</span>
        <span class="tg-name">${escapeHtml(groupName)}</span>
        <span class="tg-count">(${groupTabs.length})</span>
      `;
      header.addEventListener('click', () => {
        if (collapsedGroups.has(sessionId)) {
          collapsedGroups.delete(sessionId);
        } else {
          collapsedGroups.add(sessionId);
          // On collapse, keep this group's "spotlight" tab active so the
          // header stays highlighted. Prefer the last-focused tab in the
          // group; else the currently-active one if it belongs; else the
          // first alive one.
          const preferId = lastActiveInGroup.get(sessionId);
          const preferred = groupTabs.find((t) => t.id === preferId)
            || groupTabs.find((t) => t.id === activeTabId)
            || groupTabs.find((t) => t.alive)
            || groupTabs[0];
          if (preferred) switchToTab(preferred.id);
        }
        saveCollapsedGroups();
        renderTabs();
      });
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showGroupContextMenu(e.clientX, e.clientY, sessionId, groupTabs);
      });
      groupEl.appendChild(header);
    }

    for (const t of groupTabs) {
      const div = document.createElement('div');
      div.className = 'tab' + (t.id === activeTabId ? ' active' : '') + (t.alive ? '' : ' dead');
      div.draggable = true;
      div.dataset.tabId = t.id;
      // Inside a group we drop the redundant session-name prefix; #2 / #3
      // (etc.) makes the individual tab meaningful when the group header
      // already carries the session name.
      const label = (isSingle || !session)
        ? t.sessionName
        : deriveTabShortLabel(t, session.name);
      div.innerHTML = `
        <span class="tab-status"></span>
        <span class="tab-name">${escapeHtml(label)}</span>
        <span class="tab-close" title="Close (Ctrl+W)">&times;</span>
      `;
      div.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          closeTab(t.id);
        } else {
          switchToTab(t.id);
        }
      });
      div.addEventListener('auxclick', (e) => {
        if (e.button === 1) closeTab(t.id);
      });
      attachTabDragHandlers(div, t.id);
      groupEl.appendChild(div);
    }

    el.appendChild(groupEl);
  }
}

// Strip the "SessionName" prefix from a tab's display name inside a group,
// leaving just the "#2" suffix or "· workingDir" hint. Falls back to the
// full name if no prefix is found.
function deriveTabShortLabel(tab, sessionName) {
  const full = tab.sessionName || sessionName;
  if (full.startsWith(sessionName)) {
    const rest = full.slice(sessionName.length).replace(/^\s+/, '');
    return rest || '#1';
  }
  return full;
}

function showGroupContextMenu(x, y, sessionId, groupTabs) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  const isCollapsed = collapsedGroups.has(sessionId);
  const items = [
    {
      label: isCollapsed ? '展开这一组' : '折叠这一组',
      action: () => {
        if (isCollapsed) collapsedGroups.delete(sessionId);
        else collapsedGroups.add(sessionId);
        saveCollapsedGroups();
        renderTabs();
      },
    },
    {
      label: `+ 新建同类标签 (${groupTabs.length + 1})`,
      action: () => launchSession(sessionId),
    },
    { sep: true },
    {
      label: `关闭这一组的全部 ${groupTabs.length} 个标签`,
      danger: true,
      action: () => {
        if (!confirm(`关闭这一组下的 ${groupTabs.length} 个标签?`)) return;
        for (const t of [...groupTabs]) closeTab(t.id);
      },
    },
  ];
  for (const item of items) {
    if (item.sep) {
      const s = document.createElement('div'); s.className = 'menu-sep';
      menu.appendChild(s); continue;
    }
    const mi = document.createElement('div');
    mi.className = 'menu-item' + (item.danger ? ' danger' : '');
    mi.textContent = item.label;
    mi.addEventListener('click', () => { menu.classList.add('hidden'); item.action(); });
    menu.appendChild(mi);
  }
  menu.classList.remove('hidden');
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - 200) + 'px';
  menu.style.top = Math.min(y, vh - 180) + 'px';
}

// ============================================================================
// Tab drag-and-drop reordering
// ============================================================================

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

  el.addEventListener('dragleave', () => {
    el.classList.remove('drop-before', 'drop-after');
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const fromId = draggingTabId;
    const toId = tabId;
    el.classList.remove('drop-before', 'drop-after');
    if (!fromId || fromId === toId) return;

    const rect = el.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;

    const fromIdx = tabs.findIndex((t) => t.id === fromId);
    const toIdxRaw = tabs.findIndex((t) => t.id === toId);
    if (fromIdx < 0 || toIdxRaw < 0) return;

    const [moved] = tabs.splice(fromIdx, 1);
    let toIdx = tabs.findIndex((t) => t.id === toId);
    if (!before) toIdx += 1;
    tabs.splice(toIdx, 0, moved);

    renderTabs();
  });
}

// ============================================================================
// Keyboard handlers on terminal containers
// ============================================================================

function attachKeyboardHandlers(tab) {
  const { term, container, id: tabId } = tab;

  container.addEventListener('keydown', (e) => {
    // Ctrl+Shift+C : force copy
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      e.preventDefault();
      e.stopPropagation();
      const sel = term.getSelection();
      if (sel) {
        clipboard.writeText(sel);
        term.clearSelection();
        notify('Copied', 'success');
      }
      return;
    }

    // Ctrl+Shift+V : paste image
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      e.stopPropagation();
      pasteImageToTab(tabId);
      return;
    }

    // Ctrl+C (no shift): copy if selection, else fall through to SIGINT
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyC') {
      if (term.hasSelection()) {
        e.preventDefault();
        e.stopPropagation();
        clipboard.writeText(term.getSelection());
        term.clearSelection();
        return;
      }
      // no selection -> let xterm handle (produces \x03)
    }

    // Ctrl+V : paste text (bracketed)
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      e.stopPropagation();
      const text = clipboard.readText();
      if (text) bracketedPaste(tabId, text);
      return;
    }

    // Ctrl+W : close tab
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyW') {
      e.preventDefault();
      e.stopPropagation();
      closeTab(tabId);
      return;
    }
  }, true);

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showTerminalContextMenu(e.clientX, e.clientY, tabId);
  });
}

// Terminal right-click menu: copy / preview-selected-path / paste.
// Preview reads the file (local fs, or over ssh for SSH sessions) via
// the main process and renders it with the shared FilePreview module.
function showTerminalContextMenu(x, y, tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const term = tab.term;
  const menu = $('#context-menu');
  menu.innerHTML = '';
  const items = [];
  if (term.hasSelection()) {
    const sel = term.getSelection();
    items.push({ label: 'Copy', action: () => {
      clipboard.writeText(sel); term.clearSelection(); notify('Copied', 'success');
    }});
    items.push({ label: '预览文件', action: () => openPreviewForSelection(tab, sel) });
  }
  if (window.TerminalSearch && tab.searchAddon) {
    const q = term.hasSelection()
      ? term.getSelection().replace(/\r?\n/g, ' ').trim().slice(0, 200) : '';
    items.push({ label: '查找 (Ctrl+F)', action: () =>
      window.TerminalSearch.open({ term, addon: tab.searchAddon, query: q }) });
  }
  items.push({ label: 'Paste', action: () => {
    const text = clipboard.readText(); if (text) bracketedPaste(tabId, text);
  }});
  for (const item of items) {
    const mi = document.createElement('div');
    mi.className = 'menu-item';
    mi.textContent = item.label;
    mi.addEventListener('click', () => { menu.classList.add('hidden'); item.action(); });
    menu.appendChild(mi);
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - 160) + 'px';
  menu.style.top = Math.min(y, vh - 140) + 'px';
  menu.classList.remove('hidden');
}

function openPreviewForSelection(tab, sel) {
  if (!window.FilePreview) { notify('Preview module not loaded', 'error'); return; }
  const session = sessions.find((s) => s.id === tab.sessionId);
  const sshHost = session && session.type === 'ssh' ? session.ssh_host : null;
  window.FilePreview.open({
    path: sel,
    read: async (p, max) => {
      const res = await ipcRenderer.invoke('read-file', p, max, sshHost);
      if (res && res.error) throw new Error(res.error);
      return res;
    },
    clip: (t) => clipboard.writeText(t),
    notify,
    openExternal: (u) => shell.openExternal(u).catch(() => {}),
  });
}

// ============================================================================
// Image paste
// ============================================================================

async function pasteImageToTab(tabId) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) return;

  const localPath = await ipcRenderer.invoke('paste-clipboard-image');
  if (!localPath) {
    notify('No image in clipboard', 'error');
    return;
  }

  if (session.type === 'local') {
    bracketedPaste(tabId, localPath);
    notify('Pasted image path', 'success');
    return;
  }

  // SSH: upload via SCP
  notify('Uploading image...', 'info');
  const res = await ipcRenderer.invoke('scp-upload', session.ssh_host, localPath);
  if (res && res.ok) {
    bracketedPaste(tabId, res.remotePath);
    notify('Uploaded', 'success');
  } else {
    notify(`Upload failed: ${res && res.error}`, 'error');
  }
}

async function pasteImageToActiveTab() {
  if (!activeTabId) {
    notify('No active terminal', 'error');
    return;
  }
  await pasteImageToTab(activeTabId);
}

// ============================================================================
// IPC events from main
// ============================================================================

ipcRenderer.on('terminal-data', (_e, tabId, data) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) tab.term.write(data);
});

// Install the "parked" key handler on an exited tab: R (re)tries the
// reconnect, any other key closes. Re-armable, so a failed reconnect can leave
// the tab parked for another R / wake / online-event retry.
function armParkedKeys(tab) {
  if (tab._exitKeyDisposable) { try { tab._exitKeyDisposable.dispose(); } catch (_) {} }
  tab._exitKeyDisposable = tab.term.onKey(({ domEvent }) => {
    if (domEvent && (domEvent.key === 'r' || domEvent.key === 'R')) {
      doReconnect(tab, { auto: false });
    } else {
      try { tab._exitKeyDisposable.dispose(); } catch (_) {}
      tab._exitKeyDisposable = null;
      closeTab(tab.id);
    }
  });
}

// Reconnect a parked tab. Shared by the R key and the auto triggers (wake from
// sleep / network back online). On failure the tab stays parked so a later
// event can retry; auto retries stay quiet to avoid spamming the terminal.
function doReconnect(tab, opts) {
  opts = opts || {};
  if (!tab || !tab._parked || tab._reconnecting) return;
  tab._reconnecting = true;
  if (tab._exitKeyDisposable) { try { tab._exitKeyDisposable.dispose(); } catch (_) {} tab._exitKeyDisposable = null; }
  const cols = (tab.term && tab.term.cols) || 120;
  const rows = (tab.term && tab.term.rows) || 30;
  tab.term.write(`\x1b[33m[reconnecting…]\x1b[0m\r\n`);
  ipcRenderer.invoke('reconnect-terminal', tab.id, cols, rows).then((res) => {
    tab._reconnecting = false;
    if (res && res.ok) {
      tab._parked = false;
      // Defer alive=true so this same keypress' onData (xterm may fire it AFTER
      // onKey) sees alive=false and gets dropped — otherwise the literal 'r'
      // slips into the new PTY's input.
      setTimeout(() => {
        tab.alive = true;
        renderTabs();
        renderSessionList();
      }, 0);
    } else {
      if (!opts.auto) {
        const msg = (res && res.error) || 'unknown error';
        tab.term.write(`\r\n\x1b[31m[reconnect failed: ${msg}. Press R to retry, any other key to close.]\x1b[0m\r\n`);
      }
      armParkedKeys(tab);
    }
  });
}

// Fire the auto-reconnect for every currently-parked tab. Bound to the machine
// waking from sleep (main → 'power-resume') and the network coming back.
function reconnectParkedTabs() {
  for (const tab of tabs) {
    if (tab._parked && !tab._reconnecting) doReconnect(tab, { auto: true });
  }
}

ipcRenderer.on('terminal-exit', (_e, tabId, exitCode) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.alive = false;
  tab._parked = true;
  tab.term.write(
    `\r\n\x1b[33m[Session ended with code ${exitCode}. Press R to reconnect, any other key to close.]\x1b[0m\r\n`
  );
  renderTabs();
  renderSessionList();
  armParkedKeys(tab);
});

window.addEventListener('online', reconnectParkedTabs);
ipcRenderer.on('power-resume', reconnectParkedTabs);

// ============================================================================
// Global keyboard + buttons
// ============================================================================

document.addEventListener('keydown', (e) => {
  const modalOpen = !$('#modal-overlay').classList.contains('hidden');

  if (modalOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); return; }
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); saveEditor(); return; }
    return;
  }

  if (e.ctrlKey && !e.shiftKey && e.code === 'KeyN') {
    e.preventDefault();
    openEditor(null);
    return;
  }

  if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
    e.preventDefault();
    pasteImageToActiveTab();
    return;
  }

  if (e.ctrlKey && !e.shiftKey && e.code === 'Tab') {
    e.preventDefault();
    const wsTabs = tabsInActiveWorkspace();
    if (wsTabs.length <= 1) return;
    const idx = wsTabs.findIndex((t) => t.id === activeTabId);
    const next = wsTabs[(idx + 1) % wsTabs.length];
    if (next) switchToTab(next.id);
    return;
  }
});

window.addEventListener('resize', () => {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab) {
    try {
      tab.fitAddon.fit();
      const { cols, rows } = tab.term;
      if (tab.alive) ipcRenderer.send('terminal-resize', tab.id, cols, rows);
    } catch (_) {}
  }
});

// Editor events
$('#btn-new').addEventListener('click', () => openEditor(null));
$('#btn-paste-img').addEventListener('click', () => pasteImageToActiveTab());
$('#editor-close').addEventListener('click', closeEditor);
$('#editor-cancel').addEventListener('click', closeEditor);
$('#editor-form').addEventListener('submit', saveEditor);

// Tab bar "+" — VSCode-style new tab. Reuses the active tab's session
// (or the last-launched / first session if none is active). The caret
// next to it opens a menu to pick a different session or override cwd.
function newTabReuseCurrent() {
  if (!sessions.length) {
    openEditor(null);
    return;
  }
  const id = pickDefaultSessionForNewTab();
  if (id) launchSession(id);
  else notify('No session to reuse — create one first', 'info');
}

function openNewTabMenu(anchor) {
  const menu = $('#context-menu');
  menu.innerHTML = '';

  const active = tabs.find((t) => t.id === activeTabId);
  const reuseId = pickDefaultSessionForNewTab();

  const items = [];
  if (sessions.length === 0) {
    items.push({ label: 'Create your first session…', action: () => openEditor(null) });
  } else {
    items.push({
      label: `New tab (reuse ${active ? 'current' : 'last'})`,
      dim: !reuseId,
      action: () => reuseId && launchSession(reuseId),
    });
    items.push({
      label: 'New tab in custom dir…',
      dim: !reuseId,
      action: () => reuseId && promptCustomDirAndLaunch(reuseId),
    });
    items.push({ sep: true });
    for (const s of sessions) {
      items.push({
        label: s.name + (s.working_dir ? `  ⟶  ${shortDir(s.working_dir)}` : ''),
        action: () => launchSession(s.id),
      });
    }
    items.push({ sep: true });
    items.push({ label: '+ New session…', action: () => openEditor(null) });
  }

  for (const item of items) {
    if (item.sep) {
      const s = document.createElement('div');
      s.className = 'menu-sep';
      menu.appendChild(s);
      continue;
    }
    const mi = document.createElement('div');
    mi.className = 'menu-item' + (item.dim ? ' dim' : '');
    mi.textContent = item.label;
    mi.addEventListener('click', () => {
      menu.classList.add('hidden');
      item.action();
    });
    menu.appendChild(mi);
  }

  // Position above-right of the anchor, flipping if it'd overflow.
  menu.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = rect.right - mw;
  if (left < 4) left = 4;
  let top = rect.bottom + 2;
  if (top + mh > window.innerHeight - 4) top = rect.top - mh - 2;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

async function promptCustomDirAndLaunch(sessionId) {
  const base = sessions.find((s) => s.id === sessionId);
  if (!base) return;
  const sshHost = base.type === 'ssh' ? base.ssh_host : null;
  let dir;
  try {
    // Browsable tree for both local and SSH (lists the remote fs over ssh).
    dir = await browseDirectory(base.working_dir || '', base.name, sshHost);
  } catch (_) {
    // Main process predates the list-dir handler (app not relaunched yet):
    // fall back to a typed-path box so the flow still works.
    dir = await inAppPrompt(
      `Working dir for new "${base.name}" tab${sshHost ? ' (remote path)' : ''}`,
      base.working_dir || '',
      { placeholder: sshHost ? '/home/user/project' : 'D:/path', okLabel: 'Open tab' }
    );
  }
  if (dir == null) return;
  launchSession(sessionId, { workingDirOverride: String(dir).trim() || undefined });
}

// Browsable folder chooser backed by the list-dir IPC. Tap a folder to
// descend, ⬆ for parent, ⌂ for home, or type a path. "Use this folder"
// picks the open directory. Resolves to the chosen abs path, or null on
// cancel. Rejects (so the caller can fall back) if the IPC handler is
// missing — i.e. the main process hasn't been relaunched with this build.
let dirPickerEl = null;

function buildDirPicker() {
  const overlay = document.createElement('div');
  overlay.id = 'dir-picker-overlay';
  overlay.className = 'hidden';
  overlay.innerHTML =
    '<div class="dir-picker">' +
      '<div class="editor-header">' +
        '<span class="dp-title">Choose folder</span>' +
        '<button type="button" class="dp-close" title="Close (Esc)">&times;</button>' +
      '</div>' +
      '<div class="dp-pathrow">' +
        '<button type="button" class="dp-up" title="Parent folder">&#x2B06;</button>' +
        '<input type="text" class="dp-path" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Folder path" />' +
        '<button type="button" class="dp-home" title="Home folder">&#x2302;</button>' +
      '</div>' +
      '<div class="dp-banner hidden"></div>' +
      '<div class="dp-list"></div>' +
      '<div class="editor-actions">' +
        '<button type="button" class="dp-cancel">Cancel</button>' +
        '<button type="button" class="dp-use">Use this folder</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  return overlay;
}

// Remote fs is POSIX; local Windows tolerates forward-slash joins too.
function joinDirPath(base, name) {
  if (!base) return name;
  return base.endsWith('/') || base.endsWith('\\') ? base + name : base + '/' + name;
}

function browseDirectory(startPath, label, sshHost) {
  const overlay = dirPickerEl || (dirPickerEl = buildDirPicker());
  const titleEl = overlay.querySelector('.dp-title');
  const pathInput = overlay.querySelector('.dp-path');
  const listEl = overlay.querySelector('.dp-list');
  const bannerEl = overlay.querySelector('.dp-banner');
  const upBtn = overlay.querySelector('.dp-up');
  const homeBtn = overlay.querySelector('.dp-home');
  const useBtn = overlay.querySelector('.dp-use');
  const cancelBtn = overlay.querySelector('.dp-cancel');
  const closeBtn = overlay.querySelector('.dp-close');

  titleEl.textContent = label ? `Choose folder — ${label}` : 'Choose folder';

  let current = null;   // resolved abs path currently shown
  let parent = null;    // parent of `current`, or null at the fs root
  let firstNav = true;

  return new Promise((resolve, reject) => {
    let settled = false;
    function teardown() {
      document.removeEventListener('keydown', onKey);
      overlay.removeEventListener('mousedown', onOverlayClick);
      pathInput.removeEventListener('keydown', onPathKey);
      upBtn.removeEventListener('click', onUp);
      homeBtn.removeEventListener('click', onHome);
      useBtn.removeEventListener('click', onUse);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      overlay.classList.add('hidden');
    }
    function done(value) {
      if (settled) return;
      settled = true;
      teardown();
      resolve(value);
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      teardown();
      reject(err);
    }

    function showBanner(text) {
      bannerEl.textContent = text || '';
      bannerEl.classList.toggle('hidden', !text);
    }

    async function navigate(p) {
      showBanner('');
      listEl.classList.add('dp-loading');
      let data;
      try {
        data = await ipcRenderer.invoke('list-dir', p == null ? '' : p, sshHost);
      } catch (err) {
        // No handler registered → old main process. Bail so the caller
        // can fall back to a typed-path prompt.
        if (firstNav) return fail(err);
        showBanner(err && err.message ? err.message : 'Cannot read that folder');
        listEl.classList.remove('dp-loading');
        return;
      }
      firstNav = false;
      listEl.classList.remove('dp-loading');
      if (data && data.error) {
        showBanner(data.error);
        if (data.path != null) pathInput.value = data.path;
        return;
      }
      current = data.path;
      parent = data.parent;
      pathInput.value = current;
      upBtn.disabled = !parent;
      renderList(data.dirs || []);
    }

    function renderList(dirs) {
      listEl.innerHTML = '';
      if (!dirs.length) {
        const empty = document.createElement('div');
        empty.className = 'dp-empty';
        empty.textContent = 'No sub-folders here — “Use this folder” to pick it.';
        listEl.appendChild(empty);
        return;
      }
      for (const name of dirs) {
        const row = document.createElement('div');
        row.className = 'dp-row';
        const icon = document.createElement('span'); icon.className = 'dp-icon'; icon.textContent = '📁';
        const nm = document.createElement('span'); nm.className = 'dp-name'; nm.textContent = name;
        const caret = document.createElement('span'); caret.className = 'dp-caret'; caret.textContent = '›';
        row.append(icon, nm, caret);
        row.addEventListener('click', () => navigate(joinDirPath(current, name)));
        listEl.appendChild(row);
      }
    }

    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(null); } }
    function onOverlayClick(e) { if (e.target === overlay) done(null); }
    function onPathKey(e) { if (e.key === 'Enter') { e.preventDefault(); navigate(pathInput.value.trim()); } }
    const onUp = () => { if (parent) navigate(parent); };
    const onHome = () => navigate('');
    const onUse = () => done(current);
    const onCancel = () => done(null);

    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', onOverlayClick);
    pathInput.addEventListener('keydown', onPathKey);
    upBtn.addEventListener('click', onUp);
    homeBtn.addEventListener('click', onHome);
    useBtn.addEventListener('click', onUse);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);

    overlay.classList.remove('hidden');
    navigate(startPath || '');
  });
}

$('#btn-tab-add').addEventListener('click', (e) => {
  e.stopPropagation();
  newTabReuseCurrent();
});
$('#btn-tab-add-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  openNewTabMenu(e.currentTarget);
});
document.querySelectorAll('#editor-form input[name="type"]').forEach((el) => {
  el.addEventListener('change', updateTypeVisibility);
});

// ============================================================================
// Sidebar: resize + collapse (persisted to localStorage)
// ============================================================================

const LS_WIDTH = 'claude-sessions.sidebarWidth';
const LS_COLLAPSED = 'claude-sessions.sidebarCollapsed';
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 260;

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
  // Wait for width transition before refitting
  setTimeout(refitActiveTerminal, 220);
}

function refitActiveTerminal() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return;
  try {
    tab.fitAddon.fit();
    const { cols, rows } = tab.term;
    if (tab.alive) ipcRenderer.send('terminal-resize', tab.id, cols, rows);
  } catch (_) {}
}

// Restore persisted state
try {
  const savedWidth = parseInt(localStorage.getItem(LS_WIDTH), 10);
  if (Number.isFinite(savedWidth)) {
    $('#sidebar').style.width =
      Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, savedWidth)) + 'px';
  } else {
    $('#sidebar').style.width = SIDEBAR_DEFAULT + 'px';
  }
  if (localStorage.getItem(LS_COLLAPSED) === '1') {
    setSidebarCollapsed(true);
  }
} catch (_) {}

// Drag handle
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
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    setSidebarWidth(e.clientX);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    $('#sidebar').classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    refitActiveTerminal();
  });
  // Double-click to reset
  resizer.addEventListener('dblclick', () => setSidebarWidth(SIDEBAR_DEFAULT));
})();

$('#btn-collapse').addEventListener('click', () => setSidebarCollapsed(true));
$('#btn-expand').addEventListener('click', () => setSidebarCollapsed(false));

// Ctrl+F / Cmd+F → terminal search bar (terminal-search.js handles the
// UI; we just supply the active terminal + its SearchAddon).
if (window.TerminalSearch) {
  window.TerminalSearch.installGlobalShortcut(() => {
    const t = tabs.find((x) => x.id === activeTabId);
    return t && t.searchAddon ? { term: t.term, addon: t.searchAddon } : null;
  });
}

// ============================================================================
// Workspace switching + management menu
// ============================================================================

async function switchWorkspace(wsId) {
  // Clicking a real workspace always drops the "全部" filter — user picked a
  // specific target, they want the focused view again.
  if (viewAll) {
    viewAll = false;
    try { localStorage.setItem(LS_VIEW_ALL, '0'); } catch (_) {}
  }
  if (wsId === activeWorkspaceId) {
    updateWorkspaceButton();
    renderSessionList();
    renderTabs();
    return;
  }
  // Snapshot the workspace we're leaving so its tab list survives a restart.
  snapshotWorkspaceTabs(activeWorkspaceId);

  activeWorkspaceId = wsId;
  persistWorkspaces();

  // Close terminal-search bar if open (its state is tied to the previous tab).
  if (window.TerminalSearch) window.TerminalSearch.close();

  // Pick a tab from the new workspace to focus. If there are alive tabs, use
  // the first one; otherwise activeTabId becomes null and welcome shows.
  const wsTabs = tabsInActiveWorkspace();
  activeTabId = wsTabs[0] ? wsTabs[0].id : null;
  for (const t of tabs) {
    t.container.classList.toggle('active', t.id === activeTabId);
  }
  if (activeTabId) {
    const t = tabs.find((x) => x.id === activeTabId);
    try {
      t.fitAddon.fit();
      if (t.alive) ipcRenderer.send('terminal-resize', t.id, t.term.cols, t.term.rows);
      t.term.focus();
    } catch (_) {}
  }
  $('#welcome').classList.toggle('hidden', wsTabs.length > 0);

  updateWorkspaceButton();
  renderTabs();
  renderSessionList();

  // Restore remembered tabs if this workspace has none live yet — this covers
  // both "just reopened the app" and "first switch after startup".
  if (wsTabs.length === 0) restoreRememberedTabs(wsId);
}

async function restoreRememberedTabs(wsId) {
  const ws = workspaces.find((w) => w.id === wsId);
  if (!ws || !Array.isArray(ws.remembered_tabs) || ws.remembered_tabs.length === 0) return;
  suspendSnapshot = true;
  try {
    for (const r of ws.remembered_tabs) {
      if (!r || !r.sessionId) continue;
      if (!sessions.find((s) => s.id === r.sessionId)) continue;
      // Reattach to the same claude conversation (resume) when we remembered
      // its id; older snapshots without one just start fresh. workspaceId is
      // pinned to the workspace being rehydrated — never re-derived from the
      // current view.
      launchSession(r.sessionId, {
        workingDirOverride: r.workingDirOverride || undefined,
        claudeSessionId: r.claudeSessionId || undefined,
        resume: !!r.claudeSessionId,
        workspaceId: wsId,
      });
    }
  } finally {
    suspendSnapshot = false;
  }
}

// In "全部" view the tab bar claims to show every workspace's tabs, so lazily
// restoring only the active workspace (the normal per-switch behavior) leaves
// phantom gaps: remembered tabs of other workspaces simply don't exist until
// you visit each one. Rehydrate every workspace that has no live tabs yet.
async function restoreAllRememberedTabs() {
  for (const w of workspaces) {
    if (tabs.some((t) => t.workspaceId === w.id)) continue;
    await restoreRememberedTabs(w.id);
  }
  // Every launch stole focus, so the last-restored workspace's tab ended up
  // active — hand focus back to a tab of the active workspace.
  const own = tabs.find((t) => t.workspaceId === activeWorkspaceId);
  if (own && activeTabId !== own.id) switchToTab(own.id);
}

async function newWorkspace() {
  const name = await inAppPrompt('新工作区名称', '', { placeholder: '例如: 项目 A' });
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const ws = {
    id: 'ws-' + genId(),
    name: trimmed,
    session_ids: [],
    remembered_tabs: [],
  };
  workspaces.push(ws);
  persistWorkspaces();
  await switchWorkspace(ws.id);
}

async function renameWorkspace(wsId) {
  const ws = workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  const name = await inAppPrompt('重命名工作区', ws.name || '');
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  ws.name = trimmed;
  persistWorkspaces();
  updateWorkspaceButton();
}

function deleteWorkspace(wsId) {
  if (workspaces.length <= 1) { notify('至少要保留一个工作区', 'error'); return; }
  const ws = workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  if (!confirm(`删除工作区 "${ws.name}"?(其中的会话不会被删除,只是从这个工作区里移除)`)) return;
  // Close all tabs belonging to this workspace first.
  const doomed = tabs.filter((t) => t.workspaceId === wsId).map((t) => t.id);
  for (const tid of doomed) closeTab(tid);
  workspaces = workspaces.filter((w) => w.id !== wsId);
  if (activeWorkspaceId === wsId) {
    activeWorkspaceId = workspaces[0].id;
    updateWorkspaceButton();
    renderSessionList();
    renderTabs();
  }
  persistWorkspaces();
}

function removeSessionFromActiveWorkspace(sessionId) {
  const ws = getActiveWorkspace();
  if (!ws) return;
  ws.session_ids = (ws.session_ids || []).filter((id) => id !== sessionId);
  persistWorkspaces();
  renderSessionList();
}

function addSessionToActiveWorkspace(sessionId) {
  const ws = getActiveWorkspace();
  if (!ws) return;
  if ((ws.session_ids || []).includes(sessionId)) return;
  ws.session_ids = [...(ws.session_ids || []), sessionId];
  persistWorkspaces();
  renderSessionList();
  notify(`已加入工作区 "${ws.name}"`, 'success');
}

function setViewAll(on) {
  viewAll = !!on;
  try { localStorage.setItem(LS_VIEW_ALL, viewAll ? '1' : '0'); } catch (_) {}
  updateWorkspaceButton();
  renderSessionList();
  renderTabs();
  $('#welcome').classList.toggle('hidden', tabsInActiveWorkspace().length > 0);
  if (viewAll) restoreAllRememberedTabs();
}

function openWorkspaceMenu(anchor) {
  const menu = $('#context-menu');
  menu.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'menu-header';
  header.textContent = '切换工作区';
  menu.appendChild(header);

  // "全部" pseudo-entry — unfilters both sidebar + tab bar.
  const allRow = document.createElement('div');
  allRow.className = 'menu-item checked' + (viewAll ? '' : ' unchecked');
  allRow.textContent = '🌐 全部(不过滤)';
  allRow.title = '打开后侧栏和标签栏都显示所有工作区的内容';
  allRow.addEventListener('click', () => {
    menu.classList.add('hidden');
    setViewAll(!viewAll);
  });
  menu.appendChild(allRow);

  const sep0 = document.createElement('div'); sep0.className = 'menu-sep'; menu.appendChild(sep0);

  workspaces.forEach((w, idx) => {
    const row = document.createElement('div');
    row.className = 'menu-item ws-row checked' + (w.id === activeWorkspaceId ? '' : ' unchecked');
    const count = (w.session_ids || []).length;
    row.innerHTML = `
      <span class="ws-row-label">${escapeHtml(w.name)}  <span style="color:var(--fg-dim)">(${count})</span></span>
      <span class="ws-row-arrows">
        <button class="ws-arrow" data-dir="up" title="上移" ${idx === 0 ? 'disabled' : ''}>&#x25B4;</button>
        <button class="ws-arrow" data-dir="down" title="下移" ${idx === workspaces.length - 1 ? 'disabled' : ''}>&#x25BE;</button>
      </span>
    `;
    row.addEventListener('click', (e) => {
      // Don't switch when the click was on one of the reorder arrows.
      if (e.target.closest('.ws-arrow')) return;
      menu.classList.add('hidden');
      switchWorkspace(w.id);
    });
    row.querySelectorAll('.ws-arrow').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (btn.disabled) return;
        moveWorkspace(w.id, btn.dataset.dir === 'up' ? -1 : 1);
        openWorkspaceMenu(anchor);   // re-render menu in place
      });
    });
    menu.appendChild(row);
  });

  const sep = document.createElement('div'); sep.className = 'menu-sep'; menu.appendChild(sep);

  const items = [
    { label: '+ 新建工作区…', action: newWorkspace },
    { label: '重命名当前工作区…', action: () => renameWorkspace(activeWorkspaceId) },
    { label: '删除当前工作区', danger: true, action: () => deleteWorkspace(activeWorkspaceId) },
  ];
  for (const item of items) {
    const mi = document.createElement('div');
    mi.className = 'menu-item' + (item.danger ? ' danger' : '');
    mi.textContent = item.label;
    mi.addEventListener('click', () => { menu.classList.add('hidden'); item.action(); });
    menu.appendChild(mi);
  }

  menu.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = rect.left;
  if (left + mw > window.innerWidth - 4) left = window.innerWidth - mw - 4;
  let top = rect.bottom + 2;
  if (top + mh > window.innerHeight - 4) top = rect.top - mh - 2;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function moveWorkspace(wsId, delta) {
  const idx = workspaces.findIndex((w) => w.id === wsId);
  if (idx < 0) return;
  const target = idx + delta;
  if (target < 0 || target >= workspaces.length) return;
  const [moved] = workspaces.splice(idx, 1);
  workspaces.splice(target, 0, moved);
  persistWorkspaces();
}

function openAddToWorkspaceMenu(sessionId, x, y) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'menu-header';
  header.textContent = '加入 / 移出工作区';
  menu.appendChild(header);

  for (const w of workspaces) {
    const inWs = (w.session_ids || []).includes(sessionId);
    const mi = document.createElement('div');
    mi.className = 'menu-item checked' + (inWs ? '' : ' unchecked');
    mi.textContent = w.name;
    mi.addEventListener('click', (e) => {
      e.stopPropagation();
      if (inWs) {
        w.session_ids = (w.session_ids || []).filter((id) => id !== sessionId);
      } else {
        w.session_ids = [...(w.session_ids || []), sessionId];
      }
      persistWorkspaces();
      renderSessionList();
      openAddToWorkspaceMenu(sessionId, x, y);
    });
    menu.appendChild(mi);
  }

  menu.classList.remove('hidden');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

const btnWs = $('#btn-workspace');
if (btnWs) {
  btnWs.addEventListener('click', (e) => {
    e.stopPropagation();
    openWorkspaceMenu(btnWs);
  });
}


// ============================================================================
// Running-tabs global panel (across workspaces + collapsed groups)
// ============================================================================
//
// Because both workspace filtering and group collapsing can hide alive PTYs
// from the tab bar, users need a single "what's actually running right now?"
// view. The panel lists every alive tab across every workspace, grouped by
// workspace, with click → switch workspace + activate tab.

function updateRunningCount() {
  const btn = $('#btn-running');
  const countEl = $('#running-count');
  if (!btn || !countEl) return;
  const aliveCount = tabs.filter((t) => t.alive).length;
  countEl.textContent = String(aliveCount);
  btn.classList.toggle('zero', aliveCount === 0);
  btn.title = aliveCount === 0
    ? '没有运行中的标签'
    : `${aliveCount} 个运行中的标签 · 点击查看跨工作区列表`;
}

let runningPanelEl = null;
function ensureRunningPanel() {
  if (runningPanelEl) return runningPanelEl;
  runningPanelEl = document.createElement('div');
  runningPanelEl.id = 'running-panel';
  runningPanelEl.className = 'hidden';
  document.body.appendChild(runningPanelEl);
  // Click outside closes it.
  document.addEventListener('mousedown', (e) => {
    if (!runningPanelEl || runningPanelEl.classList.contains('hidden')) return;
    if (runningPanelEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#btn-running')) return;
    runningPanelEl.classList.add('hidden');
  });
  return runningPanelEl;
}

function toggleRunningPanel(anchor) {
  const panel = ensureRunningPanel();
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  renderRunningPanel();
  panel.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  const pw = panel.offsetWidth;
  let left = rect.right - pw;
  if (left < 8) left = 8;
  panel.style.left = left + 'px';
  panel.style.top = (rect.bottom + 4) + 'px';
}

function renderRunningPanel() {
  const panel = ensureRunningPanel();
  panel.innerHTML = '';

  // Group by workspace: any workspace that owns at least one tab shows up.
  // Foreign / unknown workspaceIds (e.g. session imported from an older
  // build) get lumped into a "其他" section so nothing gets orphaned.
  const byWs = new Map();
  for (const t of tabs) {
    const key = t.workspaceId || '__none__';
    if (!byWs.has(key)) byWs.set(key, []);
    byWs.get(key).push(t);
  }

  if (byWs.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'rp-empty';
    empty.textContent = '没有运行中的标签';
    panel.appendChild(empty);
    return;
  }

  // Active workspace first, then the rest in workspace-list order.
  const orderedKeys = [
    activeWorkspaceId,
    ...workspaces.map((w) => w.id).filter((id) => id !== activeWorkspaceId),
    '__none__',
  ].filter((k, i, arr) => byWs.has(k) && arr.indexOf(k) === i);

  for (const wsId of orderedKeys) {
    const ws = workspaces.find((w) => w.id === wsId);
    const wsName = ws ? ws.name : '其他';
    const groupTabs = byWs.get(wsId) || [];
    const aliveCount = groupTabs.filter((t) => t.alive).length;

    const head = document.createElement('div');
    head.className = 'rp-group';
    head.innerHTML = `${escapeHtml(wsName)}<span class="rp-badge">${aliveCount}/${groupTabs.length}</span>`;
    panel.appendChild(head);

    for (const t of groupTabs) {
      const row = document.createElement('div');
      row.className = 'rp-row'
        + (t.id === activeTabId ? ' active' : '')
        + (t.alive ? '' : ' dead');
      row.innerHTML = `
        <span class="rp-status"></span>
        <span class="rp-name">${escapeHtml(t.sessionName)}</span>
        <span class="rp-close" title="关闭">&times;</span>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('rp-close')) {
          closeTab(t.id);
          renderRunningPanel();
          return;
        }
        // Jump to this tab's workspace if needed, then activate the tab.
        if (t.workspaceId && t.workspaceId !== activeWorkspaceId) {
          switchWorkspace(t.workspaceId).then(() => switchToTab(t.id));
        } else {
          switchToTab(t.id);
        }
        ensureRunningPanel().classList.add('hidden');
      });
      panel.appendChild(row);
    }
  }
}

const btnRunning = $('#btn-running');
if (btnRunning) {
  btnRunning.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRunningPanel(btnRunning);
  });
}

// ============================================================================
// Initial load
// ============================================================================

(async function init() {
  try { viewAll = localStorage.getItem(LS_VIEW_ALL) === '1'; } catch (_) {}
  await loadSessionsFromDisk();
  await loadWorkspacesFromDisk();
  updateWorkspaceButton();
  renderSessionList();
  updateRunningCount();
  // Restore tabs remembered from last session — just the active workspace
  // normally (others rehydrate lazily on switch), all of them in "全部" view
  // since that view is supposed to show everything.
  if (viewAll) restoreAllRememberedTabs();
  else restoreRememberedTabs(activeWorkspaceId);
})();
