# Chrome Web Store submission: Showrunner 1.8.0

Upload: `store/Showrunner-1.8.0-chrome-web-store.zip`

## Store listing tab

**Name** (from the manifest): Showrunner

**Summary** (manifest description, 132 max):
Seller tools for live shows: live auction status and a DYMO label printed on every sale.

**Description:**

Showrunner is the back office for your live shows. When an auction is won on your Whatnot seller dashboard, a label prints on your DYMO LabelWriter right away, so every item is tagged before it leaves the table.

WHAT IT DOES
• Prints a label the moment an auction is won: the item number in large type (the "#94" in your title), then the price.
• Label designer: add the buyer, the full title, the date and time, or a seller line, and see a live preview at your label's real size.
• Works with DYMO die-cut labels, from 1 × 1 in squares to 3½ × 1⅛ in address labels.
• Sale history for the show, with one-click reprints, and Reprint last for bundles that need the same label.
• Lives in one small card on your seller dashboard. Settings are one click away.
• Send a bug report, feature request or feedback right from the card.

HOW IT WORKS
1. Install DYMO Connect for Desktop (free from DYMO) and plug in your LabelWriter.
2. Open your show from Seller Hub › Shows › Open show.
3. Click ⚙ on the Showrunner card, pick your printer and label, print a test, and turn on Auto-print.

READ-ONLY BY DESIGN
Showrunner only reads your own seller page. It never clicks, bids, posts or sends messages for you. Your settings and sale history stay on your computer.

PUBLIC BETA
Free during the beta. Tools are shaped by sellers: tell us what you'd like next at showrunner.tools.

Showrunner works with Whatnot. It is not affiliated with or endorsed by Whatnot Inc.

**Category:** Productivity → Tools (or "Workflow & Planning" if offered)
**Language:** English (United States)

**Graphics:**
- Store icon: `icon-128.png`
- Screenshots (1280×800), in this order: `screenshot-2-sold.png`, `screenshot-3-settings.png`, `screenshot-5-labels.png`, `screenshot-1-running.png`, `screenshot-4-feedback.png`
- Small promo tile (440×280): `promo-small-440x280.png`
- Marquee: skip

**Official URL / Homepage:** https://showrunner.tools
**Support URL:** https://showrunner.tools/support

## Privacy practices tab

**Single purpose:**
Print a label on the seller's own DYMO label printer when an auction is won on the seller's live-show dashboard, and show that auction's status and sale history in a small card on that page.

**Permission justifications:**
- `storage`: Saves the seller's printer, label size and label layout settings, the sale history used for reprints, and the email they typed for feedback, on their own computer.
- `scripting`: Re-attaches the card to seller dashboard tabs that were already open when the extension was installed or updated, so the seller doesn't have to reload a live show.
- Host `https://www.whatnot.com/*`, `https://whatnot.com/*`: Reads the seller's own live-show dashboard (current item, price, timer and the winning buyer) to know when an auction is won, and shows the Showrunner card there.
- Host `http(s)://127.0.0.1/*`, `http(s)://localhost/*`: Talks to the label printer's local print service on the seller's own computer (DYMO Connect's web service, or the Showrunner Print Bridge on Mac) to list printers and print labels.
- Host `https://showrunner.tools/*`: Sends a bug report, feature request or feedback to Showrunner, only when the seller presses Send.

**Remote code:** No, I am not using remote code.

**Data usage (check these):**
- Personally identifiable information: YES (the email address a user enters with feedback).
- Website content: YES (item titles, prices and buyer usernames read from the seller's own dashboard; kept on the device, sent to us only inside a feedback report the user chooses to send).
- Everything else: NO.

**Certify all three:**
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://showrunner.tools/privacy

## Distribution tab
- Visibility: **Unlisted** for the first submission (installable by link), switch to Public when ready. Or Public now for the open beta.
- Regions: all regions (or United States only to start).
- Pricing: free.

## Test instructions (for the reviewer)
Showrunner runs only on a Whatnot seller's own live-show dashboard (https://www.whatnot.com/dashboard/live/<show id>), which requires a seller account with a show in progress, and it prints to a DYMO LabelWriter. Screenshots 1–5 show it in use. A screen recording of a test auction printing a label: <link to add>. Contact via https://showrunner.tools/support for a walkthrough.
