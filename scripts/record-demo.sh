#!/usr/bin/env bash
# Records the scripted demo to media/demo-<fake|real>-<date>.mp4 with its OWN Xvfb. Always cleans up Xvfb/ffmpeg (hard timeouts).
# DEMO_PROVIDER=anthropic for a REAL model run (key from the backend-only .env, never printed). Output of demo-run is status-only.
set -uo pipefail
cd "$(dirname "$0")/.."
DISP=":${REC_DISPLAY_NUM:-98}"
MODE=fake; [ "${DEMO_PROVIDER:-fake}" = "anthropic" ] && MODE=real
OUT="media/demo-${MODE}-$(date -u +%Y-%m-%d).mp4"
mkdir -p media
npm run build -w extension >/dev/null || exit 1
Xvfb "$DISP" -screen 0 1400x900x24 >/dev/null 2>&1 & XPID=$!
sleep 1.5
FFPID=""
stop_ffmpeg() { [ -n "$FFPID" ] && { kill -INT "$FFPID" 2>/dev/null; for _ in $(seq 1 20); do kill -0 "$FFPID" 2>/dev/null || break; sleep 0.5; done; kill -9 "$FFPID" 2>/dev/null; wait "$FFPID" 2>/dev/null; FFPID=""; }; }
cleanup() { stop_ffmpeg; kill "$XPID" 2>/dev/null; for _ in $(seq 1 10); do kill -0 "$XPID" 2>/dev/null || break; sleep 0.3; done; kill -9 "$XPID" 2>/dev/null; wait "$XPID" 2>/dev/null; }
trap cleanup EXIT
ffmpeg -y -loglevel error -f x11grab -framerate 15 -video_size 1400x900 -i "$DISP" -c:v libx264 -preset veryfast -pix_fmt yuv420p "$OUT.part.mp4" & FFPID=$!
sleep 1
DISPLAY="$DISP" timeout -k 10 "${DEMO_TIMEOUT:-330}" node_modules/.bin/tsx scripts/demo-run.ts 2>&1 | tee media/demo-run.log
RC=${PIPESTATUS[0]}
sleep 2
stop_ffmpeg
if [ "$RC" -eq 0 ]; then mv "$OUT.part.mp4" "$OUT"; echo "wrote $OUT"; else echo "demo-run FAILED rc=$RC; partial left at $OUT.part.mp4"; exit "$RC"; fi
