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
const { acquireTunnel } = require('../lib/socks-tunnel');

const auth = require('../lib/auth');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// If CS_PASSWORD is set, provision the single account from env so
// there's no one-time-code registration step. Otherwise fall back to
// printing the registration code for the browser flow.
auth.bootstrapFromEnv().then((bootstrapped) => {
  if (bootstrapped) return;
  const initialCode = auth.ensureRegistrationCode();
  if (initialCode) {
    console.log('\n' + '='.repeat(60));
    console.log(' [claude-sessions] No account exists yet.');
    console.log(' Register on the web UI with this one-time code,');
    console.log(' OR restart with CS_PASSWORD=<your-password> set:');
    console.log('');
    console.log('   REGISTRATION CODE: ' + initialCode);
    console.log('');
    console.log(' (Code is invalidated after first successful registration');
    console.log('  or whenever the server restarts.)');
    console.log('='.repeat(60) + '\n');
  }
}).catch((err) => console.error('[auth] bootstrap failed:', err));

const app = express();
if (TRUST_PROXY) app.set('trust proxy', true);

// CORS for the native APK client. The APK's WebView origin
// (https://localhost / capacitor://localhost) is cross-origin to this
// server, so its fetch('/api/auth/login') would be blocked without
// these headers. We DON'T allow credentials (the APK authenticates
// with a token it reads from the login response body, not a cookie),
// so a wildcard origin is safe — and every API route still requires
// auth regardless. The browser web UI is same-origin and unaffected.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
  // Browser: HttpOnly cookie. Native APK (cross-origin, can't read or
  // send that cookie): a token via ?token= or Authorization: Bearer.
  const cookies = parseCookies(req);
  let token = cookies.cs_session;
  if (!token && req.query && req.query.token) token = String(req.query.token);
  if (!token) {
    const authz = req.headers && req.headers.authorization;
    if (authz && /^Bearer\s+/i.test(authz)) token = authz.replace(/^Bearer\s+/i, '').trim();
  }
  const session = auth.getSession(token);
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
// File-preview render libs (marked / DOMPurify / KaTeX), served straight
// from node_modules like xterm so the browser loads them offline.
const NM = path.join(__dirname, '..', 'node_modules');
app.use('/vendor/marked', express.static(path.join(NM, 'marked')));
app.use('/vendor/dompurify', express.static(path.join(NM, 'dompurify', 'dist')));
app.use('/vendor/katex', express.static(path.join(NM, 'katex', 'dist')));

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
    // Also return the token in the body. Browsers ignore it (they use
    // the HttpOnly cookie), but the native APK can't read an HttpOnly
    // cookie across origins, so it reads the token here and passes it
    // as ?token= on the WebSocket URL.
    res.json({ ok: true, username, token: session.sessionId });
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

// ---- directory browser (for the working-dir picker) -----------------
//
// Lists subdirectories of `path` so the client can offer a "browse"
// picker instead of making the user type an absolute path. Auth-gated.
// Returns the resolved absolute path, its parent, and the immediate
// child directories. Symlinks are followed for the listing but we
// only report directories.
app.get('/api/fs/list', (req, res) => {
  let dir = (req.query.path || os.homedir()).toString();
  try {
    dir = path.resolve(dir);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (e.name.startsWith('.')) return false;          // hide dotdirs
        try {
          return e.isDirectory() ||
            (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isDirectory());
        } catch (_) { return false; }
      })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    res.json({
      path: dir,
      parent: path.dirname(dir) === dir ? null : path.dirname(dir),
      dirs,
    });
  } catch (err) {
    res.status(400).json({ error: String(err && err.message || err), path: dir });
  }
});

// ---- file read (for the read-only preview) --------------------------
//
// Reads up to `max` bytes of a file and returns it base64-encoded so
// the client can preview markdown / images / text. Capped (default
// 1 MB, hard ceiling 16 MB) so a giant log or binary can't blow up the
// response or the client WebView. Auth-gated like the rest of /api.
// No path sandbox: this is the user's own single-account server and
// the working-dir picker already exposes the whole FS — same trust
// boundary as /api/fs/list.
app.get('/api/fs/read', (req, res) => {
  const filePath = (req.query.path || '').toString();
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const HARD_MAX = 16 * 1024 * 1024;
  let max = parseInt((req.query.max || '').toString(), 10);
  if (!Number.isFinite(max) || max <= 0) max = 1024 * 1024;
  max = Math.min(max, HARD_MAX);
  try {
    const resolved = path.resolve(filePath);
    const st = fs.statSync(resolved);
    if (!st.isFile()) return res.status(400).json({ error: 'not a regular file' });
    const size = st.size;
    const toRead = Math.min(size, max);
    const fd = fs.openSync(resolved, 'r');
    try {
      const buf = Buffer.alloc(toRead);
      let read = 0;
      while (read < toRead) {
        const n = fs.readSync(fd, buf, read, toRead - read, read);
        if (n <= 0) break;
        read += n;
      }
      res.json({
        base64: buf.subarray(0, read).toString('base64'),
        size,
        truncated: size > max,
      });
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    res.status(400).json({ error: String(err && err.message || err) });
  }
});

// ---- tmux session discovery -----------------------------------------
//
// Persistent sessions run inside a `cs-<id>` tmux session on this host
// (see buildLocalCommand). These endpoints let a client see which ones
// are currently alive on the server — independent of whether any
// browser/APK is attached — and kill stale ones. This is the
// "了解服务端活跃的 claude 会话" feature: the agent (this server) owns
// the source of truth, the client just queries it.
const { execFile } = require('child_process');

app.get('/api/tmux/sessions', (_req, res) => {
  if (process.platform === 'win32') return res.json({ sessions: [], tmux: false });
  // -F format: name \t created(unix) \t attached(count) \t windows
  execFile(
    'tmux',
    ['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}'],
    { timeout: 5000 },
    (err, stdout) => {
      // err with code 1 + "no server running" just means zero sessions.
      if (err && !/no server running|no sessions/i.test(String(err.stderr || err.message))) {
        return res.json({ sessions: [], tmux: true, error: String(err.message) });
      }
      const sessions = String(stdout || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, created, attached, windows] = line.split('\t');
          return {
            name,
            created: parseInt(created, 10) || 0,
            attached: parseInt(attached, 10) || 0,
            windows: parseInt(windows, 10) || 0,
          };
        })
        .filter((s) => s.name && s.name.startsWith('cs-'));
      res.json({ sessions, tmux: true });
    },
  );
});

app.post('/api/tmux/kill', (req, res) => {
  const name = String((req.body && req.body.name) || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!name || !name.startsWith('cs-')) {
    return res.status(400).json({ ok: false, error: 'invalid session name' });
  }
  execFile('tmux', ['kill-session', '-t', name], { timeout: 5000 }, (err) => {
    res.json({ ok: !err, error: err ? String(err.message) : undefined });
  });
});

app.post('/api/sessions', (req, res) => {
  try {
    saveSessions(Array.isArray(req.body) ? req.body : (req.body && req.body.sessions) || []);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

// Accepts any base64-encoded image dataUrl (image/png from the clipboard,
// image/jpeg or image/heic from a phone gallery picker, etc.). Saves to
// /tmp/claude-clipboard/clip_<ts>.<ext>. Same response shape regardless
// of source type so the renderer doesn't care.
const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
};

app.post('/api/paste-image', (req, res) => {
  try {
    const dataUrl = req.body && req.body.dataUrl;
    const m = /^data:(image\/[A-Za-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl || '');
    if (!m) {
      return res.status(400).json({ ok: false, error: 'expected base64 image dataUrl' });
    }
    const mime = m[1].toLowerCase();
    const ext = MIME_TO_EXT[mime] || mime.split('/')[1].replace(/[^a-z0-9]/g, '') || 'bin';
    const buf = Buffer.from(m[2], 'base64');
    const MAX = 25 * 1024 * 1024;
    if (buf.length > MAX) {
      return res.status(413).json({ ok: false, error: 'image too large (>25MB)' });
    }
    const localPath = saveImageToTemp(buf, ext);
    res.json({ ok: true, localPath, mime });
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
    // IMPORTANT: keep ws:false here. With ws:true, http-proxy-middleware
    // auto-subscribes its OWN `server.on('upgrade')` handler on the first
    // HTTP request — and since we set no pathFilter, its default filter
    // ('/') matches EVERY upgrade, including our terminal WS at `/`. That
    // handler then hijacks the already-upgraded terminal socket and tries
    // to proxy it to the web upstream, breaking ALL terminal sessions
    // (client sees an immediate 1006). WS upgrades for /p/<id> are routed
    // explicitly via proxy.upgrade() in the server 'upgrade' handler below,
    // so we don't need (or want) the auto-subscription.
    ws: false,
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
  // Auth via the HttpOnly cookie (browser) OR a ?token= query param
  // (native APK client, which can't read the cookie across origins).
  let token = cookies.cs_session;
  try {
    const t = new URL(req.url || '/', 'http://x').searchParams.get('token');
    if (!token && t) token = t;
  } catch (_) {}
  const session = auth.getSession(token);
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

// Global PTY registry — survives individual WS disconnects so a user
// switching apps, locking the phone, or reloading the page can re-attach
// and pick up where they left off instead of losing all in-flight work.
//
// Each entry is keyed by a persistent id chosen by the client (a UUID
// stored in localStorage). When the WS that owns a PTY closes we DON'T
// kill the PTY immediately — instead we null the ws and start a GC
// timer (default 10 min); if any WS reattaches before that, the timer
// is cancelled, the new WS becomes the owner, and the buffered output
// (last ~256KB) is replayed so the client catches up on whatever
// happened while it was disconnected.
const ptys = new Map();
const PTY_GC_MS = 10 * 60 * 1000;
const PTY_BUFFER_BYTES = 256 * 1024;

function gcPty(persistentId) {
  const e = ptys.get(persistentId);
  if (!e) return;
  if (e.pty) { try { e.pty.kill(); } catch (_) {} }
  if (e.releaseTunnel) { try { e.releaseTunnel(); } catch (_) {} }
  ptys.delete(persistentId);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  // Set of persistent IDs currently attached via THIS ws — used on
  // ws.close to start GC timers for each.
  const attached = new Set();

  // Same env-injection logic as the Electron path (main.js#makeSocksProxyEnv).
  function makeSocksProxyEnv(tunnel) {
    const http = `http://127.0.0.1:${tunnel.bridgePort}`;
    const socks = `socks5h://127.0.0.1:${tunnel.socksPort}`;
    return {
      HTTP_PROXY: http, HTTPS_PROXY: http,
      http_proxy: http, https_proxy: http,
      ALL_PROXY: socks, all_proxy: socks,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    };
  }

  // Spawn a PTY for the given session, awaiting an SSH SOCKS tunnel first
  // if this is a local session that opted into one. Returns
  // `{ pty, releaseTunnel }` so the caller can release on PTY exit.
  async function spawnSessionPty(session, cols, rows) {
    const cwd =
      session.type === 'local'
        ? session.working_dir && fs.existsSync(session.working_dir)
          ? session.working_dir
          : os.homedir()
        : os.homedir();

    let env = { ...process.env };
    let releaseTunnel = null;
    const socksHost = session.type === 'local' && (session.socks_via_ssh || '').trim();
    if (socksHost) {
      const port = parseInt(session.socks_port, 10) || 1080;
      const tun = await acquireTunnel(socksHost, port);
      env = { ...env, ...makeSocksProxyEnv(tun) };
      releaseTunnel = () => tun.release();
    }

    // run_as: launch the session as a different Linux user. Requires
    // this server to run as root (su - <user> needs no password only
    // for root). Empty / unset = run as the server's own identity.
    // Validated to [A-Za-z0-9._-] and confirmed to exist before we
    // hand it to su, so it can't be turned into argument injection.
    const runAs = (process.platform !== 'win32' && session.run_as)
      ? String(session.run_as).trim() : '';
    let shell, shellArgs, spawnCwd = cwd;
    if (runAs) {
      if (!/^[A-Za-z0-9._-]+$/.test(runAs)) {
        throw new Error(`invalid run_as username: ${runAs}`);
      }
      if (process.getuid && process.getuid() !== 0) {
        throw new Error('run_as requires the server to run as root');
      }
      // `su - <user>` = interactive login shell as that user, with
      // their environment + a clean PAM session. The login shell cds
      // to the user's home, so we honor working_dir by cd-ing in the
      // startup command (sendStartupForSession) rather than via cwd.
      shell = 'su';
      shellArgs = ['-', runAs];
      // su sets up cwd itself; spawning in / avoids EACCES if the
      // server's cwd isn't readable by the target user.
      spawnCwd = '/';
    } else {
      shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
      shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoExit'] : [];
    }

    const term = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd: spawnCwd,
      env,
      useConpty: process.platform === 'win32',
    });
    return { pty: term, releaseTunnel, runAs };
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === 'create') {
      const { tabId, session, cols, rows } = msg;
      // Reattach path: a PTY with this id might still be alive on the
      // server from a previous WS (phone switched apps / page reloaded
      // / network blip). Cancel its GC timer, take ownership, replay
      // the buffered output. The client will see {type:'reattached'}
      // followed by a single big data frame.
      const existing = ptys.get(tabId);
      if (existing) {
        if (existing.killTimer) {
          clearTimeout(existing.killTimer);
          existing.killTimer = null;
        }
        // If another WS still claims it, detach that one first so
        // input from one phone doesn't leak to another.
        existing.ws = ws;
        attached.add(tabId);

        if (existing.exited) {
          // PTY died while detached. Surface it to the client so the
          // "Press R to reconnect" prompt shows up.
          send(ws, {
            type: 'reattached',
            tabId,
            exited: true,
            exitCode: existing.lastExitCode,
          });
          if (existing.buffer) {
            send(ws, { type: 'data', tabId, data: existing.buffer });
          }
          send(ws, { type: 'exit', tabId, exitCode: existing.lastExitCode });
        } else {
          send(ws, { type: 'reattached', tabId });
          if (existing.buffer) {
            send(ws, { type: 'data', tabId, data: existing.buffer });
          }
          // Push the client's current size to the live PTY.
          try { existing.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0)); } catch (_) {}
        }
        return;
      }

      // Fresh spawn.
      let term, releaseTunnel, runAs;
      try {
        ({ pty: term, releaseTunnel, runAs } = await spawnSessionPty(session, cols, rows));
      } catch (err) {
        send(ws, { type: 'error', tabId, error: String(err && err.message || err) });
        return;
      }
      if (ws.readyState !== ws.OPEN) {
        try { term.kill(); } catch (_) {}
        if (releaseTunnel) { try { releaseTunnel(); } catch (_) {} }
        return;
      }

      const entry = {
        tabId,
        pty: term,
        session,
        releaseTunnel,
        exited: false,
        lastExitCode: 0,
        buffer: '',
        ws,
        killTimer: null,
      };
      ptys.set(tabId, entry);
      attached.add(tabId);
      attachTermHandlers(tabId, entry);
      sendStartupForSession(term, session, runAs);

      send(ws, { type: 'ready', tabId });
    } else if (msg.type === 'reconnect') {
      // Force a fresh PTY into this tabId — used by the "Press R"
      // prompt after a session exited. Reuses the entry's stored
      // session config if we still have it, otherwise falls back to
      // the session passed in the message (covers the case where the
      // entry was already GC'd after a long absence).
      const { tabId, session: msgSession, cols, rows } = msg;
      let entry = ptys.get(tabId);
      const sessionForSpawn = (entry && entry.session) || msgSession;
      if (!sessionForSpawn) {
        send(ws, { type: 'error', tabId, error: 'no session config available for reconnect' });
        return;
      }
      let term, releaseTunnel, runAs;
      try {
        ({ pty: term, releaseTunnel, runAs } = await spawnSessionPty(sessionForSpawn, cols, rows));
      } catch (err) {
        send(ws, { type: 'error', tabId, error: String(err && err.message || err) });
        return;
      }
      if (ws.readyState !== ws.OPEN) {
        try { term.kill(); } catch (_) {}
        if (releaseTunnel) { try { releaseTunnel(); } catch (_) {} }
        return;
      }
      if (!entry) {
        entry = {
          tabId, pty: term, session: sessionForSpawn, releaseTunnel,
          exited: false, lastExitCode: 0, buffer: '', ws, killTimer: null,
        };
        ptys.set(tabId, entry);
      } else {
        if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = null; }
        entry.pty = term;
        entry.releaseTunnel = releaseTunnel;
        entry.exited = false;
        entry.buffer = '';
        entry.ws = ws;
      }
      attached.add(tabId);
      attachTermHandlers(tabId, entry);
      sendStartupForSession(term, entry.session, runAs);
      send(ws, { type: 'ready', tabId });
    } else if (msg.type === 'input') {
      const e = ptys.get(msg.tabId);
      if (e && e.pty) try { e.pty.write(msg.data); } catch (_) {}
    } else if (msg.type === 'resize') {
      const e = ptys.get(msg.tabId);
      if (e && e.pty) try { e.pty.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0)); } catch (_) {}
    } else if (msg.type === 'kill') {
      // User-initiated teardown: actually destroy the PTY.
      const e = ptys.get(msg.tabId);
      if (e) {
        if (e.killTimer) clearTimeout(e.killTimer);
        gcPty(msg.tabId);
      }
      attached.delete(msg.tabId);
    }
  });

  // Helper: wire data + exit handlers for a freshly-spawned PTY.
  // Appends every byte to the entry's circular-ish buffer so a future
  // reattach can replay catch-up output.
  function attachTermHandlers(tabId, entry) {
    const term = entry.pty;
    term.onData((data) => {
      entry.buffer = (entry.buffer + data);
      if (entry.buffer.length > PTY_BUFFER_BYTES) {
        entry.buffer = entry.buffer.slice(-PTY_BUFFER_BYTES);
      }
      if (entry.ws && entry.ws.readyState === entry.ws.OPEN) {
        send(entry.ws, { type: 'data', tabId, data });
      }
    });
    term.onExit(({ exitCode }) => {
      const cur = ptys.get(tabId);
      if (!cur || cur.pty !== term) return;
      if (cur.releaseTunnel) {
        try { cur.releaseTunnel(); } catch (_) {}
        cur.releaseTunnel = null;
      }
      cur.pty = null;
      cur.exited = true;
      cur.lastExitCode = exitCode;
      if (cur.ws && cur.ws.readyState === cur.ws.OPEN) {
        send(cur.ws, { type: 'exit', tabId, exitCode });
      }
    });
  }

  function sendStartupForSession(term, session, runAs) {
    setTimeout(() => {
      try {
        if (session.type === 'local') {
          let cmd = buildLocalCommand(session);
          // When run_as switched us into a `su - <user>` login shell,
          // that shell starts in the target user's home — the pty cwd
          // we'd normally rely on is gone. cd into working_dir first
          // so the session (and its tmux) start in the right project.
          if (runAs && session.working_dir) {
            const dir = String(session.working_dir).replace(/'/g, `'\\''`);
            cmd = `cd '${dir}' 2>/dev/null; ${cmd}`;
          }
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
    // Detach from PTYs but DO NOT kill them. Start a GC timer for each;
    // if any client reattaches with the same tabId before the timer
    // fires, the PTY is preserved and its buffered output is replayed.
    // Explicit user teardown happens via the 'kill' message instead.
    for (const tabId of attached) {
      const e = ptys.get(tabId);
      if (!e) continue;
      if (e.ws === ws) e.ws = null;
      if (e.killTimer) clearTimeout(e.killTimer);
      e.killTimer = setTimeout(() => gcPty(tabId), PTY_GC_MS);
    }
    attached.clear();
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
