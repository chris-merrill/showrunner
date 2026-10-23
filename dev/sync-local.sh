#!/bin/bash
# Copy the runtime files into the folder Chrome loads the unpacked extension from,
# so the owner only has to press reload in chrome://extensions.
# Usage: bash dev/sync-local.sh [target]   (default: ~/Downloads/Showrunner-1.0.0)
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:-$HOME/Downloads/Showrunner-1.0.0}"
[ -f "$target/manifest.json" ] || { echo "no extension at $target"; exit 1; }
rsync -a --delete-after manifest.json background.js content.js capture.js "$target/"
rsync -a --delete options/ "$target/options/"
rsync -a --delete icons/ "$target/icons/"
echo "synced $(python3 -c "import json;print(json.load(open('manifest.json'))['version'])") to $target"
