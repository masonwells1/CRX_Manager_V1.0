#!/usr/bin/env bash
# ============================================================================
# SQL Migration Full Audit — scans ALL migration files (not just staged)
# ============================================================================
# Run manually to audit the entire migration history for known anti-patterns.
#
# Usage:
#   bash scripts/validate-sql-migrations.sh
#   bash scripts/validate-sql-migrations.sh --idempotency-only   # just check idempotency bugs
#
# Exit codes:
#   0 = all clean
#   1 = violations found
# ============================================================================

set -euo pipefail

VIOLATIONS=0
WARNINGS=0
IDEMPOTENCY_ONLY=false
MAX_VIOLATIONS=""

# Argument parsing
for arg in "$@"; do
  case "$arg" in
    --idempotency-only) IDEMPOTENCY_ONLY=true ;;
    --max-violations=*) MAX_VIOLATIONS="${arg#--max-violations=}" ;;
    --help|-h)
      echo "Usage: $0 [--idempotency-only] [--max-violations=N]"
      echo ""
      echo "  --idempotency-only   Only check idempotency_keys column-name bugs"
      echo "  --max-violations=N   Exit 0 if violations <= N (baseline ratchet for CI)."
      echo "                       Exit 1 if violations > N. Recommend updating the"
      echo "                       baseline downward when violations decrease."
      exit 0
      ;;
  esac
done

# Tables that do NOT have an updated_at column
TABLES_WITHOUT_UPDATED_AT=(
  commissions
  purchase_order_items
  payments
  write_offs
  delivery_items
  order_items
  quote_items
  return_items
  finance_charges
  prepay_applications
  cycle_counts
  cycle_count_items
  activity_feed
  financial_audit_log
  idempotency_keys
  receiving_records
  inventory_transactions
  invoice_line_allocations
  order_line_allocations
  invoice_shares
  order_shares
  commission_payment_items
  blend_ticket_products
  blend_ticket_images
  blend_ticket_to_order_items
  blend_recipe_items
  delivery_photos
  receiving_photos
  email_log
  ar_reminder_tracking
  rup_sales_records
  vendor_payments
  cost_history
)

MIGRATION_DIR="supabase/migrations"

if [ ! -d "$MIGRATION_DIR" ]; then
  echo "ERROR: $MIGRATION_DIR directory not found. Run from repo root."
  exit 1
fi

ALL_SQL=$(find "$MIGRATION_DIR" -name '*.sql' -type f | sort)
FILE_COUNT=$(echo "$ALL_SQL" | wc -l | tr -d ' ')

echo "============================================"
echo "  SQL Migration Full Audit"
echo "  Scanning $FILE_COUNT migration files..."
echo "============================================"
echo ""

for file in $ALL_SQL; do
  # Strip SQL comments for pattern matching
  CODE_ONLY=$(grep -v '^\s*--' "$file" 2>/dev/null || true)

  if [ -z "$CODE_ONLY" ]; then
    continue
  fi

  # ================================================================
  # IDEMPOTENCY COLUMN NAME CHECKS (the recurring bug)
  # Correct columns: idempotency_key, operation, result
  # Wrong columns:   key, entity_type, entity_id, result_id
  # ================================================================

  # Only check files that reference idempotency_keys at all
  if echo "$CODE_ONLY" | grep -qiE 'idempotency_keys'; then

    # 1: WHERE key = p_idempotency_key (should be WHERE idempotency_key = ...)
    if echo "$CODE_ONLY" | grep -qiE 'WHERE\s+key\s*=\s*p_idempotency_key'; then
      echo "VIOLATION: $file"
      echo "  Uses 'WHERE key = p_idempotency_key'"
      echo "  CORRECT: WHERE idempotency_key = p_idempotency_key"
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    # 2: INSERT INTO idempotency_keys (key, ...)
    if echo "$CODE_ONLY" | grep -qiE 'INTO\s+idempotency_keys\s*\(\s*key\s*,'; then
      echo "VIOLATION: $file"
      echo "  Uses 'INSERT INTO idempotency_keys (key, ...'"
      echo "  CORRECT: INSERT INTO idempotency_keys (idempotency_key, ..."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    # 3: ON CONFLICT (key)
    if echo "$CODE_ONLY" | grep -qiE 'ON\s+CONFLICT\s*\(\s*key\s*\)'; then
      echo "VIOLATION: $file"
      echo "  Uses 'ON CONFLICT (key)'"
      echo "  CORRECT: ON CONFLICT (idempotency_key)"
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    # 4: entity_type, entity_id IN idempotency_keys context
    #    (Exclude lines referencing activity_log, financial_audit_log, activity_feed,
    #     notifications — those tables legitimately use entity_type/entity_id columns)
    if echo "$CODE_ONLY" | grep -viE '(activity_log|financial_audit_log|activity_feed|notifications|operation_type)' | grep -qiE 'entity_type\s*,\s*entity_id'; then
      echo "VIOLATION: $file"
      echo "  Uses 'entity_type, entity_id' columns"
      echo "  CORRECT: operation, result"
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    # 5: result_id
    if echo "$CODE_ONLY" | grep -qiE 'result_id'; then
      echo "VIOLATION: $file"
      echo "  Uses 'result_id' column"
      echo "  CORRECT: result (not result_id)"
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  fi

  # Skip remaining checks if --idempotency-only
  if [ "$IDEMPOTENCY_ONLY" = true ]; then
    continue
  fi

  # ================================================================
  # OTHER CHECKS
  # ================================================================

  # pg_get_functiondef usage (BANNED)
  if echo "$CODE_ONLY" | grep -qiE 'pg_get_functiondef'; then
    echo "VIOLATION: $file"
    echo "  Uses pg_get_functiondef() — bakes in existing bugs."
    echo "  Write the full CREATE OR REPLACE FUNCTION instead."
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # updated_at on tables without that column
  for tbl in "${TABLES_WITHOUT_UPDATED_AT[@]}"; do
    if echo "$CODE_ONLY" | grep -qiE "UPDATE[[:space:]]+(public\.)?${tbl}[[:space:]]+SET" && \
       echo "$CODE_ONLY" | grep -iE "UPDATE[[:space:]]+(public\.)?${tbl}[[:space:]]+SET" | grep -qiE 'updated_at'; then
      echo "VIOLATION: $file"
      echo "  References updated_at on '${tbl}' — that column does NOT exist."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done

  # SECURITY DEFINER without search_path
  if echo "$CODE_ONLY" | grep -qiE 'SECURITY\s+DEFINER' && ! echo "$CODE_ONLY" | grep -qiE 'SET\s+search_path'; then
    echo "WARNING: $file"
    echo "  Has SECURITY DEFINER without SET search_path."
    echo ""
    WARNINGS=$((WARNINGS + 1))
  fi

  # customer_name reference
  if echo "$CODE_ONLY" | grep -qiE 'customer_name'; then
    echo "WARNING: $file"
    echo "  References 'customer_name' — verify this is a joined alias, not a direct column."
    echo ""
    WARNINGS=$((WARNINGS + 1))
  fi
done

echo "============================================"
echo "  Audit Complete"
echo "  Files scanned: $FILE_COUNT"
echo "  Violations:    $VIOLATIONS"
echo "  Warnings:      $WARNINGS"
echo "============================================"

if [ -n "$MAX_VIOLATIONS" ]; then
  # Baseline ratchet mode — used by CI. Exits 0 when violations <= baseline so
  # legacy migration bugs (already superseded by later fixes) don't break the
  # build, but any NEW violation pushes the count over the threshold and fails.
  if [ "$VIOLATIONS" -gt "$MAX_VIOLATIONS" ]; then
    echo ""
    echo "FAILED: Violation count ($VIOLATIONS) exceeds baseline ($MAX_VIOLATIONS)."
    echo "A new migration introduced an SQL safety violation. Fix it, or if the"
    echo "violation is intentional (rare), bump the --max-violations baseline."
    exit 1
  fi
  if [ "$VIOLATIONS" -lt "$MAX_VIOLATIONS" ]; then
    echo ""
    echo "GOOD: Violation count ($VIOLATIONS) is BELOW baseline ($MAX_VIOLATIONS)."
    echo "Lower the --max-violations baseline in .github/workflows/ci.yml to lock"
    echo "in the improvement."
  fi
  exit 0
fi

if [ $VIOLATIONS -gt 0 ]; then
  echo ""
  echo "NOTE: Violations in OLD migrations are expected (they were the bugs that"
  echo "got fixed by later migrations). Only violations in RECENT migrations"
  echo "indicate a regression. Use --max-violations=N for CI ratcheting."
  exit 1
fi

exit 0
