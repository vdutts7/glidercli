#!/bin/bash
# Glider daemon - respawns relay forever with log rotation

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BSERVE="$SCRIPT_DIR/bserve.js"
LOG_DIR="$HOME/.glider"
LOG_FILE="$LOG_DIR/daemon.log"
PID_FILE="$LOG_DIR/daemon.pid"
MAX_LOG_SIZE=10485760  # 10MB

mkdir -p "$LOG_DIR"

# Rotate log if > 10MB
rotate_log() {
  if [ -f "$LOG_FILE" ] && [ $(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0) -gt $MAX_LOG_SIZE ]; then
    rm -f "$LOG_FILE.3"
    [ -f "$LOG_FILE.2" ] && mv "$LOG_FILE.2" "$LOG_FILE.3"
    [ -f "$LOG_FILE.1" ] && mv "$LOG_FILE.1" "$LOG_FILE.2"
    mv "$LOG_FILE" "$LOG_FILE.1"
    echo "[$(date)] Log rotated" > "$LOG_FILE"
  fi
}

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
  rotate_log
  echo "[$(date)] Starting relay..." >> "$LOG_FILE"
  node "$BSERVE" >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  echo "[$(date)] Relay exited with code $EXIT_CODE, restarting in 2s..." >> "$LOG_FILE"
  sleep 2
done
