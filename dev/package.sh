#!/bin/bash
# Build the release artifacts:
#   dist/Showrunner-<version>.zip                  the Chrome extension (runtime files only;
#                                                  what the Web Store takes, or "Load unpacked")
#   dist/Showrunner-mac-print-bridge-<version>.zip the Mac print bridge (Python + start script)
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
name=$(python3 -c "import json; print(json.load(open('manifest.json'))['name'])" | tr -cs 'A-Za-z0-9' '-' | sed 's/^-//; s/-$//')
mkdir -p dist

ext="dist/${name}-${version}.zip"
rm -f "$ext"
zip -q -r "$ext" manifest.json background.js capture.js options icons -x '*.DS_Store'
echo "built $ext ($(du -h "$ext" | cut -f1))"

mac="dist/${name}-mac-print-bridge-${version}.zip"
rm -f "$mac"
zip -q -r "$mac" mac-print-bridge -x '*.DS_Store' -x 'mac-print-bridge/.venv/*'
echo "built $mac ($(du -h "$mac" | cut -f1))"
