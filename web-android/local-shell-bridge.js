/*
 * Thin JS wrapper around the LocalShell Capacitor plugin defined in
 * android-native/LocalShellPlugin.kt. Mirrors the API surface of
 * SshBridge so renderer.js can use whichever bridge matches the
 * session type without an if-ladder at every call site.
 *
 * Falls back to a noisy no-op when Capacitor isn't present (desktop
 * browser dev, or when the plugin failed to register).
 */
(function () {
  'use strict';

  const SHELL = window.Capacitor &&
    window.Capacitor.Plugins &&
    window.Capacitor.Plugins.LocalShell;

  const dataListeners = new Set();
  const exitListeners = new Set();

  if (SHELL) {
    SHELL.addListener('data', (ev) => {
      for (const cb of dataListeners) { try { cb(ev); } catch (_) {} }
    });
    SHELL.addListener('exit', (ev) => {
      for (const cb of exitListeners) { try { cb(ev); } catch (_) {} }
    });
  }

  function notSupported(name) {
    console.warn(`[local-shell-bridge] ${name}() — LocalShell plugin missing`);
  }

  window.LocalShellBridge = {
    available: !!SHELL,

    async connect(params) {
      if (!SHELL) { notSupported('connect'); return; }
      return SHELL.connect(params);
    },
    async write(tabId, data) {
      if (!SHELL) { notSupported('write'); return; }
      return SHELL.write({ tabId, data });
    },
    async resize(tabId, cols, rows) {
      if (!SHELL) { notSupported('resize'); return; }
      return SHELL.resize({ tabId, cols, rows });
    },
    async close(tabId) {
      if (!SHELL) { notSupported('close'); return; }
      return SHELL.close({ tabId });
    },

    onData(cb) { dataListeners.add(cb); return () => dataListeners.delete(cb); },
    onExit(cb) { exitListeners.add(cb); return () => exitListeners.delete(cb); },
  };
})();
