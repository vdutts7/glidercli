#!/bin/bash
# Glider daemon - respawns relay forever, fuck launchd throttling

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BSERVE="$SCRIPT_DIR/bserve.js"
LOG_DIR="$HOME/.glider"
PID_FILE="$LOG_DIR/daemon.pid"

mkdir -p "$LOG_DIR"

# Kill any existing
if [ -f "$PID_FILE" ]; then
  kill $(cat "$PID_FILE") 2>/dev/null
  rm "$PID_FILE"
fi

echo $$ > "$PID_FILE"

cleanup() {
  rm -f "$PID_FILE"
  exit 0
}
trap cleanup SIGTERM SIGINT

while true; do
  echo "[$(date)] Starting relay..." >> "$LOG_DIR/daemon.log"
  node "$BSERVE" >> "$LOG_DIR/daemon.log" 2>&1
  EXIT_CODE=$?
  echo "[$(date)] Relay exited with code $EXIT_CODE, restarting in 2s..." >> "$LOG_DIR/daemon.log"
  sleep 2
done
