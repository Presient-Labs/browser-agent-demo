#!/usr/bin/env bash
# Build the extension, make sure a display exists (Xvfb :99 on a headless VPS), launch the dedicated browser.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w extension >/dev/null
if [ -z "${DISPLAY:-}" ]; then
  (Xvfb :99 -screen 0 1400x900x24 >/dev/null 2>&1 &) || true
  sleep 1
  export DISPLAY=:99
fi
exec npx tsx scripts/launch-browser.ts
