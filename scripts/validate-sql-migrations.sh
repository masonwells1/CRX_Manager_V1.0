#!/usr/bin/env bash
# ============================================================================
# SQL Migration Full Audit — scans ALL migration files (not just staged)
# ============================================================================
# Run manually to audit the entire migration history for known anti-patterns.
#
# Usage:
#   bash scripts/validate-sql-migrations.sh
#   bash scripts/validate-sql-migrations.sh --idempotency-only   # just check idempotency bugs
#   bash scripts/validate-sql-migrations.sh --changed-only       # only migrations changed vs origin/main (fast loop path)
#
# Exit codes:
#   0 = all clean (or no changed migrations under --changed-only)
#   1 = violations found
# ============================================================================

set -euo pipefail

VIOLATIONS=0
WARNINGS=0
IDEMPOTENCY_ONLY=false
MAX_VIOLATIONS=""
CHANGED_ONLY=false
BASE_REF="origin/main"

# Argument parsing
for arg in "$@"; do
  case "$arg" in
    --idempotency-only) IDEMPOTENCY_ONLY=true ;;
    --changed-only) CHANGED_ONLY=true ;;
    --base=*) BASE_REF="${arg#--base=}" ;;
    --max-violations=*) MAX_VIOLATIONS="${arg#--max-violations=}" ;;
    --help|-h)
      echo "Usage: $0 [--idempotency-only] [--changed-only] [--base=<ref>] [--max-violations=N]"
      echo ""
      echo "  --idempotency-only   Only check idempotency_keys column-name bugs"
      echo "  --changed-only       Scan ONLY migrations changed vs <ref> (default origin/main)."
      echo "                       Fast path for the per-change loop: a full scan of all"
      echo "                       migrations takes >3min, but old/baselined violations in"
      echo "                       untouched files don't tell you whether THIS change regressed."
      echo "                       Falls back to a full scan (with a warning) if git or the base"
      echo "                       ref is unavailable, so it never silently scans nothing."
      echo "  --base=<ref>         Base ref for --changed-only (default origin/main)."
      echo "  --max-violations=N   Exit 0 if violations <= N (baseline ratchet for CI)."
      echo "                       Exit 1 if violations > N. Recommend updating the"
      echo "                       baseline downward when violations decrease."
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# APPROVED-SET BINDING (added 2026-08-10, DECISION_LOG 2026-08-10)
# ---------------------------------------------------------------------------
# A one-shot migration that rewrites EXISTING business rows must bind its
# authorization to the identity of the approved records, not to how many of
# them there are. Cardinality is not identity: a different population that
# happens to share the same counts satisfies a count-only guard and the
# migration rewrites rows nobody approved.
#
# Only migrations stamped on or after the cutoff are held to this. Everything
# before it is history — including 20260810025159_backfill_stale_line_profit.sql,
# which is already APPLIED LIVE and therefore cannot be edited (AGENTS.md).
# The cutoff is a date, not an allowlist, so it needs no maintenance and closes
# with zero headroom for the next migration written.
APPROVED_SET_CUTOFF=20260811000000

# Tables whose rows carry money, inventory, or customer-visible state. A
# top-level rewrite of these is what needs binding; rewrites inside a function
# body are runtime logic, not a one-shot data migration, and are not checked.
BUSINESS_ROW_TABLES='orders|order_items|quotes|quote_items|invoices|invoice_items|payments|commissions|commission_payments|deliveries|delivery_items|purchase_orders|purchase_order_items|returns|return_items|inventory_transactions|products|customers|jobs|write_offs|prepay_applications|finance_charges'

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

SCAN_MODE="full"
DELETED=""
if [ "$CHANGED_ONLY" = true ]; then
  # Fast path for the per-change loop: scan ONLY migrations this branch changed vs
  # BASE_REF — added/modified (committed or not) plus untracked-new files. A full
  # scan of all migrations takes >3min, but old/baselined violations in untouched
  # files don't tell you whether THIS change regressed, so scanning just the diff
  # turns the sweep sub-second. Untracked files MUST be unioned in (`git diff` omits
  # them, and a brand-new migration starts untracked). Renames are included via
  # --diff-filter=AMR, whose --name-only output is the rename DESTINATION, so a
  # renamed-AND-edited migration is still scanned (a B7 content-identical rename just
  # re-scans already-clean SQL). DELETED migrations (classified D, never R) are caught
  # separately below as a red-line violation — never a clean no-op. Falls back to a
  # full scan (loudly) if git or the base ref is unavailable.
  if git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
    # Diff against the MERGE BASE, not the tip of BASE_REF. A branch that is behind
    # origin/main would otherwise see main's post-fork migrations as "deleted" (a
    # two-dot diff vs the tip), producing false deleted-migration violations. The
    # merge-base..working-tree set is exactly what THIS branch changed (committed +
    # uncommitted) — which is what --changed-only is meant to validate.
    MB=$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo "$BASE_REF")
    CHANGED=$( {
      { git diff -M --name-only --diff-filter=AMR "$MB" -- "$MIGRATION_DIR" 2>/dev/null || true; }
      { git ls-files --others --exclude-standard -- "$MIGRATION_DIR" 2>/dev/null || true; }
    } | { grep -E '\.sql$' || true; } | sort -u )
    DELETED=$( { git diff -M --name-only --diff-filter=D "$MB" -- "$MIGRATION_DIR" 2>/dev/null || true; } | { grep -E '\.sql$' || true; } | sort -u )
    EXISTING=""
    for f in $CHANGED; do
      if [ -f "$f" ]; then EXISTING="${EXISTING}${f} "; fi
    done
    ALL_SQL=$(printf '%s\n' $EXISTING)
    SCAN_MODE="changed-only vs $BASE_REF (merge-base)"
    # Zero baseline applies ONLY on the real changed-only path: the scanned set is just
    # what this change touched, so any violation is a regression and the --max-violations
    # ratchet (which exists for the full historical scan, ~61 legacy violations) would
    # mask new ones. The full-scan fallback in the else branch KEEPS the caller's baseline.
    if [ -n "$MAX_VIOLATIONS" ]; then
      echo "NOTE: --max-violations ignored with --changed-only (zero baseline — any violation in a changed file is a regression)."
      echo ""
      MAX_VIOLATIONS=""
    fi
  else
    echo "WARNING: --changed-only requested but base ref '$BASE_REF' not found — running FULL scan instead."
    echo ""
    ALL_SQL=$(find "$MIGRATION_DIR" -name '*.sql' -type f | sort)
  fi
else
  ALL_SQL=$(find "$MIGRATION_DIR" -name '*.sql' -type f | sort)
fi

# Deleted migrations are a red-line violation (history is append-only) — report each
# so --changed-only can never silently bless a destructive change. Renames are
# classified R (not D) by rename detection, so legitimate B7 renames are exempt.
for d in $DELETED; do
  echo "VIOLATION: $d"
  echo "  Migration DELETED vs $BASE_REF — migrations are append-only; NEVER delete an existing migration file."
  echo ""
  VIOLATIONS=$((VIOLATIONS + 1))
done

if [ -z "$ALL_SQL" ]; then
  echo "============================================"
  echo "  SQL Migration Audit ($SCAN_MODE)"
  if [ "$VIOLATIONS" -gt 0 ]; then
    echo "  No files to scan, but $VIOLATIONS deleted-migration violation(s) found above."
    echo "============================================"
    exit 1
  fi
  echo "  0 changed migration file(s) vs $BASE_REF — nothing to scan."
  echo "============================================"
  exit 0
fi

FILE_COUNT=$(echo "$ALL_SQL" | wc -l | tr -d ' ')

echo "============================================"
echo "  SQL Migration Audit ($SCAN_MODE)"
echo "  Scanning $FILE_COUNT migration file(s)..."
echo "============================================"
echo ""

for file in $ALL_SQL; do
  # Strip SQL comments for pattern matching
  CODE_ONLY=$(grep -v '^\s*--' "$file" 2>/dev/null || true)

  if [ -z "$CODE_ONLY" ]; then
    continue
  fi

  # pg_get_functiondef exemption — scoped by name to specific already-applied
  # migrations that reference the catalog fn ONLY inside a read-only post-apply
  # verification DO block (a LIKE assertion that a patch landed), never to
  # clone/re-emit function text. Named explicitly (not marker-based) so the count
  # returns to the established baseline (61) with ZERO new headroom — the guard
  # still fires on the next new violation. Add here ONLY with that same read-only
  # justification.
  EXEMPT_PGDEF=false
  case "$(basename "$file")" in
    20260707011000_start_complete_job_null_actor_guard.sql) EXEMPT_PGDEF=true ;;
  esac

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

    # 4: entity_type/entity_id used AS idempotency_keys columns (the real bug) — an
    #    INSERT INTO idempotency_keys (..., entity_type, entity_id ...), or a single-line lookup that
    #    filters idempotency_keys by entity_type/entity_id. The first clause flattens newlines (tr)
    #    so a MULTI-LINE INSERT col-list is caught (Codex fix-review). The second clause is line-based
    #    so a DIFFERENT table's legit entity_type/entity_id columns (watchdog_flags, notifications,
    #    activity_feed, financial_audit_log) do NOT false-flag — they never share a line OR an
    #    idempotency_keys INSERT col-list (this was the CI red 2026-06-30..07-01 on watchdog_flags).
    #    KNOWN LIMIT (accepted): a MULTI-LINE SELECT/WHERE lookup that filters idempotency_keys by
    #    entity_type across lines is not caught — a statement-window match for it false-fires on a
    #    legit fn that uses idempotency_keys AND activity_feed.entity_type together (e.g.
    #    20260317100000_fix_idempotency_and_searchpath_final.sql). The gap is low-risk: new code uses
    #    the check_idempotency/save_idempotency helpers, not raw idempotency_keys access, and the
    #    original check never caught it either. The single-line + multi-line-INSERT cases are covered.
    if echo "$CODE_ONLY" | tr '\n' ' ' | grep -qiE 'INTO[[:space:]]+idempotency_keys[[:space:]]*\([^)]*entity_(type|id)' \
       || echo "$CODE_ONLY" | grep -iE 'idempotency_keys' | grep -qiE 'entity_(type|id)'; then
      echo "VIOLATION: $file"
      echo "  Uses 'entity_type/entity_id' as idempotency_keys columns"
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

  # pg_get_functiondef usage (BANNED) — unless the file is name-exempted above
  # (read-only verification use only; see EXEMPT_PGDEF).
  if [ "$EXEMPT_PGDEF" != true ] && echo "$CODE_ONLY" | grep -qiE 'pg_get_functiondef'; then
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
  # Strip SQL string literals first so SECURITY DEFINER inside COMMENT ON strings doesn't false-positive
  CODE_NO_STRINGS=$(echo "$CODE_ONLY" | sed "s/'[^']*'//g")
  if echo "$CODE_NO_STRINGS" | grep -qiE 'SECURITY\s+DEFINER' && ! echo "$CODE_ONLY" | grep -qiE 'SET\s+search_path'; then
    echo "WARNING: $file"
    echo "  Has SECURITY DEFINER without SET search_path."
    echo ""
    WARNINGS=$((WARNINGS + 1))
  fi

  # ================================================================
  # APPROVED-SET BINDING for one-shot business-row rewrites
  # See APPROVED_SET_CUTOFF above for why this is date-scoped.
  # ================================================================
  MIG_BASENAME=$(basename "$file")
  MIG_STAMP="${MIG_BASENAME%%_*}"
  if [[ "$MIG_STAMP" =~ ^[0-9]{14}$ ]] && [ "$MIG_STAMP" -ge "$APPROVED_SET_CUTOFF" ]; then
    # Find UPDATE/DELETE against a business table that is NOT inside a function
    # body. A DO $$ ... $$ block is deliberately NOT treated as a function body:
    # that is exactly where one-shot backfills live.
    #
    # Detection is TOKEN-based, not line-based. SQL is free-form: `UPDATE`, the
    # optional `ONLY`, and the table name may sit on three different lines, and
    # the table may be quoted ("public"."orders"). A line-anchored regex misses
    # all of that, so the non-function-body text is flattened into a token
    # stream and scanned for `UPDATE [ONLY] <tbl>` / `DELETE FROM [ONLY] <tbl>`.
    # Quoted string literals are dropped first so prose inside a RAISE NOTICE
    # cannot fabricate a match. Output is TAB-separated: line, table, text.
    REWRITES=$(awk -v tables="$BUSINESS_ROW_TABLES" '
      {
        raw[FNR] = $0
        line = tolower($0)
        sub(/--.*/, "", line)
        gsub(/'"'"'[^'"'"']*'"'"'/, " ", line)
        # Drop quoting BEFORE normalizing, so "public"."orders" survives as one
        # dotted token instead of splitting into public . orders.
        gsub(/"/, "", line)
        if (line ~ /create[ \t]+(or[ \t]+replace[ \t]+)?function/) { infn = 1 }
        else if (infn && line ~ /language[ \t]+(plpgsql|sql)/) { infn = 0; next }
        if (infn) next
        # Normalize every non-identifier character to a space. This also strips
        # quotes, so "public"."orders" collapses to the token public.orders.
        gsub(/[^a-z0-9_.]+/, " ", line)
        n = split(line, t, / +/)
        for (i = 1; i <= n; i++) {
          if (t[i] != "") { ntok++; tok[ntok] = t[i]; tokln[ntok] = FNR }
        }
      }
      END {
        for (i = 1; i <= ntok; i++) {
          target = ""
          if (tok[i] == "update") {
            j = i + 1
            if (tok[j] == "only") j++
            target = tok[j]
          } else if (tok[i] == "delete" && tok[i + 1] == "from") {
            j = i + 2
            if (tok[j] == "only") j++
            target = tok[j]
          }
          if (target == "") continue
          sub(/^public\./, "", target)
          if (target ~ ("^(" tables ")$")) {
            printf "%d\t%s\t%s\n", tokln[i], target, raw[tokln[i]]
          }
        }
      }
    ' "$file")

    if [ -n "$REWRITES" ]; then
      FIRST_REWRITE_LINE=$(printf '%s\n' "$REWRITES" | head -1 | cut -f1)
      REWRITE_TABLES=$(printf '%s\n' "$REWRITES" | cut -f2 | sort -u)

      # The declared digest, from a comment marker.
      DIGEST_HEX=$(grep -oiE 'APPROVED_SET_DIGEST:[[:space:]]*[0-9a-f]{64}' "$file" \
                     | grep -oiE '[0-9a-f]{64}' | head -1 | tr '[:upper:]' '[:lower:]' || true)

      # An opt-out must NAME every business table it waives, so it cannot be a
      # blanket wave-through, and it is never silent — see the WARNING below.
      OPT_OUT=$(grep -iE 'APPROVED_SET_DIGEST:[[:space:]]*NOT-REQUIRED' "$file" | head -1 || true)

      DIGEST_BOUND=0
      DIGEST_WHY=""
      if [ -n "$DIGEST_HEX" ]; then
        # Where does that hex first appear in EXECUTABLE sql (comments stripped)?
        DIGEST_EXEC_LINE=$(awk -v hex="$DIGEST_HEX" '
          { l = tolower($0); sub(/--.*/, "", l); if (index(l, hex) > 0) { print FNR; exit } }
        ' "$file")
        if [ -z "$DIGEST_EXEC_LINE" ]; then
          DIGEST_WHY="the digest appears only in a comment — it is documented, never compared"
        elif [ "$DIGEST_EXEC_LINE" -ge "$FIRST_REWRITE_LINE" ]; then
          DIGEST_WHY="the digest is compared at line $DIGEST_EXEC_LINE, AFTER the first write at line $FIRST_REWRITE_LINE"
        else
          # Fail-closed: a mismatch must abort. Require a RAISE EXCEPTION in the
          # statement region around the comparison.
          RAISE_NEAR=$(awk -v dl="$DIGEST_EXEC_LINE" '
            FNR >= dl - 6 && FNR <= dl + 12 { l = $0; sub(/--.*/, "", l); print l }
          ' "$file" | grep -ciE 'raise[[:space:]]+exception' || true)
          if [ "$RAISE_NEAR" -gt 0 ]; then
            DIGEST_BOUND=1
          else
            DIGEST_WHY="the digest comparison at line $DIGEST_EXEC_LINE does not RAISE EXCEPTION on mismatch — it is not fail-closed"
          fi
        fi
      fi

      if [ "$DIGEST_BOUND" -eq 1 ]; then
        : # bound to an approved-set digest, asserted fail-closed before the write
      elif [ -n "$OPT_OUT" ]; then
        MISSING_TBL=""
        while IFS= read -r t; do
          [ -z "$t" ] && continue
          echo "$OPT_OUT" | grep -qiE "(^|[^a-z0-9_])${t}([^a-z0-9_]|$)" || MISSING_TBL="$MISSING_TBL $t"
        done <<< "$REWRITE_TABLES"
        if [ -n "$MISSING_TBL" ]; then
          echo "VIOLATION: $file"
          echo "  APPROVED_SET_DIGEST: NOT-REQUIRED does not name every table it waives."
          echo "  Unnamed:$MISSING_TBL"
          echo "  A waiver must list each business table it covers, so it cannot be a blanket pass."
          echo ""
          VIOLATIONS=$((VIOLATIONS + 1))
        else
          # Accepted, but never silently: a waived money/inventory rewrite is
          # exactly the thing a reviewer must see in the CI log.
          echo "WARNING: $file"
          echo "  Business-row rewrite WAIVED out of approved-set binding by its author:"
          echo "  $OPT_OUT"
          echo ""
          WARNINGS=$((WARNINGS + 1))
        fi
      else
        echo "VIOLATION: $file"
        echo "  Rewrites existing business rows without binding to the approved set:"
        printf '%s\n' "$REWRITES" | awk -F'\t' '{ printf "    line %s: %s\n", $1, $3 }'
        [ -n "$DIGEST_WHY" ] && echo "  Digest present but not enforced: $DIGEST_WHY"
        echo "  Counts are not identity. Add to the migration EITHER:"
        echo "    -- APPROVED_SET_DIGEST: <sha256 of the sorted approved ids + before-values>"
        echo "    and, BEFORE the first write, recompute it and RAISE EXCEPTION on mismatch; OR"
        echo "    -- APPROVED_SET_DIGEST: NOT-REQUIRED (<tables>) - <why there is no before-value>"
        echo ""
        VIOLATIONS=$((VIOLATIONS + 1))
      fi
    fi
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
