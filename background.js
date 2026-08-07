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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
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

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab.url || !/^https:\/\/(www\.)?whatnot\.com\//.test(tab.url)) return;
  injectInto(tabId);
});

// ------------------------------------------------------------- classifier

// The fetch runs here, not in the content script: with host permission granted
// for the endpoint, extension-initiated requests from the service worker aren't
// subject to CORS, so diecastr doesn't need to emit CORS headers for us.
async function classify(payload) {
  const { settings } = await chrome.storage.local.get('settings');
  const endpoint = settings?.endpoint?.trim();
  const token = settings?.token?.trim();
  if (!endpoint) return { error: 'no endpoint configured' };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return { results: Array.isArray(data?.results) ? data.results : [] };
  } catch (err) {
    return { error: err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'reconnect') {
    injectAll().then((tabs) => sendResponse({ ok: true, tabs }));
    return true;
  }
  if (msg?.type === 'classify') {
    classify(msg.payload).then(sendResponse);
    return true;
  }
  return false;
});
