// Popup menu: two switches, written to chrome.storage.local. The content script
// watches storage and re-decorates, so changes land without a reload.

const DEFAULT_ENDPOINT = 'https://diecastr.app/api/is-question';

const DEFAULTS = {
  highlightQuestions: true,
  allowResolve: true,
  questionsTab: true,
  aiEnabled: false,
  endpoint: DEFAULT_ENDPOINT,
  token: '',
};

const el = {
  dot: document.getElementById('dot'),
  status: document.getElementById('status'),
  reset: document.getElementById('reset'),
  highlightQuestions: document.getElementById('highlightQuestions'),
  allowResolve: document.getElementById('allowResolve'),
  questionsTab: document.getElementById('questionsTab'),
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
  el.questionsTab.checked = current.questionsTab;
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
    questionsTab: el.questionsTab.checked,
    aiEnabled: el.aiEnabled.checked,
    ...patch,
  };
  chrome.storage.local.set({ settings: current });
}

el.highlightQuestions.addEventListener('change', () => save());
el.allowResolve.addEventListener('change', () => save());
el.questionsTab.addEventListener('change', () => save());

el.aiEnabled.addEventListener('change', () => {
  el.aiConfig.hidden = !el.aiEnabled.checked;
  save();
});

// No host permission needed — the API sends CORS headers, so the service
// worker's fetch is allowed on its own.
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
  const tab = await activeWhatnotTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'clearResolved' }, () => {
    void chrome.runtime.lastError;
    el.status.textContent = 'Ticks cleared';
  });
});

load();
refreshStatus();
