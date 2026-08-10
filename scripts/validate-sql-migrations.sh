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
# The cutoff sits one second past that stamp — not at the next midnight, which
# would have left every later 20260810 migration unguarded. It is a timestamp,
# not an allowlist, so it needs no maintenance, and every migration written from
# here on is in force.
APPROVED_SET_CUTOFF=20260810025160

# Tables whose rows carry money, inventory, or customer-visible state. A
# top-level rewrite of these is what needs binding; rewrites inside a function
# body are runtime logic, not a one-shot data migration, and are not checked.
BUSINESS_ROW_TABLES='orders|order_items|order_shares|order_line_allocations|order_item_field_allocations|quotes|quote_items|quote_versions|quote_product_draws|invoices|invoice_items|invoice_shares|invoice_line_shares|invoice_line_allocations|payments|commissions|commission_payments|commission_payment_items|deliveries|delivery_items|delivery_remainders|purchase_orders|purchase_order_items|returns|return_items|inventory|inventory_holds|inventory_transactions|cycle_counts|cycle_count_items|receiving_records|products|product_cost_basis|cost_history|customers|jobs|job_product_draws|write_offs|prepay_applications|prepay_credits|credit_memo_applications|finance_charges|vendors|vendor_bills|vendor_payments|rebate_claims|accounting_periods|financial_audit_log|application_records|blend_tickets|blend_ticket_products|rup_sales_records|profiles'

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
    # stream and scanned for `UPDATE [ONLY] <tbl>` / `DELETE FROM [ONLY] <tbl>`,
    # plus the two rewrite shapes that do not spell UPDATE first:
    # `INSERT INTO <tbl> ... ON CONFLICT ... DO UPDATE` and `MERGE INTO <tbl>`.
    # Quoted string literals are dropped first so prose inside a RAISE NOTICE
    # cannot fabricate a match.
    # Output is TAB-separated: line, table, kind, written-columns, text.
    REWRITES=$(awk -v tables="$BUSINESS_ROW_TABLES" '
      {
        raw[FNR] = $0
        line = tolower($0)
        # Block comments first: a /* CREATE FUNCTION */ that survives here would
        # pin the scanner in function-body mode and hide every later rewrite.
        while (1) {
          if (inblk) {
            e = index(line, "*/")
            if (e == 0) { line = ""; break }
            line = substr(line, e + 2); inblk = 0
          }
          s = index(line, "/*")
          if (s == 0) break
          e = index(substr(line, s + 2), "*/")
          if (e == 0) { line = substr(line, 1, s - 1); inblk = 1; break }
          line = substr(line, 1, s - 1) " " substr(line, s + 2 + e + 1)
        }
        sub(/--.*/, "", line)
        gsub(/'"'"'[^'"'"']*'"'"'/, " ", line)
        # Drop quoting BEFORE normalizing, so "public"."orders" survives as one
        # dotted token instead of splitting into public . orders.
        gsub(/"/, "", line)
        # Function-body mode. Both markers can share one line
        # (CREATE FUNCTION f() RETURNS void AS $$ ... $$ LANGUAGE plpgsql;), so
        # the close is checked on the same line as the open, not only after it.
        if (line ~ /create[ \t]+(or[ \t]+replace[ \t]+)?function/) {
          infn = 1
          if (line ~ /language[ \t]+(plpgsql|sql)/) { infn = 0 }
          next
        }
        if (infn && line ~ /language[ \t]+(plpgsql|sql)/) { infn = 0; next }
        if (infn) next
        # Normalize every non-identifier character to a space. This also strips
        # quotes, so "public"."orders" collapses to the token public.orders.
        # `;` `,` and `=` survive as tokens of their own: statement boundaries
        # are what bound an UPSERT search, and `,`/`=` are what identify the
        # columns a SET clause actually assigns.
        gsub(/;/, " ; ", line)
        gsub(/,/, " , ", line)
        gsub(/=/, " = ", line)
        gsub(/[^a-z0-9_.;,=]+/, " ", line)
        n = split(line, t, / +/)
        for (i = 1; i <= n; i++) {
          if (t[i] != "") { ntok++; tok[ntok] = t[i]; tokln[ntok] = FNR }
        }
      }
      # Which columns does the statement starting at token p actually assign?
      # Only tokens sitting directly after SET or a comma AND directly before an
      # `=` count, so the `=` inside a WHERE, an ON, or a USING is not mistaken
      # for a written column.
      function set_cols(p,   k, insetc, out, c) {
        insetc = 0; out = ""
        for (k = p; k <= ntok; k++) {
          if (tok[k] == ";") break
          if (tok[k] == "set") { insetc = 1; continue }
          if (tok[k] == "where" || tok[k] == "returning" || tok[k] == "from" ||
              tok[k] == "when" || tok[k] == "on" || tok[k] == "using") { insetc = 0; continue }
          if (!insetc) continue
          if (tok[k + 1] == "=" && (tok[k - 1] == "set" || tok[k - 1] == ",")) {
            c = tok[k]
            sub(/^[a-z0-9_]+\./, "", c)
            if (index(" " out " ", " " c " ") == 0) out = (out == "" ? c : out " " c)
          }
        }
        return out
      }
      END {
        for (i = 1; i <= ntok; i++) {
          target = ""; kind = ""; setp = 0
          if (tok[i] == "update" && tok[i - 1] != "do") {
            j = i + 1
            if (tok[j] == "only") j++
            target = tok[j]; kind = "update"; setp = j + 1
          } else if (tok[i] == "delete" && tok[i + 1] == "from") {
            j = i + 2
            if (tok[j] == "only") j++
            target = tok[j]; kind = "delete"
          } else if (tok[i] == "insert" && tok[i + 1] == "into") {
            # An INSERT is only a rewrite of EXISTING rows when it carries
            # ON CONFLICT ... DO UPDATE. A plain INSERT adds rows and is out of
            # scope for approved-set binding.
            j = i + 2
            if (tok[j] == "only") j++
            for (k = j; k <= ntok && tok[k] != ";"; k++) {
              if (tok[k] == "do" && tok[k + 1] == "update") { setp = k + 2; break }
            }
            if (setp == 0) continue
            target = tok[j]; kind = "upsert"
          } else if (tok[i] == "merge" && tok[i + 1] == "into") {
            j = i + 2
            if (tok[j] == "only") j++
            target = tok[j]; kind = "merge"; setp = j + 1
          }
          if (target == "") continue
          sub(/^public\./, "", target)
          if (target ~ ("^(" tables ")$")) {
            printf "%d\t%s\t%s\t%s\t%s\n", tokln[i], target, kind,
                   (setp ? set_cols(setp) : ""), raw[tokln[i]]
          }
        }
      }
    ' "$file")

    if [ -n "$REWRITES" ]; then
      FIRST_REWRITE_LINE=$(printf '%s\n' "$REWRITES" | head -1 | cut -f1)
      REWRITE_TABLES=$(printf '%s\n' "$REWRITES" | cut -f2 | sort -u)
      # Alternation of the rewritten tables, and the union of the columns those
      # rewrites assign. The digest has to be shown to cover THIS material, so
      # both are handed to the hash check below.
      REWRITE_TABLES_RE=$(printf '%s\n' "$REWRITE_TABLES" | tr '\n' '|' | sed 's/|$//')
      REWRITE_COLS=$(printf '%s\n' "$REWRITES" | cut -f4 | tr ' ' '\n' | sort -u | tr '\n' ' ')

      # The declared digest, from a comment marker.
      DIGEST_HEX=$(grep -oiE 'APPROVED_SET_DIGEST:[[:space:]]*[0-9a-f]{64}' "$file" \
                     | grep -oiE '[0-9a-f]{64}' | head -1 | tr '[:upper:]' '[:lower:]' || true)

      # An opt-out must NAME every business table it waives, so it cannot be a
      # blanket wave-through, and it is never silent — see the WARNING below.
      OPT_OUT=$(grep -iE 'APPROVED_SET_DIGEST:[[:space:]]*NOT-REQUIRED' "$file" | head -1 || true)

      DIGEST_BOUND=0
      DIGEST_WHY=""
      if [ -n "$DIGEST_HEX" ]; then
        # Where is that hex first compared for INEQUALITY in executable sql?
        # Only a mismatch operator counts. `IF actual = '<approved>' THEN RAISE`
        # reads like a guard and is the exact inversion of one: it aborts when
        # the data is right and writes when it has drifted. Equality is not a
        # near-miss here, it is the bypass, so it is rejected outright.
        #
        # Also capture the identifier on the left of that operator, so the next
        # check can prove THAT variable is the one the hash was computed into —
        # otherwise any unrelated hash call anywhere above satisfies the guard.
        DIGEST_CMP=$(awk -v hex="$DIGEST_HEX" '
          {
            l = tolower($0); sub(/--.*/, "", l)
            p = index(l, hex)
            if (p == 0) next
            pre = substr(l, 1, p - 1)
            # Drop string literals from the prefix so an operator or an @ inside
            # quoted text cannot be mistaken for the comparison itself.
            gsub(/'"'"'[^'"'"']*'"'"'/, " ", pre)
            gsub(/is[ \t]+distinct[ \t]+from/, "@", pre)
            gsub(/<>/, "@", pre)
            gsub(/!=/, "@", pre)
            k = 0
            for (j = length(pre); j >= 1; j--) { if (substr(pre, j, 1) == "@") { k = j; break } }
            if (k == 0) next
            lhs = substr(pre, 1, k - 1)
            sub(/[^a-z0-9_]+$/, "", lhs)
            if (match(lhs, /[a-z0-9_]+$/)) { print FNR "\t" substr(lhs, RSTART, RLENGTH) }
            else { print FNR "\t" }
            exit
          }
        ' "$file")
        DIGEST_EXEC_LINE=$(printf '%s' "$DIGEST_CMP" | cut -f1)
        DIGEST_VAR=$(printf '%s' "$DIGEST_CMP" | cut -f2)
        DIGEST_MENTION_LINE=$(awk -v hex="$DIGEST_HEX" '
          { l = tolower($0); sub(/--.*/, "", l); if (index(l, hex) > 0) { print FNR; exit } }
        ' "$file")
        if [ -z "$DIGEST_EXEC_LINE" ] && [ -n "$DIGEST_MENTION_LINE" ]; then
          DIGEST_WHY="the digest is mentioned at line $DIGEST_MENTION_LINE but never tested for a MISMATCH — use <>, != or IS DISTINCT FROM (an = test aborts when the data is right and writes when it has drifted)"
        elif [ -z "$DIGEST_EXEC_LINE" ]; then
          DIGEST_WHY="the digest appears only in a comment — it is documented, never compared"
        elif [ "$DIGEST_EXEC_LINE" -ge "$FIRST_REWRITE_LINE" ]; then
          DIGEST_WHY="the digest is compared at line $DIGEST_EXEC_LINE, AFTER the first write at line $FIRST_REWRITE_LINE"
        else
          # The hex must be compared against something the migration COMPUTED,
          # not against another literal — and specifically against THIS variable,
          # over THIS material. "A hash appears somewhere above" is not a
          # binding: a migration could hash a constant, or an unrelated table,
          # then compare a hand-set variable to the literal and pass. So the
          # statement that assigns the hash must (a) assign it to the same
          # identifier that sits on the left of the mismatch, (b) read one of the
          # tables being rewritten, (c) cover `id`, and (d) cover at least one of
          # the columns the rewrite actually assigns — that last one is what
          # makes it a digest of BEFORE-VALUES rather than of row identity alone.
          #
          # Statement-level, not line-level: a SELECT ... INTO routinely spans
          # several lines, so the text before the write is joined and split on
          # `;`, and the hash call and the assignment must land in one statement.
          DIGEST_VAR_RE=$(printf '%s' "$DIGEST_VAR" | sed 's/[^a-z0-9_]//g')
          DIGEST_SRC_WHY=""
          if [ -z "$DIGEST_VAR_RE" ]; then
            COMPUTED=0
          else
            DIGEST_SRC_WHY=$(awk -v fl="$FIRST_REWRITE_LINE" -v var="$DIGEST_VAR_RE" \
                                 -v tbls="$REWRITE_TABLES_RE" -v cols="$REWRITE_COLS" '
              FNR >= fl { next }
              { l = tolower($0); sub(/--.*/, "", l); buf = buf " " l }
              END {
                ncol = split(cols, c, / +/)
                n = split(buf, st, /;/)
                for (i = 1; i <= n; i++) {
                  s = st[i]
                  if (s !~ /(md5|sha224|sha256|sha384|sha512|digest|encode)[ \t]*\(/) continue
                  if (s !~ ("into[ \t]+(strict[ \t]+)?" var "([^a-z0-9_]|$)") &&
                      s !~ (var "[ \t]*:=")) continue
                  # This statement does assign a hash to the compared variable.
                  # Now prove the hash is over the material being rewritten.
                  if (s !~ ("(^|[^a-z0-9_.])(public\\.)?(" tbls ")([^a-z0-9_]|$)")) {
                    print "reads none of the rewritten tables (" tbls ")"; exit
                  }
                  if (s !~ /(^|[^a-z0-9_.])id([^a-z0-9_]|$)/) {
                    print "does not cover the row ids"; exit
                  }
                  hit = 0
                  for (k = 1; k <= ncol; k++) {
                    if (c[k] == "") continue
                    if (s ~ ("(^|[^a-z0-9_.])" c[k] "([^a-z0-9_]|$)")) { hit = 1; break }
                  }
                  if (ncol > 0 && c[1] != "" && !hit) {
                    print "does not cover any column the rewrite assigns (" cols ")"; exit
                  }
                  print "OK"; exit
                }
              }
            ' "$file")
            if [ "$DIGEST_SRC_WHY" = "OK" ]; then
              COMPUTED=1
              DIGEST_SRC_WHY=""
            else
              COMPUTED=0
            fi
          fi

          # Fail-closed: the mismatch branch must abort. Require the RAISE to sit
          # inside the SAME IF block as the comparison — a RAISE that merely
          # happens to be nearby, in an unrelated or unreachable branch, is not
          # the guard it looks like. Walk forward from the comparison, tracking
          # IF depth, and stop at the END IF that closes it.
          RAISE_IN_BRANCH=$(awk -v dl="$DIGEST_EXEC_LINE" '
            FNR < dl { next }
            {
              l = tolower($0); sub(/--.*/, "", l)
              if (FNR == dl) { depth = 1 }
              else {
                if (l ~ /(^|[^a-z0-9_])if([^a-z0-9_]|$)/ && l !~ /end[[:space:]]+if/) depth++
                if (l ~ /end[[:space:]]+if/) { depth--; if (depth <= 0) exit }
              }
              if (l ~ /raise[[:space:]]+exception/) { print "yes"; exit }
            }
          ' "$file" | grep -c yes || true)

          if [ "$COMPUTED" -eq 0 ] && [ -n "$DIGEST_SRC_WHY" ]; then
            DIGEST_WHY="the hash assigned to '${DIGEST_VAR}' before line $FIRST_REWRITE_LINE $DIGEST_SRC_WHY — a digest that does not cover the rewritten rows and their before-values authorizes nothing"
          elif [ "$COMPUTED" -eq 0 ]; then
            DIGEST_WHY="the value compared to the digest at line $DIGEST_EXEC_LINE is not one this migration computed — no statement before line $FIRST_REWRITE_LINE assigns a hash (md5/sha256/digest/encode) into '${DIGEST_VAR:-<no identifier>}'"
          elif [ "$RAISE_IN_BRANCH" -eq 0 ]; then
            DIGEST_WHY="the comparison at line $DIGEST_EXEC_LINE does not RAISE EXCEPTION inside its own IF block — a mismatch would not abort"
          else
            DIGEST_BOUND=1
          fi
        fi
      fi

      if [ "$DIGEST_BOUND" -eq 1 ]; then
        : # bound to an approved-set digest, asserted fail-closed before the write
      elif [ -n "$OPT_OUT" ]; then
        # The waiver has exactly one honest use: the migration is populating a
        # column IT JUST ADDED, so there is no pre-existing approved population
        # to bind to. Anything else is the author waiving their own guard, which
        # is not a guard.
        #
        # Column-level, not table-level. "This table gets some ADD COLUMN" is a
        # bypass: add a harmless column, then rewrite a pre-existing money column
        # in the same migration and the waiver covers it. So a waiver must name
        # every table AND every column the rewrite assigns must be a column this
        # migration adds. A rewrite that assigns nothing identifiable — a DELETE,
        # or an UPDATE whose SET clause could not be read — is never a backfill.
        ADDED_COLS=$(awk '
          { l = tolower($0); sub(/--.*/, "", l); buf = buf " " l }
          END {
            n = split(buf, st, /;/)
            for (i = 1; i <= n; i++) {
              s = st[i]
              gsub(/"/, "", s)
              if (s !~ /alter[ \t]+table/) continue
              if (!match(s, /alter[ \t]+table[ \t]+(if[ \t]+exists[ \t]+)?(only[ \t]+)?[a-z0-9_.]+/)) continue
              t = substr(s, RSTART, RLENGTH)
              sub(/.*[ \t]/, "", t)
              sub(/^public\./, "", t)
              rest = s
              while (match(rest, /add[ \t]+column[ \t]+(if[ \t]+not[ \t]+exists[ \t]+)?[a-z0-9_]+/)) {
                c = substr(rest, RSTART, RLENGTH)
                sub(/.*[ \t]/, "", c)
                print t "\t" c
                rest = substr(rest, RSTART + RLENGTH)
              }
            }
          }
        ' "$file" | sort -u)

        MISSING_TBL=""
        UNADDED_TBL=""
        while IFS=$'\t' read -r r_ln r_tbl r_kind r_cols r_raw; do
          [ -z "$r_tbl" ] && continue
          if ! echo "$OPT_OUT" | grep -qiE "(^|[^a-z0-9_])${r_tbl}([^a-z0-9_]|$)"; then
            case " $MISSING_TBL " in
              *" $r_tbl "*) ;;
              *) MISSING_TBL="$MISSING_TBL $r_tbl" ;;
            esac
            continue
          fi
          if [ -z "$r_cols" ]; then
            UNADDED_TBL="$UNADDED_TBL ${r_tbl}(line ${r_ln}: ${r_kind} assigns no column this migration adds)"
            continue
          fi
          for r_col in $r_cols; do
            if ! printf '%s\n' "$ADDED_COLS" | grep -qxF "$(printf '%s\t%s' "$r_tbl" "$r_col")"; then
              UNADDED_TBL="$UNADDED_TBL ${r_tbl}.${r_col}"
            fi
          done
        done <<< "$REWRITES"
        if [ -n "$MISSING_TBL" ]; then
          echo "VIOLATION: $file"
          echo "  APPROVED_SET_DIGEST: NOT-REQUIRED does not name every table it waives."
          echo "  Unnamed:$MISSING_TBL"
          echo "  A waiver must list each business table it covers, so it cannot be a blanket pass."
          echo ""
          VIOLATIONS=$((VIOLATIONS + 1))
        elif [ -n "$UNADDED_TBL" ]; then
          echo "VIOLATION: $file"
          echo "  APPROVED_SET_DIGEST: NOT-REQUIRED is only for backfilling a column this"
          echo "  migration adds. These writes hit columns it does not add:$UNADDED_TBL"
          echo "  Pre-existing values are being rewritten — bind them with an approved-set digest."
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
        printf '%s\n' "$REWRITES" | awk -F'\t' '{ printf "    line %s (%s): %s\n", $1, $3, $5 }'
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
