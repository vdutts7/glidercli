#!/usr/bin/env bash
# smoke-depth.sh — P0-1 depth=0 passive bexplore (inline probes, no slop)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BEX="$ROOT/lib/bexplore.js"
pass=0 fail=0

ok() { echo "OK $1"; pass=$((pass + 1)); }
no() { echo "FAIL $1" >&2; fail=$((fail + 1)); }

# static: depth 0 not coerced to 3
node -e "
const fs=require('fs');
const s=fs.readFileSync('$BEX','utf8');
if (/this\\.depth = options\\.depth \\|\\| 3/.test(s)) process.exit(1);
if (!/depth === 0/.test(s)) process.exit(1);
if (!/clicksPerformed/.test(s)) process.exit(1);
if (!/sendWithRetry/.test(s)) process.exit(1);
if (!/sessionId: this\\.sessionId/.test(s)) process.exit(1);
if (!/prefetchSessionFromTargets/.test(s)) process.exit(1);
" && ok static_depth_wiring || no static_depth_wiring

# help surfaces session-id + depth 0
node "$BEX" --help 2>&1 | grep -q -- '--session-id' && ok help_session_id || no help_session_id
node "$BEX" --help 2>&1 | grep -qi 'depth 0' && ok help_depth_zero || no help_depth_zero

# relay up
curl -sf --max-time 3 http://127.0.0.1:19988/status >/dev/null && ok relay_status || no relay_status

# live depth-0 (needs extension + attached tab)
if curl -sf --max-time 3 http://127.0.0.1:19988/status | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.exit(j.extension&&j.targets>0?0:1)})"; then
  OUT="/tmp/glider-bexplore-depth0-$$"
  HAR="/tmp/glider-bexplore-depth0-$$.har"
  SID="$(curl -sf http://127.0.0.1:19988/targets | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d);process.stdout.write((a[0]&&a[0].sessionId)||'')})")"
  if [[ -n "$SID" ]]; then
    glider goto "https://example.com" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6; do
      glider url 2>/dev/null | grep -q 'example.com' && break
      sleep 1
    done
    SID="$(curl -sf http://127.0.0.1:19988/targets | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d);const t=a.find(x=>(x.url||'').includes('example.com'))||a[0];process.stdout.write((t&&t.sessionId)||'')})")"
    LOG="/tmp/bexplore-smoke-$$.log"
    node "$BEX" --depth 0 --output "$OUT" --har "$HAR" --session-id "$SID" >"$LOG" 2>&1 || true
    grep -qE 'depth=0 passive|\(depth=0\)' "$LOG" && ok live_stderr_passive || no live_stderr_passive
    grep -q 'Session pinned from /targets' "$LOG" && ok live_session_prefetch || no live_session_prefetch
    trash "$LOG" 2>/dev/null || true
    if [[ -f "$OUT/report.json" ]] && jq -e '.clicksPerformed == 0 and .passive == true and .depth == 0 and .sessionId != null' "$OUT/report.json" >/dev/null; then
      ok live_report_clicks_zero
    else
      no live_report_clicks_zero
    fi
    [[ -f "$HAR" ]] && ok live_har_written || no live_har_written
    trash "$OUT" "$HAR" 2>/dev/null || true
  else
    echo "SKIP live — no targets"
  fi
else
  echo "SKIP live — extension not connected"
fi

echo "smoke-depth pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
