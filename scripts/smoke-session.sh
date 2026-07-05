#!/usr/bin/env bash
# smoke-session.sh — P0-3 global sessionId on /cdp
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GL="$ROOT/bin/glider.js"
pass=0 fail=0

ok() { echo "OK $1"; pass=$((pass + 1)); }
no() { echo "FAIL $1" >&2; fail=$((fail + 1)); }

node -e "
const fs=require('fs');
const s=fs.readFileSync('$GL','utf8');
if (!/activeSessionId/.test(s)) process.exit(1);
if (!/parseGlobalFlags/.test(s)) process.exit(1);
if (!/GLIDER_SESSION_ID/.test(s)) process.exit(1);
if (!/payload\\.sessionId = activeSessionId/.test(s)) process.exit(1);
" && ok static_session_wiring || no static_session_wiring

if curl -sf --max-time 3 http://127.0.0.1:19988/status | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.exit(j.extension&&j.targets>0?0:1)})"; then
  SID="$(curl -sf http://127.0.0.1:19988/targets | jq -r '.[0].sessionId')"
  if [[ -n "$SID" && "$SID" != null ]]; then
    U1="$(node "$GL" url 2>/dev/null | tr -d '\"')"
    U2="$(node "$GL" --session "$SID" url 2>/dev/null | tr -d '\"')"
    [[ -n "$U1" && "$U1" == "$U2" ]] && ok cli_flag_session || no cli_flag_session
    U3="$(GLIDER_SESSION_ID="$SID" node "$GL" url 2>/dev/null | tr -d '\"')"
    [[ -n "$U1" && "$U1" == "$U3" ]] && ok env_session || no env_session
  else
    echo "SKIP live — no sessionId"
  fi
else
  echo "SKIP live — extension not connected"
fi

echo "smoke-session pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
