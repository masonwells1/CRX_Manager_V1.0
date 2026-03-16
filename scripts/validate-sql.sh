#!/usr/bin/env bash
# ============================================================================
# SQL Migration Validator — pre-commit hook helper
# ============================================================================
# Scans staged .sql migration files for known anti-patterns that have
# caused production bugs in this project.
#
# Exit codes:
#   0 = all clean
#   1 = violations found (commit blocked)
# ============================================================================

set -euo pipefail

VIOLATIONS=0

# Tables that do NOT have an updated_at column (as of 2026-03-16)
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

# Get staged SQL migration files
STAGED_SQL=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^supabase/migrations/.*\.sql$' || true)

if [ -z "$STAGED_SQL" ]; then
  exit 0
fi

echo "Validating staged SQL migrations..."

for file in $STAGED_SQL; do
  # Allow explicit exemptions for fix migrations (e.g., idempotency repair scripts
  # that must reference wrong patterns in replace() calls)
  if grep -q '^\s*-- validate-sql: exempt' "$file"; then
    echo "EXEMPT: $file (has validate-sql: exempt marker)"
    continue
  fi

  # Strip SQL comments (-- lines) for pattern matching; keep actual code only
  CODE_ONLY=$(grep -v '^\s*--' "$file")

  # --- Check 1: pg_get_functiondef usage (BANNED) ---
  if echo "$CODE_ONLY" | grep -qiE 'pg_get_functiondef'; then
    echo "BLOCKED: $file"
    echo "  pg_get_functiondef() is BANNED — it bakes in existing bugs."
    echo "  Write the full CREATE OR REPLACE FUNCTION instead."
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # --- Check 2: updated_at on tables without that column ---
  for tbl in "${TABLES_WITHOUT_UPDATED_AT[@]}"; do
    # Match: UPDATE <table> SET ... updated_at (case-insensitive, allowing schema prefix)
    # Only check non-comment lines
    if echo "$CODE_ONLY" | grep -qiE "UPDATE[[:space:]]+(public\.)?${tbl}[[:space:]]+SET" && \
       echo "$CODE_ONLY" | grep -iE "UPDATE[[:space:]]+(public\.)?${tbl}[[:space:]]+SET" | grep -qiE 'updated_at'; then
      echo "BLOCKED: $file"
      echo "  References updated_at on '${tbl}' — that column does NOT exist."
      echo "  Remove 'updated_at = now()' from the UPDATE statement."
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done

  # --- Check 3: SECURITY DEFINER without search_path ---
  if echo "$CODE_ONLY" | grep -qiE 'SECURITY\s+DEFINER' && ! echo "$CODE_ONLY" | grep -qiE 'SET\s+search_path'; then
    echo "WARNING: $file"
    echo "  Has SECURITY DEFINER without SET search_path — potential security risk."
    # Warning only, don't block
  fi

  # --- Check 4: idempotency_keys wrong column names (BANNED) ---
  # Bug has been reintroduced 3 times by copying old patterns.
  # Correct columns: idempotency_key, operation, result
  # Wrong columns:   key, entity_type, entity_id, result_id

  # 4a: WHERE key = ... (should be WHERE idempotency_key = ...)
  if echo "$CODE_ONLY" | grep -qiE 'WHERE\s+key\s*=\s*p_idempotency_key'; then
    echo "BLOCKED: $file"
    echo "  Uses 'WHERE key = p_idempotency_key' on idempotency_keys table."
    echo "  CORRECT: WHERE idempotency_key = p_idempotency_key"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # 4b: INSERT INTO idempotency_keys (key, ...) or idempotency_keys(key, ...)
  if echo "$CODE_ONLY" | grep -qiE 'INTO\s+idempotency_keys\s*\(\s*key\s*,'; then
    echo "BLOCKED: $file"
    echo "  Uses 'INSERT INTO idempotency_keys (key,' — wrong column name."
    echo "  CORRECT: INSERT INTO idempotency_keys (idempotency_key, ..."
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # 4c: ON CONFLICT (key) in idempotency_keys context
  if echo "$CODE_ONLY" | grep -qiE 'idempotency_keys' && echo "$CODE_ONLY" | grep -qiE 'ON\s+CONFLICT\s*\(\s*key\s*\)'; then
    echo "BLOCKED: $file"
    echo "  Uses 'ON CONFLICT (key)' for idempotency_keys — wrong column name."
    echo "  CORRECT: ON CONFLICT (idempotency_key)"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # 4d: entity_type, entity_id in idempotency_keys INSERT
  if echo "$CODE_ONLY" | grep -qiE 'idempotency_keys' && echo "$CODE_ONLY" | grep -qiE 'entity_type\s*,\s*entity_id'; then
    echo "BLOCKED: $file"
    echo "  Uses 'entity_type, entity_id' columns on idempotency_keys — wrong column names."
    echo "  CORRECT: operation, result"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # 4e: operation, result_id in idempotency_keys INSERT
  if echo "$CODE_ONLY" | grep -qiE 'idempotency_keys' && echo "$CODE_ONLY" | grep -qiE 'result_id'; then
    echo "BLOCKED: $file"
    echo "  Uses 'result_id' column on idempotency_keys — wrong column name."
    echo "  CORRECT: result (not result_id)"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # --- Check 5: customer_name in export configs (warning) ---
  if echo "$CODE_ONLY" | grep -qiE 'customer_name'; then
    echo "WARNING: $file"
    echo "  References 'customer_name' — verify this is a joined column, not a direct column."
    echo "  The customers table uses 'name', not 'customer_name'. May need a JOIN alias."
    # Warning only, don't block
  fi
done

if [ $VIOLATIONS -gt 0 ]; then
  echo ""
  echo "SQL validation FAILED — $VIOLATIONS violation(s) found. Fix before committing."
  exit 1
fi

echo "SQL validation passed."
exit 0
