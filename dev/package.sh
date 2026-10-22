#!/bin/bash
# Build a distributable zip of the extension (what gets uploaded to the Chrome
# Web Store, or handed out for "Load unpacked"). Only runtime files go in.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
name=$(python3 -c "import json; print(json.load(open('manifest.json'))['name'])" | tr -cs 'A-Za-z0-9' '-' | sed 's/^-//; s/-$//')
out="dist/${name}-${version}.zip"
mkdir -p dist
rm -f "$out"
zip -q -r "$out" manifest.json background.js content.js capture.js options icons \
  -x '*.DS_Store' 2>/dev/null || zip -q -r "$out" manifest.json background.js content.js capture.js options -x '*.DS_Store'
echo "built $out ($(du -h "$out" | cut -f1))"
