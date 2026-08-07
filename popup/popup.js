// Popup menu: two switches, written to chrome.storage.local. The content script
// watches storage and re-decorates, so changes land without a reload.

const DEFAULTS = { highlightQuestions: true, allowResolve: true };

const el = {
  dot: document.getElementById('dot'),
  status: document.getElementById('status'),
  reset: document.getElementById('reset'),
  highlightQuestions: document.getElementById('highlightQuestions'),
  allowResolve: document.getElementById('allowResolve'),
};

async function activeWhatnotTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /^https:\/\/(www\.)?whatnot\.com\//.test(tab.url || '')) return tab;
  const tabs = await chrome.tabs.query({
    url: ['https://www.whatnot.com/*', 'https://whatnot.com/*'],
  });
  return tabs[0] || null;
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
  const tab = await activeWhatnotTab();
  if (!tab) {
    el.dot.dataset.state = 'off';
    el.status.textContent = 'No Whatnot tab open';
    return;
  }

  let res = await ping(tab.id);
  if (!res) {
    // Tab predates the extension (or it was just reloaded) — inject and retry.
    await new Promise((r) => chrome.runtime.sendMessage({ type: 'reconnect' }, () => {
      void chrome.runtime.lastError;
      r();
    }));
    res = await ping(tab.id);
  }

  if (!res) {
    el.dot.dataset.state = 'off';
    el.status.textContent = 'Not connected — reload the tab';
  } else if (res.attached) {
    el.dot.dataset.state = 'on';
    el.status.textContent = 'Connected to chat';
  } else {
    el.dot.dataset.state = 'off';
    el.status.textContent = 'Waiting for chat to load…';
  }
}

async function load() {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...DEFAULTS, ...(stored.settings || {}) };
  el.highlightQuestions.checked = settings.highlightQuestions;
  el.allowResolve.checked = settings.allowResolve;
}

function save() {
  chrome.storage.local.set({
    settings: {
      highlightQuestions: el.highlightQuestions.checked,
      allowResolve: el.allowResolve.checked,
    },
  });
}

el.highlightQuestions.addEventListener('change', save);
el.allowResolve.addEventListener('change', save);

el.reset.addEventListener('click', async () => {
  const tab = await activeWhatnotTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'clearResolved' }, () => {
    void chrome.runtime.lastError;
    el.status.textContent = 'Ticks cleared';
  });
});

load();
refreshStatus();
