# Whatnot Chat Helper

A Manifest V3 Chrome extension for sellers and mods running a Whatnot live show.
It highlights viewer questions **in Whatnot's own chat** so they don't scroll past
mid-show, and lets you tick each one off as you answer it.

No side panel, no second list to watch — the chat you're already looking at just
gets colour.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder (the one with `manifest.json`)
4. Open a live show; click the toolbar icon for the menu

## The menu

Click the extension icon:

- **Highlight questions** — colours any chat line ending in `?`
- **Allow resolve** — adds a ✕ on row hover; click it to tick a question off
  (turns green and dims). Click again to un-tick.
- **Reset ticks** — clears all ticks for the current tab

Settings save instantly and apply without reloading anything.

## How it works

| File | Role |
|---|---|
| `content.js` | Finds the chat, decorates rows, owns the ✕ |
| `background.js` | Keeps the content script injected |
| `popup/` | The two-switch menu |

### Finding the chat

Verified against a live show. Whatnot's layout is Tailwind and the chat window
carries a **semantic, non-hashed class**:

```
div.z-chat-window          ← anchor
├── [0] message region     ← what we watch
└── [1] composer           ← skipped
```

If that class ever disappears, it falls back to churn sampling: whichever element
gains the most short-text children over ~6s is the chat.

**Chat mounts late** — 20–40s after page load on a live show, well after
`document_idle` — so attaching is a retry loop on a 3s tick, not a one-shot.

**Whatnot pauses chat rendering in background tabs** (`document.hidden`). Nothing
arrives until the tab is foregrounded. That's Whatnot's behaviour, not a bug here.

### Decoration is disposable

Whatnot owns these rows and React will wipe an injected node on its next render,
so decoration is idempotent and re-runs on every mutation batch (coalesced to one
pass per frame). A ✕ may briefly flicker during a busy re-render — it comes back.

The row list is virtualised, so rows get recycled as you scroll. "Resolved" is
therefore keyed by **message text**, never by DOM node — otherwise a recycled row
would inherit someone else's tick.

### Injection

Two paths, because declarative injection only covers page loads that happen
*after* the extension is installed:

- `content_scripts` in the manifest — normal page loads
- `chrome.scripting.executeScript` from the service worker — on install, on
  startup, on tab-complete, and when the popup finds an unconnected tab

The background pings before injecting, so a tab never ends up with two copies.
`content.js` also guards on `window.__whatnotChatHelperLoaded`.

## Known limits

- Ticks live in memory for the page's lifetime — reloading the tab clears them.
- Question detection is literally "ends with `?`". Real asks phrased without one
  ("Nooo do a pink supra") won't highlight.
- Highlighting rides on Whatnot's markup; a redeploy that renames
  `z-chat-window` falls back to churn sampling, which is less precise.

## History

`git log` — v0.4.0 was a side-panel mirror of chat (usernames, relative ages,
question filter, CSV export). Replaced by in-place highlighting in v0.5.0; the
tag is still in history if any of it is wanted back.
