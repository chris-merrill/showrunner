# Whatnot Chat Helper

A Manifest V3 Chrome extension for sellers and mods running a Whatnot live show.
It watches chat and pulls viewer **requests** into a side panel so they don't
scroll past mid-show.

**Current scope (v0.4):** a realtime mirror of chat.

- Lines ending in `?` are highlighted
- **All / Questions only** filter chips
- Each row shows **how long it's been waiting**, ticking every 10s. Unanswered
  questions warm from accent → amber (2m) → red (5m)
- **✕** marks a message answered — dims and strikes it, and drops it from the
  active list. **Answered** chip toggles them back into view

Answered state lives in `chrome.storage.session`, so it survives closing the
panel but resets when Chrome restarts.

### Parsing a chat row

A row is `[avatar][username][badge?][message]`. The avatar renders the user's
initial as *text* when the image hasn't loaded, which is why an early version
showed authors as `R` and `(unknown)`. Parsing therefore clones the row, strips
avatar/image nodes, and reads the remaining leaf text nodes in order: first is
the username, the rest joins into the message, minus badge tokens (`Mod`,
`Host`, …).

## Injection

The content script is injected two ways, because declarative injection alone
only covers page loads that happen *after* the extension is installed — every
extension reload otherwise needed a matching tab reload:

- `content_scripts` in the manifest — normal page loads
- `chrome.scripting.executeScript` from the service worker — on install, on
  startup, on tab-complete, and on demand via the panel's **Reconnect** button

`content.js` guards on `window.__whatnotChatHelperLoaded` so double injection is
a no-op.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Open a live show on whatnot.com, then click the extension icon to open the
   side panel

## How it works

- `content.js` runs on whatnot.com, locates the chat message list, and streams
  each new line to the background worker.
- `background.js` buffers the last 500 messages in `chrome.storage.session` so
  the panel can be opened mid-show and still show recent history.
- `sidepanel/` classifies each line against your rules and renders the feed.

### Finding the chat

Verified against a live show (pablosdiecastgarage, Aug 2026). Whatnot's layout is
Tailwind, and the chat window carries a **semantic, non-hashed class**:

```
div.z-chat-window          ← anchor
├── [0] message region     ← what we observe
└── [1] composer           ← skipped, or typing looks like messages
```

Attach order:

1. **Anchor** on `.z-chat-window` and observe its first child.
2. **Churn sampling** if the anchor class ever disappears — watches DOM mutations
   for ~6s and picks whatever gains the most short-text children.
3. **Manual pick** — **Pick chat area** in settings, then click the chat list.
   Saved and reused.

**Chat mounts late.** Measured 20–40s after page load on a live show, well after
`document_idle`. Attachment is therefore a retry loop on a 3s tick, not a
one-shot at load. It also re-attaches on SPA navigation, if the watched element
is removed, or after 2 minutes of silence.

**Whatnot pauses chat rendering in background tabs** (`document.hidden`). Nothing
arrives until the tab is foregrounded again — this is Whatnot's behavior, not a
bug in the extension.

## Detection rules

Configured in the panel's ⚙ settings:

- **Keywords** — one per line, case-insensitive substring match. Defaults cover
  common ask phrasings (`show me`, `do you have`, `how much`, `i'll take`, …).
- **Questions** — optionally flag anything ending in `?` or starting with a
  question word.

Matched messages get a tag showing which rule fired. Check a message off to mark
it handled; **Export CSV** dumps whatever the current view shows.

## Known limits

- Author/message splitting is heuristic — it takes the first short child element
  or a leading `name:` prefix. **Not yet confirmed against a real chat row**; the
  live tab used for inspection was backgrounded, so its message list was empty.
  If authors come through wrong, this is the first thing to fix.
- Selectors are stored per-browser, not per-URL, so one saved pick applies to
  every Whatnot page.
- No backfill: messages already on screen when you attach are not captured, only
  ones that arrive afterward.
- Whatnot has its own **Questions** filter in the chat header. This extension is
  broader (custom keywords, persistent list, check-off, export) but if you only
  want questions, the native tab already does that.

### First-run checklist

- [ ] Panel opens and shows "Looking for the chat list…"
- [ ] Status flips to "Watching chat." once messages flow
- [ ] Messages appear in **All chat** with sane author/text split
- [ ] Keyword matches land in **Requests** with the right tag
- [ ] No duplicate lines when the chat scrolls
- [ ] "Pick chat area" highlights and locks onto the list
