# Showrunner

Seller tools for Whatnot live shows, as a Chrome extension.
(Was "Whatnot Chat Helper" up to v0.13.)

- **Questions**: viewer questions highlighted in Whatnot's own chat and listed in
  a card above it, newest first with how long each has waited; tick them off.
- **Auction**: a card above the shop list that follows the current item (running,
  sold, awaiting next) with a history of every sale in the show.
- **Labels**: prints a DYMO LabelWriter label on every sale (title, date/time,
  seller · buyer · price), with one-click reprints.

**Get it:** download the latest zip from
[Releases](https://github.com/chris-merrill/showrunner/releases/latest) and follow
[SETUP.md](SETUP.md). Mac users also need the **mac print bridge** zip from the
same page (`mac-print-bridge/`). Everything below is for developers.

## Layout, and the planned move into DIECASTr

This repo is deliberately self-contained so it can be moved into the DIECASTr
project as one folder (e.g. `apps/showrunner/`) without untangling anything:

| Path | What | Depends on |
|---|---|---|
| `manifest.json`, `background.js`, `content.js`, `capture.js`, `options/`, `icons/` | the Chrome extension | nothing outside this repo; the only network call besides Whatnot's own page is the optional question classifier at `diecastr.app/api/is-question` (the endpoint is a setting) |
| `mac-print-bridge/` | the Mac print service (Python 3 + Pillow, its own venv) | nothing in the extension |
| `dev/` | packaging (`package.sh`) and icon generation (`make-icons.py`) | the two above |
| `SETUP.md` | the seller's guide | — |

Nothing here imports from, links to, or is built by any other repo. When it
moves, `dev/package.sh` keeps working from the new folder (paths are relative
to the script), and the GitHub Releases link in `SETUP.md`/`README.md` is the
only thing to update.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder (the one with `manifest.json`)
4. Open a live show; click the toolbar icon for the settings page

## The settings page

Clicking the extension icon opens a full tab (`options/`), handy next to the
show in a second window:

- **Highlight questions** — colours any chat line ending in `?`
- **Allow resolve** — adds a ✕ on row hover; click it to tick a question off
  (turns green and dims). Click again to un-tick.
- **Questions card** — a card above Whatnot's chat card (in the
  `[grid-area:sidebar]` column) listing questions newest first with a ✓ to
  resolve; replaced the injected Questions tab + overlay panel in v0.14
  (Chris: "I don't like the tab"). Hidden on narrow layouts that have no
  sidebar column.
- **Smart detection** — DIECASTr classifier for asks with no `?`; needs a key
  minted at diecastr.app/question-api
- **Auction capture** — see below
- **Label printer → Detect printers** — probes Chrome's printer API (ChromeOS
  only, so it reports "not available" on Mac/Windows) and the DYMO web service
  on 127.0.0.1/localhost:41951-41953, listing any LabelWriters it knows. Links
  to the DYMO Connect installers (Windows / Mac) are on the page; the direct
  links are version-pinned (1.6.3, Oct 2026) and dymo.com/user-guide.html has
  the latest.
  - Mac gotcha (Chris's machine, DYMO Label 8.7): the service's "DYMO Root CA
    (for localhost)" is in the System keychain but **not trusted**, so Chrome
    refuses the HTTPS connection ("Failed to fetch"). Fix by trusting it:
    `sudo security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain dymo-root-ca.pem`.
    The service also isn't kept alive (launch agent not loaded); start it with
    `open /Library/Frameworks/DYMO/SDK/DYMO.DLS.Printing.Host.app`. DYMO
    Connect on Windows installs a trusted cert and an auto-start service.
  - **Neither DYMO service prints on Chris's Mac (macOS 26, 2026-10-21).** DYMO
    Label 8.7's service lists the USB LW450 and answers `true` to PrintLabel but
    no job ever reaches CUPS (a plain `lp` to the same queue prints fine). DYMO
    Connect 1.6.3.9's service (`DYMO.WebApi.Mac.Host`) installs its certs OK
    (System keychain identity "localhost") but never opens a port: its bundle
    is missing `System.Drawing.Common.dll`, which `DYMO.LabelAPI` needs, so
    startup dies silently after "Logger instantiated" in
    `~/Library/Application Support/DYMO/DYMOConnect/DymoWebApi.log`. Its
    first-run flag was set to false by hand (backup `DYMOWebApi.Json.bak-firstrun`).
    Conclusion: the Mac is not a usable DYMO-service test bed; test on Windows
    (Pablo's PC, or a Windows 11 ARM VM in UTM with the printer passed through).
    DYMO Label 8.7 was removed on 2026-10-21 (`~/Desktop/remove-dymo-label-8.sh`);
    DYMO Connect 1.6.3 stays installed but its service is useless here. Its
    installer also deletes the USB print queue each time it runs; re-create it with
    `lpadmin -p DYMO_LabelWriter_450_USB -v "usb://DYMO/LabelWriter%20450?serial=…" -m Library/Printers/PPDs/Contents/Resources/lw450.ppd.gz -E`.
  - **Mac print bridge:** `mac-print-bridge/showrunner-print-bridge.py` answers
    the same three calls on plain `http://127.0.0.1:41951`, lists the Mac's DYMO
    CUPS queues, renders the label XML's text runs at 300 dpi and prints with
    `lp`. Run `bash mac-print-bridge/start.sh` (creates a venv with Pillow on
    first run). The extension probes the HTTPS addresses first and this HTTP one
    last, so on a Windows PC DYMO's real service wins. It proves the flow and
    the label layout, not that DYMO's real service accepts the XML.
- **Reset ticks** — clears all ticks for the open show

Settings save instantly and apply without reloading anything.

## How it works

| File | Role |
|---|---|
| `content.js` | Finds the chat, decorates rows, owns the ✕ |
| `capture.js` | Read-only auction-close recon (v0.14) |
| `background.js` | Keeps the content scripts injected; stores capture events; opens the settings page |
| `options/` | The full-page settings tab |

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

## Auction-close capture (v0.14)

Goal: print a DYMO label the moment an auction closes (item title, date, seller),
replacing Pablo's Sharpie post-it. `capture.js` is the detector plus an
**Auction status** card. It's read-only and sends nothing to Whatnot.

### How a close is detected

Verified on a live show, 2026-10-21. The current-item panel is the player footer,
`footer[class*="livePlayerFooter"]`, and its fields are labelled elements:

| Field | Element | Running | Closed |
|---|---|---|---|
| title | `strong.text-body1` | Mainline madness #153 | same |
| subtitle | `strong.text-body2` | Hot Wheels ∙ 1:64 | same |
| bids | text node | 4 Bids | 5 Bids |
| price | right `strong.text-neutral-50` | $5 | $6 |
| status | right `strong.text-red-500` | `00:09` countdown | **`Sold`** |
| winner | header `strong.text-caption1` + nested `strong.text-yellow-500` | `user is Winning!` | `user won!` |

A close is: status flips from a countdown to `Sold` (or the yellow word becomes
`won!`). One `close` event fires per item (keyed on title + price + winner) and
the key resets when the next countdown starts. Then the footer button reads
"Awaiting next item" and the next item appears ~20s later.

**Unsold** (seen 2026-10-21, thecarcollector): the countdown reaches `00:00` with
0 bids and the footer simply reverts to the base listing ("Diecast | Shown live |
90 Available | 0 Bids | $1") with an empty status. No "unsold" wording appears.
That is reported as an `end` event, never a `close`. Sellers also re-run the same
numbered item (e.g. "Diecast #11" at $950, then again at $400), so a repeated
title is not by itself a duplicate.

**Header toggle:** a round price-tag button is added to Whatnot's top-right icon
row (left of the avatar). Yellow = detector on. It flips `captureEnabled`, the
same switch as the settings page.

### The card

With **Capture auction closes** on, a card is inserted above Whatnot's "Shop"
card in the left column (`div[class*="grid-area:shop"]`), styled like theirs
(falls back to a floating card if that column isn't on the page): state pill
(Pre-bid / Running 00:07 / Sold / Awaiting next item), the item's title,
subtitle · bids · price, the current leader or winner, the last label's print
status, an **Auto-print** switch (same setting as the settings page), and a
history of closes for this show with a **reprint** icon and a **×** per row and
**Clear all**. History and removals are backed by the stored event log, so they
survive reloads. Click the header to collapse the card.

Reload safety: a sold item already on screen when the script starts is logged as
`seen`, not reported or printed, and the 5-minute duplicate guard is re-seeded
from storage — otherwise every tab/extension reload during "Awaiting next item"
re-reported (and re-printed) the last sale. An orphaned copy of the script (after
an extension reload) detects that its `chrome.runtime.id` is gone and stands down.

### Events

`close {title, subtitle, bids, price, winner}`, `end`, `panel` (footer text on
change), `dom` (close-word text, recon), `mark` (the settings page button). They
live in `chrome.storage.local.capture` (ring buffer, 5000) and show on the settings
page's table; the badge counts closes. Reload the tab after enabling the first
time so `capture.js` is injected alongside `content.js`.

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

## Label catalog

`LABEL_CATALOG` in `background.js` lists 25 DYMO die-cut labels (part number,
DYMO paper name, short and long side). The DieCutLabel geometry, the font sizes
and the names in the settings page are all derived from it, and the Mac bridge's
`PAPERS` mirrors it, so a new label is added in one place (two with the bridge).
The paper names follow DYMO's own paper list; if a driver rejects one, fix the
name there. Only 30252, 30336 and 30334 have been printed through DYMO's own
format so far; the rest are geometry by the numbers.

The card's **Auto-print** switch only appears when printing is actually ready:
a printer chosen in settings, the DYMO service (or Mac bridge) answering, and
that printer listed as connected. Background answers `printer-status` (cached
60 s, re-checked after any failed print, on settings changes, and once a minute
while capture is on).
