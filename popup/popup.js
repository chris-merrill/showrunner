// Popup menu: two switches, written to chrome.storage.local. The content script
// watches storage and re-decorates, so changes land without a reload.

const DEFAULTS = {
  highlightQuestions: true,
  allowResolve: true,
  aiEnabled: false,
  endpoint: '',
  token: '',
};

const el = {
  dot: document.getElementById('dot'),
  status: document.getElementById('status'),
  reset: document.getElementById('reset'),
  highlightQuestions: document.getElementById('highlightQuestions'),
  allowResolve: document.getElementById('allowResolve'),
  aiEnabled: document.getElementById('aiEnabled'),
  aiConfig: document.getElementById('aiConfig'),
  aiNote: document.getElementById('aiNote'),
  endpoint: document.getElementById('endpoint'),
  token: document.getElementById('token'),
  saveAi: document.getElementById('saveAi'),
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

let current = { ...DEFAULTS };

async function load() {
  const stored = await chrome.storage.local.get('settings');
  current = { ...DEFAULTS, ...(stored.settings || {}) };
  el.highlightQuestions.checked = current.highlightQuestions;
  el.allowResolve.checked = current.allowResolve;
  el.aiEnabled.checked = current.aiEnabled;
  el.endpoint.value = current.endpoint;
  el.token.value = current.token;
  el.aiConfig.hidden = !current.aiEnabled;
}

function save(patch = {}) {
  current = {
    ...current,
    highlightQuestions: el.highlightQuestions.checked,
    allowResolve: el.allowResolve.checked,
    aiEnabled: el.aiEnabled.checked,
    ...patch,
  };
  chrome.storage.local.set({ settings: current });
}

el.highlightQuestions.addEventListener('change', () => save());
el.allowResolve.addEventListener('change', () => save());

el.aiEnabled.addEventListener('change', () => {
  el.aiConfig.hidden = !el.aiEnabled.checked;
  save();
});

// The endpoint's host isn't known at build time, so it's an optional permission
// requested here — this click is the user gesture Chrome requires.
el.saveAi.addEventListener('click', async () => {
  const endpoint = el.endpoint.value.trim();
  const token = el.token.value.trim();

  if (!endpoint) {
    el.aiNote.textContent = 'Enter an endpoint URL first.';
    return;
  }

  let origin;
  try {
    origin = `${new URL(endpoint).origin}/*`;
  } catch {
    el.aiNote.textContent = 'That doesn’t look like a valid URL.';
    return;
  }

  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    el.aiNote.textContent = 'Access denied — falling back to the “?” rule.';
    return;
  }

  save({ endpoint, token });
  el.aiNote.textContent = `Saved. Classifying via ${new URL(endpoint).host}.`;
});

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
