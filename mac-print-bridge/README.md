# Showrunner Print Bridge for Mac

On Windows, Showrunner prints through DYMO Connect's own background service.
On a Mac that service is unreliable (DYMO Connect 1.6.3's doesn't start; the old
DYMO Label 8.7 one accepts jobs and drops them), so Macs use this small bridge
instead. It answers the same three calls the extension makes, lists the Mac's
DYMO print queues, draws each label, and prints it through the normal Mac print
system.

## Setup (one time)

1. Plug the LabelWriter in by USB. macOS adds it as a printer by itself (System
   Settings → Printers & Scanners). It must use DYMO's driver, which comes with
   DYMO Connect or DYMO Label; install one of those if the printer doesn't appear.
2. Unzip this folder somewhere you'll keep it, e.g. `~/Showrunner`.
3. Open Terminal and run `bash ~/Showrunner/mac-print-bridge/start.sh`. The
   first run sets up a private Python environment (needs internet once).

## Each show

Run `start.sh` and leave its Terminal window open. Then in the extension's
settings click **Detect printers**: it reports
`DYMO service: running at http://127.0.0.1:41951/…` and lists the printer.
**Print test label** should produce a label. Ctrl-C stops the bridge.

To start it without Terminal, make a tiny Automator "Run Shell Script"
application that runs `start.sh`, or add it as a Login Item.

## Labels supported

30252 Address (3½ × 1⅛ in, default), 30336 Multipurpose (2⅛ × 1 in), 30334
Multipurpose (2¼ × 1¼ in). The label's text runs are rendered at 300 dpi in
Arial; long titles shrink to fit.

## Limits

This is a stand-in for DYMO's service, not DYMO's code. It proves the flow and
the layout on a Mac; whether DYMO's real service accepts the same label XML is
tested on Windows.
