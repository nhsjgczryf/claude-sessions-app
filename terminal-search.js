/*
 * Shared terminal search bar (Ctrl+F). Used identically by Electron,
 * the web UI, and the Android APK so the search UI lives in ONE place;
 * each frontend only:
 *
 *   1. Creates an @xterm/addon-search SearchAddon per terminal and
 *      stashes it on the tab (`term.loadAddon(addon)`).
 *   2. Calls window.TerminalSearch.installGlobalShortcut(getActive)
 *      once at boot. getActive() returns { term, addon } for the
 *      currently focused terminal (or null).
 *   3. Calls window.TerminalSearch.close() when switching/closing a
 *      tab so the bar doesn't end up bound to a stale addon.
 *
 * The module injects its own CSS, builds its own DOM, and manages the
 * Ctrl+F / Cmd+F / Esc keystrokes. Each frontend can additionally call
 * window.TerminalSearch.open({ term, addon, query }) from any trigger
 * it likes (button, menu, selection-toolbar entry); the optional
 * `query` pre-fills the input so "select text → 查找" Just Works.
 */
(function () {
  'use strict';

  let bar, input, counterEl;
  let btnPrev, btnNext, btnClose, btnCase, btnRegex, btnWord;
  let currentTerm = null;
  let currentAddon = null;
  let resultsDisposable = null;
  const opts = { caseSensitive: false, regex: false, wholeWord: false };

  // Passing `decorations` per-search is what makes addon-search highlight
  // ALL matches AND count them — onDidChangeResults (the counter source)
  // only fires when decorations are enabled. The constructor does NOT
  // accept these (it only takes { highlightLimit }), so they must live in
  // the findNext/findPrevious options. matchOverviewRuler and
  // activeMatchColorOverviewRuler are required by ISearchDecorationOptions.
  const DECORATIONS = {
    matchBackground: 'rgba(249, 226, 175, 0.35)',
    activeMatchBackground: '#fab387',
    matchOverviewRuler: '#f9e2af',
    activeMatchColorOverviewRuler: '#fab387',
  };

  function injectStyle() {
    if (document.getElementById('terminal-search-style')) return;
    const css = `
#terminal-search{position:fixed;top:calc(8px + env(safe-area-inset-top,0px));right:16px;z-index:500;display:flex;align-items:center;gap:4px;padding:6px 8px;background:var(--bg2,#252536);border:1px solid var(--border,#45475a);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.5);max-width:calc(100vw - 32px);flex-wrap:wrap;justify-content:flex-end;-webkit-tap-highlight-color:transparent;font-family:inherit}
#terminal-search.hidden{display:none}
#terminal-search input.ts-q{min-width:160px;flex:1 1 200px;background:var(--bg,#1e1e2e);border:1px solid var(--border,#45475a);border-radius:4px;padding:6px 8px;font-size:13px;color:var(--fg,#cdd6f4);outline:none;font-family:inherit}
#terminal-search input.ts-q:focus{border-color:var(--accent,#89b4fa)}
#terminal-search input.ts-q.nomatch{border-color:var(--red,#f38ba8)}
#terminal-search button{min-width:34px;min-height:32px;padding:4px 8px;background:var(--input-bg,#313244);color:var(--fg,#cdd6f4);border:1px solid var(--border,#45475a);border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;line-height:1}
#terminal-search button:hover{background:var(--bg-hover,#2e2e42)}
#terminal-search button.armed{background:var(--accent,#89b4fa);color:var(--bg,#1e1e2e);border-color:var(--accent,#89b4fa);font-weight:600}
#terminal-search button.ts-close{font-size:16px;padding:2px 10px}
#terminal-search .ts-counter{font-size:11px;color:var(--fg-dim,#6c7086);min-width:54px;text-align:center;user-select:none;font-variant-numeric:tabular-nums}
`;
    const st = document.createElement('style');
    st.id = 'terminal-search-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function build() {
    if (bar) return;
    injectStyle();
    bar = document.createElement('div');
    bar.id = 'terminal-search';
    bar.className = 'hidden';
    bar.innerHTML =
      '<input type="text" class="ts-q" placeholder="查找…" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" />' +
      '<button type="button" class="ts-case" title="区分大小写">Aa</button>' +
      '<button type="button" class="ts-regex" title="正则表达式">.*</button>' +
      '<button type="button" class="ts-word" title="整词匹配">Ww</button>' +
      '<span class="ts-counter">0/0</span>' +
      '<button type="button" class="ts-prev" title="上一个 (Shift+Enter)">↑</button>' +
      '<button type="button" class="ts-next" title="下一个 (Enter)">↓</button>' +
      '<button type="button" class="ts-close" title="关闭 (Esc)">×</button>';
    document.body.appendChild(bar);

    input = bar.querySelector('.ts-q');
    counterEl = bar.querySelector('.ts-counter');
    btnPrev = bar.querySelector('.ts-prev');
    btnNext = bar.querySelector('.ts-next');
    btnClose = bar.querySelector('.ts-close');
    btnCase = bar.querySelector('.ts-case');
    btnRegex = bar.querySelector('.ts-regex');
    btnWord = bar.querySelector('.ts-word');

    // Keep focus in the input when buttons are tapped (so Enter still
    // works after toggling options).
    bar.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') e.preventDefault();
    });
    input.addEventListener('input', () => find(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) findPrev(); else findNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });

    btnPrev.addEventListener('click', () => { findPrev(); refocus(); });
    btnNext.addEventListener('click', () => { findNext(); refocus(); });
    btnClose.addEventListener('click', () => close());
    btnCase.addEventListener('click', () => {
      opts.caseSensitive = !opts.caseSensitive;
      btnCase.classList.toggle('armed', opts.caseSensitive);
      find(true); refocus();
    });
    btnRegex.addEventListener('click', () => {
      opts.regex = !opts.regex;
      btnRegex.classList.toggle('armed', opts.regex);
      find(true); refocus();
    });
    btnWord.addEventListener('click', () => {
      opts.wholeWord = !opts.wholeWord;
      btnWord.classList.toggle('armed', opts.wholeWord);
      find(true); refocus();
    });
  }

  function refocus() { try { input.focus(); } catch (_) {} }

  function setCounter(idx, count) {
    if (!counterEl) return;
    if (count === 0) {
      counterEl.textContent = '未找到';
      input.classList.add('nomatch');
    } else {
      counterEl.textContent = `${idx + 1}/${count}`;
      input.classList.remove('nomatch');
    }
  }

  function searchOpts(incremental) {
    return {
      caseSensitive: opts.caseSensitive,
      regex: opts.regex,
      wholeWord: opts.wholeWord,
      incremental: !!incremental,
      decorations: DECORATIONS,
    };
  }

  function find(incremental) {
    if (!currentAddon || !input) return;
    const q = input.value || '';
    if (!q) {
      try { currentAddon.clearDecorations(); } catch (_) {}
      input.classList.remove('nomatch');
      counterEl.textContent = '0/0';
      return;
    }
    try { currentAddon.findNext(q, searchOpts(incremental)); } catch (_) {}
  }
  function findNext() {
    if (!currentAddon || !input || !input.value) return;
    try { currentAddon.findNext(input.value, searchOpts(false)); } catch (_) {}
  }
  function findPrev() {
    if (!currentAddon || !input || !input.value) return;
    try { currentAddon.findPrevious(input.value, searchOpts(false)); } catch (_) {}
  }

  function open(o) {
    build();
    o = o || {};
    if (!o.term || !o.addon) return;

    if (resultsDisposable) {
      try { resultsDisposable.dispose(); } catch (_) {}
      resultsDisposable = null;
    }
    currentTerm = o.term;
    currentAddon = o.addon;

    // The addon publishes match counter updates via onDidChangeResults
    // (modern xterm). Older builds without it just leave the counter at
    // its last value — search itself still works.
    if (typeof o.addon.onDidChangeResults === 'function') {
      try {
        const d = o.addon.onDidChangeResults((r) => {
          if (!r) { setCounter(-1, 0); return; }
          setCounter(r.resultIndex, r.resultCount);
        });
        resultsDisposable = (d && typeof d.dispose === 'function') ? d : { dispose() {} };
      } catch (_) {}
    }

    bar.classList.remove('hidden');
    if (typeof o.query === 'string' && o.query) {
      input.value = o.query;
    }
    setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} }, 0);
    if (input.value) find(true);
    else { input.classList.remove('nomatch'); counterEl.textContent = '0/0'; }
  }

  function close() {
    if (currentAddon) {
      try { currentAddon.clearDecorations(); } catch (_) {}
    }
    if (resultsDisposable) {
      try { resultsDisposable.dispose(); } catch (_) {}
      resultsDisposable = null;
    }
    const t = currentTerm;
    currentAddon = null;
    currentTerm = null;
    if (bar) bar.classList.add('hidden');
    if (t) { try { t.focus(); } catch (_) {} }
  }

  function isOpen() {
    return !!bar && !bar.classList.contains('hidden');
  }

  function installGlobalShortcut(getActive) {
    document.addEventListener('keydown', (e) => {
      // Ctrl+F (Cmd+F on Mac) opens the search bar bound to the active
      // terminal. We override Chromium's built-in find-in-page because
      // it can't see text inside xterm's div/canvas grid anyway.
      const plainMod = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
      const isFindKey = e.code === 'KeyF' || e.key === 'f' || e.key === 'F';
      if (plainMod && isFindKey) {
        const handle = getActive && getActive();
        if (!handle || !handle.term || !handle.addon) return;
        e.preventDefault();
        e.stopPropagation();
        // If a selection exists, pre-fill it as the query — same UX as
        // VS Code / browsers.
        let query;
        try {
          const sel = handle.term.hasSelection && handle.term.hasSelection()
            ? handle.term.getSelection() : '';
          if (sel) query = sel.replace(/\r?\n/g, ' ').trim().slice(0, 200);
        } catch (_) {}
        open({ term: handle.term, addon: handle.addon, query });
        return;
      }
      // Esc closes the bar from anywhere (input keydown handles its own
      // Esc; this catches Esc fired with focus elsewhere).
      if (e.key === 'Escape' && isOpen()) {
        e.preventDefault();
        close();
      }
    }, true);
  }

  window.TerminalSearch = { open, close, isOpen, installGlobalShortcut };
})();
