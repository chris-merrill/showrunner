// Auction-close capture + the "Auction status" card. Read-only: watches the
// live player's footer (the current-item panel), fires a structured `close`
// event when an auction ends, and mirrors what it sees into a small fixed card
// so the detector can be trusted by eye. Sends nothing to Whatnot.
//
// Verified against a live show on 2026-10-21. The footer is
// `footer[class*="livePlayerFooter"]` and carries:
//   left   strong.text-body1  title            "Mainline madness #152"
//          strong.text-body2  subtitle         "Hot Wheels ∙ 1:64"
//          text               bids             "13 Bids"
//   right  strong.text-neutral-50  price       "$15"
//          strong.text-red-500     status      "00:09" while running → "Sold" at close
//   header strong.text-caption1    winner      "<user>" + strong.text-yellow-500 "is Winning!" → "won!"
// Then the button reads "Awaiting next item" and ~20s later the next item appears.
//
// Events (to background.js → chrome.storage.local.capture, shown on the options page):
//   close – {title, subtitle, bids, price, winner} once per sold item
//   end   – status flipped from a timer to something other than "Sold" (to learn the no-sale wording)
//   panel – footer text whenever it changes (recon)
//   dom   – any new/changed text containing a close word (recon)
//   mark  – the options page's "closed now" button

(() => {
  'use strict';

  if (window.__wnCaptureLoaded) return;
  window.__wnCaptureLoaded = true;

  const LOG = '[wn-capture]';
  const FOOTER = 'footer[class*="livePlayerFooter"]';
  const HEADER_ROW = 'header nav div.flex.w-max.items-center.gap-3'; // the + / activity / inbox / bell / gift / avatar row
  const CARD_ID = 'wn-card';
  const TOGGLE_ID = 'wn-toggle';
  const STYLE_ID = 'wn-card-style';
  const HISTORY_MAX = 50;
  const HISTORY_SHOWN = 12;
  const BIDS_RE = /^\s*\d+\s+bids?\s*$/i;
  const TIMER_RE = /^\s*\d{1,2}:\d{2}\s*$/;
  const TICK_MS = 250;

  let enabled = false;
  let lastStatus = '';
  let closedKey = '';           // title|price|winner of the close already reported
  let history = [];             // closes, newest last: {ts, title, price, winner, bids}
  const recentCloses = new Map(); // title|price|winner -> ts of the close we reported
  const DUP_WINDOW_MS = 5 * 60 * 1000;
  const timers = [];              // every setInterval, so an orphaned copy can stop itself
  let startup = true;             // true until the first footer read after enabling

  const DEBUG = false; // true: echo every event to the page console

  function send(kind, data, extra) {
    const ev = { ts: Date.now(), kind, data: String(data ?? '').slice(0, 2000), page: location.href, ...extra };
    if (DEBUG) console.log(LOG, kind, ev.data);
    try {
      chrome.runtime.sendMessage({ type: 'capture-event', event: ev }, () => void chrome.runtime.lastError);
    } catch (_) { /* extension context gone; stand down on next tick */ }
  }

  const text = (el) => (el ? (el.textContent || '').trim() : '');

  // ------------------------------------------------------------ reading

  // Read the current-item panel into fields. Returns null when there's no live player.
  function readFooter() {
    const f = document.querySelector(FOOTER);
    if (!f) return null;
    const strongs = [...f.querySelectorAll('strong')];
    const title = text(strongs.find((s) => /\btext-body1\b/.test(s.className)));
    const subtitle = text(strongs.find((s) => /\btext-body2\b/.test(s.className)));
    const status = text(strongs.find((s) => /\btext-red-500\b/.test(s.className)));
    const price = text(strongs.find((s) => /\btext-right\b/.test(s.className) && /\btext-neutral-50\b/.test(s.className)));
    const walker = document.createTreeWalker(f, NodeFilter.SHOW_TEXT);
    let bids = '';
    let node;
    while ((node = walker.nextNode())) {
      if (BIDS_RE.test(node.nodeValue)) { bids = node.nodeValue.trim(); break; }
    }
    const yellow = strongs.find((s) => /\btext-yellow-500\b/.test(s.className));
    const winner = yellow && yellow.parentElement
      ? text(yellow.parentElement).replace(text(yellow), '').trim()
      : '';
    const winState = text(yellow); // "is Winning!" | "won!" | ""
    const panel = (f.innerText || '').replace(/\s*\n+\s*/g, ' | ').trim();
    const sold = /^sold$/i.test(status) || /\bwon\b/i.test(winState);
    const running = TIMER_RE.test(status);
    const waiting = /awaiting next item/i.test(panel);
    return { title, subtitle, bids, price, status, winner, winState, panel, sold, running, waiting };
  }

  // Showrunner is a seller's tool: the card shows only on the seller's own live
  // show, Whatnot's dashboard at /dashboard/live/<id> (owner, 2026-10-23: "tune it
  // to only show on seller pages"). Never on viewer pages, home, or login.
  function onShowPage() {
    return /^\/dashboard\/live\//.test(location.pathname);
  }

  function tick() {
    if (!enabled || !document.body) return;
    if (!onShowPage()) { removeCard(); return; }
    try {
      const r = readFooter();
      renderCard(r);
      if (!r) return;

      const key = `${r.title}|${r.price}|${r.winner}`;

      // First look after (re)starting: if the footer already shows a sold item,
      // that sale happened before we were watching (a tab or extension reload
      // mid-"Awaiting next item"). Note it, don't report or print it again.
      if (startup) {
        startup = false;
        if (r.sold) {
          closedKey = key;
          send('seen', `already sold at start — ${r.title} — ${r.price} — ${r.winner || '?'}`);
        }
      }

      if (r.sold && key !== closedKey) {
        closedKey = key;
        const now = Date.now();
        const entry = { ts: now, title: r.title, subtitle: r.subtitle, bids: r.bids, price: r.price, winner: r.winner };
        const prev = recentCloses.get(key);
        if (prev && now - prev < DUP_WINDOW_MS) {
          // Same item, price and winner sold again within minutes: the footer
          // re-rendered through a countdown state, not a second sale. Logged
          // so the panel sequence around it can be studied; not a close.
          send('dup', `${r.title} — ${r.price} — ${r.winner || '?'} (${Math.round((now - prev) / 1000)}s after the first)`, entry);
        } else {
          recentCloses.set(key, now);
          history.push(entry);
          if (history.length > HISTORY_MAX) history.shift();
          renderHistory();
          send('close', `${r.title} — ${r.price} — ${r.winner || '?'} — ${r.bids}`, entry);
        }
      } else if (!r.sold && r.running) {
        closedKey = ''; // a new countdown is running; the next close is a new sale
      }

      // Status went from a countdown to something that isn't "Sold": record the
      // wording so we learn what an unsold / cancelled item looks like.
      if (r.status !== lastStatus) {
        if (TIMER_RE.test(lastStatus) && !r.running && !r.sold) {
          send('end', `status "${r.status}" after countdown — ${r.title} — ${r.bids}`, { title: r.title, status: r.status });
        }
        lastStatus = r.status;
      }
    } catch (e) {
      send('error', e && e.message);
    }
  }

  // --------------------------------------------------------------- card

  const CSS = `
    /* The card is a sibling of Whatnot's "Shop" card in the left column and
       copies its look: white, 16px radius, 24px side padding, system font.
       Falls back to a floating card (data-floating) if that column isn't there. */
    #${CARD_ID} {
      --wn-fg: #000;
      --wn-dim: #6b6b6b;
      --wn-line: rgba(0, 0, 0, 0.08);
      --wn-bg: #fff;
      box-sizing: border-box;
      flex: none;
      margin-bottom: 16px;
      border-radius: 16px;
      background: var(--wn-bg);
      color: var(--wn-fg);
      font: 400 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    html.dark #${CARD_ID}, .dark #${CARD_ID} { --wn-fg: #fff; --wn-dim: #a3a3a3; --wn-line: rgba(255, 255, 255, 0.1); --wn-bg: #171717; }
    #${CARD_ID}[data-floating] {
      position: fixed;
      left: 16px;
      bottom: 16px;
      width: 320px;
      z-index: 2147482000;
      margin: 0;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    }
    #${CARD_ID} .wn-head {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 24px 0;
      cursor: pointer;
      user-select: none;
    }
    #${CARD_ID} .wn-name { font-weight: 600; font-size: 16px; flex: 1; }
    #${CARD_ID} .wn-head .wn-mark { flex: none; margin-right: -2px; }
    #${CARD_ID} .wn-state {
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 999px;
      background: rgba(128, 128, 128, 0.15);
      color: var(--wn-fg);
    }
    #${CARD_ID} .wn-state[data-state="running"] { background: #e03131; color: #fff; }
    #${CARD_ID} .wn-state[data-state="sold"] { background: #2f9e44; color: #fff; }
    #${CARD_ID} .wn-state[data-state="waiting"] { background: #ffe500; color: #111; }
    #${CARD_ID} .wn-body { padding: 10px 24px 16px; }
    #${CARD_ID} .wn-title { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
    #${CARD_ID} .wn-meta { color: var(--wn-dim); margin-top: 2px; font-size: 13px; }
    #${CARD_ID} .wn-who { margin-top: 6px; font-size: 13px; }
    #${CARD_ID} .wn-who b { font-weight: 600; }
    #${CARD_ID} .wn-print { margin-top: 6px; font-size: 12px; color: var(--wn-dim); }
    #${CARD_ID} .wn-print:empty { display: none; }
    #${CARD_ID} .wn-print[data-ok="1"] { color: #2f9e44; }
    #${CARD_ID} .wn-print[data-ok="0"] { color: #e03131; }
    #${CARD_ID} .wn-again {
      display: block;
      width: 100%;
      margin-top: 10px;
      padding: 9px 12px;
      border: 1px solid var(--wn-line);
      border-radius: 999px;
      background: transparent;
      color: var(--wn-fg);
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${CARD_ID} .wn-again:hover { background: rgba(128, 128, 128, 0.15); }
    #${CARD_ID} .wn-auto {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--wn-line);
      font-size: 13px;
      cursor: pointer;
      user-select: none;
    }
    #${CARD_ID} .wn-auto span { flex: 1; }
    /* Showrunner branding: yellow edge, logo, name. */
    #${CARD_ID} { box-shadow: inset 0 0 0 1px rgba(255, 229, 0, 0.45); border-top: 3px solid #ffe500; }
    #${CARD_ID} .wn-logo { width: 20px; height: 20px; border-radius: 5px; flex: none; }
    #${CARD_ID} .wn-name b { font-weight: 700; }
    #${CARD_ID} .wn-tool { color: var(--wn-dim); font-weight: 500; margin-left: 6px; }
    #${CARD_ID} .wn-tool::before { content: '·'; margin-right: 6px; }
    #${CARD_ID} .wn-gear { flex: none; display: grid; place-items: center; width: 28px; height: 28px; margin-right: -6px; border: 0; border-radius: 999px; background: transparent; color: var(--wn-dim); cursor: pointer; }
    #${CARD_ID} .wn-gear:hover { color: var(--wn-fg); background: rgba(128, 128, 128, 0.15); }
    #${CARD_ID} :is(.wn-title, .wn-meta, .wn-who) { display: none; }
    #${CARD_ID} .wn-body:not(:has(.wn-print:not(:empty), .wn-again:not([style*="none"]))) { display: none; }
    #${CARD_ID} .wn-head { cursor: default; padding-bottom: 10px; }
    #${CARD_ID} .wn-chev { flex: none; width: 28px; height: 28px; margin-right: -8px; border: 0; border-radius: 999px; background: transparent; color: var(--wn-dim); font-size: 20px; line-height: 1; cursor: pointer; }
    #${CARD_ID} .wn-chev:hover { color: var(--wn-fg); background: rgba(128, 128, 128, 0.15); }
    #${CARD_ID}[data-folded] .wn-status { display: none; }
    #${CARD_ID}[data-folded] .wn-head { padding-bottom: 10px; }
    #${CARD_ID} .wn-body { display: none !important; }
    #${CARD_ID} .wn-head { padding-bottom: 4px; }
    #${CARD_ID} .wn-status { display: flex; align-items: center; gap: 8px; padding: 0 14px 10px; min-height: 26px; }
    #${CARD_ID} .wn-status .wn-state { white-space: nowrap; }
    #${CARD_ID} .wn-status .wn-state[data-state="none"], #${CARD_ID} .wn-status .wn-state[data-state="idle"] { background: transparent; padding-left: 0; color: var(--wn-dim); font-weight: 500; }
    #${CARD_ID} .wn-status .wn-print { flex: 1; min-width: 0; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #${CARD_ID} .wn-status .wn-again { width: auto; margin: 0 0 0 auto; padding: 4px 10px; font-size: 12px; flex: none; }
    .wn-dialog { width: 360px; max-width: calc(100vw - 32px); max-height: 80vh; overflow: auto; padding: 16px 18px; border: 0; border-top: 3px solid #ffe500; border-radius: 14px; background: #171717; color: #fff; font: 400 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; --wn-fg: #fff; --wn-dim: #a3a3a3; --wn-line: rgba(255,255,255,0.1); }
    .wn-dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
    #${CARD_ID} .wn-help { font: 700 14px/1 system-ui, sans-serif; }
    .wn-blurb { margin: 8px 0 4px; color: var(--wn-dim); font-size: 13px; }
    .wn-links { margin: 0 0 12px; font-size: 12px; color: var(--wn-dim); }
    .wn-links a { color: #ffe500; }
    .wn-form { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--wn-line); }
    .wn-kinds { display: flex; flex-wrap: wrap; gap: 6px; }
    .wn-kind { padding: 5px 10px; border: 1px solid var(--wn-line); border-radius: 999px; background: transparent; color: var(--wn-fg); font: inherit; font-size: 12px; cursor: pointer; }
    .wn-kind[data-on] { background: #ffe500; border-color: #ffe500; color: #111; font-weight: 600; }
    .wn-input { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--wn-line); border-radius: 10px; background: rgba(255, 255, 255, 0.04); color: var(--wn-fg); font: inherit; font-size: 13px; resize: vertical; }
    .wn-input:focus { outline: 2px solid #ffe500; outline-offset: 0; }
    .wn-check { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--wn-dim); cursor: pointer; }
    .wn-send { margin-top: 2px; background: #ffe500; border-color: #ffe500; color: #111; }
    .wn-send:hover { background: #ffe500; filter: brightness(0.95); }
    .wn-send:disabled { opacity: 0.6; cursor: default; }
    .wn-sent { font-size: 12px; min-height: 16px; }
    .wn-sent[data-ok="1"] { color: #3ddc97; }
    .wn-sent[data-ok="0"] { color: #ff8787; }
    .wn-dhead { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .wn-dhead .wn-name { flex: 1; font-size: 15px; }
    .wn-close { border: 0; background: transparent; color: var(--wn-dim); font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px; }
    .wn-noprinter { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: rgba(255, 229, 0, 0.12); font-size: 13px; }
    .wn-more { margin-top: 14px; width: 100%; padding: 9px 12px; border: 1px solid var(--wn-line); border-radius: 999px; background: transparent; color: var(--wn-fg); font: inherit; font-weight: 600; cursor: pointer; }
    .wn-more:hover { background: rgba(128, 128, 128, 0.15); }
    /* Compact sizing for the seller dashboard. */
    #${CARD_ID} { margin-bottom: 12px; border-radius: 12px; }
    #${CARD_ID} .wn-head { padding: 10px 14px 0; gap: 8px; }
    #${CARD_ID} .wn-name { font-size: 14px; }
    #${CARD_ID} .wn-body { padding: 6px 14px 10px; }
    #${CARD_ID} .wn-auto input { position: absolute; opacity: 0; pointer-events: none; }
    #${CARD_ID} .wn-sw {
      display: block;
      flex: none;
      width: 36px;
      height: 20px;
      border-radius: 999px;
      background: rgba(128, 128, 128, 0.35);
      position: relative;
      transition: background 120ms ease;
    }
    #${CARD_ID} .wn-sw::after {
      content: '';
      position: absolute;
      top: 2px; left: 2px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: #fff;
      transition: transform 120ms ease;
    }
    #${CARD_ID} .wn-auto input:checked + .wn-sw { background: #ffe500; }
    #${CARD_ID} .wn-auto input:checked + .wn-sw::after { transform: translateX(16px); }
    #${CARD_ID} .wn-hist-head {
      display: flex;
      align-items: center;
      margin: 14px 0 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--wn-dim);
    }
    #${CARD_ID} .wn-hist-head span { flex: 1; }
    #${CARD_ID} .wn-clear {
      border: 0;
      background: transparent;
      color: var(--wn-dim);
      font: inherit;
      text-transform: none;
      letter-spacing: 0;
      font-size: 12px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 6px;
    }
    #${CARD_ID} .wn-clear:hover { color: var(--wn-fg); background: rgba(128, 128, 128, 0.15); }
    #${CARD_ID} .wn-hist .wn-x {
      flex: none;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--wn-dim);
      font: 600 15px/1 system-ui, sans-serif;
      cursor: pointer;
    }
    #${CARD_ID} .wn-hist .wn-x:hover { color: #e03131; background: rgba(224, 49, 49, 0.1); }
    #${CARD_ID} .wn-hist { max-height: 190px; overflow-y: auto; margin: 0; padding: 0; list-style: none; font-size: 13px; }
    #${CARD_ID} .wn-hist li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 0;
      border-top: 1px solid var(--wn-line);
    }
    #${CARD_ID} .wn-hist .wn-t { color: var(--wn-dim); font-variant-numeric: tabular-nums; flex: none; }
    #${CARD_ID} .wn-hist .wn-i { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #${CARD_ID} .wn-hist .wn-p { font-weight: 600; flex: none; }
    #${CARD_ID} .wn-hist .wn-re {
      flex: none;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--wn-dim);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #${CARD_ID} .wn-hist .wn-re:hover { color: var(--wn-fg); background: rgba(128, 128, 128, 0.15); }
    #${CARD_ID} .wn-hist .wn-re svg { width: 15px; height: 15px; }
    #${CARD_ID} .wn-empty { color: var(--wn-dim); }

    /* Header toggle: same 36px round button as Whatnot's own icons. It is NOT a
       child of their header (React re-renders that row and would remove it,
       which blinked once a second). It lives on <body>, position:fixed, in a
       gap we open left of the avatar with a margin React never touches. */
    ${HEADER_ROW} > button:last-of-type { margin-left: 48px !important; }
    /* Chris's ask: a narrower search box, with the icon row kept on the right. */
    header nav div.hidden.grow.items-center > div.grow { max-width: 420px; }
    ${HEADER_ROW} { margin-left: auto; }
    #${TOGGLE_ID} {
      position: fixed;
      z-index: 2147482001;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: currentColor;
      cursor: pointer;
      flex: none;
    }
    #${TOGGLE_ID}:hover { background: rgba(128, 128, 128, 0.15); }
    #${TOGGLE_ID} svg { width: 24px; height: 24px; }
    #${TOGGLE_ID}[data-on] { background: #ffe500; color: #111; }
    #${TOGGLE_ID}[data-on]:hover { background: #f5dc00; }
  `;

  function injectStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).append(style);
    }
    if (style.textContent !== CSS) style.textContent = CSS;
  }

  const el = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };

  // The Showrunner mark (a clapperboard), as stroke paths on a 24-unit grid.
  // Used for the header toggle and the card titles; the PNG icons match it.
  const MARK_PATHS = [
    'M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z',
    'm6.2 5.3 3.1 3.9',
    'm12.4 3.4 3.1 4',
    'M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  ];
  function markSvg(size) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.classList.add('wn-mark');
    for (const d of MARK_PATHS) {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  let card = null;
  let cardEls = null;
  let folded = false;
  try { chrome.storage.local.get('cardFolded').then((r) => { folded = !!r.cardFolded; if (cardEls) cardEls.setChev(); }); } catch (_) { /* orphaned */ }

  // The left column of a live show ("Shop" card lives in it). Our card goes in
  // as its first child; React reconciles its own children and leaves ours be.
  const SHOP_COLUMN = 'div[class*="grid-area:shop"]';

  // The seller's live dashboard: a 3-column grid (products | video | stats+chat).
  // Our card goes at the top of the left (products) column, so it never covers
  // the seller's own controls (owner, 2026-10-23: it hid the Add button).
  const SELLER_LEFT = 'div[class*="grid-cols-[375px_1fr"] > div:first-child > section';

  function mountCard() {
    // Only ever in that column (owner, 2026-10-23): no floating fallback. Until
    // the column renders, the card waits off-page; the next tick mounts it.
    const col = document.querySelector(SELLER_LEFT);
    if (!col) return;
    card.removeAttribute('data-floating');
    if (card.parentElement !== col || col.firstElementChild !== card) col.prepend(card);
  }

  function ensureCard() {
    injectStyle();
    if (card && document.contains(card)) {
      return;
    }
    if (card) { mountCard(); return; } // same card, re-attached after a re-render
    card = el('div');
    card.id = CARD_ID;
    const head = el('div', 'wn-head');
    // Showrunner branding (owner, 2026-10-23: "hard to tell what is ours"):
    // the extension's own yellow clapperboard icon, the name, then the tool.
    const logo = el('img', 'wn-logo');
    logo.alt = '';
    try { logo.src = chrome.runtime.getURL('icons/icon-48.png'); } catch (_) { /* orphaned */ }
    const name = el('span', 'wn-name');
    name.append(el('b', null, 'Showrunner'));
    const state = el('span', 'wn-state', '—');
    // Settings live behind a gear (owner, 2026-10-23: "be thoughtful about our
    // presence on the screen"); the card itself is just status + Reprint last.
    const gear = el('button', 'wn-gear');
    gear.type = 'button';
    gear.title = 'Showrunner settings and sale history';
    gear.setAttribute('aria-label', gear.title);
    gear.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    // Collapse (owner, 2026-10-23: "icons > and \/"): a chevron folds the card
    // to its header line. Remembered across reloads.
    const chev = el('button', 'wn-chev');
    chev.type = 'button';
    const setChev = () => {
      card.toggleAttribute('data-folded', folded);
      chev.textContent = folded ? '›' : '⌄';
      chev.title = folded ? 'Show details' : 'Hide details';
      chev.setAttribute('aria-expanded', String(!folded));
    };
    chev.addEventListener('click', () => {
      folded = !folded;
      setChev();
      try { chrome.storage.local.set({ cardFolded: folded }); } catch (_) { /* orphaned */ }
    });
    setChev();
    // About + feedback (owner, 2026-10-23): a (?) in the header opens what
    // Showrunner is and a form for bugs, feature requests and feedback.
    const help = el('button', 'wn-gear wn-help', '?');
    help.type = 'button';
    help.title = 'About Showrunner, report a bug, request a feature';
    help.setAttribute('aria-label', help.title);
    // Two rows (owner, 2026-10-23: "too cluttered… primary and secondary row"):
    // brand + icons on top, the live status and Reprint last underneath.
    head.append(logo, name, help, gear, chev);
    const body = el('div', 'wn-body');
    const title = el('div', 'wn-title', '');
    const meta = el('div', 'wn-meta', '');
    const who = el('div', 'wn-who', '');
    const print = el('div', 'wn-print', '');

    // Reprint last label (Pablo, 2026-10-22: "I sometimes bundle up 3-4 cars
    // and each one needs the same label"): one tap per extra copy of the most
    // recent sale's label. Shown only when printing is ready and there's a sale.
    const again = el('button', 'wn-again', 'Reprint last label');
    again.type = 'button';
    again.addEventListener('click', () => {
      const last = history[history.length - 1];
      if (last) reprint(last);
    });

    // Auto-print switch: the same `printOnClose` setting as the settings page.
    const auto = el('label', 'wn-auto');
    const autoInput = el('input');
    autoInput.type = 'checkbox';
    autoInput.checked = printOnClose;
    autoInput.addEventListener('change', async () => {
      try {
        const { settings = {} } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, printOnClose: autoInput.checked } });
      } catch (_) { /* orphaned copy */ }
    });
    auto.append(el('span', null, 'Auto-print a label on each sale'), autoInput, el('i', 'wn-sw'));
    auto.style.display = printerReady ? '' : 'none';
    const noPrinter = el('div', 'wn-noprinter', 'No label printer found. Open All settings to set one up.');
    noPrinter.style.display = printerReady ? 'none' : '';

    const histHead = el('div', 'wn-hist-head');
    const clearAll = el('button', 'wn-clear', 'Clear all');
    clearAll.type = 'button';
    clearAll.title = 'Remove every sale from this list';
    clearAll.addEventListener('click', () => removeCloses());
    histHead.append(el('span', null, 'History'), clearAll);
    const hist = el('ul', 'wn-hist');
    const status = el('div', 'wn-status');
    status.append(state, print, again);
    body.append(title, meta, who);
    card.append(head, status, body);

    // The settings modal: auto-print, sale history, a link to all settings.
    const dlg = el('dialog', 'wn-dialog');
    dlg.id = CARD_ID + '-dialog';
    const dHead = el('div', 'wn-dhead');
    const dLogo = logo.cloneNode();
    const dName = el('span', 'wn-name');
    dName.append(el('b', null, 'Showrunner'), el('span', 'wn-tool', 'Labels'));
    const close = el('button', 'wn-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => dlg.close());
    dHead.append(dLogo, dName, close);
    const more = el('button', 'wn-more', 'All settings');
    more.type = 'button';
    more.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'open-options' }, () => void chrome.runtime.lastError); } catch (_) { /* orphaned */ }
    });
    dlg.append(dHead, auto, noPrinter, histHead, hist, more);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop click
    gear.addEventListener('click', () => {
      // Stays inside the card (so the card's styles apply); showModal lifts it
      // into the top layer above the page anyway.
      if (!dlg.open) dlg.showModal();
    });
    card.append(dlg);

    const about = el('dialog', 'wn-dialog');
    const aHead = el('div', 'wn-dhead');
    const aName = el('span', 'wn-name');
    aName.append(el('b', null, 'Showrunner'), el('span', 'wn-tool', 'Public beta'));
    const aClose = el('button', 'wn-close', '×');
    aClose.type = 'button';
    aClose.setAttribute('aria-label', 'Close');
    aClose.addEventListener('click', () => about.close());
    aHead.append(logo.cloneNode(), aName, aClose);
    let ver = '';
    try { ver = chrome.runtime.getManifest().version; } catch (_) { /* orphaned */ }
    const blurb = el('p', 'wn-blurb', 'The back office for your live shows. A label prints the moment an auction closes. Free during the beta: tell us what breaks and what you would like next.');
    const links = el('p', 'wn-links');
    const site = el('a', null, 'showrunner.tools');
    site.href = 'https://showrunner.tools';
    site.target = '_blank';
    site.rel = 'noopener';
    links.append(site, el('span', null, ` · version ${ver}`));

    const form = el('form', 'wn-form');
    const kinds = el('div', 'wn-kinds');
    let kind = 'bug';
    for (const [k, label] of [['bug', 'Report a bug'], ['feature', 'Request a feature'], ['feedback', 'Feedback']]) {
      const b = el('button', 'wn-kind', label);
      b.type = 'button';
      b.dataset.kind = k;
      if (k === kind) b.dataset.on = '';
      b.addEventListener('click', () => {
        kind = k;
        for (const x of kinds.children) x.toggleAttribute('data-on', x === b);
        msgBox.placeholder = k === 'bug' ? 'What happened, and what did you expect?' : k === 'feature' ? 'What would make your shows easier?' : 'Tell us anything.';
      });
      kinds.append(b);
    }
    const msgBox = el('textarea', 'wn-input');
    msgBox.rows = 4;
    msgBox.maxLength = 5000;
    msgBox.required = true;
    msgBox.placeholder = 'What happened, and what did you expect?';
    const emailBox = el('input', 'wn-input');
    emailBox.type = 'email';
    emailBox.maxLength = 200;
    emailBox.placeholder = 'Email, if you would like a reply (optional)';
    const diagRow = el('label', 'wn-check');
    const diagBox = el('input');
    diagBox.type = 'checkbox';
    diagBox.checked = true;
    diagRow.append(diagBox, el('span', null, 'Include printer settings and the last few sales, to help us fix it'));
    const send = el('button', 'wn-more wn-send', 'Send');
    send.type = 'submit';
    const sent = el('div', 'wn-sent');
    form.append(kinds, msgBox, emailBox, diagRow, send, sent);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const message = msgBox.value.trim();
      if (!message) return;
      send.disabled = true;
      send.textContent = 'Sending…';
      sent.textContent = '';
      try {
        chrome.runtime.sendMessage({
          type: 'feedback', kind, message, email: emailBox.value.trim(),
          includeDiagnostics: diagBox.checked, page: onShowPage() ? 'seller-live' : 'other',
        }, (res) => {
          void chrome.runtime.lastError;
          send.disabled = false;
          send.textContent = 'Send';
          if (res?.ok) {
            msgBox.value = '';
            sent.dataset.ok = '1';
            sent.textContent = 'Thanks, it’s on its way to us.';
          } else {
            sent.dataset.ok = '0';
            sent.textContent = 'Couldn’t send. Check your connection and try again.';
          }
        });
      } catch (_) {
        send.disabled = false;
        send.textContent = 'Send';
        sent.dataset.ok = '0';
        sent.textContent = 'Showrunner was updated. Refresh this page, then try again.';
      }
    });
    about.append(aHead, blurb, links, form);
    about.addEventListener('click', (e) => { if (e.target === about) about.close(); });
    // Keep typing inside our form away from the page's own keyboard shortcuts.
    for (const t of ['keydown', 'keyup', 'keypress']) about.addEventListener(t, (e) => e.stopPropagation());
    help.addEventListener('click', () => { if (!about.open) about.showModal(); });
    card.append(about);
    cardEls = { state, title, meta, who, print, hist, autoInput, auto, again, noPrinter, dlg, setChev };
    mountCard();
    renderHistory();
  }

  // Remove one close (by ts) or all closes for this show from the stored log,
  // then rebuild the list from storage so the change sticks across reloads.
  function removeCloses(ts) {
    try {
      chrome.runtime.sendMessage({ type: 'capture-remove', page: location.href, ts }, () => {
        void chrome.runtime.lastError;
        loadHistory();
      });
    } catch (_) { /* orphaned copy */ }
  }

  // background.js reports each label it printed (or failed to) for a close.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // background.js and the settings page ping before injecting, so a tab never
    // gets a second copy (two copies would print every label twice).
    if (msg?.type === 'ping') {
      sendResponse({ ok: true, attached: onShowPage(), url: location.href });
      return true;
    }
    if (msg?.type !== 'print-result' || !cardEls) return;
    const r = msg.result;
    cardEls.print.textContent = r.ok ? `Label printed ${fmtTime(r.ts)} ✓` : `Label ${r.data}`;
    cardEls.print.dataset.ok = r.ok ? '1' : '0';
    if (!r.ok) checkPrinter(true);
  });

  // Only touch the DOM when a value changed: every write is a mutation the
  // page has to process, four times a second.
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  let lastWho = '';

  function renderCard(r) {
    ensureCard();
    const { state, title, meta, who } = cardEls;
    let s = 'none';
    let label = 'Waiting for an auction';
    let titleText = 'No live player on this page';
    let metaText = '';
    let whoText = '';
    if (r) {
      s = 'idle'; label = 'Idle';
      if (r.sold) { s = 'sold'; label = 'Sold'; }
      else if (r.running) { s = 'running'; label = `Running ${r.status}`; }
      else if (r.waiting) { s = 'waiting'; label = 'Awaiting next item'; }
      else if (r.title) { s = 'waiting'; label = 'Pre-bid'; }
      titleText = r.title || '—';
      metaText = [r.subtitle, r.bids, r.price].filter(Boolean).join(' · ');
      whoText = r.winner ? `${r.winner}\u0000${r.winState}` : '';
    }
    setText(state, label);
    if (state.dataset.state !== s) state.dataset.state = s;
    setText(title, titleText);
    setText(meta, metaText);
    if (whoText !== lastWho) {
      lastWho = whoText;
      if (!whoText) setText(cardEls.print, ''); // new item: clear the last print status
      who.replaceChildren();
      if (whoText) {
        const [winner, winState] = whoText.split('\u0000');
        who.append(el('b', null, winner), document.createTextNode(` ${winState}`));
      }
    }
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function renderHistory() {
    if (!cardEls) return;
    updateAgain();
    const items = history.slice(-HISTORY_SHOWN).reverse();
    if (!items.length) {
      cardEls.hist.replaceChildren(el('li', 'wn-empty', 'No closes seen yet'));
      return;
    }
    cardEls.hist.replaceChildren(...items.map((h) => {
      const li = el('li');
      li.append(
        el('span', 'wn-t', fmtTime(h.ts)),
        el('span', 'wn-i', `${h.title}${h.winner ? ' → ' + h.winner : ''}`),
        el('span', 'wn-p', h.price || ''),
        reprintButton(h),
        removeButton(h),
      );
      li.title = `${h.title}\n${h.subtitle || ''}\n${h.bids || ''} · ${h.price || ''} · ${h.winner || ''}`;
      return li;
    }));
  }

  function removeButton(h) {
    const b = el('button', 'wn-x', '×');
    b.type = 'button';
    b.title = `Remove ${h.title} from the list`;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeCloses(h.ts);
    });
    return b;
  }

  // A small printer icon per history row: prints that sale's label again.
  function reprintButton(h) {
    const b = el('button', 'wn-re');
    b.type = 'button';
    b.title = `Reprint label for ${h.title}`;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of ['M6 9V3h12v6', 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', 'M6 14h12v7H6z']) {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    b.append(svg);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      reprint(h);
    });
    return b;
  }

  // Print one sale's label again -- the history row icons and the
  // "Reprint last label" button both land here.
  function reprint(h) {
    if (cardEls) {
      cardEls.print.textContent = `Reprinting ${h.title}…`;
      cardEls.print.dataset.ok = '';
    }
    try {
      chrome.runtime.sendMessage({ type: 'dymo-print', entry: h }, () => void chrome.runtime.lastError);
    } catch (_) { /* orphaned copy; stand-down will follow */ }
  }

  // The reprint button follows the same gate as the auto-print switch, plus
  // there has to be a sale to reprint; its label names that sale.
  function updateAgain() {
    if (!cardEls) return;
    const last = history[history.length - 1];
    cardEls.again.style.display = printerReady && last ? '' : 'none';
    const text = 'Reprint last';
    if (cardEls.again.textContent !== text) cardEls.again.textContent = text;
    cardEls.again.title = last ? `Print the label for ${last.title} again` : '';
  }

  function removeCard() {
    if (card) card.remove();
    card = null;
    cardEls = null;
  }

  // ------------------------------------------------------------- toggle

  // A round button that sits in Whatnot's header icon row, left of the avatar,
  // and flips `captureEnabled`. Lit yellow while the detector is on. It's
  // appended to <body> and positioned over the gap each tick, so the header
  // can re-render as much as it likes.
  let toggle = null;

  function ensureToggle() {
    injectStyle();
    if (toggle && document.contains(toggle)) return;
    toggle = el('button');
    toggle.id = TOGGLE_ID;
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Showrunner: auction detector');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    // The Showrunner mark: a clapperboard.
    for (const d of MARK_PATHS) {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    toggle.append(svg);
    toggle.addEventListener('click', async () => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, captureEnabled: !enabled } });
    });
    toggle.style.display = 'none';
    document.body.append(toggle);
    renderToggle();
    positionToggle();
  }

  // Place the toggle in the gap left of the avatar button (see the CSS). Hidden
  // when the desktop header row isn't on screen (narrow layouts use another).
  let lastPos = '';
  function positionToggle() {
    if (!toggle) return;
    const row = document.querySelector(HEADER_ROW);
    const avatar = row && [...row.children].reverse().find((c) => c.tagName === 'BUTTON');
    const rect = avatar && avatar.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      if (lastPos !== 'hidden') { toggle.style.display = 'none'; lastPos = 'hidden'; }
      return;
    }
    const left = Math.round(rect.left - 48);
    const top = Math.round(rect.top + (rect.height - 36) / 2);
    const pos = `${left},${top}`;
    if (pos === lastPos) return;
    lastPos = pos;
    toggle.style.left = `${left}px`;
    toggle.style.top = `${top}px`;
    toggle.style.display = 'flex';
  }

  function renderToggle() {
    if (!toggle) return;
    toggle.toggleAttribute('data-on', enabled);
    toggle.title = enabled ? 'Showrunner is on: Auction and Questions cards, labels (click to turn off)' : 'Showrunner is off (click to turn on)';
  }

  // Seed the history from closes already stored for this show, so a tab reload
  // mid-stream doesn't blank the card.
  async function loadHistory() {
    const { capture = [] } = await chrome.storage.local.get('capture');
    const here = location.href.split('?')[0];
    history = capture
      .filter((e) => e.kind === 'close' && (e.page || '').split('?')[0] === here)
      .slice(-HISTORY_MAX)
      .map((e) => ({ ts: e.ts, title: e.title, subtitle: e.subtitle, bids: e.bids, price: e.price, winner: e.winner }));
    // The duplicate guard must survive a reload too, or the same sale is
    // reported (and printed) again every time the tab restarts.
    const since = Date.now() - DUP_WINDOW_MS;
    for (const h of history) if (h.ts >= since) recentCloses.set(`${h.title}|${h.price}|${h.winner}`, h.ts);
    renderHistory();
  }

  // ------------------------------------------------------------ enable

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    renderToggle();
    if (on) {
      if (onShowPage()) ensureCard();
      startup = true;
      checkPrinter(true);
      loadHistory().finally(() => { send('start', 'capture started'); tick(); });
    } else {
      removeCard();
      lastStatus = closedKey = '';
    }
  }

  let printOnClose = false;
  let printerReady = false;

  // Ask background whether printing is set up and working; the auto-print
  // switch only shows when it is (nothing to switch on otherwise).
  function checkPrinter(force) {
    try {
      chrome.runtime.sendMessage({ type: 'printer-status', force: !!force }, (res) => {
        void chrome.runtime.lastError;
        printerReady = !!res?.ready;
        if (cardEls) {
          cardEls.auto.style.display = printerReady ? '' : 'none';
          cardEls.noPrinter.style.display = printerReady ? 'none' : '';
        }
        updateAgain();
      });
    } catch (_) { /* orphaned copy */ }
  }

  function applySettings(settings) {
    printOnClose = !!settings?.printOnClose;
    if (enabled) checkPrinter(true);
    if (cardEls && cardEls.autoInput.checked !== printOnClose) cardEls.autoInput.checked = printOnClose;
    setEnabled(!!settings?.captureEnabled);
  }

  async function loadSetting() {
    const { settings } = await chrome.storage.local.get('settings');
    applySettings(settings);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
  });

  // Whatnot is a SPA: a new show URL means a new history.
  let currentUrl = location.href;
  timers.push(setInterval(() => {
    if (orphaned()) return standDown();
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    closedKey = lastStatus = '';
    if (enabled) loadHistory();
  }, 1500));

  // After the extension is reloaded this copy of the script is orphaned: its
  // chrome.* APIs are gone but its timers keep running, so it would keep
  // re-adding a second toggle beside the new copy's. Detect that and stand down.
  function orphaned() {
    try { return !chrome.runtime?.id; } catch { return true; }
  }
  function standDown() {
    for (const t of timers) clearInterval(t);
    removeCard();
    if (toggle) toggle.remove();
    toggle = null;
    enabled = false;
  }

  function boot() {
    if (!document.body) return setTimeout(boot, 200);
    // Clear anything a previous copy left behind before we add our own.
    for (const stale of document.querySelectorAll(`#${TOGGLE_ID}, #${CARD_ID}`)) stale.remove();
    timers.push(setInterval(() => {
      if (orphaned()) return standDown();
      tick();
      ensureToggle();
      positionToggle();
    }, TICK_MS));
    timers.push(setInterval(() => { if (enabled) checkPrinter(false); }, 60000));
    window.addEventListener('resize', positionToggle);
    ensureToggle();
    loadSetting();
  }
  boot();
})();
