# Showrunner — setup guide for sellers

What it does, once set up: while you're live on Whatnot, it highlights viewer
questions in chat and lists them in a card above the chat, shows the current
auction in a card above your shop list, and prints a label on your DYMO
LabelWriter the moment each auction closes — item title, date and time, and
the buyer — so you can stick it on the item.

You need: Chrome on Windows (or Mac), a DYMO LabelWriter (450 or 550) plugged in
by USB, and a roll of DYMO **30252 address labels** (the 550 only takes DYMO-brand
labels).

## 1. Install DYMO Connect (one time)

1. Download **DYMO Connect for Desktop** for Windows from
   https://www.dymo.com/user-guide.html (free), run the installer, and accept
   the defaults. It installs the printer driver and a small background service
   the extension talks to.
2. Plug the LabelWriter in by USB and turn it on. Load the 30252 roll.
3. Open DYMO Connect once and print any test label from it, to confirm the
   printer works on its own. Close it; the background service keeps running.

**On a Mac** DYMO Connect's service doesn't work reliably, so Macs use the
**Showrunner Print Bridge** instead: download `Showrunner-mac-print-bridge-x.y.z.zip`
from the same Releases page and follow the README inside it (plug the printer
in by USB, run `start.sh`, leave it open during the show). Step 3 below is the
same on both.

## 2. Install the extension (one time)

1. Download the latest **Showrunner-x.y.z.zip** from
   https://github.com/chris-merrill/showrunner/releases/latest and unzip it
   somewhere you'll leave it (for example `Documents\Showrunner`). Don't delete
   that folder later; Chrome loads the extension from it.
2. In Chrome go to `chrome://extensions`, turn on **Developer mode** (top right),
   click **Load unpacked**, and pick the unzipped folder.
3. Click the puzzle-piece icon in Chrome's toolbar and **pin** the extension so
   its icon stays visible.

## 3. Set it up (one time)

Click the extension's toolbar icon. A settings page opens.

**Label printer**
1. Click **Detect printers**. It should list "DYMO service: running" and your
   LabelWriter. If it says *not reachable*, DYMO Connect isn't installed or its
   service hasn't started yet: restart the PC and try again.
2. Make sure your LabelWriter is chosen under **Printer**, **Label** is
   *30252 Address*, and type your shop name in **Seller line** if you want it on
   each label.
3. Click **Save**, then **Print test label**. A sample label comes out.
4. Turn on **Print a label when an auction closes**.

**Auction capture**: turn on **Capture auction closes**. This shows the auction
card on your show and is what triggers the labels.

**Chat**: leave **Highlight questions**, **Allow resolve** and **Questions card**
on. **Smart detection** is optional; it catches questions with no "?" in them
and needs a key (ask Chris).

## 4. During a show

Open your show in Chrome like you normally do (the extension only works in
Chrome, on `whatnot.com`).

- **Top right, next to your avatar**: the Showrunner button (a clapperboard).
  Yellow means it's on: both cards are shown and labels print. Click it to turn
  everything off and on without opening settings. Chat highlighting stays on
  either way.
- **Above your shop list**: the **Auction** card. It follows the current item
  and shows *Running*, *Sold* or *Awaiting next item*, who's winning, and
  "Label printed ✓" after each sale. Under **History**, every sale of the show
  with a printer icon to **reprint** that label (say the first one jammed) and a
  × to remove it from the list. The **Auto-print** switch there is the same as
  the settings-page one.
- **Above the chat**: the **Questions** card, newest first, with how long each
  has been waiting. Click the ✓ when you've answered one.
- Questions are also highlighted in orange in the chat itself.

If a label doesn't print, the card says why in red. The usual causes: the
printer is off or out of labels, or DYMO Connect's service isn't running
(restart the PC).

## Updating

Download the new zip from the same Releases page, unzip it over the same
folder, then click the refresh arrow on Showrunner's card at
`chrome://extensions`. Your settings are kept.

## Privacy

The extension only reads the Whatnot pages you have open. It never clicks,
bids, posts or sends anything to Whatnot on your behalf, and it doesn't send
your chat anywhere except, if you turn Smart detection on, the message text to
the question-detection service to decide whether it's a question.
