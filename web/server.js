// Web version of Claude Sessions.
//
// Run with:
//   npm run web
// or
//   PORT=3000 HOST=0.0.0.0 TOKEN=mysecret node web/server.js
//
// Architecture:
//   Browser (xterm.js) <-> WebSocket <-> Node (node-pty / ssh / scp)
//
// Defaults to binding to 127.0.0.1 (so it's not exposed on the LAN until
// you opt in by setting HOST). When binding to anything other than
// 127.0.0.1 we REQUIRE a TOKEN to be set, since this process is
// effectively a remote shell server.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const {
  loadSessions,
  saveSessions,
  buildSshCommand,
  buildLocalCommand,
  scpUpload,
  saveImageToTemp,
} = require('../lib/session-runtime');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.TOKEN || '';

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  console.error(
    '[claude-sessions] Refusing to bind to ' + HOST + ' without TOKEN.\n' +
    '  Set TOKEN=somesecret or restrict HOST=127.0.0.1.'
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '15mb' }));

// Auth middleware: only enforced when TOKEN is set
function requireToken(req, res, next) {
  if (!TOKEN) return next();
  const provided =
    req.headers['x-token'] ||
    req.query.token ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Static files: app shell + xterm assets straight from node_modules
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  '/vendor/xterm',
  express.static(path.join(__dirname, '..', 'node_modules', '@xterm'))
);

// REST API
app.get('/api/config', (req, res) => {
  // Tells the client whether auth is required (so the login screen knows
  // when to prompt). Does not leak the token.
  res.json({ requireToken: !!TOKEN });
});

app.get('/api/sessions', requireToken, (_req, res) => {
  res.json(loadSessions());
});

app.post('/api/sessions', requireToken, (req, res) => {
  try {
    saveSessions(Array.isArray(req.body) ? req.body : (req.body && req.body.sessions) || []);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

app.post('/api/paste-image', requireToken, (req, res) => {
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

app.post('/api/scp-upload', requireToken, async (req, res) => {
  const { sshHost, localPath } = req.body || {};
  const result = await scpUpload(sshHost, localPath);
  res.json(result);
});

// HTTP + WS share the same server so the token check on the upgrade
// request can reuse the same logic.
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (TOKEN) {
    const url = new URL(req.url, 'http://x');
    const provided = url.searchParams.get('token') || req.headers['x-token'];
    if (provided !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const SOCKET_TERMS = new WeakMap(); // ws -> Map<tabId, term>

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  const terms = new Map();
  SOCKET_TERMS.set(ws, terms);

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

      terms.set(tabId, term);

      term.onData((data) => send(ws, { type: 'data', tabId, data }));
      term.onExit(({ exitCode }) => {
        terms.delete(tabId);
        send(ws, { type: 'exit', tabId, exitCode });
      });

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

      send(ws, { type: 'ready', tabId });
    } else if (msg.type === 'input') {
      const t = terms.get(msg.tabId);
      if (t) try { t.write(msg.data); } catch (_) {}
    } else if (msg.type === 'resize') {
      const t = terms.get(msg.tabId);
      if (t) try { t.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0)); } catch (_) {}
    } else if (msg.type === 'kill') {
      const t = terms.get(msg.tabId);
      if (t) {
        try { t.kill(); } catch (_) {}
        terms.delete(msg.tabId);
      }
    }
  });

  ws.on('close', () => {
    for (const t of terms.values()) {
      try { t.kill(); } catch (_) {}
    }
    terms.clear();
  });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`[claude-sessions] web UI listening on ${url}`);
  if (TOKEN) console.log(`[claude-sessions] auth token required: ${TOKEN}`);
  if (HOST === '0.0.0.0') {
    console.log('[claude-sessions] Bound on all interfaces — accessible on LAN.');
  }
});
