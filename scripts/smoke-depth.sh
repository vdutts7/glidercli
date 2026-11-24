#!/usr/bin/env bash
# Folded into package live gate. Do not grow a third door.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec npm run test:live "$@"
