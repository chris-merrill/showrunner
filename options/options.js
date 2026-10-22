// Full-page settings (opened by the toolbar icon). Writes chrome.storage.local;
// content.js and capture.js watch storage, so changes land without a reload.

const DEFAULT_ENDPOINT = 'https://diecastr.app/api/is-question';
const WHATNOT_URLS = ['https://www.whatnot.com/*', 'https://whatnot.com/*'];

const DEFAULTS = {
  highlightQuestions: true,
  allowResolve: true,
  questionsTab: true,
  aiEnabled: false,
  endpoint: DEFAULT_ENDPOINT,
  token: '',
  captureEnabled: false,
  printerName: '',
  labelKind: '30252',
  sellerName: '',
  printOnClose: false,
};

const $ = (id) => document.getElementById(id);
const el = {
  dot: $('dot'), status: $('status'), reconnect: $('reconnect'), reset: $('reset'),
  highlightQuestions: $('highlightQuestions'), allowResolve: $('allowResolve'), questionsTab: $('questionsTab'),
  aiEnabled: $('aiEnabled'), aiConfig: $('aiConfig'), aiNote: $('aiNote'), endpoint: $('endpoint'), token: $('token'), saveAi: $('saveAi'),
  captureEnabled: $('captureEnabled'), captureConfig: $('captureConfig'), captureMark: $('captureMark'),
  captureFilter: $('captureFilter'), captureHitsOnly: $('captureHitsOnly'), captureExport: $('captureExport'),
  captureClear: $('captureClear'), captureNote: $('captureNote'), captureBody: document.querySelector('#captureTable tbody'),
  captureLog: $('captureLog'), closesList: $('closesList'),
  printerName: $('printerName'), labelKind: $('labelKind'), sellerName: $('sellerName'), printOnClose: $('printOnClose'),
};

// ---------------------------------------------------------------- status

async function whatnotTab() {
  const tabs = await chrome.tabs.query({ url: WHATNOT_URLS });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

function ping(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'ping' }, (res) => {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

async function refreshStatus() {
  const tab = await whatnotTab();
  if (!tab) {
    el.dot.dataset.state = 'off';
    el.status.textContent = 'No Whatnot tab open';
    return;
  }
  let res = await ping(tab.id);
  if (!res) {
    await new Promise((r) => chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
      void chrome.runtime.lastError;
      r();
    }));
    res = await ping(tab.id);
  }
  if (!res) {
    el.dot.dataset.state = 'off';
    el.status.textContent = 'Not connected — reload the Whatnot tab';
  } else if (res.attached) {
    el.dot.dataset.state = 'on';
    el.status.textContent = 'Connected to chat';
  } else {
    el.dot.dataset.state = 'off';
    el.status.textContent = 'Waiting for chat to load…';
  }
}

el.reconnect.addEventListener('click', refreshStatus);
setInterval(refreshStatus, 5000);

// -------------------------------------------------------------- settings

let current = { ...DEFAULTS };

async function load() {
  const stored = await chrome.storage.local.get('settings');
  current = { ...DEFAULTS, ...(stored.settings || {}) };
  for (const k of ['highlightQuestions', 'allowResolve', 'questionsTab', 'aiEnabled', 'captureEnabled', 'printOnClose']) el[k].checked = current[k];
  el.endpoint.value = current.endpoint;
  el.token.value = current.token;
  el.aiConfig.hidden = !current.aiEnabled;
  el.captureConfig.hidden = !current.captureEnabled;
  el.labelKind.value = current.labelKind;
  el.sellerName.value = current.sellerName;
  setPrinterOptions([], current.printerName);
}

function save(patch = {}) {
  current = {
    ...current,
    highlightQuestions: el.highlightQuestions.checked,
    allowResolve: el.allowResolve.checked,
    questionsTab: el.questionsTab.checked,
    aiEnabled: el.aiEnabled.checked,
    captureEnabled: el.captureEnabled.checked,
    printOnClose: el.printOnClose.checked,
    ...patch,
  };
  chrome.storage.local.set({ settings: current });
}

for (const k of ['highlightQuestions', 'allowResolve', 'questionsTab']) el[k].addEventListener('change', () => save());

el.aiEnabled.addEventListener('change', () => {
  el.aiConfig.hidden = !el.aiEnabled.checked;
  save();
});

el.saveAi.addEventListener('click', () => {
  const endpoint = el.endpoint.value.trim() || DEFAULT_ENDPOINT;
  const token = el.token.value.trim();
  if (!token) {
    el.aiNote.textContent = 'Paste your DIECASTr key first.';
    return;
  }
  try {
    new URL(endpoint);
  } catch {
    el.aiNote.textContent = 'That endpoint isn’t a valid URL.';
    return;
  }
  save({ endpoint, token });
  el.aiNote.textContent = `Saved — classifying via ${new URL(endpoint).host}.`;
});

el.reset.addEventListener('click', async () => {
  const tab = await whatnotTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'clearResolved' }, () => {
    void chrome.runtime.lastError;
    el.status.textContent = 'Ticks cleared';
  });
});

// --------------------------------------------------------------- capture

el.captureEnabled.addEventListener('change', () => {
  el.captureConfig.hidden = !el.captureEnabled.checked;
  save();
});

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function isHit(e) {
  return e.kind === 'close' || e.kind === 'end' || e.kind === 'dup' || e.kind === 'mark';
}

function cell(cls, text) {
  const td = document.createElement('td');
  td.className = cls;
  td.textContent = text;
  return td;
}

function renderCloses(capture) {
  const closes = capture.filter((e) => e.kind === 'close').slice(-20).reverse();
  if (!closes.length) {
    el.closesList.replaceChildren(li('No closes seen yet. Open a live show with capture on.', true));
    return;
  }
  el.closesList.replaceChildren(...closes.map((e) => {
    const item = document.createElement('li');
    const t = document.createElement('span'); t.className = 't'; t.textContent = fmtTime(e.ts).slice(0, 8);
    const i = document.createElement('span'); i.className = 'i'; i.textContent = e.title || '—';
    const w = document.createElement('span'); w.className = 'w'; w.textContent = e.winner ? `→ ${e.winner}` : '';
    const p = document.createElement('span'); p.className = 'p'; p.textContent = e.price || '';
    item.append(t, i, w, p);
    item.title = `${e.subtitle || ''}\n${e.bids || ''}\n${e.page || ''}`;
    return item;
  }));
}

async function renderCapture() {
  const { capture = [] } = await chrome.storage.local.get('capture');
  renderCloses(capture);
  if (!el.captureLog.open) return; // the big table is only built while the log is expanded
  let re = null;
  try { re = el.captureFilter.value ? new RegExp(el.captureFilter.value, 'i') : null; } catch { /* keep typing */ }
  const rows = capture
    .filter((e) => !el.captureHitsOnly.checked || isHit(e))
    .filter((e) => !re || re.test(`${e.kind} ${e.data} ${e.path || ''}`))
    .slice(-500)
    .reverse();

  const hits = capture.filter(isHit).length;
  el.captureNote.textContent = capture.length
    ? `${capture.length} events stored (${hits} closes), showing ${rows.length}, newest first.`
    : 'No events yet. Open a live show with capture on.';

  el.captureBody.replaceChildren(...rows.map((e) => {
    const tr = document.createElement('tr');
    tr.dataset.kind = e.kind;
    tr.append(cell('t', fmtTime(e.ts)), cell('k', e.kind));
    const d = cell('d', String(e.data ?? ''));
    for (const [label, val] of [['was', e.prev], ['at', e.path]]) {
      if (!val) continue;
      const m = document.createElement('div');
      m.className = 'meta';
      m.textContent = `${label}: ${val}`;
      d.append(m);
    }
    tr.append(d);
    return tr;
  }));
}

el.captureMark.addEventListener('click', async () => {
  const tab = await whatnotTab();
  chrome.runtime.sendMessage({
    type: 'capture-event',
    event: { ts: Date.now(), kind: 'mark', data: 'USER: auction closed on screen', page: tab?.url || '' },
  }, () => void chrome.runtime.lastError);
});

el.captureClear.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'capture-clear' }, () => void chrome.runtime.lastError);
});

el.captureExport.addEventListener('click', async () => {
  const { capture = [] } = await chrome.storage.local.get('capture');
  const blob = new Blob([JSON.stringify(capture, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `whatnot-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
});

el.captureFilter.addEventListener('input', renderCapture);
el.captureHitsOnly.addEventListener('change', renderCapture);

// Remember whether the log is expanded (per browser; a convenience only).
try { el.captureLog.open = localStorage.getItem('wch-log-open') === '1'; } catch { /* storage blocked */ }
el.captureLog.addEventListener('toggle', () => {
  try { localStorage.setItem('wch-log-open', el.captureLog.open ? '1' : '0'); } catch { /* storage blocked */ }
  if (el.captureLog.open) renderCapture();
});

// --------------------------------------------------------------- printers

const printerEl = {
  detect: $('printerDetect'), note: $('printerNote'), list: $('printerList'),
  name: $('printerName'), save: $('printerSave'), test: $('printerTest'), testNote: $('printerTestNote'),
};

// The DYMO probe and all printing live in background.js (its host permissions
// make the local HTTPS call CORS-exempt). This page just asks it.
function probeDymo() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'dymo-printers' }, (res) => {
      void chrome.runtime.lastError;
      resolve(res || { ok: false, error: 'no answer from the extension', details: [] });
    });
  });
}

// Fill the printer <select>; keep the saved name selectable even if it isn't
// in the list right now (printer off, service down).
function setPrinterOptions(printers, selected) {
  const names = printers.map((p) => p.name);
  if (selected && !names.includes(selected)) names.unshift(selected);
  el.printerName.replaceChildren(...[
    Object.assign(document.createElement('option'), { value: '', textContent: names.length ? '— choose —' : '— detect first —' }),
    ...names.map((n) => Object.assign(document.createElement('option'), { value: n, textContent: n })),
  ]);
  el.printerName.value = selected || '';
}

printerEl.save.addEventListener('click', () => {
  save({ printerName: el.printerName.value, labelKind: el.labelKind.value, sellerName: el.sellerName.value.trim() });
  printerEl.testNote.textContent = el.printerName.value ? `Saved — labels go to ${el.printerName.value}.` : 'Saved, but no printer chosen yet.';
});

printerEl.test.addEventListener('click', () => {
  printerEl.test.disabled = true;
  printerEl.testNote.textContent = 'Printing…';
  save({ printerName: el.printerName.value, labelKind: el.labelKind.value, sellerName: el.sellerName.value.trim() });
  chrome.runtime.sendMessage({ type: 'dymo-test-print' }, (res) => {
    void chrome.runtime.lastError;
    printerEl.test.disabled = false;
    printerEl.testNote.textContent = res?.ok ? 'Sent. A label should be coming out now.' : `Failed: ${res?.error || 'no answer'}`;
  });
});

el.printOnClose.addEventListener('change', () => save());

function li(text, dim) {
  const item = document.createElement('li');
  item.textContent = text;
  if (dim) item.className = 'dim';
  return item;
}

printerEl.detect.addEventListener('click', async () => {
  printerEl.detect.disabled = true;
  printerEl.note.textContent = 'Checking…';
  const items = [];

  // 1. Chrome's own printer API (chrome.printing) — ChromeOS only.
  if (chrome.printing && chrome.printing.getPrinters) {
    try {
      const list = await chrome.printing.getPrinters();
      items.push(li(`Chrome printer API: ${list.length} printer(s)`));
      for (const p of list) items.push(li(`  ${p.name}${p.isDefault ? ' (default)' : ''}`, true));
    } catch (err) {
      items.push(li(`Chrome printer API: error — ${err.message}`, true));
    }
  } else {
    items.push(li('Chrome printer API: not available on this platform (ChromeOS only)', true));
  }

  // 2. DYMO web service.
  const dymo = await probeDymo();
  if (!dymo.ok) {
    items.push(li('DYMO service: not reachable. Install DYMO Connect (or open DYMO Label on Mac) so its web service is running.', true));
    items.push(li('A "TimeoutError" usually means Chrome is waiting on its "allow local network access" prompt; a "Failed to fetch" means the connection was refused or the certificate was rejected.', true));
    for (const e of dymo.details || []) items.push(li(`  ${e}`, true));
  } else if (!dymo.printers.length) {
    items.push(li(`DYMO service: running at ${dymo.base}, but it lists no printers. The LabelWriter must be plugged in by USB and installed with DYMO's own driver.`, true));
  } else {
    items.push(li(`DYMO service: running at ${dymo.base}`));
    for (const p of dymo.printers) {
      items.push(li(`  ${p.name} — ${p.model}${p.connected ? ', connected' : ', not connected'}${p.local ? '' : ', network'}`));
    }
    // Keep the saved choice only if the service still lists it; otherwise the
    // first detected printer is the sensible pick (a renamed queue, a new PC).
    const names = dymo.printers.map((p) => p.name);
    const wanted = el.printerName.value || current.printerName;
    setPrinterOptions(dymo.printers, names.includes(wanted) ? wanted : names[0]);
    if (wanted && !names.includes(wanted)) printerEl.testNote.textContent = `"${wanted}" isn't listed any more; switched to ${names[0]}. Click Save to keep it.`;
  }

  printerEl.list.replaceChildren(...items);
  printerEl.note.textContent = '';
  printerEl.detect.disabled = false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.capture) renderCapture();
  if (changes.settings) load();
});

load();
refreshStatus();
renderCapture();
