// Decorates Whatnot's own live chat in place: questions get a highlight, and
// (optionally) a ✕ to tick them off once answered.
//
// Everything we add is disposable. Whatnot owns these rows and React will happily
// wipe a node we injected on its next render, so decoration is idempotent and
// re-runs on every mutation batch rather than being applied once.

(() => {
  'use strict';

  if (window.__whatnotChatHelperLoaded) return;
  window.__whatnotChatHelperLoaded = true;

  const DEBUG = false;
  const log = (...a) => DEBUG && console.log('[wch]', ...a);

  const MAX_ROW_CHARS = 400;
  const ATTACH_RETRY_MS = 3000;
  const DETECT_WINDOW_MS = 6000;

  // Styling hangs off a data attribute, not a class. React owns `className` on
  // these rows and rewrites it on every re-render — a class we add is wiped and
  // re-added a frame later, which is what the flicker was. React's diffing
  // doesn't touch attributes outside its vdom, so this survives re-renders.
  const ATTR = 'data-wch-q';
  const TAB_ID = 'wch-tab';
  const CLS = { tag: 'wch-tag', label: 'wch-label', btn: 'wch-x' };

  const NATIVE_TABS = ['Chat', 'Watching', 'Activity'];
  let questionsOnly = false;

  let settings = {
    highlightQuestions: true,
    allowResolve: true,
    questionsTab: true,
    aiEnabled: false,
    endpoint: '',
    token: '',
  };

  // Classifier state. Verdicts are keyed by message text, same as `resolved` —
  // the row list is virtualised, so DOM nodes can't hold this.
  //
  // The API takes one message per request and bills DIECASTr per call, so this
  // is a bounded queue rather than a fan-out: identical text is never asked
  // twice, and no more than MAX_INFLIGHT requests are open at once.
  const MAX_INFLIGHT = 3;
  const RATE_LIMIT_BACKOFF_MS = 60000;
  const verdicts = new Map();
  const queued = [];
  const seen = new Set();
  let inFlight = 0;
  let pausedUntil = 0;
  let pumpTimer = null;

  /** @type {Element|null} */ let region = null;   // chat message region
  /** @type {Element|null} */ let rowList = null;  // element whose children are rows
  /** @type {MutationObserver|null} */ let observer = null;

  // Rows are recycled by the virtualised list, so "resolved" is keyed by message
  // content, never by DOM node.
  const resolved = new Set();

  let attachAttempts = 0;
  let detecting = false;
  let scheduled = false;
  let currentUrl = location.href;

  const isVisible = (el) => {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 60;
  };

  // textContent, never innerText. innerText is layout-dependent: reading it
  // forces a synchronous reflow, and we read it for every row on every mutation
  // batch — that alone can make the page shimmer. It's also unstable mid-render
  // (returns '' or partial text for a row being re-rendered), which changes the
  // row's key and flips its highlight off and on.
  const textOf = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

  // Stamped on <html> so a stale content script from a previous extension
  // reload is identifiable: check document.documentElement.dataset.wchV.
  const VERSION = '0.11.0';

  const mark = (state) => {
    try {
      document.documentElement.setAttribute('data-wch', state);
      document.documentElement.setAttribute('data-wch-v', VERSION);
    } catch (_) {}
  };

  // Flicker diagnostics, readable from the page console without DEBUG logging:
  //   document.documentElement.dataset.wchMarks    — rows marked for the first time
  //   document.documentElement.dataset.wchRemarks  — rows we had to re-mark
  let marked = new WeakSet();
  const offCandidate = new WeakMap();
  const diag = { marks: 0, remarks: 0 };
  const bumpDiag = (kind) => {
    diag[kind]++;
    try {
      document.documentElement.dataset[kind === 'marks' ? 'wchMarks' : 'wchRemarks'] =
        String(diag[kind]);
    } catch (_) {}
  };

  // ------------------------------------------------------------------- style

  // Outline, not a fill: an outline doesn't repaint the row's background, so
  // it can't shimmer against the page's own painting. No transitions either —
  // any animation on a row the page re-renders reads as a flash.
  // Styled to disappear into Whatnot's own UI: their orange question colour,
  // system font, sentence case, pill shapes. Nothing here should read as
  // "an extension did this".
  const CSS = `
      [${ATTR}] {
        position: relative;
        background: rgba(234, 88, 12, 0.06);
        box-shadow: inset 2px 0 0 #ea580c;
        border-radius: 8px;
      }
      [${ATTR}="resolved"] {
        background: transparent;
        box-shadow: inset 2px 0 0 rgba(0, 0, 0, 0.14);
        opacity: 0.5;
      }
      .${CLS.tag} {
        position: absolute;
        top: 3px;
        right: 5px;
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 4px;
        pointer-events: none;
        font: 600 10px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      .${CLS.label} {
        background: rgba(234, 88, 12, 0.12);
        color: #c2410c;
        padding: 3px 7px;
        border-radius: 999px;
      }
      [${ATTR}="resolved"] .${CLS.label} {
        background: rgba(0, 0, 0, 0.06);
        color: #4b5563;
      }
      .${CLS.btn} {
        display: none;
        pointer-events: auto;
        appearance: none;
        background: #f3f4f6;
        color: #374151;
        border: 1px solid #e5e7eb;
        font: inherit;
        font-weight: 500;
        white-space: nowrap;
        padding: 3px 8px;
        border-radius: 999px;
        cursor: pointer;
      }
      /* Full label is wide for a ~300px column, so it reveals on hover — the
         pill alone is what's visible while scanning. */
      [${ATTR}]:hover .${CLS.btn} { display: inline-block; }
      .${CLS.btn}:hover { background: #e5e7eb; color: #111827; }

      /* Questions-only filter. 'revert' rather than a fixed display value —
         the rows are flex children and hardcoding 'block' would reflow them. */
      [data-wch-only] > * { display: none !important; }
      [data-wch-only] > [${ATTR}] { display: revert !important; }

      /* currentColor, not a brand colour of ours — the tab inherits Whatnot's
         own text colour so the active underline matches their tabs. */
      #${TAB_ID}[data-wch-active] {
        font-weight: 600;
        box-shadow: inset 0 -2px 0 currentColor;
      }
      #${TAB_ID} .wch-count {
        margin-left: 5px;
        font-size: 0.85em;
        opacity: 0.55;
      }
  `;

  // Overwrite, don't skip-if-present. An extension reload injects a fresh
  // content script into a page that still holds the *previous* instance's
  // stylesheet — bailing early left old CSS paired with new markup, which
  // rendered the tags as unstyled block text in the message flow.
  function injectStyle() {
    let style = document.getElementById('wch-style');
    if (style && style.textContent === CSS) return;
    if (!style) {
      style = document.createElement('style');
      style.id = 'wch-style';
      (document.head || document.documentElement).append(style);
    }
    style.textContent = CSS;
  }

  // ------------------------------------------------------------ questions tab

  function findTabBar() {
    const tabs = Array.from(document.querySelectorAll('button')).filter((b) =>
      NATIVE_TABS.includes(textOf(b))
    );
    return tabs.length >= 2 ? tabs[0].parentElement : null;
  }

  function applyFilter() {
    if (!rowList) return;
    if (questionsOnly && settings.questionsTab) rowList.setAttribute('data-wch-only', '1');
    else rowList.removeAttribute('data-wch-only');
  }

  function syncTab(tab) {
    if (!tab) return;
    if (questionsOnly) tab.setAttribute('data-wch-active', '1');
    else tab.removeAttribute('data-wch-active');

    const count = rowList ? rowList.querySelectorAll(`[${ATTR}]:not([${ATTR}="resolved"])`).length : 0;
    const badge = tab.querySelector('.wch-count');
    const want = count ? String(count) : '';
    if (badge && badge.textContent !== want) badge.textContent = want;
  }

  function removeTab() {
    const tab = document.getElementById(TAB_ID);
    if (tab) tab.remove();
    questionsOnly = false;
    if (rowList) rowList.removeAttribute('data-wch-only');
  }

  // The tab is rebuilt if React drops it. Its className is copied from a real
  // tab button rather than styled by hand — that's what makes it match, and it
  // keeps matching when Whatnot restyles their own tabs.
  function ensureTab() {
    if (!settings.questionsTab) {
      removeTab();
      return;
    }

    const bar = findTabBar();
    if (!bar) return;

    let tab = document.getElementById(TAB_ID);
    if (tab && tab.parentElement === bar) {
      syncTab(tab);
      return;
    }
    if (tab) tab.remove();

    const model = Array.from(bar.children).find((c) => c.tagName === 'BUTTON');

    tab = document.createElement('button');
    tab.id = TAB_ID;
    tab.type = 'button';
    if (model) tab.className = model.className;
    tab.textContent = 'Questions';

    const badge = document.createElement('span');
    badge.className = 'wch-count';
    tab.append(badge);

    tab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      questionsOnly = !questionsOnly;
      applyFilter();
      syncTab(tab);
    });

    bar.append(tab);

    // Clicking a real tab drops our filter, so the panel can't be left showing
    // a filtered list under someone else's tab.
    if (!bar.dataset.wchBound) {
      bar.dataset.wchBound = '1';
      bar.addEventListener(
        'click',
        (e) => {
          if (e.target.closest(`#${TAB_ID}`)) return;
          questionsOnly = false;
          applyFilter();
          syncTab(document.getElementById(TAB_ID));
        },
        true
      );
    }

    syncTab(tab);
  }

  // -------------------------------------------------------------- decoration

  const keyOf = (row) => textOf(row).slice(0, 200);
  const isQuestion = (t) => /\?\s*$/.test(t);

  // Local rule is the instant answer; a verdict from diecastr supersedes it when
  // it lands. Anything not yet classified keeps the '?' highlight in the
  // meantime, so the chat is never un-annotated while a batch is in flight.
  function shouldHighlight(key, text) {
    if (verdicts.has(key)) return verdicts.get(key);
    return isQuestion(text);
  }

  function queueForClassification(key, text) {
    if (!settings.aiEnabled || !settings.token) return;
    if (seen.has(key)) return;
    seen.add(key);
    queued.push([key, text]);
    pump();
  }

  function schedulePump(delay) {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, delay);
  }

  function pump() {
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      schedulePump(wait);
      return;
    }

    while (inFlight < MAX_INFLIGHT && queued.length) {
      const [key, text] = queued.shift();
      inFlight++;

      chrome.runtime.sendMessage({ type: 'classify', text }, (res) => {
        void chrome.runtime.lastError;
        inFlight--;

        if (res && typeof res.isQuestion === 'boolean') {
          verdicts.set(key, res.isQuestion);
          scheduleDecorate();
        } else if (res?.status === 429) {
          // Key paused by the owner — put it back and stop asking for a while.
          queued.unshift([key, text]);
          pausedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
          log('rate limited (429) — pausing classification for 60s');
        } else if (res?.status === 401) {
          settings.aiEnabled = false;
          log('auth failed (401) — smart detection off, using the "?" rule');
        } else {
          // 400/500/network: the spec says treat as not-a-question and move on.
          // Leaving no verdict means the row keeps the local '?' rule, which is
          // the better failure mode — a real question still highlights.
          log('classify failed:', res?.status || res?.error);
        }

        pump();
      });
    }
  }

  function undecorate(row) {
    if (!row.hasAttribute(ATTR)) return;
    row.removeAttribute(ATTR);
    const tag = row.querySelector(`.${CLS.tag}`);
    if (tag) tag.remove();
  }

  function buildTag(row, key, isResolved) {
    const tag = document.createElement('span');
    tag.className = CLS.tag;

    const label = document.createElement('span');
    label.className = CLS.label;
    label.textContent = isResolved ? 'Resolved' : 'Question';
    tag.append(label);

    if (settings.allowResolve) {
      const btn = document.createElement('button');
      btn.className = CLS.btn;
      btn.type = 'button';
      btn.textContent = isResolved ? 'Reopen' : 'Mark as resolved';
      btn.addEventListener('click', (e) => {
        // Whatnot puts click handlers on the row itself (profile popovers etc).
        e.preventDefault();
        e.stopPropagation();
        if (resolved.has(key)) resolved.delete(key);
        else resolved.add(key);
        scheduleDecorate();
      });
      tag.append(btn);
    }

    row.append(tag);
    return tag;
  }

  function decorate(row) {
    const text = textOf(row);
    if (!text || text.length > MAX_ROW_CHARS) return;

    const key = keyOf(row);
    queueForClassification(key, text);

    if (!settings.highlightQuestions || !shouldHighlight(key, text)) {
      // Removal needs confirming twice with the same text before it happens.
      //
      // Scrolling recycles rows, and React re-renders them in stages — a row
      // mid-render reports partial text, which reads as "not a question" for one
      // batch and strips the border, then restores it on the next. Requiring two
      // consecutive passes to agree means a transient state can't unmark a row.
      // Adding a mark is still immediate; only removal waits.
      if (row.hasAttribute(ATTR)) {
        if (offCandidate.get(row) === key) {
          offCandidate.delete(row);
          undecorate(row);
        } else {
          offCandidate.set(row, key);
        }
        return;
      }
      undecorate(row);
      return;
    }
    offCandidate.delete(row);

    // Write only on change — an unconditional setAttribute every pass is a DOM
    // write per row per message, which is its own source of churn.
    const want = resolved.has(key) ? 'resolved' : '1';
    if (row.getAttribute(ATTR) !== want) {
      // Diagnostics: a re-mark on a node we already marked means something
      // stripped our attribute (React reclaiming the row). A first mark on a
      // node we've never seen means the row element itself was replaced.
      // Reading the two counters tells us which — see README § Diagnosing flicker.
      if (marked.has(row)) bumpDiag('remarks');
      else bumpDiag('marks');
      marked.add(row);
      row.setAttribute(ATTR, want);
    }

    const isResolved = want === 'resolved';
    const tag = row.querySelector(`.${CLS.tag}`);

    if (!tag) {
      buildTag(row, key, isResolved);
      return;
    }

    // Tag already present — only touch the label/button text if it's stale.
    const label = tag.querySelector(`.${CLS.label}`);
    const wantLabel = isResolved ? 'Resolved' : 'Question';
    if (label && label.textContent !== wantLabel) label.textContent = wantLabel;

    // Keep the button in sync with the Allow-resolve toggle.
    const btn = tag.querySelector(`.${CLS.btn}`);
    if (!settings.allowResolve) {
      if (btn) btn.remove();
      return;
    }
    if (!btn) {
      tag.remove();
      buildTag(row, key, isResolved);
      return;
    }
    const wantBtn = isResolved ? 'Reopen' : 'Mark as resolved';
    if (btn.textContent !== wantBtn) btn.textContent = wantBtn;
  }

  function decorateAll() {
    if (!rowList || !document.contains(rowList)) {
      rowList = region ? findRowList(region) : null;
    }
    if (!rowList) return;

    // Self-heal: the tags are positioned by the injected stylesheet, so if it's
    // missing they render as bare inline text in the message flow. Re-add rather
    // than trusting that it survived.
    injectStyle();

    // Injecting the tag is itself a childList mutation. Left connected, the
    // observer sees our own writes and schedules another pass — a feedback loop
    // on top of whatever the page is doing.
    if (observer) observer.disconnect();
    try {
      for (const row of Array.from(rowList.children)) decorate(row);
      ensureTab();
      applyFilter();
    } finally {
      if (observer && region) {
        observer.observe(region, { childList: true, subtree: true, characterData: true });
      }
    }
  }

  // Chat can burst; coalesce to one pass per frame.
  // Only for redraws that originate outside a DOM mutation — a classifier
  // verdict arriving, or a settings change. Mutation-driven redraws run
  // synchronously in the observer callback so they land before paint.
  function scheduleDecorate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        decorateAll();
      } catch (err) {
        log('decorate failed', err);
      }
    });
  }

  // Full revert: every trace of the extension comes out of the page. Queries the
  // whole document rather than the current rowList — rows we decorated may have
  // scrolled out of the list we're holding a reference to.
  function removeAllDecorations() {
    for (const el of document.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
    for (const el of document.querySelectorAll(`.${CLS.tag}`)) el.remove();
    for (const el of document.querySelectorAll('[data-wch-only]')) {
      el.removeAttribute('data-wch-only');
    }
    removeTab();
    const style = document.getElementById('wch-style');
    if (style) style.remove();
    marked = new WeakSet();
  }

  // ---------------------------------------------------------------- discovery

  // Whatnot marks the chat with the semantic class `z-chat-window`. Its first
  // child is the message region; the second is the composer.
  function findChatByAnchor() {
    const win = document.querySelector('.z-chat-window');
    const el = win && win.firstElementChild;
    return el && isVisible(el) ? el : null;
  }

  // The rows sit some levels below the region wrapper — find the container whose
  // children are mostly text-bearing.
  function findRowList(root) {
    let best = null;
    let bestScore = 0;
    for (const candidate of root.querySelectorAll('*')) {
      const kids = candidate.children;
      if (kids.length < 3) continue;
      let withText = 0;
      for (const k of kids) if (textOf(k).length > 1) withText++;
      if (withText > bestScore) {
        bestScore = withText;
        best = candidate;
      }
    }
    return best;
  }

  // Fallback if the anchor class ever disappears: whichever element gains the
  // most short-text children over a sampling window is the chat.
  function autoDetect() {
    if (detecting) return;
    detecting = true;

    const scores = new Map();
    const probe = new MutationObserver((records) => {
      for (const rec of records) {
        if (!(rec.target instanceof Element)) continue;
        for (const node of rec.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const t = textOf(node);
          if (!t || t.length > MAX_ROW_CHARS) continue;
          scores.set(rec.target, (scores.get(rec.target) || 0) + 1);
        }
      }
    });
    probe.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      probe.disconnect();
      detecting = false;
      const ranked = [...scores.entries()]
        .filter(([el, n]) => n >= 3 && el.children.length >= 3 && isVisible(el))
        .sort((a, b) => b[1] - a[1]);
      if (ranked.length) attach(ranked[0][0], 'churn');
    }, DETECT_WINDOW_MS);
  }

  function attach(el, source) {
    if (observer) observer.disconnect();
    region = el;
    rowList = findRowList(el) || el;
    attachAttempts = 0;

    // Messages already on screen at attach time are marked seen but never sent:
    // classifying 40 rows of scrollback would be 40 billed calls for lines that
    // have already scrolled past. They keep the local '?' rule.
    if (rowList) {
      for (const row of Array.from(rowList.children)) seen.add(keyOf(row));
    }

    // Decorate synchronously in the observer callback, NOT on a rAF.
    //
    // MutationObserver callbacks run as microtasks at the end of the task that
    // mutated the DOM — before the browser paints. React replacing a row and us
    // re-marking it therefore land in the *same* frame, and the user never sees
    // an unmarked state. Deferring to requestAnimationFrame meant the browser
    // painted the bare row first and our styling one frame later: that gap,
    // repeating on every incoming message, is the flicker.
    observer = new MutationObserver(() => {
      // Never let a throw here kill the observer — it's the only thing keeping
      // decoration alive, and an uncaught error in a sync callback strands it.
      try {
        decorateAll();
      } catch (err) {
        log('decorate failed', err);
      }
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });

    log('attached via', source);
    mark('watching:' + source);
    scheduleDecorate();
  }

  function tryAttach() {
    if (region && document.contains(region)) return true;
    const found = findChatByAnchor();
    if (found) {
      attach(found, 'anchor');
      return true;
    }
    return false;
  }

  function detach() {
    if (observer) observer.disconnect();
    observer = null;
    region = null;
    rowList = null;
  }

  // ----------------------------------------------------------------- settings

  async function loadSettings() {
    const stored = await chrome.storage.local.get('settings');
    settings = { ...settings, ...(stored.settings || {}) };
    log('settings', settings);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = { ...settings, ...changes.settings.newValue };
    log('settings changed', settings);

    if (!settings.highlightQuestions) {
      removeAllDecorations();
      return;
    }
    injectStyle(); // re-add if a previous untick removed it
    scheduleDecorate();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'ping') {
      sendResponse({ ok: true, attached: !!region, url: location.href });
      return true;
    }
    if (msg?.type === 'clearResolved') {
      resolved.clear();
      scheduleDecorate();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  // -------------------------------------------------------------------- boot

  async function boot() {
    await loadSettings();
    if (settings.highlightQuestions) injectStyle();
    mark('loaded');
    if (!tryAttach()) log('chat not up yet, retrying');
  }

  // Chat mounts well after document_idle (20-40s on a live show) and not at all
  // while the tab is backgrounded, so attaching is a retry loop, not a one-shot.
  setInterval(() => {
    if (region && document.contains(region)) return;
    attachAttempts++;
    if (tryAttach()) return;
    if (attachAttempts % 10 === 0) autoDetect();
  }, ATTACH_RETRY_MS);

  // Whatnot is a SPA: re-attach when the route changes.
  setInterval(() => {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    detach();
    boot();
  }, 1500);

  boot();
})();
