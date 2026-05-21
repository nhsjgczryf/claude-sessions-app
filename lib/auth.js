// Single-account authentication for the web version.
//
// Security choices:
//   - scrypt (Node built-in) for password hashing — N=2^15, r=8, p=1.
//     No native module deps. OWASP-aligned parameters.
//   - 16-byte random salt per password.
//   - constant-time comparisons throughout (timingSafeEqual).
//   - 32-byte session ids (base64url) generated with crypto.randomBytes.
//   - Sessions stored in-memory + persisted to disk so they survive a
//     restart. Each entry has an expiresAt (default 7d).
//   - First-run registration is gated by a one-time code printed to the
//     server console at startup, so an attacker can't race to register.
//   - Login attempts are throttled per IP (5 / 15min).
//   - Username enumeration: when no account exists or the username
//     doesn't match, we still run a real scrypt verify against a dummy
//     hash so timing is indistinguishable from a wrong-password case.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUTH_PATH = path.join(ROOT, 'auth.json');
const SESSIONS_PATH = path.join(ROOT, 'auth-sessions.json');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

const PASSWORD_MIN_LEN = 12;
const USERNAME_MAX_LEN = 64;

// In-memory session table. Persisted to disk on each mutation so a
// process restart doesn't immediately log everyone out.
let sessions = loadSessionsFromDisk();

// Throttle login attempts per IP.
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 5;
const rateLimit = new Map(); // ip -> { count, resetAt }

// A dummy hash kept around so failed-username paths can run a real
// scrypt verify and stay timing-equivalent to a wrong-password attempt.
const DUMMY_HASH_PROMISE = hashPassword('a-dummy-password-used-only-for-timing-equalisation');

// ---------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS, (err, derived) => {
      if (err) return reject(err);
      resolve(
        `scrypt$${SCRYPT_OPTS.N}$${SCRYPT_OPTS.r}$${SCRYPT_OPTS.p}$` +
        `${salt.toString('hex')}$${derived.toString('hex')}`
      );
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    let salt, expected;
    try {
      salt = Buffer.from(parts[4], 'hex');
      expected = Buffer.from(parts[5], 'hex');
    } catch (_) { return resolve(false); }
    crypto.scrypt(password, salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 }, (err, derived) => {
      if (err) return resolve(false);
      try { resolve(crypto.timingSafeEqual(derived, expected)); }
      catch (_) { resolve(false); }
    });
  });
}

// ---------------------------------------------------------------------
// Auth.json IO
// ---------------------------------------------------------------------

function loadAuth() {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('[auth] failed to read auth.json:', err);
  }
  return null;
}

function saveAuth(data) {
  fs.writeFileSync(AUTH_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function isRegistered() {
  return loadAuth() !== null;
}

// ---------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------

function loadSessionsFromDisk() {
  try {
    if (fs.existsSync(SESSIONS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf-8'));
      const now = Date.now();
      const m = new Map();
      for (const [id, s] of Object.entries(raw || {})) {
        if (s && s.expiresAt > now) m.set(id, s);
      }
      return m;
    }
  } catch (_) {}
  return new Map();
}

function persistSessions() {
  try {
    const obj = {};
    for (const [id, s] of sessions) obj[id] = s;
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(obj), { mode: 0o600 });
  } catch (err) {
    console.error('[auth] failed to persist sessions:', err);
  }
}

function createSession(username) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(sessionId, { username, expiresAt });
  persistSessions();
  return { sessionId, expiresAt };
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    persistSessions();
    return null;
  }
  return s;
}

function deleteSession(sessionId) {
  if (sessions.delete(sessionId)) persistSessions();
}

function deleteAllSessions() {
  sessions.clear();
  persistSessions();
}

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) { sessions.delete(id); changed = true; }
  }
  if (changed) persistSessions();
}, 60 * 60 * 1000);

// ---------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);
  if (!entry || entry.resetAt < now) {
    rateLimit.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return { ok: true };
  }
  if (entry.count >= RL_MAX) {
    return { ok: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count++;
  return { ok: true };
}

function resetRateLimit(ip) {
  rateLimit.delete(ip);
}

// ---------------------------------------------------------------------
// Registration code (one-time, in-memory)
// ---------------------------------------------------------------------

let registrationCode = null;

function ensureRegistrationCode() {
  if (isRegistered()) { registrationCode = null; return null; }
  if (!registrationCode) {
    registrationCode = crypto.randomBytes(12).toString('base64url');
  }
  return registrationCode;
}

function consumeRegistrationCode(code) {
  if (!registrationCode || !code) return false;
  const a = Buffer.from(registrationCode);
  const b = Buffer.from(String(code));
  if (a.length !== b.length) {
    // keep timing-ish equivalent
    try { crypto.timingSafeEqual(a, a); } catch (_) {}
    return false;
  }
  if (!crypto.timingSafeEqual(a, b)) return false;
  registrationCode = null;
  return true;
}

// ---------------------------------------------------------------------
// Public ops
// ---------------------------------------------------------------------

function validateUsername(s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= USERNAME_MAX_LEN
    && /^[A-Za-z0-9._-]+$/.test(s);
}

function validatePassword(s) {
  return typeof s === 'string' && s.length >= PASSWORD_MIN_LEN && s.length <= 256;
}

async function register({ username, password, code }) {
  // Validate inputs first so a typo in username/password doesn't burn
  // the one-time registration code.
  if (isRegistered()) {
    const err = new Error('account already exists'); err.status = 409; throw err;
  }
  if (!validateUsername(username)) {
    const err = new Error('username must be 1–64 chars, [A-Za-z0-9._-]'); err.status = 400; throw err;
  }
  if (!validatePassword(password)) {
    const err = new Error(`password must be ${PASSWORD_MIN_LEN}–256 characters`); err.status = 400; throw err;
  }
  if (!consumeRegistrationCode(code)) {
    const err = new Error('invalid or expired registration code'); err.status = 403; throw err;
  }
  const passwordHash = await hashPassword(password);
  saveAuth({
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
  });
  return createSession(username);
}

async function login({ username, password }) {
  const auth = loadAuth();
  // Always run a real scrypt verify to keep timing flat.
  const dummyHash = await DUMMY_HASH_PROMISE;
  if (!auth) {
    await verifyPassword(password || '', dummyHash);
    const err = new Error('not registered'); err.status = 401; throw err;
  }
  const userBuf = Buffer.from(String(auth.username || ''));
  const inputBuf = Buffer.from(String(username || ''));
  let usernameOk;
  if (userBuf.length !== inputBuf.length) {
    try { crypto.timingSafeEqual(userBuf, userBuf); } catch (_) {}
    usernameOk = false;
  } else {
    usernameOk = crypto.timingSafeEqual(userBuf, inputBuf);
  }
  const passwordOk = await verifyPassword(password || '', auth.passwordHash);
  if (!(usernameOk && passwordOk)) {
    const err = new Error('invalid credentials'); err.status = 401; throw err;
  }
  return createSession(auth.username);
}

// ---------------------------------------------------------------------
// Env-based bootstrap (CS_PASSWORD)
// ---------------------------------------------------------------------
//
// Personal-use shortcut: set CS_PASSWORD (and optionally CS_USERNAME)
// and the server provisions the single account at startup with no
// registration-code dance. If an account already exists with a
// different password, the env value wins (re-provisions) so you can
// rotate the password by just changing the env var and restarting.
// The password may be anything you like — e.g. the same string you
// use for SSH (it's hashed and stored here, never checked against the
// system credential store).
async function bootstrapFromEnv() {
  const password = process.env.CS_PASSWORD;
  if (!password) return false;
  const username = process.env.CS_USERNAME || 'user';
  if (!validatePassword(password)) {
    console.error(`[auth] CS_PASSWORD must be ${PASSWORD_MIN_LEN}–256 chars; ignoring.`);
    return false;
  }
  const existing = loadAuth();
  if (existing && existing.username === username) {
    // Re-verify: only rewrite if the password actually changed, to
    // avoid churning the salt/hash on every restart.
    try {
      const ok = await verifyPassword(password, existing.passwordHash);
      if (ok) return true;            // already provisioned with this password
    } catch (_) {}
  }
  const passwordHash = await hashPassword(password);
  saveAuth({ username, passwordHash, createdAt: new Date().toISOString() });
  registrationCode = null;            // no longer needed
  console.log(`[auth] account provisioned from CS_PASSWORD (user: ${username}).`);
  return true;
}

module.exports = {
  isRegistered,
  ensureRegistrationCode,
  bootstrapFromEnv,
  register,
  login,
  getSession,
  deleteSession,
  deleteAllSessions,
  checkRateLimit,
  resetRateLimit,
  SESSION_TTL_MS,
  PASSWORD_MIN_LEN,
};
