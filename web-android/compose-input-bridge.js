/*
 * Thin wrapper around the native ComposeInputPlugin (the EditText +
 * Send bar docked below the WebView). Using a NATIVE input avoids the
 * Android WebView Chromium bug where editing CJK / non-Latin text in
 * the middle of a web textarea snaps the caret to the end. When the
 * plugin is present, renderer.js routes all message composition
 * through it; otherwise it falls back to the in-WebView compose box.
 */
(function () {
  'use strict';

  const PLUGIN = window.Capacitor &&
    window.Capacitor.Plugins &&
    window.Capacitor.Plugins.ComposeInput;

  const submitListeners = new Set();

  if (PLUGIN) {
    PLUGIN.addListener('submit', (ev) => {
      for (const cb of submitListeners) { try { cb(ev); } catch (_) {} }
    });
  }

  window.ComposeInputBridge = {
    available: !!PLUGIN,

    async setActive(active) {
      if (!PLUGIN) return;
      return PLUGIN.setActive({ active: !!active });
    },
    async clear() {
      if (!PLUGIN) return;
      return PLUGIN.clear();
    },
    async insertNewline() {
      if (!PLUGIN) return;
      return PLUGIN.insertNewline();
    },
    async focus() {
      if (!PLUGIN) return;
      return PLUGIN.focus();
    },
    // Resolves { ready } — false if the native views weren't found
    // (layout override didn't apply), so renderer can fall back to
    // the in-page compose box.
    async isReady() {
      if (!PLUGIN) return { ready: false };
      try { return await PLUGIN.isReady(); } catch (_) { return { ready: false }; }
    },

    // cb receives { text } when the native Send button is tapped.
    onSubmit(cb) { submitListeners.add(cb); return () => submitListeners.delete(cb); },
  };
})();
