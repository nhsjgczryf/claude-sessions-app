/*
 * Thin JS wrapper around the SSH Capacitor plugin (defined in
 * android-native/SshPlugin.kt). Exposes a renderer-friendly API that
 * mirrors what the web version got from its WebSocket: connect →
 * data/exit events keyed by tabId, write/resize/close, sftpPut for
 * image uploads.
 *
 * Falls back to a noisy stub when running outside Capacitor (e.g. when
 * opening this app's web-android/ folder in a desktop browser for
 * styling work). The stub doesn't actually SSH; it just makes the UI
 * not crash.
 */

(function () {
  'use strict';

  const inCapacitor = !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SSH);
  const SSH = inCapacitor ? window.Capacitor.Plugins.SSH : null;
  const Preferences = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences) || null;

  // Fan out the plugin's notifyListeners('data'|'exit'|'warning') to
  // anything that subscribed via window.SshBridge.onData / onExit.
  const dataListeners = new Set();
  const exitListeners = new Set();
  const warningListeners = new Set();
  const statusListeners = new Set();

  if (SSH) {
    SSH.addListener('data', (ev) => {
      for (const cb of dataListeners) { try { cb(ev); } catch (_) {} }
    });
    SSH.addListener('exit', (ev) => {
      for (const cb of exitListeners) { try { cb(ev); } catch (_) {} }
    });
    SSH.addListener('warning', (ev) => {
      for (const cb of warningListeners) { try { cb(ev); } catch (_) {} }
      console.warn('[ssh] warning:', ev);
    });
    // 'status' fires during connect with phase strings like "Connecting…",
    // "Authenticating…", "Opening shell…", "Ready" — used by the
    // renderer to keep the user informed while sshj's blocking calls
    // are still in progress.
    SSH.addListener('status', (ev) => {
      for (const cb of statusListeners) { try { cb(ev); } catch (_) {} }
    });
  }

  function notSupported(name) {
    console.warn(`[ssh-bridge] ${name}() called but SSH plugin not available (running outside Capacitor?)`);
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  window.SshBridge = {
    available: inCapacitor,

    // params: { tabId, host, port, username, password|privateKey,
    //           privateKeyPassphrase, cols, rows, initialCommand,
    //           portForwards: ['14500:localhost:14500', ...] }
    async connect(params) {
      if (!SSH) { notSupported('connect'); return; }
      return SSH.connect(params);
    },

    async write(tabId, data) {
      if (!SSH) { notSupported('write'); return; }
      return SSH.write({ tabId, data });
    },

    async resize(tabId, cols, rows) {
      if (!SSH) { notSupported('resize'); return; }
      return SSH.resize({ tabId, cols, rows });
    },

    async close(tabId) {
      if (!SSH) { notSupported('close'); return; }
      return SSH.close({ tabId });
    },

    // Tell native which SSH tab is currently focused so the
    // ClaudeSessionsWebView InputConnection wrapper can route OS-level
    // IME input straight into its sshj outputStream. Pass tabId=null
    // to deactivate (editor modal opened, other tab kind activated).
    async setActiveTab(tabId) {
      if (!SSH) return;
      return SSH.setActiveTab({ tabId: tabId == null ? null : tabId });
    },

    async sftpPut(tabId, remotePath, blob) {
      if (!SSH) { notSupported('sftpPut'); return; }
      const dataBase64 = await blobToBase64(blob);
      return SSH.sftpPut({ tabId, remotePath, dataBase64 });
    },

    async listActive() {
      if (!SSH) { return { tabIds: [] }; }
      return SSH.listActive();
    },

    onData(cb)    { dataListeners.add(cb);    return () => dataListeners.delete(cb); },
    onExit(cb)    { exitListeners.add(cb);    return () => exitListeners.delete(cb); },
    onWarning(cb) { warningListeners.add(cb); return () => warningListeners.delete(cb); },
    onStatus(cb)  { statusListeners.add(cb);  return () => statusListeners.delete(cb); },
  };

  // Lightweight key/value store. Uses Capacitor Preferences when
  // available (survives app updates / WebView cache wipes), falls
  // back to localStorage in the browser.
  window.Store = {
    async get(key) {
      if (Preferences) {
        const { value } = await Preferences.get({ key });
        return value == null ? null : safeParse(value);
      }
      const v = localStorage.getItem(key);
      return v == null ? null : safeParse(v);
    },
    async set(key, value) {
      const v = JSON.stringify(value);
      if (Preferences) return Preferences.set({ key, value: v });
      localStorage.setItem(key, v);
    },
    async remove(key) {
      if (Preferences) return Preferences.remove({ key });
      localStorage.removeItem(key);
    },
  };

  function safeParse(s) {
    try { return JSON.parse(s); } catch (_) { return s; }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const dataUrl = fr.result;
        const idx = String(dataUrl).indexOf(',');
        resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
      };
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }
})();
