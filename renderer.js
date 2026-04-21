const { ipcRenderer, clipboard, shell } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

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

let editingId = null;

// ============================================================================
// Utilities
// ============================================================================

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function notify(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
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
        <span class="badge ${s.type === 'ssh' ? 'ssh' : 'local'}">${s.type === 'ssh' ? 'SSH' : 'WIN'}</span>
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
  const items = [
    { label: 'Launch', action: () => launchSession(session.id) },
    { label: 'Edit', action: () => openEditor(session.id) },
    { label: 'Clone', action: () => cloneSession(session.id) },
    { sep: true },
    { label: 'Delete', danger: true, action: () => deleteSession(session.id) },
  ];
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
  };

  for (const key of ['name', 'ssh_host', 'port_forwards', 'working_dir', 'pre_command', 'claude_cmd', 'claude_args', 'description']) {
    const input = form.elements[key];
    if (input) input.value = values[key] || '';
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
  const isSsh = type && type.value === 'ssh';
  document.querySelectorAll('.ssh-only').forEach((el) => {
    el.classList.toggle('hidden', !isSsh);
  });
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
// Terminal / Tab management
// ============================================================================

function launchSession(sessionId) {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  const tabId = `tab-${++tabCounter}`;
  const existing = sessionInstanceCount(sessionId);
  const displayName = existing === 0 ? session.name : `${session.name} #${existing + 1}`;

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

  term.open(container);
  fitAddon.fit();

  const tab = {
    id: tabId,
    sessionId,
    sessionName: displayName,
    term,
    fitAddon,
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
  ipcRenderer.invoke('create-terminal', tabId, session, cols, rows).then((res) => {
    if (!res || !res.ok) {
      notify(`Failed to start: ${res && res.error}`, 'error');
    }
  });

  renderTabs();
  switchToTab(tabId);
  renderSessionList();
}

function switchToTab(tabId) {
  activeTabId = tabId;
  for (const t of tabs) {
    t.container.classList.toggle('active', t.id === tabId);
  }
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) {
    try {
      tab.fitAddon.fit();
      const { cols, rows } = tab.term;
      if (tab.alive) ipcRenderer.send('terminal-resize', tabId, cols, rows);
      tab.term.focus();
    } catch (_) {}
  }
  $('#welcome').classList.toggle('hidden', tabs.length > 0);
  renderTabs();
}

function closeTab(tabId) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.alive) ipcRenderer.invoke('kill-terminal', tabId);
  try { tab.term.dispose(); } catch (_) {}
  try { tab.container.remove(); } catch (_) {}
  tabs.splice(idx, 1);

  if (activeTabId === tabId) {
    const next = tabs[idx] || tabs[idx - 1] || null;
    activeTabId = next ? next.id : null;
    if (next) switchToTab(next.id);
  }
  $('#welcome').classList.toggle('hidden', tabs.length > 0);
  renderTabs();
  renderSessionList();
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
    el.appendChild(div);
  }
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
    if (term.hasSelection()) {
      clipboard.writeText(term.getSelection());
      term.clearSelection();
      notify('Copied', 'success');
    } else {
      const text = clipboard.readText();
      if (text) bracketedPaste(tabId, text);
    }
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

ipcRenderer.on('terminal-exit', (_e, tabId, exitCode) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.alive = false;
  tab.term.write(`\r\n\x1b[33m[Session ended with code ${exitCode}. Press any key to close.]\x1b[0m\r\n`);
  renderTabs();
  renderSessionList();

  const disposable = tab.term.onKey(() => {
    try { disposable.dispose(); } catch (_) {}
    closeTab(tabId);
  });
});

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
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(idx + 1) % tabs.length];
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

// Initial load
loadSessionsFromDisk();
