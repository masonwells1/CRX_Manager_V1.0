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

  # --- Check 1: .update() or .delete() without checkMutationResult nearby ---
  # Look for supabase .update( or .delete( patterns
  if echo "$CONTENT" | grep -qE '\.(update|delete)\s*\('; then
    # Check if checkMutationResult is imported
    if ! echo "$CONTENT" | grep -qE 'checkMutationResult'; then
      # Exempt files that only do reads or use RPCs
      if echo "$CONTENT" | grep -qE 'from.*lib/db'; then
        echo "WARNING: $file"
        echo "  Has .update() or .delete() but does not import checkMutationResult."
        echo "  Every supabase .update()/.delete() MUST use checkMutationResult()."
        WARNINGS=$((WARNINGS + 1))
      fi
    fi
  fi

  # --- Check 2: Money as floating point (look for toFixed on money) ---
  if echo "$CONTENT" | grep -qE '(price|cost|amount|total|balance|margin).*\.toFixed\s*\(\s*2\s*\)'; then
    echo "WARNING: $file"
    echo "  Uses .toFixed(2) on a money variable — verify this is display-only."
    echo "  Money must be stored as bigint cents. See CLAUDE.md."
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
