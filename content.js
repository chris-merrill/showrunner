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
  const QCARD_ID = 'wch-qcard';
  const CLS = { tag: 'wch-tag', label: 'wch-label', btn: 'wch-x' };


  let settings = {
    highlightQuestions: true,
    allowResolve: true,
    questionsTab: true,
    captureEnabled: false, // the header toggle: Showrunner on/off; the cards follow it
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

  // Every question seen this show, in arrival order: key → { user, text }.
  // The Questions panel renders from this, not from the DOM — so a question
  // that has scrolled out of Whatnot's virtualised list is still listed.
  const questions = new Map();
  let panelDirty = true;

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
  const VERSION = '0.13.0';

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
    if (!DEBUG) return; // a DOM write per marked row; development only
    diag[kind]++;
    try {
      document.documentElement.dataset[kind === 'marks' ? 'wchMarks' : 'wchRemarks'] =
        String(diag[kind]);
    } catch (_) {}
  };

  // ---------------------------------------------------------------- liveness

  // Reloading the extension invalidates this script's context while the page
  // keeps running it. Every chrome.* call then throws "Extension context
  // invalidated" — from pump(), that unwound through decorate → decorateAll →
  // the observer callback. Detect it once and stand down cleanly instead.
  let dead = false;
  const intervals = [];

  function alive() {
    if (dead) return false;
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  function shutdown(reason) {
    if (dead) return;
    dead = true;
    log('shutting down:', reason);
    try {
      if (observer) observer.disconnect();
    } catch (_) {}
    for (const id of intervals) clearInterval(id);
    // Leave the page as we found it — the orphaned script can't clean up later.
    try {
      removeAllDecorations();
    } catch (_) {}
  }

  const isContextError = (err) =>
    /Extension context invalidated|Receiving end does not exist/i.test(err?.message || '');

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

      /* Questions card: a sibling of Whatnot's chat card in the right column,
         styled like theirs (white, 16px radius, 24px side padding). Never a
         filter on Whatnot's virtualised list — that caused a flashing loop. */
      #${QCARD_ID} {
        --wch-fg: #000;
        --wch-dim: #6b6b6b;
        --wch-line: rgba(0, 0, 0, 0.08);
        --wch-bg: #fff;
        box-sizing: border-box;
        flex: none;
        border-radius: 16px;
        background: var(--wch-bg);
        color: var(--wch-fg);
        font: 400 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        overflow: hidden;
      }
      html.dark #${QCARD_ID} { --wch-fg: #fff; --wch-dim: #a3a3a3; --wch-line: rgba(255, 255, 255, 0.1); --wch-bg: #171717; }
      #${QCARD_ID} .wch-qhead {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 24px;
        cursor: pointer;
        user-select: none;
      }
      #${QCARD_ID} .wch-qname { font-weight: 600; font-size: 16px; flex: 1; }
      #${QCARD_ID} .wch-mark { flex: none; margin-right: -2px; }
      #${QCARD_ID} .wch-qcount {
        font-size: 12px;
        font-weight: 600;
        padding: 3px 10px;
        border-radius: 999px;
        background: rgba(128, 128, 128, 0.15);
      }
      #${QCARD_ID} .wch-qcount[data-open] { background: #f97316; color: #fff; }
      #${QCARD_ID} .wch-qlist {
        max-height: 260px;
        overflow-y: auto;
        margin: 0;
        padding: 0 24px 12px;
        list-style: none;
        font-size: 14px;
      }
      #${QCARD_ID}[data-collapsed] .wch-qlist { display: none; }
      #${QCARD_ID} .wch-qlist li {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 8px 0;
        border-top: 1px solid var(--wch-line);
      }
      #${QCARD_ID} .wch-qlist li[data-resolved] { color: var(--wch-dim); }
      #${QCARD_ID} .wch-qlist li[data-resolved] .wch-qtext { text-decoration: line-through; }
      #${QCARD_ID} .wch-qbody { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      #${QCARD_ID} .wch-quser { display: block; font-size: 12px; color: var(--wch-dim); }
      #${QCARD_ID} .wch-qtext { font-weight: 500; }
      #${QCARD_ID} .wch-qdone {
        flex: none;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid var(--wch-line);
        border-radius: 50%;
        background: transparent;
        color: var(--wch-dim);
        font: 600 14px/1 system-ui, sans-serif;
        cursor: pointer;
      }
      #${QCARD_ID} .wch-qdone:hover { color: #2f9e44; border-color: #2f9e44; background: rgba(47, 158, 68, 0.1); }
      #${QCARD_ID} li[data-resolved] .wch-qdone { color: #2f9e44; border-color: #2f9e44; }
      #${QCARD_ID} .wch-qempty { padding: 0 0 12px; color: var(--wch-dim); }
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

  // ----------------------------------------------------------- questions card

  // Questions live in a card above Whatnot's chat card in the right column
  // (`[grid-area:sidebar]`, a flex column with a 16px gap). React reconciles
  // its own children there and leaves ours alone. Narrow layouts have no such
  // column, so there the card simply isn't shown.
  const SIDEBAR = 'div[class*="grid-area:sidebar"]';
  let qcard = null;
  let qcardEls = null;
  let qcardCollapsed = false;

  function toggleResolved(key) {
    if (resolved.has(key)) resolved.delete(key);
    else resolved.add(key);
    panelDirty = true;
    scheduleDecorate();
  }

  // Questions that count: still questions after any classifier verdict.
  const listedQuestions = () =>
    [...questions].filter(([key, q]) => shouldHighlight(key, q.text));

  function buildQuestionsCard() {
    qcard = document.createElement('div');
    qcard.id = QCARD_ID;
    if (qcardCollapsed) qcard.setAttribute('data-collapsed', '');

    const head = document.createElement('div');
    head.className = 'wch-qhead';
    // The Showrunner mark (clapperboard), same paths as capture.js and the icons.
    const svgNS = 'http://www.w3.org/2000/svg';
    const mark = document.createElementNS(svgNS, 'svg');
    mark.setAttribute('viewBox', '0 0 24 24');
    mark.setAttribute('fill', 'none');
    mark.setAttribute('stroke', 'currentColor');
    mark.setAttribute('stroke-width', '2');
    mark.setAttribute('stroke-linecap', 'round');
    mark.setAttribute('stroke-linejoin', 'round');
    mark.setAttribute('width', '18');
    mark.setAttribute('height', '18');
    mark.classList.add('wch-mark');
    for (const d of [
      'M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z',
      'm6.2 5.3 3.1 3.9',
      'm12.4 3.4 3.1 4',
      'M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    ]) {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('d', d);
      mark.append(p);
    }
    const name = document.createElement('span');
    name.className = 'wch-qname';
    name.textContent = 'Questions';
    const count = document.createElement('span');
    count.className = 'wch-qcount';
    count.textContent = '0';
    head.append(mark, name, count);
    head.addEventListener('click', () => {
      qcardCollapsed = !qcardCollapsed;
      qcard.toggleAttribute('data-collapsed', qcardCollapsed);
    });

    const list = document.createElement('ul');
    list.className = 'wch-qlist';
    qcard.append(head, list);
    qcardEls = { count, list };
    panelDirty = true;
  }

  function ensureQuestionsCard() {
    // The header toggle (captureEnabled) is the master switch for both cards;
    // in-chat highlighting is unaffected by it.
    if (!settings.questionsTab || !settings.captureEnabled) {
      removeQuestionsCard();
      return false;
    }
    const col = document.querySelector(SIDEBAR);
    if (!col) {
      if (qcard) qcard.remove();
      return false;
    }
    if (!qcard) buildQuestionsCard();
    if (qcard.parentElement !== col || col.firstElementChild !== qcard) {
      col.prepend(qcard);
      panelDirty = true;
    }
    return true;
  }

  // Newest question on top; resolved ones stay, struck through, so a mod can
  // reopen one. Rebuilt only when something changed (panelDirty).
  function renderQuestionsCard() {
    if (!ensureQuestionsCard()) return;
    const items = listedQuestions();
    const openCount = items.filter(([key]) => !resolved.has(key)).length;
    const want = String(openCount);
    if (qcardEls.count.textContent !== want) qcardEls.count.textContent = want;
    qcardEls.count.toggleAttribute('data-open', openCount > 0);
    if (!panelDirty) return;
    panelDirty = false;

    const list = qcardEls.list;
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'wch-qempty';
      empty.textContent = 'No questions yet';
      list.append(empty);
      return;
    }
    for (const [key, q] of items.slice().reverse()) {
      const isResolved = resolved.has(key);
      const item = document.createElement('li');
      if (isResolved) item.setAttribute('data-resolved', '');

      const body = document.createElement('div');
      body.className = 'wch-qbody';
      const meta = document.createElement('span');
      meta.className = 'wch-quser';
      if (q.user) meta.append(q.user, ' · ');
      const age = document.createElement('span');
      age.className = 'wch-qage';
      age.dataset.ts = String(q.ts || Date.now());
      age.textContent = ageOf(q.ts);
      meta.append(age);
      body.append(meta);
      const text = document.createElement('span');
      text.className = 'wch-qtext';
      text.textContent = q.text;
      body.append(text);
      item.append(body);

      if (settings.allowResolve) {
        const btn = document.createElement('button');
        btn.className = 'wch-qdone';
        btn.type = 'button';
        btn.textContent = '✓';
        btn.title = isResolved ? 'Reopen' : 'Mark as resolved';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleResolved(key);
        });
        item.append(btn);
      }
      list.append(item);
    }
  }

  function removeQuestionsCard() {
    if (qcard) qcard.remove();
    qcard = null;
    qcardEls = null;
  }

  // "just now", "45s", "3m", "1h 12m" — how long since the question was first seen.
  function ageOf(ts) {
    const s = Math.max(0, Math.round((Date.now() - (ts || Date.now())) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  // Ages tick without rebuilding the list: only the age spans are touched.
  intervals.push(setInterval(() => {
    if (!qcard) return;
    for (const el of qcard.querySelectorAll('.wch-qage')) {
      const want = ageOf(Number(el.dataset.ts));
      if (el.textContent !== want) el.textContent = want;
    }
  }, 15000));

  // -------------------------------------------------------------- decoration

  const BADGE = /^(mod|host|vip|verified|og|new|top buyer|following|seller)$/i;

  // The message text only — not the whole row.
  //
  // Keying off the row's full textContent meant the username, badges, and the
  // avatar's fallback initial were part of the key. When an avatar image
  // finishes loading, that initial disappears, the key changes, and the same
  // message gets queued for classification a second time — a duplicate billed
  // call for every avatar that loads late. Stripping to the message body makes
  // the key stable, and sends the classifier cleaner input.
  function partsOf(row) {
    const clone = row.cloneNode(true);
    clone
      .querySelectorAll('img, svg, picture, video, [class*="rounded-full"], [class*="avatar"]')
      .forEach((n) => n.remove());

    const parts = Array.from(clone.querySelectorAll('*'))
      .filter((e) => e.children.length === 0)
      .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (parts.length < 2) return { user: '', body: textOf(clone).slice(0, 200) };

    // parts[0] is the username when it's a single token; the rest is the body,
    // minus badge chips that sit between the name and the message.
    const hasUser = /^\S{1,30}$/.test(parts[0]);
    const body = (hasUser ? parts.slice(1) : parts)
      .filter((p) => !BADGE.test(p))
      .join(' ')
      .trim();

    return { user: hasUser ? parts[0] : '', body: (body || textOf(clone)).slice(0, 200) };
  }

  const keyOf = (row) => partsOf(row).body;
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
    if (!alive()) return shutdown('context invalidated');
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      schedulePump(wait);
      return;
    }

    while (inFlight < MAX_INFLIGHT && queued.length) {
      const [key, text] = queued.shift();
      inFlight++;

      try {
        chrome.runtime.sendMessage({ type: 'classify', text }, (res) => {
        void chrome.runtime.lastError;
        inFlight--;

        if (res && typeof res.isQuestion === 'boolean') {
          verdicts.set(key, res.isQuestion);
          panelDirty = true;
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
      } catch (err) {
        inFlight--;
        if (isContextError(err)) return shutdown(err.message);
        log('classify threw:', err.message);
      }
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
        toggleResolved(key);
      });
      tag.append(btn);
    }

    row.append(tag);
    return tag;
  }

  function decorate(row) {
    const raw = textOf(row);
    if (!raw || raw.length > MAX_ROW_CHARS) return;

    // key IS the message body — classify and match on that, not the raw row.
    const { user, body: key } = partsOf(row);
    const text = key;
    if (text.length >= 2) queueForClassification(key, text);

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

    if (!questions.has(key)) {
      questions.set(key, { user, text, ts: Date.now() });
      panelDirty = true;
    }

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
    if (!alive()) return shutdown('context invalidated');
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
      renderQuestionsCard();
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
        if (isContextError(err)) shutdown(err.message);
        else log('decorate failed', err);
      }
    });
  }

  // Full revert: every trace of the extension comes out of the page. Queries the
  // whole document rather than the current rowList — rows we decorated may have
  // scrolled out of the list we're holding a reference to.
  function removeAllDecorations() {
    for (const el of document.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
    for (const el of document.querySelectorAll(`.${CLS.tag}`)) el.remove();
    removeQuestionsCard();
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

  // Seller pages only (owner, 2026-10-23), the same rule as the Auction card.
  const onSellerShow = () => /^\/dashboard\/live\//.test(location.pathname);

  function tryAttach() {
    if (!onSellerShow()) return false;
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
    questions.clear();
    panelDirty = true;
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
    panelDirty = true;
    scheduleDecorate();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'ping') {
      sendResponse({ ok: true, attached: !!region, url: location.href });
      return true;
    }
    if (msg?.type === 'clearResolved') {
      resolved.clear();
      panelDirty = true;
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
  intervals.push(setInterval(() => {
    if (region && document.contains(region)) return;
    if (!onSellerShow()) return;
    attachAttempts++;
    if (tryAttach()) return;
    if (attachAttempts % 10 === 0) autoDetect();
  }, ATTACH_RETRY_MS));

  // Whatnot is a SPA: re-attach when the route changes.
  intervals.push(setInterval(() => {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    detach();
    boot();
  }, 1500));

  boot();
})();
