#!/usr/bin/env python3
"""
Stand-in for the DYMO Web Service, for development on a Mac where DYMO's own
service doesn't run. Speaks the same three calls the extension uses:

    GET  /DYMO/DLS/Printing/StatusConnected   -> "true"
    GET  /DYMO/DLS/Printing/GetPrinters       -> JSON-encoded XML printer list
    POST /DYMO/DLS/Printing/PrintLabel        -> "true"   (form fields: printerName, labelXml, ...)

It lists the Mac's DYMO print queues, renders the label XML's text runs onto a
300 dpi image, and prints it with `lp`. It is NOT DYMO's code: it proves the
extension -> service -> printer flow and what the label looks like, not that
DYMO's real service accepts the XML. Plain HTTP on 127.0.0.1:41951.

    dev/.venv/bin/python dev/dymo-standin.py            # all DYMO queues
    dev/.venv/bin/python dev/dymo-standin.py --port 41951
"""
import argparse
import html
import json
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from PIL import Image, ImageDraw, ImageFont

DPI = 300
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

# DYMO PaperName -> (width in, height in, CUPS PageSize for the LW450 PPD)
PAPERS = {
    "30252 Address": (3.5, 1.125, "w79h252"),
    "30336 1 in x 2-1/8 in": (2.125, 1.0, "w72h154"),
    "30334 2-1/4 in x 1-1/4 in": (2.25, 1.25, "30334_2-1_4_in_x_1-1_4_in"),
}
DEFAULT_PAPER = "30252 Address"


def cups_dymo_queues():
    """[(queue, description)] for every CUPS queue whose model is a DYMO."""
    out = subprocess.run(["lpstat", "-p", "-l"], capture_output=True, text=True).stdout
    queues = re.findall(r"^printer (\S+)", out, re.M)
    result = []
    for q in queues:
        info = subprocess.run(["lpoptions", "-p", q], capture_output=True, text=True).stdout
        model = re.search(r"printer-make-and-model='([^']*)'", info)
        desc = re.search(r"printer-info='([^']*)'", info)
        if model and "dymo" in model.group(1).lower():
            result.append((q, (desc.group(1) if desc else q) or q, model.group(1)))
    return result


def printers_xml():
    parts = ["<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<Printers>"]
    for q, desc, model in cups_dymo_queues():
        parts.append(
            f"<LabelWriterPrinter><Name>{html.escape(desc)}</Name><ModelName>{html.escape(model)}</ModelName>"
            f"<IsConnected>True</IsConnected><IsLocal>True</IsLocal><IsTwinTurbo>False</IsTwinTurbo></LabelWriterPrinter>"
        )
    parts.append("</Printers>\n")
    return "".join(parts)


def parse_label(label_xml):
    """-> (paper name, [(text, size_pt, bold)]) from a DieCutLabel's StyledText."""
    root = ET.fromstring(label_xml)
    paper = (root.findtext("PaperName") or DEFAULT_PAPER).strip()
    runs = []
    for el in root.iter("Element"):
        text = el.findtext("String") or ""
        font = el.find("Attributes/Font")
        size = float(font.get("Size", "10")) if font is not None else 10.0
        bold = (font.get("Bold", "False") == "True") if font is not None else False
        runs.append((text, size, bold))
    return paper, runs


def render(paper, runs):
    """Draw the runs onto a label-sized image, shrinking the text to fit the width."""
    w_in, h_in, _ = PAPERS.get(paper, PAPERS[DEFAULT_PAPER])
    W, H = int(w_in * DPI), int(h_in * DPI)
    img = Image.new("1", (W, H), 1)
    draw = ImageDraw.Draw(img)
    margin = int(0.08 * DPI)

    # Split runs into lines; a run may start with "\n".
    lines = []  # [(text, size, bold)]
    for text, size, bold in runs:
        for i, piece in enumerate(text.split("\n")):
            if i == 0 and lines and not text.startswith("\n"):
                lines[-1] = (lines[-1][0] + piece, lines[-1][1], lines[-1][2])
            elif piece or i > 0:
                lines.append((piece, size, bold))
    lines = [l for l in lines if l[0]]

    scale = 1.0
    while True:
        fonts = [ImageFont.truetype(FONT_BOLD if b else FONT_REG, max(8, int(s * scale * DPI / 72))) for _, s, b in lines]
        widths = [draw.textlength(t, font=f) for (t, _, _), f in zip(lines, fonts)]
        heights = [f.getbbox("Ag")[3] + int(0.03 * DPI) for f in fonts]
        if (not widths or max(widths) <= W - 2 * margin) and sum(heights) <= H - 2 * margin or scale < 0.3:
            break
        scale *= 0.92

    y = (H - sum(heights)) // 2
    for (t, _, _), f, h in zip(lines, fonts, heights):
        draw.text((margin, y), t, font=f, fill=0)
        y += h
    return img


def print_label(printer_desc, label_xml):
    queues = {desc: q for q, desc, _ in cups_dymo_queues()}
    queue = queues.get(printer_desc)
    if not queue:
        raise ValueError(f"unknown printer {printer_desc!r}; known: {list(queues)}")
    paper, runs = parse_label(label_xml)
    img = render(paper, runs)
    page = PAPERS.get(paper, PAPERS[DEFAULT_PAPER])[2]
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        img.save(f.name, dpi=(DPI, DPI))
        path = f.name
    res = subprocess.run(["lp", "-d", queue, "-o", f"PageSize={page}", "-o", "fit-to-page", path],
                         capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or "lp failed")
    return queue, res.stdout.strip(), [t for t, _, _ in runs]


class Handler(BaseHTTPRequestHandler):
    def _send(self, body, status=200, ctype="text/plain; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send("")

    def do_GET(self):
        if self.path.endswith("/StatusConnected"):
            return self._send("true")
        if self.path.endswith("/GetPrinters"):
            return self._send(json.dumps(printers_xml()), ctype="application/json")
        self._send("not found", 404)

    def do_POST(self):
        if not self.path.endswith("/PrintLabel"):
            return self._send("not found", 404)
        length = int(self.headers.get("Content-Length", "0"))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        printer = form.get("printerName", [""])[0]
        label_xml = form.get("labelXml", [""])[0]
        try:
            queue, job, lines = print_label(printer, label_xml)
            print(f"[print] {printer} -> {queue} ({job}): {' | '.join(lines)}", flush=True)
            self._send("true")
        except Exception as e:  # report like DYMO would not: loudly
            print(f"[print] FAILED: {e}", file=sys.stderr, flush=True)
            self._send(f"false: {e}", 500)

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] " + (fmt % args) + "\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=41951)
    ap.add_argument("--render-only", metavar="OUT.png", help="render a sample label to a file and exit")
    args = ap.parse_args()
    if args.render_only:
        sample = ("<?xml version='1.0'?><DieCutLabel><PaperName>30252 Address</PaperName><ObjectInfo><TextObject><StyledText>"
                  "<Element><String>Mainline madness #136</String><Attributes><Font Size='14' Bold='True'/></Attributes></Element>"
                  "<Element><String>\n10/21/2026 7:41 PM</String><Attributes><Font Size='10' Bold='False'/></Attributes></Element>"
                  "<Element><String>\nPablo's Diecast Garage · whatnot_buyer · $12</String><Attributes><Font Size='10' Bold='False'/></Attributes></Element>"
                  "</StyledText></TextObject></ObjectInfo></DieCutLabel>")
        render(*parse_label(sample)).save(args.render_only)
        print("wrote", args.render_only)
        sys.exit(0)
    print(f"DYMO stand-in on http://127.0.0.1:{args.port}  queues: {[d for _, d, _ in cups_dymo_queues()]}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
