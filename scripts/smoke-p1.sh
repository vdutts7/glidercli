#!/usr/bin/env bash
# smoke-p1.sh — P1-1..P1-4 snapshot, --json, allowed-domains, targets/use-session
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GL="$ROOT/bin/glider.js"
pass=0 fail=0

ok() { echo "OK $1"; pass=$((pass + 1)); }
no() { echo "FAIL $1" >&2; fail=$((fail + 1)); }

node -e "
const fs=require('fs');
for (const f of ['$GL','$ROOT/lib/guard.js','$ROOT/lib/bsnapshot.js']) {
  if (!fs.existsSync(f)) process.exit(1);
}
const g=fs.readFileSync('$GL','utf8');
if (!/cmdSnapshot/.test(g)) process.exit(1);
if (!/cmdTargets/.test(g)) process.exit(1);
if (!/cmdUseSession/.test(g)) process.exit(1);
if (!/emitJson/.test(g)) process.exit(1);
if (!/allowed-domains/.test(g)) process.exit(1);
" && ok static_p1_wiring || no static_p1_wiring

node -e "
const { urlAllowed, hostMatchesPattern } = require('$ROOT/lib/guard.js');
if (!hostMatchesPattern('api.foo.example', 'teams.*')) process.exit(1);
if (urlAllowed('https://evil.com', ['example.com'])) process.exit(1);
if (!urlAllowed('https://example.com/foo', ['example.com'])) process.exit(1);
" && ok guard_unit || no guard_unit

if curl -sf --max-time 3 http://127.0.0.1:19988/status | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.exit(j.extension&&j.targets>0?0:1)})"; then
  node "$GL" goto "https://example.com" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6; do
    node "$GL" url 2>/dev/null | grep -q example.com && break
    sleep 1
  done

  SNAP="$(node "$GL" --json snapshot --interactive-only 2>/dev/null)"
  echo "$SNAP" | jq -e '.ok == true and .observation.url != null and (.observation.elements | type) == "array"' >/dev/null \
    && ok live_snapshot_json || no live_snapshot_json

  node "$GL" --json url 2>/dev/null | jq -e '.ok == true and (.observation.url | type) == "string"' >/dev/null \
    && ok live_url_json || no live_url_json

  node "$GL" --json targets 2>/dev/null | jq -e '.ok == true and (.observation.targets | length) >= 1' >/dev/null \
    && ok live_targets_json || no live_targets_json

  SID="$(node "$GL" --json targets 2>/dev/null | jq -r '.observation.targets[0].sessionId')"
  if [[ -n "$SID" && "$SID" != null ]]; then
    node "$GL" --json use-session "$SID" 2>/dev/null | jq -e ".ok == true and .observation.sessionId == \"$SID\"" >/dev/null \
      && ok live_use_session || no live_use_session
  fi

  if node "$GL" --allowed-domains example.com goto "https://example.com" --json 2>/dev/null | jq -e '.ok == true' >/dev/null; then
    ok allowed_domains_pass
  else
    no allowed_domains_pass
  fi

  BLOCK_OUT="$(node "$GL" --allowed-domains blocked.example goto "https://example.com" --json 2>&1 || true)"
  if echo "$BLOCK_OUT" | jq -e '.ok == false and (.error | contains("allowed_domains"))' >/dev/null; then
    ok allowed_domains_block
  else
    no allowed_domains_block
  fi
else
  echo "SKIP live — extension not connected"
fi

echo "smoke-p1 pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]]
