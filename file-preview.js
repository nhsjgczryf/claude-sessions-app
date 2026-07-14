/*
 * Shared read-only file preview (Tier 0). Used identically by all three
 * frontends — Electron desktop, the web UI, and the Android APK — so the
 * render logic lives in ONE place; each frontend only supplies a
 * transport-specific read() and a trigger.
 *
 *   window.FilePreview.open({
 *     path,                         // raw path (may have quotes / :line:col)
 *     read(path, maxBytes) -> { base64, size, truncated },
 *     clip(text),                   // optional: copy to clipboard
 *     notify(msg, type),            // optional: toast (falls back to console)
 *     openExternal(url),            // optional: open links (falls back to window.open)
 *   })
 *
 * Renders markdown (+LaTeX via KaTeX), images, and plain text. The libs
 * (marked / DOMPurify / katex / renderMathInElement) are read off the
 * global scope and each is feature-detected — absent ones degrade to
 * plain text. DOMPurify matters: the preview shares its document with
 * the app (and, on the APK, the Capacitor native bridge), so marked's
 * HTML is sanitized before injection.
 *
 * The module is self-contained: it injects its own CSS and builds its
 * own overlay on first use, so a frontend only needs to load this script
 * (plus the lib <script>/<link> tags) — no markup or CSS to copy.
 */
(function () {
  'use strict';

  const IMG_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  };
  const MD_EXT = { md: 1, markdown: 1, mdown: 1, mkd: 1, mkdn: 1, markdn: 1 };
  const IMG_MAX = 10 * 1024 * 1024;   // base64 inflates ~33%; cap so the WebView survives
  const TEXT_MAX = 1024 * 1024;

  // ---- helpers ------------------------------------------------------

  // Normalize a path token grabbed from terminal output: strip wrapping
  // quotes/backticks/parens and a trailing :line[:col] (claude prints
  // "Edited src/foo.ts:42") so the path actually resolves.
  function cleanPath(raw) {
    let p = (raw || '').trim();
    p = p.replace(/^[`'"(<\[]+/, '').replace(/[`'")>\].,]+$/, '');
    p = p.replace(/:\d+(:\d+)?$/, '');
    return p.trim();
  }
  function extOf(p) {
    const base = p.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  }
  function b64ToBytes(b64) {
    const bin = atob(b64 || '');
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function looksBinary(bytes) {
    const n = Math.min(bytes.length, 8192);   // a NUL up front = binary
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  }
  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ---- one-time CSS + overlay ---------------------------------------

  function injectStyle() {
    if (document.getElementById('file-preview-style')) return;
    const css = `
#file-preview{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:450;padding:16px}
#file-preview.hidden{display:none}
#file-preview .fp-box{background:var(--bg2,#252536);border:1px solid var(--border,#45475a);border-radius:8px;width:100%;max-width:760px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
#file-preview .fp-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border,#45475a);background:var(--bg,#1e1e2e)}
#file-preview .fp-path{flex:1;min-width:0;font-family:'Cascadia Code','Consolas',monospace;font-size:12px;color:var(--accent,#89b4fa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;user-select:text}
#file-preview .fp-head button{flex:0 0 auto;min-height:34px;min-width:40px;font-family:inherit;font-size:12px;color:var(--fg,#cdd6f4);background:var(--input-bg,#313244);border:1px solid var(--border,#45475a);border-radius:4px;cursor:pointer;padding:4px 10px}
#file-preview .fp-close{font-size:20px;line-height:1;padding:2px 10px;background:transparent!important;border:none!important;color:var(--fg-dim,#6c7086)!important}
#file-preview .fp-close:hover{color:var(--red,#f38ba8)!important}
#file-preview .fp-banner{padding:6px 12px;font-size:12px;border-bottom:1px solid var(--border,#45475a)}
#file-preview .fp-banner.hidden{display:none}
#file-preview .fp-banner.warn{background:rgba(249,226,175,.15);color:var(--yellow,#f9e2af)}
#file-preview .fp-banner.error{background:rgba(243,139,168,.15);color:var(--red,#f38ba8)}
#file-preview .fp-body{flex:1;overflow:auto;padding:14px 16px;font-size:14px;line-height:1.55;color:var(--fg,#cdd6f4);user-select:text;-webkit-user-select:text}
#file-preview .fp-body.is-image{display:flex;align-items:center;justify-content:center;background:linear-gradient(45deg,#2a2a3a 25%,transparent 25%) -8px 0/16px 16px,linear-gradient(-45deg,#2a2a3a 25%,transparent 25%) -8px 0/16px 16px,linear-gradient(45deg,transparent 75%,#2a2a3a 75%) -8px 0/16px 16px,linear-gradient(-45deg,transparent 75%,#2a2a3a 75%) -8px 0/16px 16px,var(--bg,#1e1e2e)}
#file-preview .fp-body.is-image img{max-width:100%;max-height:76vh;object-fit:contain}
#file-preview .fp-body.is-text pre{margin:0;font-family:'Cascadia Code','Consolas',monospace;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
#file-preview .fp-body.is-markdown h1,#file-preview .fp-body.is-markdown h2,#file-preview .fp-body.is-markdown h3{color:var(--accent,#89b4fa);margin:.8em 0 .4em;line-height:1.3}
#file-preview .fp-body.is-markdown h1{font-size:1.5em;border-bottom:1px solid var(--border,#45475a);padding-bottom:.2em}
#file-preview .fp-body.is-markdown h2{font-size:1.3em;border-bottom:1px solid var(--border,#45475a);padding-bottom:.2em}
#file-preview .fp-body.is-markdown h3{font-size:1.12em}
#file-preview .fp-body.is-markdown p{margin:.6em 0}
#file-preview .fp-body.is-markdown a{color:var(--accent,#89b4fa)}
#file-preview .fp-body.is-markdown code{font-family:'Cascadia Code','Consolas',monospace;font-size:.88em;background:var(--input-bg,#313244);padding:1px 5px;border-radius:4px}
#file-preview .fp-body.is-markdown pre{background:var(--bg,#1e1e2e);border:1px solid var(--border,#45475a);border-radius:6px;padding:10px 12px;overflow-x:auto}
#file-preview .fp-body.is-markdown pre code{background:none;padding:0}
#file-preview .fp-body.is-markdown blockquote{margin:.6em 0;padding:.2em .9em;border-left:3px solid var(--border,#45475a);color:var(--fg-dim,#6c7086)}
#file-preview .fp-body.is-markdown table{border-collapse:collapse;margin:.6em 0;display:block;overflow-x:auto}
#file-preview .fp-body.is-markdown th,#file-preview .fp-body.is-markdown td{border:1px solid var(--border,#45475a);padding:5px 9px}
#file-preview .fp-body.is-markdown img{max-width:100%}
#file-preview .fp-body.is-markdown hr{border:none;border-top:1px solid var(--border,#45475a);margin:1em 0}
#file-preview .fp-body.is-markdown ul,#file-preview .fp-body.is-markdown ol{padding-left:1.4em}
`;
    const st = document.createElement('style');
    st.id = 'file-preview-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  let overlay, pathEl, bannerEl, bodyEl, copyBtn;
  let state = { text: null, clip: null, notify: null };

  function noticer(fn) { return fn || ((m) => { try { console.log('[preview]', m); } catch (_) {} }); }

  function buildOverlay() {
    if (overlay) return;
    injectStyle();
    overlay = document.getElementById('file-preview');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'file-preview';
      overlay.className = 'hidden';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML =
      '<div class="fp-box">' +
      '<div class="fp-head">' +
      '<span class="fp-path"></span>' +
      '<button type="button" class="fp-copy" title="Copy file contents">Copy</button>' +
      '<button type="button" class="fp-close" title="Close">×</button>' +
      '</div>' +
      '<div class="fp-banner hidden"></div>' +
      '<div class="fp-body"></div>' +
      '</div>';
    pathEl = overlay.querySelector('.fp-path');
    bannerEl = overlay.querySelector('.fp-banner');
    bodyEl = overlay.querySelector('.fp-body');
    copyBtn = overlay.querySelector('.fp-copy');
    overlay.querySelector('.fp-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    copyBtn.addEventListener('click', () => {
      if (state.text == null) { state.notify('No text to copy', 'info'); return; }
      if (state.clip) state.clip(state.text);
      state.notify('Copied file contents', 'success');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) close();
    });
  }

  function setBanner(text, kind) {
    if (!bannerEl) return;
    if (!text) { bannerEl.classList.add('hidden'); return; }
    bannerEl.textContent = text;
    bannerEl.className = 'fp-banner' + (kind ? ' ' + kind : '');
    bannerEl.classList.remove('hidden');
  }

  function renderMarkdown(text, openExternal) {
    bodyEl.classList.add('is-markdown');
    let html;
    try {
      html = window.marked.parse(text, { breaks: true, gfm: true });
    } catch (_) {
      bodyEl.classList.remove('is-markdown'); bodyEl.classList.add('is-text');
      const pre = document.createElement('pre'); pre.textContent = text;
      bodyEl.textContent = ''; bodyEl.appendChild(pre); return;
    }
    bodyEl.innerHTML = window.DOMPurify.sanitize(html);
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(bodyEl, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
      } catch (_) {}
    }
    bodyEl.querySelectorAll('a[href]').forEach((a) => {
      a.addEventListener('click', (ev) => {
        const href = a.getAttribute('href') || '';
        if (href.startsWith('#')) return;   // in-document anchors are harmless
        // Everything else must be intercepted: a relative href would navigate
        // the WHOLE window/tab away from the app (the preview shares the
        // app's document). http(s) goes to the system browser, rest is inert.
        ev.preventDefault();
        if (/^https?:/i.test(href)) openExternal(href);
      });
    });
  }

  // ---- public API ---------------------------------------------------

  async function open(opts) {
    opts = opts || {};
    buildOverlay();
    const notify = noticer(opts.notify);
    const openExternal = opts.openExternal || ((u) => { try { window.open(u, '_blank'); } catch (_) {} });
    state.clip = opts.clip || null;
    state.notify = notify;
    state.text = null;

    const filePath = cleanPath(opts.path);
    if (!filePath) { notify('Not a valid path', 'error'); return; }
    if (typeof opts.read !== 'function') { notify('Preview not supported here', 'error'); return; }

    pathEl.textContent = filePath;
    setBanner('', '');
    bodyEl.className = 'fp-body';
    bodyEl.textContent = 'Loading…';
    overlay.classList.remove('hidden');

    const ext = extOf(filePath);
    const isImage = !!IMG_EXT[ext];
    const maxBytes = isImage ? IMG_MAX : TEXT_MAX;

    let res;
    try {
      res = await opts.read(filePath, maxBytes);
    } catch (err) {
      bodyEl.textContent = '';
      setBanner('Read failed: ' + (err && err.message || err), 'error');
      return;
    }
    if (!res || res.base64 == null) {
      bodyEl.textContent = '';
      setBanner('Read failed: empty response', 'error');
      return;
    }
    if (res.truncated) {
      setBanner(
        `File ${humanSize(res.size)} — previewing first ${humanSize(maxBytes)}` +
        (isImage ? ' (image too large, may not display)' : ' (truncated)'), 'warn');
    }

    const bytes = b64ToBytes(res.base64);

    if (isImage) {
      bodyEl.classList.add('is-image');
      const img = document.createElement('img');
      img.alt = filePath;
      img.src = `data:${IMG_EXT[ext]};base64,${res.base64}`;
      img.onerror = () => setBanner('Cannot display this image (unsupported or truncated)', 'error');
      bodyEl.textContent = '';
      bodyEl.appendChild(img);
      return;
    }
    if (looksBinary(bytes)) {
      bodyEl.textContent = '';
      setBanner(`Binary file, ${humanSize(res.size)} — preview not supported`, 'warn');
      return;
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    state.text = text;

    if (MD_EXT[ext] && window.marked && window.DOMPurify) {
      renderMarkdown(text, openExternal);
    } else {
      bodyEl.classList.add('is-text');
      const pre = document.createElement('pre');
      pre.textContent = text;
      bodyEl.textContent = '';
      bodyEl.appendChild(pre);
    }
  }

  function close() {
    if (overlay) overlay.classList.add('hidden');
    if (bodyEl) bodyEl.textContent = '';
    state.text = null;
  }

  window.FilePreview = { open, close };
})();
