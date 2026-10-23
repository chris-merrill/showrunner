// Service worker: keeps the content script injected into Whatnot tabs.
//
// Declarative content_scripts only cover page loads that happen after the
// extension is installed, which otherwise makes every extension reload need a
// matching tab reload. Injecting programmatically covers already-open tabs.

const WHATNOT_MATCHES = ['https://www.whatnot.com/*', 'https://whatnot.com/*'];

// Ask before injecting: a second copy in the same tab would double-decorate.
function isAlreadyActive(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'ping' }, (res) => {
      void chrome.runtime.lastError;
      resolve(!!res?.ok);
    });
  });
}

async function injectInto(tabId) {
  if (await isAlreadyActive(tabId)) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['capture.js'] });
    return true;
  } catch (err) {
    console.warn('[wch] inject failed for tab', tabId, err.message);
    return false;
  }
}

async function injectAll() {
  const tabs = await chrome.tabs.query({ url: WHATNOT_MATCHES });
  await Promise.all(tabs.map((t) => injectInto(t.id)));
  return tabs.length;
}

chrome.runtime.onInstalled.addListener(injectAll);
chrome.runtime.onStartup.addListener(injectAll);

// The toolbar icon opens the full settings page (no popup). Chrome focuses the
// existing tab if the page is already open.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab.url || !/^https:\/\/(www\.)?whatnot\.com\//.test(tab.url)) return;
  injectInto(tabId);
});

// ------------------------------------------------------------- classifier

// The fetch runs here, not in the content script: with host permission granted
// for the endpoint, extension-initiated requests from the service worker aren't
// subject to CORS, so diecastr doesn't need to emit CORS headers for us.
const DEFAULT_ENDPOINT = 'https://diecastr.app/api/is-question';

async function classify(text) {
  const { settings } = await chrome.storage.local.get('settings');
  const endpoint = settings?.endpoint?.trim() || DEFAULT_ENDPOINT;
  const token = settings?.token?.trim();
  if (!token) return { error: 'no api key configured' };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text }),
    });

    // The caller branches on status: 401 disables, 429 backs off, everything
    // else falls through to the local rule.
    if (!res.ok) return { status: res.status };

    const data = await res.json();
    return typeof data?.isQuestion === 'boolean'
      ? { isQuestion: data.isQuestion }
      : { error: 'malformed response' };
  } catch (err) {
    return { error: err.message };
  }
}

// ------------------------------------------------------------- capture log

// capture.js fires in bursts (every panel/timer change), so events are queued
// and written in one storage round-trip per ~300ms rather than one per event.
const CAPTURE_MAX = 2000;
let captureQueue = [];
let captureFlush = null;

async function flushCapture() {
  captureFlush = null;
  if (!captureQueue.length) return;
  const batch = captureQueue;
  captureQueue = [];
  const { capture = [] } = await chrome.storage.local.get('capture');
  const all = capture.concat(batch).slice(-CAPTURE_MAX);
  await chrome.storage.local.set({ capture: all });
  const hits = all.filter((e) => e.kind === 'close').length;
  chrome.action.setBadgeText({ text: hits ? String(hits) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#d9480f' });
}

// ---------------------------------------------------------------- DYMO

// DYMO Connect (and the older DYMO Label) run a local HTTPS "DYMO Web Service"
// on 41951, moving up the range if the port is taken. All printing goes through
// here, in the service worker: host_permissions make the request CORS-exempt,
// which a content script's fetch would not be.
const DYMO_HOSTS = ['127.0.0.1', 'localhost'];
const DYMO_PORTS = [41951, 41952, 41953];
let dymoBase = null; // last base URL that answered

async function dymoGet(base, path, timeout = 4000) {
  const res = await fetch(`${base}/${path}`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  let body = await res.text();
  try { body = JSON.parse(body); } catch { /* raw XML or plain text */ }
  return body;
}

function parsePrinters(xml) {
  // The worker has no DOMParser; the service's XML is flat enough for a regex.
  const printers = [];
  const re = /<(LabelWriterPrinter|TapePrinter)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(String(xml)))) {
    const field = (name) => (m[2].match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [])[1] || '';
    printers.push({
      name: field('Name'),
      model: field('ModelName'),
      connected: field('IsConnected') === 'True',
      local: field('IsLocal') === 'True',
      twinTurbo: field('IsTwinTurbo') === 'True',
    });
  }
  return printers;
}

// Find the service and list its printers. Returns {base, printers} or throws
// with the per-port reasons so the settings page can show them.
async function dymoPrinters() {
  const errors = [];
  const bases = dymoBase ? [dymoBase] : [];
  for (const host of DYMO_HOSTS) for (const port of DYMO_PORTS) bases.push(`https://${host}:${port}/DYMO/DLS/Printing`);
  // Plain HTTP last: only the development stand-in (dev/dymo-standin.py) uses it.
  for (const host of DYMO_HOSTS) bases.push(`http://${host}:41951/DYMO/DLS/Printing`);
  for (const base of bases) {
    try {
      const printers = parsePrinters(await dymoGet(base, 'GetPrinters', 8000));
      dymoBase = base;
      return { base, printers };
    } catch (err) {
      errors.push(`${base.replace('/DYMO/DLS/Printing', '')} → ${err.name}: ${err.message}`);
    }
  }
  dymoBase = null;
  const e = new Error('DYMO service not reachable');
  e.details = errors;
  throw e;
}

// DYMO LabelWriter die-cut labels: part number, DYMO's paper name (must match
// the driver's paper list exactly), short and long side in inches. Drawn in
// landscape; geometry below is derived (twips, 1440/in).
const LABEL_CATALOG = [
  // Names and sizes are DYMO's own, from the LabelWriter 450 driver's paper list.
  ['30252', '30252 Address', 1.09, 3.5, 'Address', '3½ × 1⅛ in'],
  ['30320', '30320 Address', 1.0967, 3.5, 'Address', '3½ × 1⅛ in'],
  ['99010', '99010 Standard Address', 1.0967, 3.5, 'Standard Address', '3½ × 1⅛ in'],
  ['30321', '30321 Large Address', 1.41, 3.48, 'Large Address', '3½ × 1⅖ in'],
  ['99012', '99012 Large Address', 1.4067, 3.4867, 'Large Address', '3½ × 1⅖ in'],
  ['30323', '30323 Shipping', 2.1267, 3.97, 'Shipping', '4 × 2⅛ in'],
  ['99014', '99014 Shipping', 2.1267, 3.97, 'Shipping', '4 × 2⅛ in'],
  ['30256', '30256 Shipping', 2.3133, 4, 'Shipping', '4 × 2⁵⁄₁₆ in'],
  ['1744907', '1744907 4 in x 6 in Shipping', 4, 6, 'Shipping (4XL only)', '6 × 4 in'],
  ['30324', '30324 Diskette', 2.1267, 2.75, 'Diskette', '2¾ × 2⅛ in'],
  ['30327', '30327 File Folder', 0.7833, 3.4367, 'File Folder', '3⁷⁄₁₆ × ⁹⁄₁₆ in, 2 up'],
  ['30330', '30330 Return Address', 0.75, 2, 'Return Address', '2 × ¾ in'],
  ['11352', '11352 Return Address Int', 1, 2.1267, 'Return Address (Intl)', '2⅛ × 1 in'],
  ['30332', '30332 1 in x 1 in', 1, 1, 'Multipurpose', '1 × 1 in'],
  ['30333', '30333 1/2 in x 1 in, 2 up', 1, 1, 'Multipurpose (2 up)', '1 × ½ in, 2 up'],
  ['30334', '30334 2-1/4 in x 1-1/4 in', 1.25, 2.25, 'Multipurpose', '2¼ × 1¼ in'],
  ['30336', '30336 1 in x 2-1/8 in', 1, 2.1267, 'Multipurpose', '2⅛ × 1 in'],
  ['11354', '11354 Multi-Purpose', 1.25, 2.25, 'Multipurpose (Intl)', '2¼ × 1¼ in'],
  ['30345', '30345 3/4 in x 2-1/2 in', 0.75, 2.5, 'Multipurpose', '2½ × ¾ in'],
  ['30346', '30346 1/2 in x 1-7/8 in', 0.5, 1.8767, 'Multipurpose', '1⅞ × ½ in'],
  ['30347', '30347 1 in x 1-1/2 in', 1, 1.5, 'Book Spine', '1½ × 1 in'],
  ['30348', '30348 9/10 in x 1-1/4 in', 0.9, 1.25, 'Multipurpose', '1¼ × ⁹⁄₁₀ in'],
  ['30373', '30373 Price Tag Label', 0.9767, 2, 'Price Tag', '2 × ⁷⁄₈ in, 2 up'],
  ['30374', '30374 Appointment Card', 2, 3.5, 'Appointment / Business Card', '3½ × 2 in'],
  ['30376', '30376 Hanging File Insert', 1.1, 2, 'Hanging File Insert', '2 × ⁹⁄₁₆ in, 2 up'],
  ['30364', '30364 Name Badge Label', 2.3133, 4, 'Name Badge', '4 × 2¼ in'],
  ['30857', '30857 Badge Label', 2.3133, 4, 'Badge Label', '4 × 2¼ in'],
  ['30856', '30856 Badge Card Label', 2.4367, 4.05, 'Badge Card', '4 × 2⁷⁄₁₆ in'],
  ['30365', '30365 Name Badge Card', 2.32, 3.5, 'Name Badge Card', '3½ × 2⁵⁄₁₆ in'],
  ['30383', '30383 PC Postage 3-Part', 2.25, 7, 'Postage', '7 × 2¼ in'],
  ['30384', '30384 PC Postage 2-Part', 2.3133, 7.5, 'Postage', '7½ × 2⁵⁄₁₆ in'],
];

// {kind: {paper, w, h, bounds, title, body, label}} for the XML builder and the settings page.
const LABELS = Object.fromEntries(LABEL_CATALOG.map(([code, paper, short, long, use, nominal]) => {
  const W = Math.round(short * 1440), H = Math.round(long * 1440);
  const mx = Math.round(Math.min(0.14, short * 0.12) * 1440), my = Math.round(Math.min(0.1, short * 0.1) * 1440);
  const title = Math.max(7, Math.min(20, Math.round(short * 12)));
  return [code, {
    paper, w: W, h: H,
    bounds: [mx + 120, my, H - 2 * mx - 120, W - 2 * my],
    title, body: Math.max(6, Math.round(title * 0.72)),
    label: `${code} ${use} (${nominal})`,
  }];
}));


const xmlEscape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The label's layout (owner + Pablo, 2026-10-23): fields are switched on and
// off in the card's settings window; their order, sizes and styling are fixed
// here. Pablo, on a 1×1 in label: item number biggest, then the price; no date.
const DEFAULT_LABEL_FIELDS = { item: true, price: true, buyer: false, title: false, date: false, seller: false, tagline: true };
const TAGLINE = 'Auto labels by showrunner.tools';
const TAGLINE_SHORT = 'showrunner.tools'; // labels under 1.6 in wide

// "1:24 DIECAST - Mel #94" -> "#94". The lot number sellers put in titles;
// falls back to the whole title when there isn't one.
function itemNumber(title) {
  const m = String(title || '').match(/#\s*([A-Za-z0-9-]+)(?!.*#)/);
  return m ? `#${m[1]}` : String(title || '').trim();
}

// [{text, size: 'xl'|'l'|'m'|'s', bold}] in print order, plus whether to add the
// tag-line bar. Shared with the settings window's live preview.
function labelLayout(entry, settings) {
  const f = { ...DEFAULT_LABEL_FIELDS, ...(settings.labelFields || {}) };
  f.tagline = true; // always on during the beta (owner, 2026-10-23), whatever storage says
  const lines = [];
  if (f.item) lines.push({ text: itemNumber(entry.title) || '(no title)', size: 'xl', bold: true });
  if (f.price && entry.price) lines.push({ text: entry.price, size: 'l', bold: true });
  if (f.buyer && entry.winner) lines.push({ text: entry.winner, size: 'm', bold: false });
  if (f.title && entry.title) lines.push({ text: entry.title, size: 's', bold: false });
  if (f.date) lines.push({ text: fmtWhen(entry.ts), size: 's', bold: false });
  if (f.seller && settings.sellerName) lines.push({ text: settings.sellerName, size: 's', bold: false });
  if (!lines.length) lines.push({ text: itemNumber(entry.title) || '(no title)', size: 'xl', bold: true });
  return { lines, tagline: !!f.tagline };
}

// Point sizes per label: scaled from the label's short side, then ShrinkToFit
// (DYMO) / the bridge's fit loop keeps everything on the label.
function sizesFor(L) {
  const t = L.title; // ~12 pt on a 1 in label
  return { xl: Math.round(t * 2.6), l: Math.round(t * 1.5), m: Math.round(t * 0.95), s: Math.max(6, Math.round(t * 0.7)) };
}

function textObject(name, runs, [x, y, w, h], { align = 'Center', back = null, fore = [0, 0, 0] } = {}) {
  const [fr, fg, fb] = fore;
  const run = (text, size, bold) => `<Element><String>${xmlEscape(text)}</String><Attributes><Font Family="Arial" Size="${size}" Bold="${bold ? 'True' : 'False'}" Italic="False" Underline="False" Strikeout="False"/><ForeColor Alpha="255" Red="${fr}" Green="${fg}" Blue="${fb}"/></Attributes></Element>`;
  const backXml = back ? `<BackColor Alpha="255" Red="${back[0]}" Green="${back[1]}" Blue="${back[2]}"/>` : '<BackColor Alpha="0" Red="255" Green="255" Blue="255"/>';
  return `<ObjectInfo>
    <TextObject>
      <Name>${name}</Name>
      <ForeColor Alpha="255" Red="${fr}" Green="${fg}" Blue="${fb}"/>
      ${backXml}
      <LinkedObjectName></LinkedObjectName>
      <Rotation>Rotation0</Rotation>
      <IsMirrored>False</IsMirrored>
      <IsVariable>False</IsVariable>
      <HorizontalAlignment>${align}</HorizontalAlignment>
      <VerticalAlignment>Middle</VerticalAlignment>
      <TextFitMode>ShrinkToFit</TextFitMode>
      <UseFullFontHeight>True</UseFullFontHeight>
      <Verticalized>False</Verticalized>
      <StyledText>${runs.map((r, i) => run((i ? '\n' : '') + r.text, r.size, r.bold)).join('')}</StyledText>
    </TextObject>
    <Bounds X="${x}" Y="${y}" Width="${w}" Height="${h}"/>
  </ObjectInfo>`;
}

// Main text centered; the optional tag line is white on a black bar along the
// bottom edge (an ad for Showrunner on every label, owner's ask).
function labelXml(kind, layout) {
  const L = LABELS[kind] || LABELS[30252];
  const S = sizesFor(L);
  const [x, y, w, h] = L.bounds;
  const barH = layout.tagline ? Math.round(Math.min(260, Math.max(170, L.w * 0.16))) : 0;
  const gap = layout.tagline ? 40 : 0;
  const main = textObject('TEXT', layout.lines.map((l) => ({ text: l.text, size: S[l.size], bold: l.bold })), [x, y, w, h - barH - gap]);
  const bar = layout.tagline
    ? textObject('FOOTER', [{ text: L.h < 1.6 * 1440 ? TAGLINE_SHORT : TAGLINE, size: Math.max(5, Math.round(L.title * 0.5)), bold: true }], [x, y + h - barH, w, barH], { back: [0, 0, 0], fore: [255, 255, 255] })
    : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips">
  <PaperOrientation>Landscape</PaperOrientation>
  <Id>Label</Id>
  <PaperName>${L.paper}</PaperName>
  <DrawCommands><RoundRectangle X="0" Y="0" Width="${L.w}" Height="${L.h}" Rx="270" Ry="270"/></DrawCommands>
  ${main}
  ${bar}
</DieCutLabel>`;
}

function fmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function dymoPrint(entry) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (!settings.printerName) throw new Error('No printer chosen on the settings page');
  const { base } = await dymoPrinters();
  const body = new URLSearchParams({
    printerName: settings.printerName,
    printParamsXml: '<LabelWriterPrintParams><Copies>1</Copies><PrintQuality>Text</PrintQuality></LabelWriterPrintParams>',
    labelXml: labelXml(settings.labelKind || 30252, labelLayout(entry, settings)),
    labelSetXml: '',
  });
  const res = await fetch(`${base}/PrintLabel`, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  const text = (await res.text()).trim();
  if (!res.ok || !/true/i.test(text)) throw new Error(`service said: ${text.slice(0, 120) || res.status}`);
  return true;
}

// Is label printing actually set up and working right now? A printer chosen
// in settings, the DYMO service answering, and that printer in its list.
// Cached for a minute; the cards show the auto-print switch only when ready.
let readyCache = { at: 0, result: null };
async function printerReady(force) {
  if (!force && readyCache.result && Date.now() - readyCache.at < 60000) return readyCache.result;
  let result;
  try {
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (!settings.printerName) result = { ready: false, reason: 'no printer chosen' };
    else {
      const { printers } = await dymoPrinters();
      const p = printers.find((x) => x.name === settings.printerName);
      if (!p) result = { ready: false, reason: `${settings.printerName} not listed by the DYMO service` };
      else if (!p.connected) result = { ready: false, reason: `${settings.printerName} not connected` };
      else result = { ready: true, printer: p.name };
    }
  } catch (err) {
    result = { ready: false, reason: err.message };
  }
  readyCache = { at: Date.now(), result };
  return result;
}

// Print for a close and report back to the tab's card and the event log.
async function printForClose(entry, tabId) {
  const result = { ts: Date.now(), kind: 'print', title: entry.title, page: entry.page };
  try {
    await dymoPrint(entry);
    result.ok = true;
    result.data = `printed — ${entry.title}`;
  } catch (err) {
    result.ok = false;
    result.data = `FAILED — ${entry.title} — ${err.message}`;
    readyCache.at = 0; // re-check readiness on the next ask
  }
  captureQueue.push(result);
  if (!captureFlush) captureFlush = setTimeout(flushCapture, 300);
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'print-result', result }, () => void chrome.runtime.lastError);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'feedback') {
    sendFeedback(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'label-layout') {
    chrome.storage.local.get('settings').then(({ settings = {} }) => {
      const merged = { ...settings, ...(msg.settings || {}) };
      sendResponse({ ok: true, layout: labelLayout(msg.entry, merged), tagline: TAGLINE, defaults: DEFAULT_LABEL_FIELDS });
    });
    return true;
  }
  if (msg?.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'capture-event') {
    captureQueue.push(msg.event);
    if (!captureFlush) captureFlush = setTimeout(flushCapture, 300);
    sendResponse({ ok: true });
    if (msg.event?.kind === 'close') {
      chrome.storage.local.get('settings').then(({ settings }) => {
        if (settings?.printOnClose) printForClose(msg.event, sender.tab?.id);
      });
    }
    return false;
  }
  if (msg?.type === 'label-catalog') {
    sendResponse({ ok: true, labels: LABEL_CATALOG.map(([code, , short, long]) => ({ code, label: LABELS[code].label, short, long })) });
    return false;
  }
  if (msg?.type === 'printer-status') {
    printerReady(!!msg.force).then(sendResponse);
    return true;
  }
  if (msg?.type === 'dymo-printers') {
    dymoPrinters()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message, details: err.details || [] }));
    return true;
  }
  if (msg?.type === 'dymo-print') {
    // Reprint from the card's history: same path as a live close.
    printForClose({ ...msg.entry, page: sender.tab?.url || msg.entry.page }, sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'dymo-test-print') {
    const entry = { ts: Date.now(), title: 'Mainline madness #136', winner: 'whatnot_buyer', price: '$12', page: '' };
    dymoPrint(entry)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'capture-remove') {
    // Drop close events from the log: one (by ts) or all for a show (by page).
    // The card rebuilds its history from the log, so this is what makes
    // "clear" stick across reloads.
    const page = (msg.page || '').split('?')[0];
    flushCapture().then(async () => {
      const { capture = [] } = await chrome.storage.local.get('capture');
      const keep = capture.filter((e) => !(e.kind === 'close' && (e.page || '').split('?')[0] === page && (msg.ts == null || e.ts === msg.ts)));
      await chrome.storage.local.set({ capture: keep });
      const hits = keep.filter((e) => e.kind === 'close').length;
      chrome.action.setBadgeText({ text: hits ? String(hits) : '' });
      sendResponse({ ok: true, removed: capture.length - keep.length });
    });
    return true;
  }
  if (msg?.type === 'capture-clear') {
    captureQueue = [];
    chrome.storage.local.set({ capture: [] }).then(() => {
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg?.type === 'reconnect') {
    injectAll().then((tabs) => sendResponse({ ok: true, tabs }));
    return true;
  }
  if (msg?.type === 'classify') {
    classify(msg.text).then(sendResponse);
    return true;
  }
  return false;
});

// ------------------------------------------------------------------ feedback

// Feedback, bug reports and feature requests go to Showrunner's own database
// (Firebase project showrunner-tools, collection `feedback`). Its rules allow
// adding one well-formed report and nothing else: no client can read them back.
const FEEDBACK_URL =
  'https://firestore.googleapis.com/v1/projects/showrunner-tools/databases/(default)/documents/feedback';

async function sendFeedback({ kind, message, email, includeDiagnostics, page }) {
  const fields = {
    type: { stringValue: ['bug', 'feature', 'feedback'].includes(kind) ? kind : 'feedback' },
    message: { stringValue: String(message || '').slice(0, 5000) },
    version: { stringValue: chrome.runtime.getManifest().version },
    page: { stringValue: String(page || '').slice(0, 40) },
  };
  if (email) fields.email = { stringValue: String(email).slice(0, 200) };
  if (includeDiagnostics) {
    const { settings = {}, capture = [] } = await chrome.storage.local.get(['settings', 'capture']);
    const diag = {
      userAgent: navigator.userAgent,
      printer: { name: settings.printerName || null, label: settings.labelKind || null, autoPrint: !!settings.printOnClose },
      recent: capture.slice(-15),
    };
    fields.diagnostics = { stringValue: JSON.stringify(diag).slice(0, 20000) };
  }
  const r = await fetch(FEEDBACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { ok: true };
}
