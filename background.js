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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js', 'capture.js'] });
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
const CAPTURE_MAX = 5000;
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

const LABELS = {
  // DYMO die-cut label geometry in twips (1440/in), drawn in landscape. The
  // PaperName must match the driver's paper list exactly.
  30252: { paper: '30252 Address', w: 1581, h: 5040, bounds: [332, 150, 4455, 1260], title: 14, body: 10 },
  30336: { paper: '30336 1 in x 2-1/8 in', w: 1440, h: 3060, bounds: [130, 130, 2800, 1180], title: 12, body: 9 },
  30334: { paper: '30334 2-1/4 in x 1-1/4 in', w: 1800, h: 3240, bounds: [150, 150, 2940, 1500], title: 13, body: 10 },
};

const xmlEscape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One text object whose styled runs carry their own font sizes: a bold title
// line, then the smaller detail lines. ShrinkToFit keeps long titles on the label.
function labelXml(kind, lines) {
  const L = LABELS[kind] || LABELS[30252];
  const run = (text, size, bold) => `<Element><String>${xmlEscape(text)}</String><Attributes><Font Family="Arial" Size="${size}" Bold="${bold ? 'True' : 'False'}" Italic="False" Underline="False" Strikeout="False"/><ForeColor Alpha="255" Red="0" Green="0" Blue="0"/></Attributes></Element>`;
  const runs = lines.map((l, i) => run((i ? '\n' : '') + l.text, l.title ? L.title : L.body, !!l.title)).join('');
  const [x, y, w, h] = L.bounds;
  return `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips">
  <PaperOrientation>Landscape</PaperOrientation>
  <Id>Label</Id>
  <PaperName>${L.paper}</PaperName>
  <DrawCommands><RoundRectangle X="0" Y="0" Width="${L.w}" Height="${L.h}" Rx="270" Ry="270"/></DrawCommands>
  <ObjectInfo>
    <TextObject>
      <Name>TEXT</Name>
      <ForeColor Alpha="255" Red="0" Green="0" Blue="0"/>
      <BackColor Alpha="0" Red="255" Green="255" Blue="255"/>
      <LinkedObjectName></LinkedObjectName>
      <Rotation>Rotation0</Rotation>
      <IsMirrored>False</IsMirrored>
      <IsVariable>False</IsVariable>
      <HorizontalAlignment>Left</HorizontalAlignment>
      <VerticalAlignment>Middle</VerticalAlignment>
      <TextFitMode>ShrinkToFit</TextFitMode>
      <UseFullFontHeight>True</UseFullFontHeight>
      <Verticalized>False</Verticalized>
      <StyledText>${runs}</StyledText>
    </TextObject>
    <Bounds X="${x}" Y="${y}" Width="${w}" Height="${h}"/>
  </ObjectInfo>
</DieCutLabel>`;
}

function fmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// The lines on a label for one close: title, when, seller/winner/price.
function labelLines(entry, settings) {
  const lines = [{ text: entry.title || '(no title)', title: true }, { text: fmtWhen(entry.ts) }];
  const bits = [];
  if (settings.sellerName) bits.push(settings.sellerName);
  if (entry.winner) bits.push(entry.winner);
  if (entry.price) bits.push(entry.price);
  if (bits.length) lines.push({ text: bits.join(' · ') });
  return lines;
}

async function dymoPrint(entry) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (!settings.printerName) throw new Error('No printer chosen on the settings page');
  const { base } = await dymoPrinters();
  const body = new URLSearchParams({
    printerName: settings.printerName,
    printParamsXml: '<LabelWriterPrintParams><Copies>1</Copies><PrintQuality>Text</PrintQuality></LabelWriterPrintParams>',
    labelXml: labelXml(settings.labelKind || 30252, labelLines(entry, settings)),
    labelSetXml: '',
  });
  const res = await fetch(`${base}/PrintLabel`, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  const text = (await res.text()).trim();
  if (!res.ok || !/true/i.test(text)) throw new Error(`service said: ${text.slice(0, 120) || res.status}`);
  return true;
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
  }
  captureQueue.push(result);
  if (!captureFlush) captureFlush = setTimeout(flushCapture, 300);
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'print-result', result }, () => void chrome.runtime.lastError);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
