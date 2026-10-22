#!/bin/bash
# Showrunner Print Bridge for Mac: starts the local print service the
# extension talks to. First run creates a private Python environment and
# installs Pillow (needs internet once). Leave this window open during a show.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required. Install Xcode Command Line Tools:  xcode-select --install"
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "Setting up (first run only)…"
  python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet pillow
fi

echo "Showrunner Print Bridge starting. Keep this window open; press Ctrl-C to stop."
exec .venv/bin/python showrunner-print-bridge.py "$@"
