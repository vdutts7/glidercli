#!/bin/bash
# setup.sh - run after cloning
# Installs hooks and prompts for email config

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# 1. Install hooks
mkdir -p .git/hooks
cp .github/hooks/* .git/hooks/ 2>/dev/null
chmod +x .git/hooks/* 2>/dev/null
echo "✓ Hooks installed"

# 2. Prompt user to set email
echo ""
echo "Set your git email:"
echo "  git config user.email 'github.relock416@passmail.net'  # vdutts"
echo "  git config user.email 'me@vd7.io'                      # vdutts7"
echo ""
