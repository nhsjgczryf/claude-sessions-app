// SSH SOCKS5 tunnel manager + built-in HTTP CONNECT bridge.
//
// Why this exists: users want to run `claude` locally (Windows or macOS)
// but have its outbound HTTP/HTTPS traffic exit from a remote Linux box
// they've already set up SSH passwordless access to. `ssh -D` provides
// the SOCKS5 endpoint; the HTTP bridge converts it to a regular HTTP
// proxy so anything that respects HTTPS_PROXY=http://... works, including
// the Anthropic SDK / claude-code which doesn't natively grok socks5://.
//
// One tunnel per (sshHost, socksPort) tuple, refcounted across tabs.
// First acquireTunnel() starts ssh + bridge; last release() tears both
// down. The handle returned to callers is opaque: callers only need to
// know the bridge port (to set HTTP_PROXY) and to call release() on exit.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

// Cached, platform-aware path to `ssh`. Mirrors main.js#resolveSshPath
// (kept duplicated rather than imported, since this module is loaded by
// both the Electron main process and the web server).
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

// Tunnels keyed by `${sshHost}|${socksPort}`. Value:
//   { sshHost, socksPort, sshProc, bridgeServer, bridgePort,
//     refcount, ready, readyPromise, error }
const tunnels = new Map();

function tunnelKey(sshHost, socksPort) {
  return `${sshHost}|${socksPort}`;
}

// Poll-connect to 127.0.0.1:port until it accepts a TCP connection or we
// time out. ssh -D doesn't print anything on success, so this is how we
// know the SOCKS port is actually listening.
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

// SOCKS5 client: open a TCP socket to socksHost:socksPort, perform the
// NO-AUTH handshake, then issue CONNECT for dstHost:dstPort. Resolves
// once the upstream connect succeeds, with `{ socket, leftover }`. The
// `leftover` buffer is whatever bytes followed the SOCKS5 reply (rare,
// but possible if the remote sent data on the heels of the connect).
function socks5Connect(socksHost, socksPort, dstHost, dstPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: socksHost, port: socksPort });
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (err) => {
      if (settled) return; settled = true;
      try { sock.destroy(); } catch (_) {}
      reject(err);
    };
    const ok = (val) => {
      if (settled) return; settled = true;
      resolve(val);
    };

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

    // Greeting: SOCKS5, one method, NO-AUTH (0x00).
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

// Bidirectional pipe between two sockets, with cross-destroy on error.
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

// Start a local HTTP proxy that tunnels every request through SOCKS5 at
// socksHost:socksPort. Handles both modes a Node-based / curl-like
// client would speak:
//
//   1. CONNECT host:port HTTP/1.1   — HTTPS tunnel; we open SOCKS to
//      host:port, reply 200 to the client, then pipe bytes both ways.
//      This is what claude-code uses for api.anthropic.com.
//
//   2. METHOD http://host[:port]/path HTTP/1.1   — forward-proxy form
//      for plain HTTP. We strip proxy-only headers, rewrite the request
//      line to a relative URI, open SOCKS to host:port, replay the
//      head + any body bytes already buffered, then pipe both ways.
//
// Resolves once the proxy is listening on an ephemeral 127.0.0.1 port.
function startHttpProxyBridge(socksHost, socksPort) {
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
          // Clients are spec-bound to wait for 200 before sending data,
          // so anything past \r\n\r\n here is a misbehaving client. Drop
          // it on the floor rather than smuggle it through.
          socks5Connect(socksHost, socksPort, dstHost, dstPort).then(({ socket: upstream, leftover }) => {
            try { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch (_) {}
            if (leftover && leftover.length) {
              try { client.write(leftover); } catch (_) {}
            }
            pipeBoth(client, upstream);
          }).catch((err) => send502(client, err.message));
          return;
        }

        // --- Plain HTTP forward proxy -----------------------------------
        // Match: METHOD http://host[:port][/path] HTTP/1.x
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
            // Hop-by-hop / proxy-only headers — must not be forwarded.
            if (lower.startsWith('proxy-connection:')) continue;
            if (lower.startsWith('proxy-authorization:')) continue;
            // Force Connection: close to keep this proxy stateless —
            // no pipelining, no keep-alive tracking, one request per TCP.
            if (lower.startsWith('connection:')) continue;
            if (lower.startsWith('host:')) hasHost = true;
            rebuilt.push(line);
          }
          if (!hasHost) {
            rebuilt.splice(1, 0, `Host: ${dstPort === 80 ? dstHost : `${dstHost}:${dstPort}`}`);
          }
          rebuilt.push('Connection: close');
          const rebuiltHead = rebuilt.join('\r\n') + '\r\n\r\n';
          const bodyHead = buf.slice(eoh + 4); // any request-body bytes already buffered

          // Pause until the upstream is ready, so body bytes that arrive
          // during the SOCKS handshake aren't dropped.
          client.pause();
          socks5Connect(socksHost, socksPort, dstHost, dstPort).then(({ socket: upstream, leftover }) => {
            try { upstream.write(rebuiltHead); } catch (_) {}
            if (bodyHead.length) {
              try { upstream.write(bodyHead); } catch (_) {}
            }
            // `leftover` is bytes the SOCKS server sent after the reply;
            // should always be empty for a fresh CONNECT, but if non-zero
            // it's already part of the upstream response stream.
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

        // Neither CONNECT nor absolute-URI HTTP — likely someone hit the
        // bridge with a relative-path GET expecting a real web server.
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

function spawnSshDynamicForward(sshHost, socksPort) {
  const args = [
    '-N',
    '-D', `127.0.0.1:${socksPort}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    // Fail fast instead of hanging on a password prompt. The whole
    // point of this feature is "already passwordless" — if BatchMode
    // breaks the user's auth setup, they need to fix that anyway.
    '-o', 'BatchMode=yes',
    sshHost,
  ];
  return spawn(resolveSshPath(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// Acquire (or attach to) a SOCKS-over-SSH tunnel for `sshHost`, listening
// at `socksPort`. Returns `{ sshHost, socksPort, bridgePort, release() }`.
// `bridgePort` is the local HTTP proxy port the caller should expose to
// the spawned process via HTTP_PROXY / HTTPS_PROXY.
async function acquireTunnel(sshHost, socksPort) {
  if (!sshHost || !String(sshHost).trim()) throw new Error('sshHost is required');
  socksPort = parseInt(socksPort, 10);
  if (!Number.isFinite(socksPort) || socksPort < 1 || socksPort > 65535) {
    throw new Error('socksPort must be 1..65535');
  }

  const key = tunnelKey(sshHost, socksPort);
  let entry = tunnels.get(key);
  if (entry) {
    // Either already up, or still in the middle of coming up — wait,
    // then bump refcount. If start-up failed before we got here, the
    // failed entry has already been deleted by the start-up logic, so
    // the lookup above misses it and we fall through to fresh-start.
    if (entry.readyPromise) {
      try { await entry.readyPromise; } catch (err) { throw err; }
    }
    entry.refcount++;
    return makeHandle(key, entry);
  }

  entry = {
    sshHost, socksPort,
    sshProc: null, bridgeServer: null, bridgePort: 0,
    refcount: 1, ready: false, readyPromise: null, error: null,
  };
  tunnels.set(key, entry);

  entry.readyPromise = (async () => {
    let stderrBuf = '';
    const sshProc = spawnSshDynamicForward(sshHost, socksPort);
    entry.sshProc = sshProc;

    sshProc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      // Cap to a reasonable size so a chatty ssh doesn't leak memory.
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });
    sshProc.once('error', (err) => {
      entry.error = new Error(`failed to spawn ssh: ${err.message}`);
    });
    sshProc.once('exit', (code, signal) => {
      const tail = stderrBuf.trim().slice(-400);
      entry.error = entry.error || new Error(
        `ssh -D ${sshHost}:${socksPort} exited (code=${code}, signal=${signal})` +
        (tail ? `\nssh stderr: ${tail}` : '')
      );
      if (entry.bridgeServer) {
        try { entry.bridgeServer.close(); } catch (_) {}
      }
      // Don't leave a dead entry in the map — next acquireTunnel() must
      // start a fresh ssh.
      if (tunnels.get(key) === entry) tunnels.delete(key);
    });

    try {
      await waitForPort(socksPort, 12000, 200);
    } catch (err) {
      try { sshProc.kill(); } catch (_) {}
      const tail = stderrBuf.trim().slice(-400);
      const wrapped = new Error(
        `SSH SOCKS tunnel to ${sshHost} did not come up: ${err.message}` +
        (tail ? `\nssh stderr: ${tail}` : '')
      );
      entry.error = wrapped;
      if (tunnels.get(key) === entry) tunnels.delete(key);
      throw wrapped;
    }

    const { server, port } = await startHttpProxyBridge('127.0.0.1', socksPort);
    entry.bridgeServer = server;
    entry.bridgePort = port;
    entry.ready = true;
  })();

  try {
    await entry.readyPromise;
  } catch (err) {
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
      if (tunnels.get(key) === entry) tunnels.delete(key);
      if (entry.bridgeServer) {
        try { entry.bridgeServer.close(); } catch (_) {}
      }
      if (entry.sshProc) {
        try { entry.sshProc.kill(); } catch (_) {}
      }
    },
  };
}

module.exports = { acquireTunnel };
