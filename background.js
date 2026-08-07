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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'reconnect') {
    injectAll().then((tabs) => sendResponse({ ok: true, tabs }));
    return true;
  }
  return false;
});
