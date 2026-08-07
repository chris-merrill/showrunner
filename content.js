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

  const CLS = {
    row: 'wch-row',
    question: 'wch-q',
    resolved: 'wch-resolved',
    btn: 'wch-x',
  };

  let settings = {
    highlightQuestions: true,
    allowResolve: true,
    aiEnabled: false,
    endpoint: '',
    token: '',
  };

  // Classifier state. Verdicts are keyed by message text, same as `resolved` —
  // the row list is virtualised, so DOM nodes can't hold this.
  const BATCH_SIZE = 15;
  const BATCH_MS = 3000;
  const verdicts = new Map();
  const pending = new Map();
  const inFlight = new Set();
  let flushTimer = null;

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

  const textOf = (el) =>
    ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();

  const mark = (state) => {
    try {
      document.documentElement.setAttribute('data-wch', state);
    } catch (_) {}
  };

  // ------------------------------------------------------------------- style

  function injectStyle() {
    if (document.getElementById('wch-style')) return;
    const style = document.createElement('style');
    style.id = 'wch-style';
    style.textContent = `
      .${CLS.row} { position: relative; }
      .${CLS.question} {
        background: rgba(124, 92, 255, 0.14);
        box-shadow: inset 3px 0 0 #7c5cff;
        border-radius: 6px;
      }
      .${CLS.question}.${CLS.resolved} {
        background: transparent;
        box-shadow: inset 3px 0 0 rgba(61, 220, 151, 0.9);
        opacity: 0.45;
      }
      .${CLS.btn} {
        position: absolute;
        top: 2px;
        right: 2px;
        z-index: 5;
        appearance: none;
        border: 0;
        border-radius: 5px;
        background: rgba(124, 92, 255, 0.9);
        color: #fff;
        font: 600 10px/1 system-ui, sans-serif;
        padding: 4px 6px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 90ms ease;
      }
      .${CLS.row}:hover .${CLS.btn} { opacity: 1; }
      .${CLS.btn}:hover { background: #3ddc97; }
      .${CLS.resolved} .${CLS.btn} { opacity: 0.5; background: #3ddc97; }
    `;
    (document.head || document.documentElement).append(style);
  }

  // -------------------------------------------------------------- decoration

  const keyOf = (row) => textOf(row).slice(0, 200);
  const isQuestion = (t) => /\?\s*$/.test(t);

  // Local rule is the instant answer; a verdict from diecastr supersedes it when
  // it lands. Anything not yet classified keeps the '?' highlight in the
  // meantime, so the chat is never un-annotated while a batch is in flight.
  function shouldHighlight(key, text) {
    const verdict = verdicts.get(key);
    if (verdict) return !!verdict.is_request;
    return isQuestion(text);
  }

  function queueForClassification(key, text) {
    if (!settings.aiEnabled || !settings.endpoint) return;
    if (verdicts.has(key) || pending.has(key) || inFlight.has(key)) return;

    pending.set(key, text);
    if (pending.size >= BATCH_SIZE) {
      flushBatch();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushBatch, BATCH_MS);
    }
  }

  function flushBatch() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending.size) return;

    const batch = Array.from(pending.entries());
    batch.forEach(([key]) => {
      pending.delete(key);
      inFlight.add(key);
    });

    // Index is the id: the response is matched back by position-free lookup, so
    // a dropped or reordered result can't shift verdicts onto the wrong rows.
    const payload = {
      messages: batch.map(([, text], i) => ({ id: String(i), text })),
    };

    chrome.runtime.sendMessage({ type: 'classify', payload }, (res) => {
      void chrome.runtime.lastError;
      batch.forEach(([key]) => inFlight.delete(key));

      if (!res || res.error) {
        log('classify failed:', res?.error);
        return;
      }
      for (const result of res.results || []) {
        const entry = batch[Number(result.id)];
        if (entry) verdicts.set(entry[0], result);
      }
      scheduleDecorate();
    });
  }

  function undecorate(row) {
    row.classList.remove(CLS.row, CLS.question, CLS.resolved);
    const btn = row.querySelector(`.${CLS.btn}`);
    if (btn) btn.remove();
  }

  function decorate(row) {
    const text = textOf(row);
    if (!text || text.length > MAX_ROW_CHARS) return;

    const key = keyOf(row);
    queueForClassification(key, text);

    if (!settings.highlightQuestions || !shouldHighlight(key, text)) {
      if (row.classList.contains(CLS.question)) undecorate(row);
      return;
    }

    row.classList.add(CLS.row, CLS.question);
    row.classList.toggle(CLS.resolved, resolved.has(key));

    const existing = row.querySelector(`.${CLS.btn}`);
    if (!settings.allowResolve) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const btn = document.createElement('button');
    btn.className = CLS.btn;
    btn.type = 'button';
    btn.textContent = '✕';
    btn.title = 'Mark answered';
    btn.addEventListener('click', (e) => {
      // Whatnot puts click handlers on the row itself (profile popovers etc).
      e.preventDefault();
      e.stopPropagation();
      const key = keyOf(row);
      if (resolved.has(key)) resolved.delete(key);
      else resolved.add(key);
      row.classList.toggle(CLS.resolved, resolved.has(key));
    });
    row.append(btn);
  }

  function decorateAll() {
    if (!rowList || !document.contains(rowList)) {
      rowList = region ? findRowList(region) : null;
    }
    if (!rowList) return;
    for (const row of Array.from(rowList.children)) decorate(row);
  }

  // Chat can burst; coalesce to one pass per frame.
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

  function clearAll() {
    if (!rowList) return;
    for (const row of Array.from(rowList.children)) undecorate(row);
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

    observer = new MutationObserver(scheduleDecorate);
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
    if (!settings.highlightQuestions) clearAll();
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
    injectStyle();
    await loadSettings();
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
