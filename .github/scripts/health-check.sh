#!/bin/bash
# health-check.sh - Git health check before commit/push
# Checks: large files (>90MB), embedded git repos
# Run: .github/scripts/health-check.sh [size_mb]

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SIZE_MB="${1:-90}"
LIMIT=$((SIZE_MB * 1024 * 1024))

cd "$ROOT" || exit 1

echo "🏥 Git Health Check: $ROOT"
echo "==================="
echo ""

ISSUES=0

# ============================================================================
# CHECK 1: Large files (>90MB default)
# ============================================================================
echo "🔍 Checking for files > ${SIZE_MB}MB..."
echo ""

echo "=== UNSTAGED/UNTRACKED ==="
while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    file="${line:3}"
    # Handle renames
    [[ "$line" == R* ]] && file="${file##* -> }"
    if [[ -f "$file" ]]; then
        fsize=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "0")
        if [[ "$fsize" -gt "$LIMIT" ]]; then
            size_human=$((fsize / 1024 / 1024))
            echo "  🔴 $file (${size_human}MB)"
            ISSUES=1
        fi
    fi
done < <(git status --porcelain 2>/dev/null)

echo ""
echo "=== STAGED ==="
while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if [[ -f "$file" ]]; then
        fsize=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "0")
        if [[ "$fsize" -gt "$LIMIT" ]]; then
            size_human=$((fsize / 1024 / 1024))
            echo "  🔴 $file (${size_human}MB)"
            ISSUES=1
        fi
    fi
done < <(git diff --cached --name-only 2>/dev/null)

echo ""
echo "=== COMMITTED (last 10) ==="
while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if [[ -f "$file" ]]; then
        fsize=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "0")
        if [[ "$fsize" -gt "$LIMIT" ]]; then
            size_human=$((fsize / 1024 / 1024))
            echo "  🔴 $file (${size_human}MB)"
            ISSUES=1
        fi
    fi
done < <(git log --oneline -10 --diff-filter=A --name-only --pretty=format:"" 2>/dev/null | sort -u)

if [[ $ISSUES -eq 0 ]]; then
    echo "  🟢 No large files"
fi

echo ""

# ============================================================================
# CHECK 2: Embedded git repos
# ============================================================================
echo "🔍 Checking for embedded git repos..."
echo ""

ROOT_GIT="$ROOT/.git"
EMBEDDED=()

while IFS= read -r git_dir; do
    [[ -z "$git_dir" ]] && continue
    [[ "$git_dir" == "$ROOT_GIT" ]] && continue
    
    repo_dir="${git_dir%/.git}"
    relative="${repo_dir#$ROOT/}"
    
    # Check if tracked or not ignored
    is_tracked=false
    git ls-files --cached "$relative" 2>/dev/null | grep -q . && is_tracked=true
    
    is_ignored=false
    git check-ignore -q "$relative" 2>/dev/null && is_ignored=true
    
    if [[ "$is_tracked" == "true" ]]; then
        echo "  🔴 $relative (TRACKED - needs removal)"
        EMBEDDED+=("$relative")
        ISSUES=1
    elif [[ "$is_ignored" == "false" ]]; then
        echo "  🟡 $relative (not ignored - add to .gitignore)"
        EMBEDDED+=("$relative")
        ISSUES=1
    fi
done < <(find "$ROOT" -type d -name ".git" 2>/dev/null | sort)

if [[ ${#EMBEDDED[@]} -eq 0 ]]; then
    echo "  🟢 No embedded repos"
else
    echo ""
    echo "Fix: Add to .gitignore:"
    for repo in "${EMBEDDED[@]}"; do
        echo "  $repo/"
    done
fi

echo ""
echo "==================="

if [[ $ISSUES -eq 0 ]]; then
    echo "🟢 All checks passed"
    exit 0
else
    echo "🔴 Issues found - fix before pushing"
    exit 1
fi
