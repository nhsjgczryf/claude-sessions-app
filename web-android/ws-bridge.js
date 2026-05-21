/*
 * WebSocket bridge — the "remote (agent)" session transport.
 *
 * Mirrors the SshBridge / LocalShellBridge API so renderer.js can use
 * it interchangeably via bridgeFor(tab). Instead of doing SSH itself,
 * it connects to a web/server.js instance running on the VPS (the
 * "agent"), authenticates with a password, and speaks that server's
 * JSON-over-WebSocket protocol. The agent owns the PTY (wrapped in
 * tmux for persistence), so:
 *   - the phone can disconnect freely (background / network blip);
 *   - reconnecting re-sends `create`, the agent reattaches to the
 *     still-alive tmux session and replays buffered output;
 *   - no SSH keepalive / wake-lock fight — persistence lives on the
 *     always-on VPS, not the phone.
 *
 * One WebSocket per distinct agent URL; multiple tabs to the same
 * agent multiplex over it, keyed by tabId (the protocol is already
 * tab-multiplexed server-side).
 */
(function () {
  'use strict';

  const dataListeners = new Set();
  const exitListeners = new Set();
  const statusListeners = new Set();
  const warningListeners = new Set();

  function emit(set, ev) { for (const cb of set) { try { cb(ev); } catch (_) {} } }
  function emitStatus(tabId, status) { emit(statusListeners, { tabId, status }); }

  // agentUrl -> connection record
  const conns = new Map();
  // tabId -> { agentUrl, session, cols, rows }
  const tabs = new Map();

  function wsBaseFor(agentUrl) {
    // Accept http(s):// or ws(s):// or bare host[:port]; normalize to
    // a ws(s):// origin with no trailing slash.
    let u = String(agentUrl || '').trim();
    if (!/^[a-z]+:\/\//i.test(u)) u = 'wss://' + u;     // bare host → wss
    u = u.replace(/^http/i, 'ws');                       // http(s) → ws(s)
    return u.replace(/\/+$/, '');
  }
  function httpBaseFor(agentUrl) {
    return wsBaseFor(agentUrl).replace(/^ws/i, 'http');
  }

  async function login(agentUrl, password) {
    const resp = await fetch(httpBaseFor(agentUrl) + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Single-account server: username is effectively ignored, but
      // send something so the body shape is valid.
      body: JSON.stringify({ username: 'user', password: password || '' }),
    });
    if (!resp.ok) throw new Error(`agent login HTTP ${resp.status}`);
    const j = await resp.json();
    if (!j || !j.token) throw new Error('agent did not return a token (update web/server.js)');
    return j.token;
  }

  // Open (or reuse) the WS for an agent. Resolves once the socket is
  // OPEN. Auto-reconnects on unexpected close and re-creates every tab
  // that belongs to this agent (the server reattaches to live tmux).
  async function ensureConn(agentUrl, password) {
    let c = conns.get(agentUrl);
    if (c && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) {
      return c;
    }
    const token = await login(agentUrl, password);
    const wsUrl = wsBaseFor(agentUrl) + '/?token=' + encodeURIComponent(token);
    const ws = new WebSocket(wsUrl);
    c = { ws, agentUrl, password, token, ready: false, queue: [], reconnectTimer: null };
    conns.set(agentUrl, c);

    ws.onopen = () => {
      c.ready = true;
      for (const m of c.queue) { try { ws.send(m); } catch (_) {} }
      c.queue = [];
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      switch (msg.type) {
        case 'data':       emit(dataListeners, { tabId: msg.tabId, data: msg.data }); break;
        case 'exit':       emit(exitListeners, { tabId: msg.tabId, exitCode: msg.exitCode }); break;
        case 'ready':      emitStatus(msg.tabId, 'Ready'); break;
        case 'reattached': emitStatus(msg.tabId, msg.exited ? 'Reattached (session ended)' : 'Reattached'); break;
        case 'error':      emit(warningListeners, { tabId: msg.tabId, error: msg.error }); break;
      }
    };
    ws.onclose = () => {
      c.ready = false;
      // Auto-reconnect if any tabs still belong to this agent. The
      // server keeps the tmux session alive, so reconnecting + re-
      // creating the tabs transparently reattaches.
      const mine = [...tabs.entries()].filter(([, t]) => t.agentUrl === agentUrl);
      if (mine.length === 0) { conns.delete(agentUrl); return; }
      for (const [tabId] of mine) emitStatus(tabId, 'Reconnecting to agent…');
      if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
      c.reconnectTimer = setTimeout(async () => {
        conns.delete(agentUrl);
        try {
          const nc = await ensureConn(agentUrl, password);
          // Re-create every tab on the fresh connection.
          for (const [tabId, t] of mine) {
            sendVia(nc, { type: 'create', tabId, session: t.session, cols: t.cols, rows: t.rows });
          }
        } catch (err) {
          for (const [tabId] of mine) emit(warningListeners, { tabId, error: 'agent reconnect failed: ' + (err && err.message || err) });
        }
      }, 1500);
    };
    ws.onerror = () => {};

    // Wait until open (or fail).
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('agent WS connect timed out')), 12000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('agent WS error')); }, { once: true });
    });
    return c;
  }

  function sendVia(c, obj) {
    const m = JSON.stringify(obj);
    if (c.ready && c.ws.readyState === WebSocket.OPEN) {
      try { c.ws.send(m); } catch (_) { c.queue.push(m); }
    } else {
      c.queue.push(m);
    }
  }

  window.WebSocketBridge = {
    available: typeof WebSocket !== 'undefined',

    // params: { tabId, agentUrl, password, session, cols, rows }
    async connect(params) {
      const { tabId, agentUrl, password, session, cols, rows } = params;
      if (!agentUrl) throw new Error('agent URL required');
      emitStatus(tabId, 'Authenticating with agent…');
      const c = await ensureConn(agentUrl, password);
      tabs.set(tabId, { agentUrl, session, cols, rows });
      sendVia(c, { type: 'create', tabId, session, cols, rows });
      return { tabId };
    },

    async write(tabId, data) {
      const t = tabs.get(tabId);
      if (!t) return;
      const c = conns.get(t.agentUrl);
      if (c) sendVia(c, { type: 'input', tabId, data });
    },

    async resize(tabId, cols, rows) {
      const t = tabs.get(tabId);
      if (!t) return;
      t.cols = cols; t.rows = rows;
      const c = conns.get(t.agentUrl);
      if (c) sendVia(c, { type: 'resize', tabId, cols, rows });
    },

    async close(tabId) {
      const t = tabs.get(tabId);
      if (!t) return;
      const c = conns.get(t.agentUrl);
      if (c) sendVia(c, { type: 'kill', tabId });
      tabs.delete(tabId);
      // If no tabs left for this agent, close the socket.
      const stillUsed = [...tabs.values()].some((x) => x.agentUrl === t.agentUrl);
      if (!stillUsed && c) {
        if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
        try { c.ws.close(); } catch (_) {}
        conns.delete(t.agentUrl);
      }
    },

    onData(cb)    { dataListeners.add(cb);    return () => dataListeners.delete(cb); },
    onExit(cb)    { exitListeners.add(cb);    return () => exitListeners.delete(cb); },
    onStatus(cb)  { statusListeners.add(cb);  return () => statusListeners.delete(cb); },
    onWarning(cb) { warningListeners.add(cb); return () => warningListeners.delete(cb); },

    // Authenticated GET against the agent's HTTP API (e.g. the
    // directory browser). Logs in for a fresh token each call —
    // cheap enough for occasional picker use, and avoids coupling to
    // the WS connection lifecycle.
    async apiGet(agentUrl, password, pathname, query) {
      const token = await login(agentUrl, password);
      const base = httpBaseFor(agentUrl);
      const qs = new URLSearchParams(query || {});
      const url = `${base}${pathname}?${qs.toString()}`;
      // Token via Authorization header (requireAuth accepts Bearer).
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error(`agent GET ${pathname} → HTTP ${resp.status}`);
      return resp.json();
    },

    async apiPost(agentUrl, password, pathname, body) {
      const token = await login(agentUrl, password);
      const base = httpBaseFor(agentUrl);
      const resp = await fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body || {}),
      });
      if (!resp.ok) throw new Error(`agent POST ${pathname} → HTTP ${resp.status}`);
      return resp.json();
    },
  };
})();
