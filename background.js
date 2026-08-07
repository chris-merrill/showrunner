// Service worker: injects the content script, buffers chat messages, and relays
// them to the side panel. The worker sleeps aggressively in MV3, so the buffer
// lives in chrome.storage.session and is rehydrated on each wake.

const BUFFER_KEY = 'messageBuffer';
const STATUS_KEY = 'lastStatus';
const BUFFER_LIMIT = 500;

const WHATNOT_MATCHES = ['https://www.whatnot.com/*', 'https://whatnot.com/*'];

// ------------------------------------------------------------------ injection

// Declarative content_scripts only inject on page loads that happen after the
// extension is installed, which made every "reload the extension" cycle require
// a matching tab reload. Injecting programmatically covers already-open tabs and
// survives extension reloads. content.js guards against running twice.
// Ask before injecting: if a script is already live in the tab, a second
// executeScript would give us two observers and therefore doubled messages.
function isAlreadyActive(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'ping' }, (res) => {
      void chrome.runtime.lastError;
      resolve(!!res?.ok);
    });
  });
}

async function injectInto(tabId) {
  if (await isAlreadyActive(tabId)) {
    console.log('[wch] already active in tab', tabId);
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    console.log('[wch] injected into tab', tabId);
  } catch (err) {
    console.warn('[wch] inject failed for tab', tabId, err.message);
  }
}

async function injectAll() {
  const tabs = await chrome.tabs.query({ url: WHATNOT_MATCHES });
  console.log('[wch] injecting into', tabs.length, 'whatnot tab(s)');
  await Promise.all(tabs.map((t) => injectInto(t.id)));
  return tabs.length;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[wch] setPanelBehavior failed', err));
  injectAll();
});

chrome.runtime.onStartup.addListener(injectAll);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab.url || !/^https:\/\/(www\.)?whatnot\.com\//.test(tab.url)) return;
  injectInto(tabId);
});

// --------------------------------------------------------------------- buffer

async function readBuffer() {
  const stored = await chrome.storage.session.get(BUFFER_KEY);
  return stored[BUFFER_KEY] || [];
}

async function writeBuffer(buffer) {
  const trimmed = buffer.slice(-BUFFER_LIMIT);
  await chrome.storage.session.set({ [BUFFER_KEY]: trimmed });
  return trimmed;
}

// Last-line defence against doubled messages: React re-renders a row, or a
// second observer briefly overlaps. The window is short on purpose — viewers
// genuinely do repeat themselves ("lol", "ty") and those should still show.
const DEDUP_WINDOW_MS = 5000;
const recentKeys = new Map();

function isDuplicate(message) {
  const key = `${message.tabId}|${message.author}|${message.text}`;
  const now = Date.now();
  const prev = recentKeys.get(key);
  if (prev && now - prev < DEDUP_WINDOW_MS) {
    console.log('[wch] dropped duplicate:', message.text.slice(0, 40));
    return true;
  }
  recentKeys.set(key, now);
  if (recentKeys.size > 500) {
    for (const [k, ts] of recentKeys) {
      if (now - ts > DEDUP_WINDOW_MS) recentKeys.delete(k);
    }
  }
  return false;
}

// Fire-and-forget to the side panel. Errors just mean the panel is closed.
function relay(payload) {
  chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return false;

  switch (msg.type) {
    case 'chatMessage': {
      const message = { ...msg.message, tabId: sender.tab?.id ?? null };
      if (isDuplicate(message)) return false;
      readBuffer()
        .then((buf) => writeBuffer([...buf, message]))
        .then(() => relay({ type: 'chatMessage', message }));
      return false;
    }

    case 'status': {
      const status = {
        state: msg.state,
        detail: msg.detail ?? null,
        url: msg.url ?? sender.tab?.url ?? null,
        tabId: sender.tab?.id ?? null,
        ts: Date.now(),
      };
      chrome.storage.session.set({ [STATUS_KEY]: status });
      relay({ type: 'status', status });
      return false;
    }

    case 'getHistory': {
      Promise.all([readBuffer(), chrome.storage.session.get(STATUS_KEY)]).then(
        ([messages, stored]) => {
          sendResponse({ messages, status: stored[STATUS_KEY] || null });
        }
      );
      return true; // async response
    }

    case 'reconnect': {
      injectAll().then((count) => sendResponse({ ok: true, tabs: count }));
      return true;
    }

    case 'clearHistory': {
      chrome.storage.session.set({ [BUFFER_KEY]: [] }).then(() => sendResponse({ ok: true }));
      return true;
    }
  }

  return false;
});
