// Web version of Claude Sessions.
//
// Auth model: single account. On first run the server prints a one-time
// registration code; the user opens the page, enters that code together
// with a username + password, and the account is created. From then on
// only that account can log in. Sessions live in HttpOnly+SameSite=Strict
// cookies; the WebSocket upgrade reuses the same cookie.
//
// Run with:
//   npm run web                              (binds 127.0.0.1:3000)
//   HOST=0.0.0.0 PORT=3000 npm run web       (LAN; auth required)
//
// Env:
//   HOST   default 127.0.0.1
//   PORT   default 3000
//   TRUST_PROXY  set to "1" if you sit behind a reverse proxy that
//                terminates TLS (e.g. nginx, Caddy) so we can read
//                X-Forwarded-Proto for the Secure cookie flag.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createProxyMiddleware } = require('http-proxy-middleware');
const pty = require('node-pty');

const {
  loadSessions,
  saveSessions,
  buildSshCommand,
  buildLocalCommand,
  scpUpload,
  saveImageToTemp,
} = require('../lib/session-runtime');

const auth = require('../lib/auth');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// Print the one-time registration code if no account is set up yet.
const initialCode = auth.ensureRegistrationCode();
if (initialCode) {
  console.log('\n' + '='.repeat(60));
  console.log(' [claude-sessions] No account exists yet.');
  console.log(' Register on the web UI with this one-time code:');
  console.log('');
  console.log('   REGISTRATION CODE: ' + initialCode);
  console.log('');
  console.log(' (Code is invalidated after first successful registration');
  console.log('  or whenever the server restarts.)');
  console.log('='.repeat(60) + '\n');
}

const app = express();
if (TRUST_PROXY) app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));

// ---- minimal cookie helpers (no extra dep) ---------------------------

function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}

function isSecureRequest(req) {
  if (req.secure) return true;
  if (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') return true;
  return false;
}

function setSessionCookie(req, res, sessionId) {
  const flags = [
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(auth.SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecureRequest(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', `cs_session=${sessionId}; ${flags.join('; ')}`);
}

function clearSessionCookie(req, res) {
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (isSecureRequest(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', `cs_session=; ${flags.join('; ')}`);
}

function clientIp(req) {
  return (req.ip || req.socket && req.socket.remoteAddress || '?').toString();
}

// ---- middlewares -----------------------------------------------------

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const session = auth.getSession(cookies.cs_session);
  if (!session) return res.status(401).json({ error: 'unauthenticated' });
  req.user = session.username;
  next();
}

// ---- static files ----------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));
app.use(
  '/vendor/xterm',
  express.static(path.join(__dirname, '..', 'node_modules', '@xterm'))
);

// ---- auth API --------------------------------------------------------

app.get('/api/auth/status', (req, res) => {
  const cookies = parseCookies(req);
  const session = auth.getSession(cookies.cs_session);
  res.json({
    registered: auth.isRegistered(),
    authenticated: !!session,
    username: session ? session.username : null,
  });
});

app.post('/api/auth/register', async (req, res) => {
  if (auth.isRegistered()) {
    return res.status(409).json({ error: 'account already exists' });
  }
  // Treat registration attempts as login-grade for rate-limiting (an
  // attacker guessing the registration code should still be throttled).
  const rl = auth.checkRateLimit(clientIp(req));
  if (!rl.ok) return res.status(429).json({ error: 'too many attempts; try again later' });

  try {
    const { username, password, code } = req.body || {};
    const session = await auth.register({ username, password, code });
    auth.resetRateLimit(clientIp(req));
    setSessionCookie(req, res, session.sessionId);
    res.json({ ok: true, username });
  } catch (err) {
    res.status(err.status || 400).json({ error: String(err.message || err) });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const ip = clientIp(req);
  const rl = auth.checkRateLimit(ip);
  if (!rl.ok) {
    return res
      .status(429)
      .json({ error: 'too many attempts; try again later', retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { username, password } = req.body || {};
    const session = await auth.login({ username, password });
    auth.resetRateLimit(ip);
    setSessionCookie(req, res, session.sessionId);
    res.json({ ok: true, username });
  } catch (err) {
    res.status(401).json({ error: 'invalid credentials' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.cs_session) auth.deleteSession(cookies.cs_session);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// ---- protected API ---------------------------------------------------

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  return requireAuth(req, res, next);
});

app.get('/api/sessions', (_req, res) => res.json(loadSessions()));

app.post('/api/sessions', (req, res) => {
  try {
    saveSessions(Array.isArray(req.body) ? req.body : (req.body && req.body.sessions) || []);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

app.post('/api/paste-image', (req, res) => {
  try {
    const dataUrl = req.body && req.body.dataUrl;
    if (!dataUrl || !/^data:image\/png;base64,/.test(dataUrl)) {
      return res.status(400).json({ ok: false, error: 'expected dataUrl image/png base64' });
    }
    const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    const localPath = saveImageToTemp(buf);
    res.json({ ok: true, localPath });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

app.post('/api/scp-upload', async (req, res) => {
  const { sshHost, localPath } = req.body || {};
  const result = await scpUpload(sshHost, localPath);
  res.json(result);
});

// ---- Reverse proxy for type=web sessions -----------------------------
//
// Each web-type session gets a virtual mount point at /p/<sessionId>/*
// that forwards (HTTP + WebSocket) to whatever URL the user configured.
// We strip X-Frame-Options / frame-ancestors so the upstream can be
// iframed inside our app, and rewrite cookie Path so cookies from one
// upstream don't leak into another web tab.

function findWebSession(sessionId) {
  for (const s of loadSessions()) {
    if (s.id === sessionId && s.type === 'web' && s.url) return s;
  }
  return null;
}

function makeProxy(sessionId, upstream) {
  return createProxyMiddleware({
    target: upstream,
    changeOrigin: true,
    ws: true,
    pathRewrite: { [`^/p/${sessionId}`]: '' },
    cookiePathRewrite: { '*': `/p/${sessionId}` },
    cookieDomainRewrite: '',
    on: {
      proxyRes: (proxyRes /*, req, res */) => {
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy-report-only'];
        const csp = proxyRes.headers['content-security-policy'];
        if (csp) {
          // Strip frame-ancestors (which would otherwise still block embedding).
          // Leave the rest of the policy alone.
          const stripped = csp
            .split(/;\s*/)
            .filter((d) => !/^frame-ancestors\b/i.test(d))
            .join('; ');
          if (stripped) proxyRes.headers['content-security-policy'] = stripped;
          else delete proxyRes.headers['content-security-policy'];
        }
        // 3xx redirects with absolute Location need rewriting back to /p/<id>/...
        const loc = proxyRes.headers.location;
        if (loc) {
          try {
            const u = new URL(loc, upstream);
            const upstreamUrl = new URL(upstream);
            if (u.host === upstreamUrl.host) {
              proxyRes.headers.location = `/p/${sessionId}${u.pathname}${u.search}${u.hash}`;
            }
          } catch (_) {}
        }
      },
      error: (err, req, res) => {
        try {
          if (res && typeof res.writeHead === 'function' && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Bad gateway: ' + (err && err.message || 'unknown'));
          } else if (res && typeof res.destroy === 'function') {
            res.destroy();
          }
        } catch (_) {}
      },
    },
  });
}

// HTTP path: /p/<sessionId>/anything
app.use((req, res, next) => {
  const m = req.path.match(/^\/p\/([^/]+)/);
  if (!m) return next();

  // Auth: any web tab is at least as sensitive as our terminal.
  const cookies = parseCookies(req);
  if (!auth.getSession(cookies.cs_session)) {
    return res.status(401).json({ error: 'unauthenticated' });
  }

  const session = findWebSession(m[1]);
  if (!session) return res.status(404).type('text/plain').send('No web session with that id');

  return makeProxy(m[1], session.url)(req, res, next);
});

// ---- HTTP + WebSocket ------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const cookies = parseCookies(req);
  const session = auth.getSession(cookies.cs_session);
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Dispatch: WS to /p/<id>/* goes through the matching reverse proxy
  // (e.g. xpra HTML5 uses WS); everything else is our terminal channel.
  let pathname = '/';
  try { pathname = new URL(req.url || '/', 'http://x').pathname; } catch (_) {}
  const m = pathname.match(/^\/p\/([^/]+)/);
  if (m) {
    const ws_session = findWebSession(m[1]);
    if (!ws_session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const proxy = makeProxy(m[1], ws_session.url);
    proxy.upgrade(req, socket, head);
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = session.username;
    wss.emit('connection', ws, req);
  });
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// WebSocket heartbeat. Many intermediate links (NAT, mobile carriers,
// nginx/Caddy in front of us) drop "idle" TCP connections after 60–300s.
// Sending a WS ping every 30s keeps them all alive; if a client misses
// two pongs in a row we terminate so resources are released and the
// browser-side reconnect kicks in.
const WS_PING_INTERVAL_MS = 30000;

function heartbeat() { this.isAlive = true; }

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, WS_PING_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatTimer));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  const terms = new Map();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === 'create') {
      const { tabId, session, cols, rows } = msg;
      const cwd =
        session.type === 'local'
          ? session.working_dir && fs.existsSync(session.working_dir)
            ? session.working_dir
            : os.homedir()
          : os.homedir();

      const shell = process.platform === 'win32'
        ? 'powershell.exe'
        : (process.env.SHELL || 'bash');
      const shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoExit'] : [];

      let term;
      try {
        term = pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: cols || 120,
          rows: rows || 30,
          cwd,
          env: { ...process.env },
          useConpty: process.platform === 'win32',
        });
      } catch (err) {
        send(ws, { type: 'error', tabId, error: String(err && err.message || err) });
        return;
      }

      const entry = { pty: term, session, exited: false };
      terms.set(tabId, entry);
      attachTermHandlers(tabId, entry);
      sendStartupForSession(term, session);

      send(ws, { type: 'ready', tabId });
    } else if (msg.type === 'reconnect') {
      // Re-spawn a PTY into the same tabId after a previous one exited.
      // Only the original PTY is gone; the entry (with its session) is
      // still here, so the new shell uses the same config and — for
      // persistent SSH — `tmux attach`es back to the same remote session.
      const { tabId, cols, rows } = msg;
      const entry = terms.get(tabId);
      if (!entry || !entry.exited || entry.pty) {
        send(ws, { type: 'error', tabId, error: 'no exited terminal for this tab' });
        return;
      }
      const session = entry.session;
      const cwd =
        session.type === 'local'
          ? session.working_dir && fs.existsSync(session.working_dir)
            ? session.working_dir
            : os.homedir()
          : os.homedir();
      const shell = process.platform === 'win32'
        ? 'powershell.exe'
        : (process.env.SHELL || 'bash');
      const shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoExit'] : [];
      let term;
      try {
        term = pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: cols || 120,
          rows: rows || 30,
          cwd,
          env: { ...process.env },
          useConpty: process.platform === 'win32',
        });
      } catch (err) {
        send(ws, { type: 'error', tabId, error: String(err && err.message || err) });
        return;
      }
      entry.pty = term;
      entry.exited = false;
      attachTermHandlers(tabId, entry);
      sendStartupForSession(term, session);
      send(ws, { type: 'ready', tabId });
    } else if (msg.type === 'input') {
      const e = terms.get(msg.tabId);
      if (e && e.pty) try { e.pty.write(msg.data); } catch (_) {}
    } else if (msg.type === 'resize') {
      const e = terms.get(msg.tabId);
      if (e && e.pty) try { e.pty.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0)); } catch (_) {}
    } else if (msg.type === 'kill') {
      const e = terms.get(msg.tabId);
      if (e) {
        if (e.pty) { try { e.pty.kill(); } catch (_) {} }
        terms.delete(msg.tabId);
      }
    }
  });

  // Helper: wire data + exit handlers for a freshly-spawned PTY. Kept
  // inline (closes over `ws` and `terms`) so reconnect can reuse it.
  function attachTermHandlers(tabId, entry) {
    const term = entry.pty;
    term.onData((data) => send(ws, { type: 'data', tabId, data }));
    term.onExit(({ exitCode }) => {
      const cur = terms.get(tabId);
      // Stale exit (entry was already replaced or removed) — ignore.
      if (!cur || cur.pty !== term) return;
      cur.pty = null;
      cur.exited = true;
      cur.lastExitCode = exitCode;
      send(ws, { type: 'exit', tabId, exitCode });
    });
  }

  function sendStartupForSession(term, session) {
    setTimeout(() => {
      try {
        if (session.type === 'local') {
          const cmd = buildLocalCommand(session);
          if (cmd.trim()) term.write(cmd + '\r');
        } else if (session.type === 'ssh' && session.ssh_host) {
          term.write(buildSshCommand(session) + '\r');
        }
      } catch (err) {
        console.error('[pty] startup command failed:', err);
      }
    }, 800);
  }

  ws.on('close', () => {
    for (const e of terms.values()) {
      if (e && e.pty) { try { e.pty.kill(); } catch (_) {} }
    }
    terms.clear();
  });
});

// ---- start -----------------------------------------------------------

server.listen(PORT, HOST, () => {
  const display = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`[claude-sessions] web UI listening on ${display}`);
  if (HOST === '0.0.0.0') {
    console.log('[claude-sessions] Bound on all interfaces — accessible on LAN.');
    console.log('[claude-sessions] Use HTTPS in production (set TRUST_PROXY=1 if behind a TLS proxy).');
  }
});
