#!/usr/bin/env bash
# ============================================================================
# Frontend Code Validator — pre-commit hook helper
# ============================================================================
# Scans staged .ts/.tsx files for known anti-patterns that have caused
# repeat bugs in this project. Runs alongside ESLint but catches patterns
# that ESLint cannot (multi-line patterns, Supabase conventions).
#
# Exit codes:
#   0 = all clean
#   1 = violations found (commit blocked)
# ============================================================================

set -euo pipefail

VIOLATIONS=0
WARNINGS=0

# Get staged frontend files (exclude tests, Edge Functions, and config)
STAGED_TS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^src/.*\.(ts|tsx)$' || true)

if [ -z "$STAGED_TS" ]; then
  exit 0
fi

echo "Validating staged frontend files..."

for file in $STAGED_TS; do
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

echo "Frontend validation passed."
exit 0
