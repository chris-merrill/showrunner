// Side panel: a realtime mirror of the Whatnot chat.
//
// Renders every message as it arrives, highlights lines ending in '?', shows how
// long each has been waiting, and lets you check them off as answered.

const MAX_RENDERED = 500;
const ANSWERED_KEY = 'answeredIds';
const AGE_TICK_MS = 10000;

// A "question" is simply a line ending in '?'. Starter-word matching ("do you…",
// "any…") flagged far too much of a busy chat.
const QUESTION_RE = /\?\s*$/;
const isQuestion = (text) => QUESTION_RE.test((text || '').trim());

let messages = [];
let answered = new Set();
let filter = 'all';
let showAnswered = false;

const el = {
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  answeredCount: document.getElementById('answeredCount'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  settings: document.getElementById('settings'),
  settingsToggle: document.getElementById('settingsToggle'),
  showAnswered: document.getElementById('showAnswered'),
  reconnectBtn: document.getElementById('reconnectBtn'),
  pickBtn: document.getElementById('pickBtn'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
};

// ----------------------------------------------------------------------- age

function ageLabel(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 10) return 'now';
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
}

// Old unanswered questions earn a warmer colour the longer they sit.
function ageState(ts) {
  const mins = (Date.now() - ts) / 60000;
  if (mins >= 5) return 'old';
  if (mins >= 2) return 'aging';
  return 'fresh';
}

function tickAges() {
  for (const node of el.list.querySelectorAll('.age')) {
    const ts = Number(node.dataset.ts);
    if (!ts) continue;
    node.textContent = ageLabel(ts);
    const row = node.closest('.msg');
    if (row && row.classList.contains('is-question')) {
      row.dataset.age = ageState(ts);
    }
  }
}
setInterval(tickAges, AGE_TICK_MS);

// -------------------------------------------------------------------- render

function isVisibleMessage(msg) {
  if (!showAnswered && answered.has(msg.id)) return false;
  if (filter === 'questions' && !isQuestion(msg.text)) return false;
  return true;
}

function renderRow(msg) {
  const question = isQuestion(msg.text);
  const row = document.createElement('div');
  row.className =
    'msg' + (question ? ' is-question' : '') + (answered.has(msg.id) ? ' is-answered' : '');
  row.dataset.id = msg.id;
  if (question) row.dataset.age = ageState(msg.ts);

  const meta = document.createElement('div');
  meta.className = 'meta';

  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = msg.author;

  const age = document.createElement('span');
  age.className = 'age';
  age.dataset.ts = String(msg.ts);
  age.textContent = ageLabel(msg.ts);
  age.title = new Date(msg.ts).toLocaleTimeString();

  const dismiss = document.createElement('button');
  dismiss.className = 'dismiss';
  dismiss.textContent = '✕';
  dismiss.title = answered.has(msg.id) ? 'Mark unanswered' : 'Mark answered';
  dismiss.setAttribute('aria-label', dismiss.title);
  dismiss.addEventListener('click', () => toggleAnswered(msg.id));

  meta.append(author, age, dismiss);

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = msg.text;

  row.append(meta, body);
  return row;
}

function render() {
  const atBottom = el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 60;

  const rows = messages.filter(isVisibleMessage);
  el.list.replaceChildren(...rows.map(renderRow));
  updateCounts(rows.length);

  const isEmpty = rows.length === 0;
  el.empty.hidden = !isEmpty;
  el.list.style.display = isEmpty ? 'none' : '';

  if (atBottom) el.list.scrollTop = el.list.scrollHeight;
}

function updateCounts(visible) {
  el.count.textContent = visible;
  el.answeredCount.textContent = answered.size;
}

// Appending one row avoids re-rendering the whole list on every message.
function appendMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_RENDERED) {
    const dropped = messages.shift();
    answered.delete(dropped.id);
    const stale = el.list.querySelector(`[data-id="${CSS.escape(dropped.id)}"]`);
    if (stale) stale.remove();
  }

  if (!isVisibleMessage(msg)) return;

  const atBottom = el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 60;
  el.list.append(renderRow(msg));
  updateCounts(el.list.children.length);

  if (!el.empty.hidden) {
    el.empty.hidden = true;
    el.list.style.display = '';
  }
  if (atBottom) el.list.scrollTop = el.list.scrollHeight;
}

function toggleAnswered(id) {
  if (answered.has(id)) answered.delete(id);
  else answered.add(id);
  chrome.storage.session.set({ [ANSWERED_KEY]: [...answered] });
  render();
}

const STATUS_COPY = {
  watching: 'Mirroring chat.',
  'waiting-for-chat': 'Waiting for chat to load… (~30s on a live show)',
  detecting: 'Looking for the chat list…',
  picking: 'Click the chat area on the page.',
  'picker-cancelled': 'Picker cancelled.',
  'no-chat-found': 'No chat found — try "Pick chat area".',
  'container-detached': 'Chat element went away, re-attaching…',
  'container-stale': 'Chat went quiet, re-attaching…',
};

function setStatus(status) {
  if (!status) return;
  const dotState = ['watching', 'detecting', 'picking'].includes(status.state)
    ? status.state
    : status.state === 'no-chat-found'
      ? 'error'
      : status.state === 'waiting-for-chat'
        ? 'detecting'
        : 'idle';
  el.statusDot.dataset.state = dotState;
  el.statusText.textContent = STATUS_COPY[status.state] || status.state;
}

// ------------------------------------------------------------- tab messaging

async function sendToWhatnotTab(type) {
  const tabs = await chrome.tabs.query({
    url: ['https://www.whatnot.com/*', 'https://whatnot.com/*'],
  });
  if (!tabs.length) {
    el.statusText.textContent = 'No Whatnot tab open.';
    el.statusDot.dataset.state = 'error';
    return;
  }
  const active = tabs.find((t) => t.active) || tabs[0];
  chrome.tabs.sendMessage(active.id, { type }, () => void chrome.runtime.lastError);
}

// -------------------------------------------------------------------- export

function exportCsv() {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    ['time', 'author', 'message', 'question', 'answered'].join(','),
    ...messages.map((m) =>
      [
        new Date(m.ts).toISOString(),
        m.author,
        m.text,
        isQuestion(m.text) ? 'yes' : 'no',
        answered.has(m.id) ? 'yes' : 'no',
      ]
        .map(esc)
        .join(',')
    ),
  ].join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `whatnot-chat-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// -------------------------------------------------------------------- wiring

document.querySelectorAll('.chip[data-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document
      .querySelectorAll('.chip[data-filter]')
      .forEach((b) => b.classList.toggle('is-active', b === btn));
    filter = btn.dataset.filter;
    render();
  });
});

el.showAnswered.addEventListener('click', () => {
  showAnswered = !showAnswered;
  el.showAnswered.classList.toggle('is-active', showAnswered);
  render();
});

el.settingsToggle.addEventListener('click', () => {
  el.settings.hidden = !el.settings.hidden;
});

el.reconnectBtn.addEventListener('click', () => {
  el.statusText.textContent = 'Reconnecting…';
  chrome.runtime.sendMessage({ type: 'reconnect' }, (res) => {
    void chrome.runtime.lastError;
    el.statusText.textContent = res?.tabs
      ? `Injected into ${res.tabs} Whatnot tab(s).`
      : 'No Whatnot tab open.';
  });
});

el.pickBtn.addEventListener('click', () => sendToWhatnotTab('startPicker'));
el.exportBtn.addEventListener('click', exportCsv);
el.clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearHistory' }, () => {
    void chrome.runtime.lastError;
    messages = [];
    answered.clear();
    chrome.storage.session.set({ [ANSWERED_KEY]: [] });
    render();
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'chatMessage') appendMessage(msg.message);
  else if (msg?.type === 'status') setStatus(msg.status);
});

async function init() {
  const stored = await chrome.storage.session.get(ANSWERED_KEY);
  answered = new Set(stored[ANSWERED_KEY] || []);

  chrome.runtime.sendMessage({ type: 'getHistory' }, (res) => {
    void chrome.runtime.lastError;
    if (res?.messages) messages = res.messages;
    setStatus(res?.status);
    render();
  });
}

init();
