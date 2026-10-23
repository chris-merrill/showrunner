# Showrunner — setup guide for sellers

What it does, once set up: while you run your show from Whatnot's **seller
dashboard** (Seller Hub › Shows › Open show), a small Showrunner card at the top
of your product list follows the current auction, and the moment an auction is
won your DYMO LabelWriter prints a label: the **item number** (the `#94` in your
title) big, then the price, plus anything else you switch on.

You need: Chrome on Windows (or Mac), a DYMO LabelWriter (450 or 550) plugged in
by USB, and a roll of DYMO labels (1 × 1 in **30332** or 3½ × 1⅛ in **30252**
both work; the 550 only takes DYMO-brand labels).

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

Open your show from **Seller Hub › Shows › Open show** (the extension only
appears on that page). At the top of the left column you'll see the
**Showrunner** card. Click its **⚙** (gear):

1. **Printer**: click **Find printers** and pick your LabelWriter.
2. **Label**: pick the roll that's loaded (for example *30332 1 in x 1 in*).
3. **Seller line** (optional): your shop name, if you turn that field on.
4. Click the yellow **Print test label**. A sample label comes out.
5. **Label layout**: tick what goes on the label and check the preview.
   Item number and price are on by default; the small "showrunner.tools" bar
   at the bottom is always included during the beta.
6. Turn on **Auto-print a label on each sale**, then click **Save**.

## 4. During a show

- **The Showrunner card** (top of the left column) shows the auction:
  *Running 04:41*, then *Sold* with "Label printed ✓". **Reprint last** prints
  the latest sale's label again, one tap per extra copy (for a bundle).
- **History** on the card lists every sale of the show, newest first, with a
  printer icon to reprint that label and × to remove it.
- **⚙** opens the printer and label settings; **⌄ / ›** folds the card to one line.
- **?** is how to reach us: report a bug, request a feature or send feedback.
  It asks for your email once (so we can reply) and remembers it.

If a label doesn't print, the card says why in red. The usual causes: the
printer is off or out of labels, or DYMO Connect's service isn't running
(restart the PC).

## Updating

Download the new zip from the same Releases page, unzip it over the same
folder, then click the refresh arrow on Showrunner's card at
`chrome://extensions`. Your settings are kept.

## Privacy

The extension only reads your own Whatnot seller page. It never clicks, bids,
posts or sends anything to Whatnot on your behalf. The only thing it sends
anywhere is what you choose to send with **?** (your message, your email and,
if you leave the box ticked, your printer settings and recent sales), to
Showrunner so we can help.
