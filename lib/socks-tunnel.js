// SSH SOCKS5 tunnel manager + built-in HTTP proxy bridge.
//
// Why this exists: users want to run `claude` locally (Windows or macOS)
// but have its outbound HTTP/HTTPS traffic exit from a remote Linux box
// they've already set up SSH passwordless access to. `ssh -D` provides
// the SOCKS5 endpoint; the HTTP bridge converts it to a regular HTTP
// proxy so anything that respects HTTPS_PROXY=http://... works, including
// the Anthropic SDK / claude-code which doesn't natively grok socks5://.
//
// Lifetime model: one tunnel per (sshHost, socksPort) tuple, refcounted
// across tabs. First acquireTunnel() starts ssh + bridge; last release()
// tears both down. The handle returned to callers is opaque — they only
// need the bridge port (to set HTTP_PROXY) and the release function.
//
// Robustness:
//   - State machine (starting → ready → reconnecting → ready / failed /
//     closed) lets the bridge survive ssh -D dying transparently. The
//     bridge listens on a stable port across respawns — important because
//     HTTPS_PROXY is already baked into the spawned shell's env.
//   - Auto-respawn with exponential backoff (0.5..30s) keeps trying as
//     long as something still holds a reference.
//   - Tightened SSH keepalive (15s × 2 = ~30s gray window vs the default
//     90s) so a hung tunnel is noticed faster.
//   - Bridge requests wait up to ~5s for an in-flight respawn to finish
//     before erroring, and retry once on a transient SOCKS5 failure.
//   - Passive health watchdog: 3 consecutive SOCKS5 failures while the
//     entry still claims `ready` force-kills ssh -D so the respawn path
//     can rebuild it. Catches "TCP looks alive but bytes go nowhere".

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

// ----- ssh path resolution ---------------------------------------------

// Mirrors main.js#resolveSshPath. Duplicated rather than imported because
// this module is loaded by both Electron main and the web server.
let _cachedSshPath = null;
function resolveSshPath() {
  if (_cachedSshPath) return _cachedSshPath;
  if (process.platform !== 'win32') {
    _cachedSshPath = 'ssh';
    return _cachedSshPath;
  }
  const candidates = [];
  if (process.env.SystemRoot) {
    candidates.push(path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe'));
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) candidates.push(path.join(dir, 'ssh.exe'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { _cachedSshPath = c; return c; } } catch (_) {}
  }
  return 'ssh';
}

// ----- tuning knobs ----------------------------------------------------

const PORT_WAIT_MS = 12000;
const PORT_POLL_MS = 200;
// Backoff schedule for ssh respawns after a successful first launch.
// Tail entry is the cap; we never retry slower than this.
const RESPAWN_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000];
// Bridge waits up to this long for entry.state===ready before 502'ing.
// Long enough to bridge a normal respawn; short enough that a dead host
// surfaces as an error instead of hanging the SDK's request indefinitely.
const SOCKS_WAIT_MS = 5000;
// Brief breather before the bridge's single retry on a SOCKS5 failure.
const SOCKS_RETRY_DELAY_MS = 100;
// SOCKS5 handshake timeout per attempt — the SDK already retries above
// us, so we'd rather fail fast than stall an entire request.
const SOCKS_HANDSHAKE_TIMEOUT_MS = 8000;
// Passive health watchdog: this many SOCKS5 failures in a row while the
// entry still claims `ready` force-kills ssh -D.
const FAIL_THRESHOLD = 3;

// ----- module-level tunnel registry ------------------------------------

// Keyed by `${sshHost}|${socksPort}`. Value is a long-lived entry:
//   {
//     sshHost, socksPort,
//     state: 'starting' | 'ready' | 'reconnecting' | 'failed' | 'closed',
//     sshProc, bridgeServer, bridgePort,
//     refcount, error,
//     stateListeners: [fn, ...],
//     consecutiveFailures, respawnTimer,
//     closed,
//   }
const tunnels = new Map();

function tunnelKey(sshHost, socksPort) {
  return `${sshHost}|${socksPort}`;
}

// ----- state-machine helpers -------------------------------------------

function transitionTo(entry, newState) {
  if (entry.state === newState) return;
  entry.state = newState;
  notifyStateChange(entry);
}

function notifyStateChange(entry) {
  const listeners = entry.stateListeners;
  entry.stateListeners = [];
  for (const fn of listeners) {
    try { fn(); } catch (_) {}
  }
}

// Resolve when the entry's state changes, or when `timeoutMs` elapses.
function waitForStateChange(entry, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const wrapper = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      const i = entry.stateListeners.indexOf(wrapper);
      if (i >= 0) entry.stateListeners.splice(i, 1);
      resolve();
    };
    entry.stateListeners.push(wrapper);
    const t = setTimeout(wrapper, timeoutMs);
  });
}

// Wait until entry.state === 'ready', up to deadline. Throws if the
// entry transitions to 'failed' or 'closed', or if the deadline expires
// while still not ready.
async function waitUntilReady(entry, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (entry.state !== 'ready') {
    if (entry.state === 'closed') throw new Error('tunnel released');
    if (entry.state === 'failed') throw entry.error || new Error('tunnel failed');
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`tunnel not ready (state=${entry.state}) after ${timeoutMs}ms`);
    }
    await waitForStateChange(entry, remaining);
  }
}

// ----- low-level: TCP port readiness -----------------------------------

function waitForPort(port, timeoutMs, intervalMs) {
  const host = '127.0.0.1';
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect({ port, host });
      let settled = false;
      sock.once('connect', () => {
        if (settled) return; settled = true;
        try { sock.end(); } catch (_) {}
        resolve();
      });
      sock.once('error', () => {
        if (settled) return; settled = true;
        try { sock.destroy(); } catch (_) {}
        if (Date.now() >= deadline) {
          reject(new Error(`SOCKS port 127.0.0.1:${port} not reachable within ${timeoutMs}ms`));
        } else {
          setTimeout(tryOnce, intervalMs);
        }
      });
    };
    tryOnce();
  });
}

// ----- SOCKS5 client (NO-AUTH + CONNECT) -------------------------------

function socks5Connect(socksHost, socksPort, dstHost, dstPort, timeoutMs = SOCKS_HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: socksHost, port: socksPort });
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      fail(new Error(`SOCKS5: handshake timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function fail(err) {
      if (settled) return; settled = true;
      clearTimeout(timeoutHandle);
      try { sock.destroy(); } catch (_) {}
      reject(err);
    }
    function ok(val) {
      if (settled) return; settled = true;
      clearTimeout(timeoutHandle);
      resolve(val);
    }

    sock.once('error', fail);
    sock.once('end', () => fail(new Error('SOCKS5: upstream closed during handshake')));

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail(new Error('SOCKS5: bad version in greet'));
        if (buf[1] !== 0x00) return fail(new Error('SOCKS5: NO-AUTH not accepted'));
        buf = buf.slice(2);
        const hostBuf = Buffer.from(dstHost, 'utf8');
        const req = Buffer.alloc(7 + hostBuf.length);
        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(dstPort, 5 + hostBuf.length);
        sock.write(req);
        stage = 'connect';
      }
      if (stage === 'connect') {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05) return fail(new Error('SOCKS5: bad version in reply'));
        if (buf[1] !== 0x00) return fail(new Error(`SOCKS5: connect rejected (code ${buf[1]})`));
        const atyp = buf[3];
        let headerLen;
        if (atyp === 0x01) headerLen = 4 + 4 + 2;
        else if (atyp === 0x04) headerLen = 4 + 16 + 2;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          headerLen = 4 + 1 + buf[4] + 2;
        } else return fail(new Error('SOCKS5: unknown ATYP ' + atyp));
        if (buf.length < headerLen) return;
        const leftover = buf.slice(headerLen);
        sock.removeAllListeners('data');
        sock.removeAllListeners('end');
        sock.removeAllListeners('error');
        ok({ socket: sock, leftover });
      }
    });

    sock.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

// ----- HTTP proxy bridge -----------------------------------------------

function pipeBoth(client, upstream) {
  client.pipe(upstream);
  upstream.pipe(client);
  const drop = () => {
    try { client.destroy(); } catch (_) {}
    try { upstream.destroy(); } catch (_) {}
  };
  client.on('error', drop);
  upstream.on('error', drop);
}

function send502(client, message) {
  const body = String(message || 'Bad Gateway');
  try {
    client.write(
      'HTTP/1.1 502 Bad Gateway\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body
    );
  } catch (_) {}
  try { client.end(); } catch (_) {}
}

// Get a SOCKS5-connected upstream socket on behalf of a bridge request.
// Waits up to SOCKS_WAIT_MS for entry.state===ready (bridging respawns),
// retries once on SOCKS handshake failure (absorbs transient flaps), and
// updates the passive failure counter so a black-hole tunnel gets
// force-killed.
async function getSocksConnectionForBridge(entry, dstHost, dstPort) {
  async function tryOnce() {
    await waitUntilReady(entry, SOCKS_WAIT_MS);
    return socks5Connect('127.0.0.1', entry.socksPort, dstHost, dstPort);
  }
  try {
    const result = await tryOnce();
    recordSocksSuccess(entry);
    return result;
  } catch (err1) {
    recordSocksFailure(entry);
    // Single retry — covers brief flaps and the race where the entry
    // flipped to reconnecting while we were already inside socks5Connect.
    await new Promise((r) => setTimeout(r, SOCKS_RETRY_DELAY_MS));
    try {
      const result = await tryOnce();
      recordSocksSuccess(entry);
      return result;
    } catch (err2) {
      recordSocksFailure(entry);
      throw err2;
    }
  }
}

function recordSocksSuccess(entry) {
  entry.consecutiveFailures = 0;
}

function recordSocksFailure(entry) {
  entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
  // If we still claim 'ready' but real traffic keeps failing, the tunnel
  // is a black hole. Kill ssh -D so the normal exit→respawn path rebuilds
  // it. We don't reset the counter here; the exit handler transitions us
  // out of 'ready', at which point a fresh success will reset.
  if (
    entry.consecutiveFailures >= FAIL_THRESHOLD &&
    entry.state === 'ready' &&
    entry.sshProc
  ) {
    try { entry.sshProc.kill('SIGTERM'); } catch (_) {}
  }
}

function startHttpProxyBridge(entry) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const eoh = buf.indexOf('\r\n\r\n');
        if (eoh < 0) {
          if (buf.length > 16 * 1024) {
            try { client.write('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n'); } catch (_) {}
            try { client.destroy(); } catch (_) {}
          }
          return;
        }
        client.removeListener('data', onData);

        const headStr = buf.slice(0, eoh).toString('utf8');
        const reqLine = headStr.split('\r\n', 1)[0] || '';

        // --- CONNECT (HTTPS tunnel) -------------------------------------
        const mConnect = reqLine.match(/^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]/i);
        if (mConnect) {
          const dstHost = mConnect[1];
          const dstPort = parseInt(mConnect[2], 10);
          getSocksConnectionForBridge(entry, dstHost, dstPort).then(({ socket: upstream, leftover }) => {
            try { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch (_) {}
            if (leftover && leftover.length) {
              try { client.write(leftover); } catch (_) {}
            }
            pipeBoth(client, upstream);
          }).catch((err) => send502(client, err.message));
          return;
        }

        // --- Plain HTTP forward proxy -----------------------------------
        const mHttp = reqLine.match(/^([A-Z]+)\s+http:\/\/([^/\s:]+)(?::(\d+))?(\/[^\s]*)?\s+HTTP\/1\.[01]/i);
        if (mHttp) {
          const method = mHttp[1];
          const dstHost = mHttp[2];
          const dstPort = mHttp[3] ? parseInt(mHttp[3], 10) : 80;
          const dstPath = mHttp[4] || '/';

          const headLines = headStr.split('\r\n');
          const rebuilt = [`${method} ${dstPath} HTTP/1.1`];
          let hasHost = false;
          for (let i = 1; i < headLines.length; i++) {
            const line = headLines[i];
            const lower = line.toLowerCase();
            if (lower.startsWith('proxy-connection:')) continue;
            if (lower.startsWith('proxy-authorization:')) continue;
            if (lower.startsWith('connection:')) continue;
            if (lower.startsWith('host:')) hasHost = true;
            rebuilt.push(line);
          }
          if (!hasHost) {
            rebuilt.splice(1, 0, `Host: ${dstPort === 80 ? dstHost : `${dstHost}:${dstPort}`}`);
          }
          rebuilt.push('Connection: close');
          const rebuiltHead = rebuilt.join('\r\n') + '\r\n\r\n';
          const bodyHead = buf.slice(eoh + 4);

          client.pause();
          getSocksConnectionForBridge(entry, dstHost, dstPort).then(({ socket: upstream, leftover }) => {
            try { upstream.write(rebuiltHead); } catch (_) {}
            if (bodyHead.length) {
              try { upstream.write(bodyHead); } catch (_) {}
            }
            if (leftover && leftover.length) {
              try { client.write(leftover); } catch (_) {}
            }
            client.resume();
            pipeBoth(client, upstream);
          }).catch((err) => {
            client.resume();
            send502(client, err.message);
          });
          return;
        }

        try { client.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
        try { client.end(); } catch (_) {}
      };
      client.on('data', onData);
      client.on('error', () => { try { client.destroy(); } catch (_) {} });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

// ----- ssh process management ------------------------------------------

function spawnSshDynamicForward(sshHost, socksPort) {
  const args = [
    '-N',
    '-D', `127.0.0.1:${socksPort}`,
    '-o', 'ExitOnForwardFailure=yes',
    // Tighter than the OpenSSH default of 0 (off) / our prior 30×3. With
    // 15×2 the SSH layer notices a dead remote within ~30s instead of
    // ~90s, which is the difference between "claude looks slow once" and
    // "claude looks broken for a minute".
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    // OpenSSH default is already 'yes' but make the intent explicit:
    // we want kernel-level TCP keepalive alongside the SSH-layer pings.
    // The two detect different failure modes (TCP catches half-open
    // sockets the SSH layer might not notice promptly).
    '-o', 'TCPKeepAlive=yes',
    // Fail fast instead of hanging on a password prompt. The whole point
    // of this feature is "already passwordless" — if BatchMode breaks the
    // user's auth setup, they need to fix that anyway.
    '-o', 'BatchMode=yes',
    sshHost,
  ];
  return spawn(resolveSshPath(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// Spawn ssh and wait for the SOCKS port to listen. Wires the exit handler
// so post-start deaths trigger respawn. Throws on failure to come up.
async function startSshOnce(entry) {
  let stderrBuf = '';
  const sshProc = spawnSshDynamicForward(entry.sshHost, entry.socksPort);
  entry.sshProc = sshProc;

  sshProc.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
  });
  sshProc.once('error', (err) => {
    // Spawn-time error (e.g. binary missing). The exit handler will
    // likely also fire; carry an explanation forward either way.
    if (!entry.error) entry.error = new Error(`failed to spawn ssh: ${err.message}`);
  });
  sshProc.once('exit', (code, signal) => {
    onSshExit(entry, code, signal, stderrBuf);
  });

  try {
    await waitForPort(entry.socksPort, PORT_WAIT_MS, PORT_POLL_MS);
  } catch (err) {
    try { sshProc.kill(); } catch (_) {}
    const tail = stderrBuf.trim().slice(-400);
    throw new Error(
      `SSH SOCKS tunnel to ${entry.sshHost} did not come up: ${err.message}` +
      (tail ? `\nssh stderr: ${tail}` : '')
    );
  }
}

function onSshExit(entry, code, signal, stderrBuf) {
  // Detach so we don't try to kill an already-dead process later.
  entry.sshProc = null;

  if (entry.closed) return;

  // If we were still in initial startup, the caller of acquireTunnel is
  // about to see waitForPort fail (or already has). Don't kick off the
  // respawn loop — initial-spawn failures are surfaced synchronously.
  if (entry.state === 'starting') {
    const tail = (stderrBuf || '').trim().slice(-400);
    entry.error = entry.error || new Error(
      `ssh -D ${entry.sshHost}:${entry.socksPort} exited during startup (code=${code}, signal=${signal})` +
      (tail ? `\nssh stderr: ${tail}` : '')
    );
    return;
  }

  // Past initial startup. If anyone still cares, kick respawn.
  if (entry.refcount > 0) {
    transitionTo(entry, 'reconnecting');
    scheduleRespawn(entry, 0);
  } else {
    // Nobody waiting — release path will tear the bridge down.
    transitionTo(entry, 'closed');
  }
}

function scheduleRespawn(entry, attempt) {
  if (entry.closed || entry.state !== 'reconnecting') return;
  const delay = RESPAWN_DELAYS_MS[Math.min(attempt, RESPAWN_DELAYS_MS.length - 1)];
  entry.respawnTimer = setTimeout(async () => {
    entry.respawnTimer = null;
    if (entry.closed || entry.refcount <= 0 || entry.state !== 'reconnecting') return;
    try {
      await startSshOnce(entry);
      // startSshOnce may have synchronously turned around and exited
      // again (e.g. immediate auth failure) — onSshExit would have
      // re-scheduled, in which case state is no longer 'reconnecting'
      // with sshProc==null. Only declare ready if startSshOnce stuck.
      if (entry.sshProc && !entry.closed) {
        entry.consecutiveFailures = 0;
        transitionTo(entry, 'ready');
      }
    } catch (err) {
      entry.error = err;
      // Keep trying — caller decides when to give up by releasing.
      scheduleRespawn(entry, attempt + 1);
    }
  }, delay);
}

// ----- public API ------------------------------------------------------

async function acquireTunnel(sshHost, socksPort) {
  if (!sshHost || !String(sshHost).trim()) throw new Error('sshHost is required');
  socksPort = parseInt(socksPort, 10);
  if (!Number.isFinite(socksPort) || socksPort < 1 || socksPort > 65535) {
    throw new Error('socksPort must be 1..65535');
  }

  const key = tunnelKey(sshHost, socksPort);
  let entry = tunnels.get(key);
  if (entry) {
    // Existing entry — wait for it to settle (ready / failed) before
    // bumping the refcount. If currently reconnecting, we wait too —
    // joining an in-flight respawn is the same as a fresh acquire.
    try {
      await waitUntilReady(entry, SOCKS_WAIT_MS);
    } catch (err) {
      // Either failed or timeout. If it's a 'failed' terminal entry,
      // drop it and fall through to a fresh start.
      if (entry.state === 'failed' || entry.state === 'closed') {
        tunnels.delete(key);
        entry = null;
      } else {
        throw err;
      }
    }
    if (entry) {
      entry.refcount++;
      return makeHandle(key, entry);
    }
  }

  entry = {
    sshHost,
    socksPort,
    state: 'starting',
    sshProc: null,
    bridgeServer: null,
    bridgePort: 0,
    refcount: 1,
    error: null,
    stateListeners: [],
    consecutiveFailures: 0,
    respawnTimer: null,
    closed: false,
  };
  tunnels.set(key, entry);

  try {
    await startSshOnce(entry);
    // Bridge is the long-lived component — outlives any single ssh -D
    // and keeps its ephemeral port stable across respawns.
    const { server, port } = await startHttpProxyBridge(entry);
    entry.bridgeServer = server;
    entry.bridgePort = port;
    transitionTo(entry, 'ready');
  } catch (err) {
    entry.error = err;
    transitionTo(entry, 'failed');
    cleanupEntry(entry);
    tunnels.delete(key);
    throw err;
  }

  return makeHandle(key, entry);
}

function makeHandle(key, entry) {
  let released = false;
  return {
    sshHost: entry.sshHost,
    socksPort: entry.socksPort,
    bridgePort: entry.bridgePort,
    release() {
      if (released) return;
      released = true;
      entry.refcount--;
      if (entry.refcount > 0) return;
      // Last referrer — fully tear down.
      entry.closed = true;
      if (tunnels.get(key) === entry) tunnels.delete(key);
      cleanupEntry(entry);
      transitionTo(entry, 'closed');
    },
  };
}

function cleanupEntry(entry) {
  if (entry.respawnTimer) {
    clearTimeout(entry.respawnTimer);
    entry.respawnTimer = null;
  }
  if (entry.bridgeServer) {
    try { entry.bridgeServer.close(); } catch (_) {}
    entry.bridgeServer = null;
  }
  if (entry.sshProc) {
    try { entry.sshProc.kill(); } catch (_) {}
    entry.sshProc = null;
  }
}

module.exports = { acquireTunnel };
