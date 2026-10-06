#!/usr/bin/env bash
# One scripted end-to-end run of the demo beats, for screen recording. Needs a display (Xvfb :99 is started if DISPLAY is unset).
# DEMO_PROVIDER=fake (default) | anthropic (requires ANTHROPIC_API_KEY in .env). DEMO_PAUSE=ms between beats. DEMO_HOLD=1 keeps it open.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w extension >/dev/null
if [ -z "${DISPLAY:-}" ]; then
  (Xvfb :99 -screen 0 1400x900x24 >/dev/null 2>&1 &) || true
  sleep 1
  export DISPLAY=:99
fi
exec npx tsx scripts/demo-run.ts
