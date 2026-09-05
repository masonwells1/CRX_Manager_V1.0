#!/usr/bin/env bash
# ============================================================================
# Frontend Code Validator — pre-commit hook helper (and full-repo audit)
# ============================================================================
# Scans .ts/.tsx files for known anti-patterns that have caused repeat bugs
# in this project. Runs alongside ESLint but catches patterns that ESLint
# cannot (multi-line patterns, Supabase conventions).
#
# Usage:
#   bash scripts/validate-frontend.sh        # staged files only (pre-commit)
#   bash scripts/validate-frontend.sh --all  # every src/**/*.{ts,tsx} (audit)
#
# Exit codes:
#   0 = all clean
#   1 = violations found (commit blocked when used as pre-commit hook)
# ============================================================================

set -euo pipefail

VIOLATIONS=0
WARNINGS=0
SCAN_ALL=false

for arg in "$@"; do
  case "$arg" in
    --all) SCAN_ALL=true ;;
    --help|-h)
      echo "Usage: $0 [--all]"
      echo ""
      echo "  (no flag)  Scan only files staged via git (pre-commit mode)"
      echo "  --all      Scan every src/**/*.{ts,tsx} (audit mode)"
      exit 0
      ;;
  esac
done

if [ "$SCAN_ALL" = true ]; then
  # Full-repo audit — every TS/TSX under src/
  TS_FILES=$(find src -type f \( -name '*.ts' -o -name '*.tsx' \) | sort)
  echo "Auditing all frontend files under src/..."
else
  # Pre-commit mode — staged files only
  TS_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^src/.*\.(ts|tsx)$' || true)
  if [ -z "$TS_FILES" ]; then
    exit 0
  fi
  echo "Validating staged frontend files..."
fi

for file in $TS_FILES; do
  # Allow explicit exemptions
  if grep -q '// validate-frontend: exempt' "$file" 2>/dev/null; then
    echo "EXEMPT: $file"
    continue
  fi

  CONTENT=$(cat "$file")

  # --- Check 1: supabase .update()/.delete() without checkMutationResult ---
  # Only a genuine supabase table mutation should trip this. We match a
  # "mutation candidate" LINE — one that, after dropping comment-only lines,
  # is EITHER a chain-continuation (`.update(` / `.delete(` at the start of a
  # line, the common multi-line `supabase.from(...).update(...)` style) OR a
  # single-line chain containing `supabase`/`.from(` alongside `.update(`/`.delete(`.
  # This deliberately EXCLUDES JS Set/Map collection ops (`next.delete(id)`,
  # `map.delete(key)`) and `.update(`/`.delete(` text inside comments, which are
  # the two benign patterns that produced ~11 false-positive warnings.
  # Verified non-weakening: every real supabase mutation in src/ still matches.
  MUTATION_CANDIDATES=$(echo "$CONTENT" \
    | grep -vE '^\s*(//|\*|/\*)' \
    | grep -E '(^\s*\.(update|delete)\s*\()|((supabase|\.from\().*\.(update|delete)\s*\()' \
    || true)
  if [ -n "$MUTATION_CANDIDATES" ]; then
    # Check if checkMutationResult is imported
    if ! echo "$CONTENT" | grep -qE 'checkMutationResult'; then
      # Exempt files that only do reads or use RPCs
      if echo "$CONTENT" | grep -qE 'from.*lib/db'; then
        echo "WARNING: $file"
        echo "  Has a supabase .update()/.delete() but does not import checkMutationResult."
        echo "  Every supabase .update()/.delete() MUST use checkMutationResult()."
        WARNINGS=$((WARNINGS + 1))
      fi
    fi
  fi

  # --- Check 2: Money as floating point (look for toFixed on money) ---
  if echo "$CONTENT" | grep -qE '(price|cost|amount|total|balance|margin).*\.toFixed\s*\(\s*2\s*\)'; then
    echo "WARNING: $file"
    echo "  Uses .toFixed(2) on a money variable — verify this is display-only."
    echo "  Money must be stored as bigint cents. See AGENTS.md and docs/workflows/SAFE_DEVELOPMENT_RULES.md."
    WARNINGS=$((WARNINGS + 1))
  fi

  # --- Check 3: Direct Sentry import instead of lib/sentry wrapper ---
  # Exempt src/lib/sentry.ts — it IS the wrapper and legitimately imports @sentry/react
  # Exempt test files — they may intentionally test the enforcement rule
  if [ "$file" != "src/lib/sentry.ts" ] && ! echo "$file" | grep -qE '\.(test|spec)\.(ts|tsx)$'; then
    if echo "$CONTENT" | grep -qE "from\s+['\"]@sentry/react['\"]"; then
      echo "BLOCKED: $file"
      echo "  Imports directly from '@sentry/react' — use { Sentry } from '../lib/sentry' instead."
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  fi
done

if [ $VIOLATIONS -gt 0 ]; then
  echo ""
  echo "Frontend validation FAILED — $VIOLATIONS violation(s) found. Fix before committing."
  exit 1
fi

if [ $WARNINGS -gt 0 ]; then
  echo ""
  echo "Frontend validation passed with $WARNINGS warning(s). Review them above."
fi

if [ "$SCAN_ALL" = true ]; then
  echo "Frontend audit complete: $WARNINGS warning(s), $VIOLATIONS violation(s)."
else
  echo "Frontend validation passed."
fi
exit 0
