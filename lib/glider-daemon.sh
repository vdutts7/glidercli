#!/bin/bash

# Glider daemon - respawns one relay forever with log rotation.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_PATH="$SCRIPT_DIR/glider-daemon.sh"
BSERVE="$SCRIPT_DIR/bserve.js"
LOG_DIR="${GLIDER_HOME:-$HOME/.glider}"
PORT="${GLIDER_PORT:-${RELAY_PORT:-19988}}"

case "$PORT" in
  ''|*[!0-9]*|0|0*) echo "glider-daemon: invalid relay port: $PORT" >&2; exit 2 ;;
esac
if [ "$PORT" -gt 65535 ]; then
  echo "glider-daemon: invalid relay port: $PORT" >&2
  exit 2
fi

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PATH
NODE_BIN="${GLIDER_NODE_BIN:-$(command -v node 2>/dev/null)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "glider-daemon: node not found; set GLIDER_NODE_BIN to an executable Node.js 18+ binary" >&2
  exit 127
fi

process_started_at() {
  LC_ALL=C LANG=C TZ=UTC ps -p "$1" -o lstart= 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

LOG_FILE="$LOG_DIR/daemon.log"
PID_FILE="$LOG_DIR/daemon-$PORT.pid"
CLAIM_DIR="$LOG_DIR/daemon-$PORT.claim"
MANAGEMENT_LOCK="$LOG_DIR/daemon-$PORT.management.lock"
MAX_LOG_SIZE=10485760
child_pid=""
child_started=""
relay_ready=0
supervisor_started="$(process_started_at "$$")"
claim_token="$$-$RANDOM-$(date +%s)"
claim_owned=0
management_lock_owned=0

mkdir -p "$LOG_DIR"

rotate_log() {
  if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
    /bin/unlink "$LOG_FILE.3" 2>/dev/null || true
    [ -f "$LOG_FILE.2" ] && mv "$LOG_FILE.2" "$LOG_FILE.3"
    [ -f "$LOG_FILE.1" ] && mv "$LOG_FILE.1" "$LOG_FILE.2"
    mv "$LOG_FILE" "$LOG_FILE.1"
    echo "[$(date)] Log rotated" > "$LOG_FILE"
  fi
}

write_pid_record() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, pid, port, entry, started, childPid, childEntry, childStarted, ready] = process.argv.slice(1);
    const record = {
      schema: 1,
      pid: Number(pid),
      port: Number(port),
      entry: fs.realpathSync(entry),
      started: started.trim(),
      childPid: childPid ? Number(childPid) : null,
      childEntry: fs.realpathSync(childEntry),
      childStarted: childStarted ? childStarted.trim() : null,
      ready: ready === "1",
    };
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  ' "$PID_FILE" "$$" "$PORT" "$DAEMON_PATH" "$supervisor_started" "$child_pid" "$BSERVE" "$child_started" "$relay_ready"
}

record_matches_supervisor() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    const [file, expectedPort, expectedEntry] = process.argv.slice(1);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.schema !== 1 || record.port !== Number(expectedPort)) process.exit(1);
      if (record.entry !== fs.realpathSync(expectedEntry)) process.exit(1);
      process.kill(record.pid, 0);
      const identityEnv = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };
      const command = execFileSync("ps", ["-p", String(record.pid), "-o", "command="], {
        encoding: "utf8",
        env: identityEnv,
      }).trim();
      const started = execFileSync("ps", ["-p", String(record.pid), "-o", "lstart="], {
        encoding: "utf8",
        env: identityEnv,
      }).trim();
      if (!command.includes(record.entry) || started !== record.started) process.exit(1);
      process.stdout.write(String(record.pid));
    } catch {
      process.exit(1);
    }
  ' "$PID_FILE" "$PORT" "$DAEMON_PATH"
}

record_owned_by_self() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, pid] = process.argv.slice(1);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      process.exit(record.schema === 1 && record.pid === Number(pid) ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$PID_FILE" "$$"
}

management_lock_is_inherited() {
  [ -n "${GLIDER_DAEMON_MANAGEMENT_OWNER_PID:-}" ] || return 1
  [ -n "${GLIDER_DAEMON_MANAGEMENT_OWNER_STARTED:-}" ] || return 1
  [ "$GLIDER_DAEMON_MANAGEMENT_OWNER_PID" = "$PPID" ] || return 1
  "$NODE_BIN" -e '
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    const [file, expectedPid, expectedStarted] = process.argv.slice(1);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        record.schema !== 1
        || record.pid !== Number(expectedPid)
        || record.started !== expectedStarted
      ) process.exit(1);
      process.kill(record.pid, 0);
      const started = execFileSync("ps", ["-p", String(record.pid), "-o", "lstart="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      }).trim();
      process.exit(started === record.started ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$MANAGEMENT_LOCK" "$GLIDER_DAEMON_MANAGEMENT_OWNER_PID" "$GLIDER_DAEMON_MANAGEMENT_OWNER_STARTED"
}

acquire_management_lock() {
  if management_lock_is_inherited; then
    return 0
  fi
  "$NODE_BIN" -e '
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    const [file, pidValue, entry, started] = process.argv.slice(1);
    const pid = Number(pidValue);
    const record = { schema: 1, pid, entry: fs.realpathSync(entry), started };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const identityEnv = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };

    async function main() {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        try {
          const fd = fs.openSync(file, "wx", 0o600);
          try {
            fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
          } finally {
            fs.closeSync(fd);
          }
          return;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }

        let current = null;
        let live = false;
        try {
          current = JSON.parse(fs.readFileSync(file, "utf8"));
          process.kill(current.pid, 0);
          const currentStarted = execFileSync(
            "ps",
            ["-p", String(current.pid), "-o", "lstart="],
            { encoding: "utf8", env: identityEnv },
          ).trim();
          live = current.schema === 1 && current.started === currentStarted;
        } catch {}

        if (!live) {
          let ageMs = Infinity;
          try {
            ageMs = Date.now() - fs.statSync(file).mtimeMs;
          } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
          }
          if (ageMs >= 2000) {
            throw new Error(`Stale daemon management lock requires manual removal: ${file}`);
          }
        }
        await sleep(100);
      }
      throw new Error(`Timed out waiting for daemon management lock: ${file}`);
    }

    main().catch((error) => {
      console.error(`glider-daemon: ${error.message}`);
      process.exit(1);
    });
  ' "$MANAGEMENT_LOCK" "$$" "$DAEMON_PATH" "$supervisor_started" || return $?
  management_lock_owned=1
}

release_management_lock() {
  if [ "$management_lock_owned" -ne 1 ]; then
    return 0
  fi
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, pidValue, started] = process.argv.slice(1);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.schema === 1 && record.pid === Number(pidValue) && record.started === started) {
        fs.unlinkSync(file);
      }
    } catch {}
  ' "$MANAGEMENT_LOCK" "$$" "$supervisor_started"
  management_lock_owned=0
}

relay_is_running() {
  "$NODE_BIN" -e '
    const http = require("http");
    const port = Number(process.argv[1]);
    const request = http.get(
      { host: "127.0.0.1", port, path: "/status", timeout: 500 },
      (response) => {
        response.resume();
        process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1);
      },
    );
    request.on("error", () => process.exit(1));
    request.on("timeout", () => request.destroy());
  ' "$PORT"
}

relay_owned_by_child() {
  "$NODE_BIN" -e '
    const http = require("http");
    const [portValue, childPidValue] = process.argv.slice(1);
    const request = http.get(
      { host: "127.0.0.1", port: Number(portValue), path: "/status", timeout: 500 },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => { raw += chunk; });
        response.on("end", () => {
          try {
            const status = JSON.parse(raw);
            process.exit(
              response.statusCode >= 200
              && response.statusCode < 300
              && status.pid === Number(childPidValue)
                ? 0
                : 1,
            );
          } catch {
            process.exit(1);
          }
        });
      },
    );
    request.on("error", () => process.exit(1));
    request.on("timeout", () => request.destroy());
  ' "$PORT" "$child_pid"
}

acquire_claim() {
  if mkdir "$CLAIM_DIR" 2>/dev/null; then
    printf '%s\n' "$claim_token" > "$CLAIM_DIR/owner"
    claim_owned=1
    return 0
  fi
  i=0
  while [ "$i" -lt 20 ]; do
    existing_pid="$(record_matches_supervisor 2>/dev/null)" && {
      echo "glider-daemon: already running as PID $existing_pid on port $PORT" >&2
      exit 0
    }
    sleep 0.1
    i=$((i + 1))
  done
  echo "glider-daemon: supervisor claim exists without a verified owner: $CLAIM_DIR" >&2
  exit 1
}

release_claim() {
  if [ "$claim_owned" -eq 1 ] && [ "$(cat "$CLAIM_DIR/owner" 2>/dev/null)" = "$claim_token" ]; then
    rm -f "$CLAIM_DIR/owner"
    rmdir "$CLAIM_DIR" 2>/dev/null || true
  fi
}

cleanup() {
  status=$?
  trap - EXIT SIGTERM SIGINT
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
  fi
  if [ -f "$PID_FILE" ] && record_owned_by_self; then
    rm -f "$PID_FILE"
  fi
  release_claim
  release_management_lock
  exit "$status"
}

trap cleanup EXIT
trap 'exit 0' SIGTERM SIGINT

acquire_management_lock || exit $?

if [ -f "$PID_FILE" ]; then
  existing_pid="$(record_matches_supervisor 2>/dev/null)" && {
    echo "glider-daemon: already running as PID $existing_pid on port $PORT" >&2
    exit 0
  }
fi

if relay_is_running; then
  echo "glider-daemon: relay port $PORT is already owned by another process" >&2
  exit 1
fi

acquire_claim

if [ -f "$PID_FILE" ]; then
  rm -f "$PID_FILE"
fi

write_pid_record

initial_handoff=1
while true; do
  rotate_log
  echo "[$(date)] Starting relay on port $PORT..." >> "$LOG_FILE"

  "$NODE_BIN" "$BSERVE" >> "$LOG_FILE" 2>&1 &
  child_pid=$!
  child_started="$(process_started_at "$child_pid")"
  relay_ready=0
  write_pid_record

  handoff_attempt=0
  while [ "$handoff_attempt" -lt 50 ]; do
    relay_owned_by_child && break
    kill -0 "$child_pid" 2>/dev/null || break
    sleep 0.1
    handoff_attempt=$((handoff_attempt + 1))
  done
  if relay_owned_by_child; then
    relay_ready=1
    write_pid_record
    if [ "$initial_handoff" -eq 1 ]; then
      initial_handoff=0
      release_management_lock
    fi
  elif [ "$initial_handoff" -eq 1 ]; then
    echo "glider-daemon: relay child failed to own port $PORT" >&2
    exit 1
  fi

  wait "$child_pid"
  EXIT_CODE=$?
  child_pid=""
  child_started=""
  relay_ready=0
  write_pid_record

  echo "[$(date)] Relay exited with code $EXIT_CODE, restarting in 2s..." >> "$LOG_FILE"
  sleep 2
done
