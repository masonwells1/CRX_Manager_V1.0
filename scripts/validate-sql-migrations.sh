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
# WHAT COUNTS AS HISTORY IS NOT THE FILENAME (Codex High, round 14).
#
# This used to be scoped by a filename timestamp cutoff: stamped before it,
# history; stamped after it, in force. The stamp is part of the filename, and
# the filename is chosen by whoever writes the migration — so a brand-new file
# named with an older stamp landed on the history side and was never scanned at
# all. The guard could be switched off by the input it was guarding, which is
# the whole class of bug the last four rounds have been about.
#
# History is now defined by CONTENT, from a frozen manifest of every migration
# that existed when the rule landed (scripts/approved-set-grandfathered.txt,
# basename + sha256). A file is skipped only if its basename is listed there AND
# its bytes still hash to the recorded value. A new file — any name, any stamp —
# is in force, and so is any edit to a listed file. Migrations already applied
# live, which AGENTS.md forbids editing, keep passing untouched; that is the
# only thing the cutoff was ever there to do.
#
# The manifest is FROZEN, not maintained: a row added to it exempts that
# migration, which is a reviewed decision, not routine upkeep.
APPROVED_SET_GRANDFATHER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/approved-set-grandfathered.txt"

# Which tables carry rows worth binding an approval to? DEFAULT-DENY: every
# table in .claude/schema-registry.json, minus a short, reason-annotated
# exemption list.
#
# This was a hand-written allowlist of 52 tables, and it silently omitted live
# financial ones — `application_services` (customer-facing rates and internal
# costs, in cents), `customer_application_rates`, `allocation_sets`,
# `field_app_billing_lines`, `invoice_line_share_snapshots`, and the whole
# supplier-pricing family. `UPDATE public.application_services SET
# cost_per_acre_cents = 0` walked straight past the guard (Codex High, round 8).
# An allowlist you must remember to extend is an allowlist that drifts, and it
# drifts silently — nothing fails when a new money table is missing from it.
#
# Inverted, a new table is protected the moment it lands in the registry, and
# REMOVING protection costs a deliberate, reviewed edit right here with a stated
# reason. Exempt = append-only logs, retry queues, and operational plumbing that
# hold no money, inventory, or customer-visible state, where a bulk rewrite is
# ordinary maintenance rather than an authorized data repair.
#
# NOT exempt, however operational they look: replay- and abuse-protection
# bookkeeping — `idempotency_keys`, `offline_action_receipts`, `rate_limits`,
# `rate_limit_log`. These rows hold no money themselves, which is exactly why
# they read as prunable, but deleting them re-arms the money and inventory
# mutations they were recording as already done: a used idempotency key that no
# longer exists is a key that executes a second time (Codex High, round 9).
# Their value is entirely in their continued existence. A genuine retention
# policy over them is still possible — it just has to bind a digest and be
# approved like any other bulk rewrite of state that money depends on.
APPROVED_SET_EXEMPT_TABLES=(
  activity_feed                # append-only UI activity feed
  note_activity_log            # append-only note history
  email_log                    # outbound delivery log
  failed_notifications         # retry queue
  notifications                # transient user notices
  job_notifications            # transient user notices
  backup_runs                  # backup telemetry
  backup_snapshots             # backup telemetry
  integrity_alerts             # watchdog output
  integrity_negative_baseline  # watchdog baseline
  watchdog_flags               # watchdog output
  watchdog_flag_dismissals     # watchdog output
  ocr_processing_queue         # work queue
)

# A top-level rewrite of a protected table is what needs binding; rewrites
# inside a function body are runtime logic, not a one-shot data migration, and
# are not checked.
#
# The registry is located relative to THIS SCRIPT, not the working directory:
# the protected set is a property of the repository, while the directory being
# scanned is an argument (the mutation tests point the scanner at a scratch
# tree of synthetic migrations). Resolving it from cwd would have made the
# guard collapse to "cannot derive" the moment it was aimed anywhere else.
APPROVED_SET_REGISTRY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.claude/schema-registry.json"

BUSINESS_ROW_TABLES=$(node -e "
const fs = require('fs');
const reg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const exempt = new Set((process.argv[1] || '').split(/\s+/).filter(Boolean));
const tables = Object.keys(reg.columns || {})
  .filter((n) => /^[a-z0-9_]+\$/.test(n) && !exempt.has(n))
  .sort();
if (tables.length < 100) {
  throw new Error('schema registry yielded only ' + tables.length + ' protected tables');
}
process.stdout.write(tables.join('|'));
" "${APPROVED_SET_EXEMPT_TABLES[*]}" "$APPROVED_SET_REGISTRY" 2>/dev/null || true)

# Fail closed. A guessed or empty list would turn the approved-set binding check
# into a silent no-op — exactly the failure mode this replaced.
if [ -z "$BUSINESS_ROW_TABLES" ]; then
  echo "❌ FATAL: could not derive the protected table set from $APPROVED_SET_REGISTRY"
  echo "   (needs a readable registry with a 'columns' map of at least 100 tables, and node on PATH)."
  echo "   The approved-set binding check is default-deny and must not run on a partial list."
  exit 1
fi

# ---- MATERIAL BEFORE-VALUES PER TABLE (Codex High, round 15) ---------------
# An UPDATE names the columns it assigns, so the approved-set digest can be
# required to cover them. A DELETE names none. Round 14 therefore asked a
# DELETE for nothing but row ids inside the digest — and a row id does not
# change when the row does. A quote approved for deletion while it was a draft
# could be invoiced, delivered and paid in the interval, and the id-only digest
# would still match at apply time: CI would certify the destruction of a row
# that is no longer the row anyone approved.
#
# So a DELETE is bound to the same before-values an UPDATE would have been:
# the target table's lifecycle and financial columns, taken from the schema
# registry rather than a hand-kept list, so a new status or money column is
# protected the moment it exists.
#
# "Material" is deliberately narrow — state the row is in, money the row
# carries, and the lifecycle timestamps that record an irreversible transition.
# Notification bookkeeping (`*_sent_at`, reminder stamps) is excluded: it moves
# on its own without the row meaning anything different, and requiring it would
# push authors toward the opt-out for no safety gained.
MATERIAL_COLS_MAP=$(node -e "
const fs = require('fs');
const reg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const cols = reg.columns || {};
const LIFECYCLE_AT = /^[a-z0-9_]*(deleted|voided|paid|posted|invoiced|delivered|completed|cancelled|canceled|approved|finalized|refunded|closed|applied|archived|shipped|received|fulfilled|reconciled|settled|locked|signed)_at\$/;
const MONEY = /(^|_)(cents|price|cost|profit|amount|balance|total|subtotal|rate)\$/;
// Quantity matches anywhere in the name, not only at the end: the inventory
// columns are quantity_on_hand / quantity_available, and a stock level is as
// material to a deletion as a dollar figure is.
const QUANTITY = /(^|_)(qty|quantity)(_|\$)/;
const LIFECYCLE = /(^|_)(status|state|stage|phase)\$/;
const material = (c) => LIFECYCLE.test(c) || MONEY.test(c) || QUANTITY.test(c) || LIFECYCLE_AT.test(c);
const rows = [];
for (const t of Object.keys(cols).sort()) {
  if (!/^[a-z0-9_]+\$/.test(t)) continue;
  const m = (cols[t] || []).filter(material);
  if (m.length) rows.push(t + '\t' + m.join(' '));
}
if (rows.length < 50) {
  throw new Error('schema registry yielded material columns for only ' + rows.length + ' tables');
}
process.stdout.write(rows.join('\n'));
" "$APPROVED_SET_REGISTRY" 2>/dev/null || true)

# Fail closed for the same reason the table list does. An empty map would make
# every DELETE look like it had nothing material to bind, which is the silent
# pass this check exists to remove.
if [ -z "$MATERIAL_COLS_MAP" ]; then
  echo "❌ FATAL: could not derive the material-column map from $APPROVED_SET_REGISTRY"
  echo "   (needs a readable registry with a 'columns' map naming lifecycle/financial columns"
  echo "    on at least 50 tables, and node on PATH)."
  echo "   Approved-set DELETEs are bound to those before-values and must not run on a partial map."
  exit 1
fi

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

# ---------------------------------------------------------------------------
# MUTATING-FUNCTION INDEX (Codex High, round 10, finding 4)
# ---------------------------------------------------------------------------
# The rewrite scanner below deliberately skips function BODIES: a body is
# runtime logic, not a one-shot data migration. That is true right up until the
# migration calls the function itself, and then it is a bypass:
#
#   CREATE FUNCTION _fix() RETURNS void LANGUAGE plpgsql AS $x$
#   BEGIN UPDATE public.orders SET total_profit = 0; END $x$;
#   SELECT _fix();
#
# The UPDATE is invisible (inside a body) and the SELECT is not a write, so the
# whole thing passed with no approved-set binding at all. The same hole is open
# for functions defined by EARLIER migrations — `SELECT public.recalc_all()` is
# just as total a rewrite, and its body is not even in this file.
#
# So the write set of every function EVERY migration defines is indexed once,
# and a top-level call to any function in that index is refused. The index is
# built from the whole migration directory, which includes the file being
# scanned, so same-file and cross-file helpers are covered by one mechanism.
#
# Deliberately over-strict in two ways, both fail-closed: a function is judged
# by the union of every definition of it in history (an old mutating body still
# counts after a later rewrite made it read-only), and the refusal stands even
# if the migration DOES carry a digest — a body's predicates are runtime logic,
# so no static check can show the digest covers the rows it touches. Inline the
# DML so it can be read and bound, or split the helper into its own migration
# that does not call it.
MUTATING_FNS_RE=""
MUTATING_FNS_BUILT=false
build_mutating_fn_index() {
  if [ "$MUTATING_FNS_BUILT" = true ]; then return 0; fi
  MUTATING_FNS_BUILT=true
  MUTATING_FNS_RE=$(find "$MIGRATION_DIR" -name '*.sql' -type f -print0 \
    | xargs -0 awk -v tables="$BUSINESS_ROW_TABLES" '
        # Per-file reset: an unterminated body must not leak into the next file.
        FNR == 1 { infn = 0; curfn = ""; tag = "" }
        {
          l = tolower($0)
          sub(/--.*/, "", l)
          gsub(/'"'"'[^'"'"']*'"'"'/, " ", l)
          gsub(/"/, "", l)
          if (!infn) {
            if (l !~ /create[ \t]+(or[ \t]+replace[ \t]+)?function[ \t]/) next
            f = l
            sub(/^.*create[ \t]+(or[ \t]+replace[ \t]+)?function[ \t]+/, "", f)
            sub(/[^a-z0-9_.].*$/, "", f)
            sub(/^public\./, "", f)
            if (f == "") next
            curfn = f; infn = 1; tag = ""
          }
          buf[curfn] = buf[curfn] " " l
          # Body extent is tracked by DOLLAR QUOTES, not by the LANGUAGE marker:
          # `LANGUAGE plpgsql AS $$...$$` puts the marker BEFORE the body, and a
          # marker-terminated scan would attribute an empty body to the function.
          s = l
          while (match(s, /\$[a-z0-9_]*\$/)) {
            d = substr(s, RSTART, RLENGTH)
            s = substr(s, RSTART + RLENGTH)
            if (tag == "") { tag = d; continue }
            if (d == tag) { infn = 0; curfn = ""; tag = ""; break }
          }
          # String-literal body (`AS '"'"'select 1'"'"' LANGUAGE sql;`) never opens a
          # dollar quote; without this the body would swallow the rest of the file.
          if (infn && tag == "" && l ~ /;/) { infn = 0; curfn = "" }
        }
        END {
          for (f in buf) {
            if (buf[f] ~ ("(^|[^a-z0-9_])(update|merge[ \t]+into|delete[ \t]+from|insert[ \t]+into|truncate([ \t]+table)?)[ \t]+(only[ \t]+)?(public\\.)?(" tables ")([^a-z0-9_]|$)")) {
              print f
            }
          }
        }
      ' 2>/dev/null | sort -u | tr '\n' '|' | sed 's/|$//')
  return 0
}

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

# Which of the scanned files are history? Resolved once, in ONE process: the
# manifest holds 868 entries, and hashing that many files with a shell loop
# costs two process spawns each and takes minutes on Windows. The result is a
# newline-delimited list of basenames, matched below without spawning anything.
GRANDFATHERED=$(printf '%s\n' "$ALL_SQL" | node -e "
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const manifest = new Map();
for (const line of fs.readFileSync(process.argv[1], 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const m = line.match(/^([0-9a-f]{64})\s+(\S+)/);
  if (m) manifest.set(m[2], m[1]);
}
if (manifest.size < 500) throw new Error('grandfather manifest is truncated: ' + manifest.size);
const out = [];
for (const f of fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const want = manifest.get(path.basename(f));
  if (!want) continue;
  const norm = Buffer.from(fs.readFileSync(f, 'latin1').replace(/\r/g, ''), 'latin1');
  if (createHash('sha256').update(norm).digest('hex') === want) out.push(path.basename(f));
}
process.stdout.write(out.join('\n'));
" "$APPROVED_SET_GRANDFATHER" 2>/dev/null || echo "__GRANDFATHER_UNREADABLE__")

# Fail closed, loudly. Silently treating an unreadable manifest as "nothing is
# history" would bury the real problem under every legacy violation at once;
# treating it as "everything is history" would disable the check outright.
if [ "$GRANDFATHERED" = "__GRANDFATHER_UNREADABLE__" ]; then
  echo "❌ FATAL: could not read the approved-set grandfather manifest at"
  echo "   $APPROVED_SET_GRANDFATHER"
  echo "   (needs a readable manifest of at least 500 '<sha256>  <basename>' rows, and node on PATH)."
  echo "   Without it there is no way to tell a historical migration from a new one,"
  echo "   and the approved-set binding check must not guess."
  exit 1
fi

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
  # See APPROVED_SET_GRANDFATHER above for what counts as history and why it is
  # content, not a filename stamp.
  # ================================================================
  MIG_BASENAME=$(basename "$file")
  case "
$GRANDFATHERED
" in
    *"
$MIG_BASENAME
"*) MIG_IS_HISTORY=1 ;;
    *) MIG_IS_HISTORY=0 ;;
  esac
  if [ "$MIG_IS_HISTORY" -eq 0 ]; then
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
    #
    # TRUNCATE counts too (Codex High, round 9). It never spells UPDATE or
    # DELETE, so round 8 let `TRUNCATE public.orders` — the most total rewrite
    # there is — produce no finding at all. Its target is a comma-separated
    # list, optionally `TABLE`- and `ONLY`-decorated, so the list is walked.
    #
    # Top-level dynamic SQL is caught on a separate channel (kind `dynamic`).
    # `EXECUTE 'DELETE FROM public.orders'` hides the write inside a string
    # literal, and literals are stripped before scanning precisely so prose
    # cannot fabricate matches — which also means they cannot be read. Dynamic
    # SQL in a data migration is unauditable by construction, so it is not
    # analyzed, it is refused.
    # Output is TAB-separated: line, table, kind, written-columns, text.
    # The written-columns field is `-` when there are none (a DELETE, a
    # TRUNCATE, an unreadable SET). It can NOT be left empty: `read` treats a
    # tab as IFS *whitespace*, so a run of tabs collapses into one delimiter
    # and an empty field silently shifts every field after it — which put the
    # statement text into r_cols and left r_raw blank for every DELETE.
    #
    # Indirect rewrites ride a third channel (kind `indirect`) and are also a
    # refusal — see MUTATING-FUNCTION INDEX above for why a call to a body that
    # writes a protected table cannot be bound to a digest.
    build_mutating_fn_index
    SCAN_HITS=$(awk -v tables="$BUSINESS_ROW_TABLES" -v mutfns="$MUTATING_FNS_RE" '
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
        # Function-body mode, bounded by DOLLAR QUOTES — not by the LANGUAGE
        # marker, which round 9 used and which is wrong in both directions.
        # CRX writes functions LANGUAGE-first:
        #
        #   CREATE OR REPLACE FUNCTION f() RETURNS void
        #   LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
        #   AS $$ BEGIN UPDATE public.orders SET ...; END $$;
        #
        # so the marker arrives BEFORE the body: body mode ended on line 2 and
        # every statement in the body was scanned as though it were top-level.
        # That made ordinary trigger and RPC definitions look like unbound
        # one-shot rewrites (a false alarm on legitimate work), while a
        # body-first function still hid its DML — the fail-open half.
        #
        # A dollar-quote tag is unambiguous: the body runs from the opening tag
        # to the matching close, whatever order the clauses came in, and a
        # differently-tagged nested quote inside it is passed over. A DO block
        # is deliberately NOT a function body — that is where backfills live.
        #
        # SCAN THE WHOLE LINE, NOT WHATEVER STARTS IT (Codex High, round 14).
        # This used to flip into body mode and `next` the entire PHYSICAL line,
        # so anything sharing that line with the definition was never seen:
        #
        #   CREATE FUNCTION f() ... AS $$ ... $$; UPDATE public.orders SET ...;
        #
        # is legal SQL, and the UPDATE — a top-level rewrite of a protected
        # table — vanished with the line that carried it. A rewrite sitting
        # BEFORE a definition on one line disappeared the same way. So the line
        # is consumed as a stream instead: text outside any body accumulates
        # into `top`, body text is dropped, however often the two alternate.
        top = ""
        rest = line
        while (rest != "") {
          if (!infn) {
            if (!match(rest, /create[ \t]+(or[ \t]+replace[ \t]+)?function/)) {
              top = top " " rest
              break
            }
            top = top " " substr(rest, 1, RSTART - 1)
            rest = substr(rest, RSTART)
            infn = 1; fntag = ""
          }
          closed = 0
          while (match(rest, /\$[a-z0-9_]*\$/)) {
            d = substr(rest, RSTART, RLENGTH)
            rest = substr(rest, RSTART + RLENGTH)
            if (fntag == "") { fntag = d; continue }
            if (d == fntag) { infn = 0; fntag = ""; closed = 1; break }
          }
          if (closed) continue
          # A string-literal body (AS <quote>select 1<quote>) opens no dollar
          # quote; without this the signature would swallow the rest of the
          # file. Its terminator ends it, and what follows is top level again.
          if (fntag == "") {
            q = index(rest, ";")
            if (q > 0) { infn = 0; rest = substr(rest, q + 1); continue }
          }
          break
        }
        line = top
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
      # Which captured id-set does the statement starting at token p write
      # through? (Codex High, round 10, finding 2.)
      #
      # A digest binds nothing unless the rows it hashed are the rows that get
      # written. Hashing `orders WHERE stale` and then updating every order
      # satisfied every earlier check — the two predicates were never required
      # to select the same ids. The fix is to remove the second predicate
      # entirely: capture the approved ids ONCE, hash those, then write through
      # `WHERE id = ANY(<that same array>)`.
      #
      # Normalization already turned `ANY(v_ids)` into the tokens `any` `v_ids`
      # and kept `=` as its own token, so the shape is read directly off the
      # token stream. An alias or schema prefix on the id column is fine
      # (`o.id`); `order_id = ANY(...)` is not — it must be the row identity the
      # digest also aggregated by.
      #
      # THE WHOLE PREDICATE, NOT AN OCCURRENCE OF ONE (Codex High, round 13).
      # Round 12 returned the first `id = ANY(<var>)` it found ANYWHERE in the
      # statement, so the array only had to be MENTIONED in the row selection,
      # not to BE it:
      #
      #   UPDATE public.orders SET ... WHERE id = ANY(v_ids) OR TRUE;
      #   UPDATE public.orders SET ... WHERE id = ANY(v_ids || v_everything);
      #
      # Both read as bound to the approved set and both rewrite rows nobody
      # approved. Since there is no static way to evaluate an arbitrary added
      # predicate, the added predicate is refused: the row selection must be
      # EXACTLY `WHERE id = ANY(<array>)`, ending the statement (a RETURNING may
      # follow). Narrowing belongs in the capture that built the array, where it
      # is hashed and therefore approved — not in the write, where it is not.
      function bound_var(p,   k, e, w, ce, v) {
        for (e = p; e <= ntok && tok[e] != ";"; e++) { }
        w = 0
        for (k = p; k < e; k++) { if (tok[k] == "where") { w = k; break } }
        if (w == 0) return "-"
        ce = e
        for (k = w + 1; k < e; k++) { if (tok[k] == "returning") { ce = k; break } }
        if (ce - w - 1 != 4) return "~shape"
        if (tok[w + 1] !~ /(^|\.)id$/) return "~shape"
        if (tok[w + 2] != "=" || tok[w + 3] != "any") return "~shape"
        v = tok[w + 4]
        if (v == "") return "~shape"
        sub(/^[a-z0-9_]+\./, "", v)
        return v
      }
      # First token of the statement containing token p, so a privilege
      # `GRANT EXECUTE ON FUNCTION` is never mistaken for dynamic SQL.
      function stmt_head(p,   k) {
        for (k = p - 1; k >= 1; k--) { if (tok[k] == ";") return tok[k + 1] }
        return tok[1]
      }
      END {
        for (i = 1; i <= ntok; i++) {
          # Dynamic SQL: refused outright, no table needed. `EXECUTE FUNCTION`
          # / `EXECUTE PROCEDURE` (trigger bodies) and `... EXECUTE ON ...`
          # (privilege grants) are the non-dynamic uses of the keyword.
          if (tok[i] == "execute" &&
              tok[i + 1] != "function" && tok[i + 1] != "procedure" &&
              tok[i + 1] != "on" &&
              stmt_head(i) != "grant" && stmt_head(i) != "revoke") {
            printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], "(dynamic)", "dynamic", "-", "-", raw[tokln[i]]
            continue
          }
          # Indirect rewrite: a top-level CALL/PERFORM/SELECT of a function whose
          # body writes a protected table. The name alone is not a call — it is
          # also how a function is granted, dropped, commented, altered, and
          # bound to a trigger — so those statement heads are excluded. Everything
          # else counts, including inside a DO block, which is exactly where a
          # `PERFORM _fix()` bypass would sit.
          callee = tok[i]
          sub(/^public\./, "", callee)
          if (mutfns != "" && callee ~ ("^(" mutfns ")$") && !seenfn[callee]) {
            h = stmt_head(i)
            if (h != "grant" && h != "revoke" && h != "comment" && h != "drop" &&
                h != "alter" && h != "create" &&
                tok[i - 1] != "function" && tok[i - 1] != "procedure") {
              seenfn[callee] = 1
              printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], callee, "indirect", "-", "-", raw[tokln[i]]
              continue
            }
          }
          if (tok[i] == "truncate") {
            j = i + 1
            if (tok[j] == "table") j++
            while (j <= ntok && tok[j] != ";") {
              if (tok[j] == "only") { j++; continue }
              tt = tok[j]
              sub(/^public\./, "", tt)
              if (tt ~ ("^(" tables ")$")) {
                printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], tt, "truncate", "-", "-", raw[tokln[i]]
              }
              if (tok[j + 1] == ",") { j += 2; continue }
              break
            }
            continue
          }
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
            sc = (setp ? set_cols(setp) : "")
            printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], target, kind,
                   (sc == "" ? "-" : sc), bound_var(i), raw[tokln[i]]
          }
        }
      }
    ' "$file")

    # ── A function body written as a single-quoted string ───────────────────
    # PostgreSQL accepts `CREATE FUNCTION f() ... AS 'BEGIN UPDATE ...; END;'`.
    # Every scanner in this file strips single-quoted literals before it looks
    # for writes, so a body written that way is invisible three times over: the
    # rewrite is not seen, the function is not indexed as mutating, and a later
    # `SELECT f()` is not refused. That is an unbound rewrite of a protected
    # table with nothing standing in its way.
    #
    # Rather than teach four scanners to parse quoted bodies, refuse the shape.
    # CRX writes dollar-quoted bodies everywhere, so this costs nothing and
    # closes the hole fail-closed.
    QUOTED_BODIES=$(awk '
      { line = tolower($0)
        while (1) {
          if (inblk) { e = index(line, "*/"); if (e == 0) { line = ""; break }
                       line = substr(line, e + 2); inblk = 0 }
          s = index(line, "/*"); if (s == 0) break
          e = index(substr(line, s + 2), "*/")
          if (e == 0) { line = substr(line, 1, s - 1); inblk = 1; break }
          line = substr(line, 1, s - 1) " " substr(line, s + 2 + e + 1)
        }
        sub(/--.*/, "", line)
        if (line ~ /create[ \t]+(or[ \t]+replace[ \t]+)?(function|procedure)[ \t]/) { pending = 1 }
        if (!pending) next
        # A dollar quote opens the body: this is the shape we want, stand down.
        if (line ~ /\$[a-z0-9_]*\$/) { pending = 0; awaitq = 0; next }
        if (line ~ /(^|[^a-z0-9_])as[ \t]*'"'"'/) {
          printf "%d\t%s\n", FNR, $0; pending = 0; awaitq = 0; next
        }
        # `AS` at end of line, body opens on the next one.
        if (line ~ /(^|[^a-z0-9_])as[ \t]*$/) { awaitq = 1; next }
        if (awaitq && line ~ /^[ \t]*'"'"'/) {
          printf "%d\t%s\n", FNR, $0; pending = 0; awaitq = 0; next
        }
        if (awaitq && line ~ /[^ \t]/) { awaitq = 0 }
      }
    ' "$file")

    if [ -n "$QUOTED_BODIES" ]; then
      echo "VIOLATION: $file"
      echo "  Function body written as a single-quoted string:"
      printf '%s\n' "$QUOTED_BODIES" | while IFS=$'\t' read -r q_ln q_raw; do
        echo "    line $q_ln: $q_raw"
      done
      echo "  Every scanner in this validator strips single-quoted literals before"
      echo "  it looks for writes, so a body written this way is invisible: its"
      echo "  UPDATE is not seen, the function is not indexed as mutating, and a"
      echo "  later call to it is not refused. Use a dollar-quoted body"
      echo "  (\$\$ ... \$\$) so the statements inside can be read and bound."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    # Dynamic SQL rides the same scan but is not a bindable rewrite — it is a
    # refusal, and it stands on its own whether or not any table rewrite was
    # also found.
    DYNAMIC_HITS=$(printf '%s\n' "$SCAN_HITS" | awk -F'\t' 'NF && $3 == "dynamic"')
    INDIRECT_HITS=$(printf '%s\n' "$SCAN_HITS" | awk -F'\t' 'NF && $3 == "indirect"')
    REWRITES=$(printf '%s\n' "$SCAN_HITS" | awk -F'\t' 'NF && $3 != "dynamic" && $3 != "indirect"')

    if [ -n "$DYNAMIC_HITS" ]; then
      echo "VIOLATION: $file"
      echo "  Top-level dynamic SQL in a data migration:"
      printf '%s\n' "$DYNAMIC_HITS" | while IFS=$'\t' read -r d_ln d_tbl d_kind d_cols d_var d_raw; do
        echo "    line $d_ln: $d_raw"
      done
      echo "  An EXECUTE builds its statement at runtime, so no static guard can"
      echo "  see which tables or columns it rewrites — including this one."
      echo "  Write the statement out literally so it can be read and bound."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    if [ -n "$INDIRECT_HITS" ]; then
      echo "VIOLATION: $file"
      echo "  Top-level call to a function that rewrites business rows:"
      printf '%s\n' "$INDIRECT_HITS" | while IFS=$'\t' read -r n_ln n_fn n_kind n_cols n_var n_raw; do
        echo "    line $n_ln: $n_fn() — its body writes a protected table"
      done
      echo "  Calling it makes this migration a one-shot rewrite, but the rows it"
      echo "  touches are decided by the function's own runtime predicates, so no"
      echo "  digest can be shown to cover them. Inline the DML here so it can be"
      echo "  read and bound to an approved set."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    if [ -n "$REWRITES" ]; then
      FIRST_REWRITE_LINE=$(printf '%s\n' "$REWRITES" | head -1 | cut -f1)
      REWRITE_TABLES=$(printf '%s\n' "$REWRITES" | cut -f2 | sort -u)
      # Alternation of the rewritten tables, and the union of the columns those
      # rewrites assign. The digest has to be shown to cover THIS material, so
      # both are handed to the hash check below.
      REWRITE_TABLES_RE=$(printf '%s\n' "$REWRITE_TABLES" | tr '\n' '|' | sed 's/|$//')
      # `|| true` because the script runs under `set -o pipefail`: a rewrite set
      # that is ALL column-less (a DELETE-only repair) filters to nothing, and
      # grep's exit 1 would abort the whole validator.
      REWRITE_COLS=$(printf '%s\n' "$REWRITES" | cut -f4 | tr ' ' '\n' \
                       | { grep -vx '-' || true; } | sort -u | tr '\n' ' ')

      # ---- A DELETE BINDS ITS TABLE'S BEFORE-VALUES (Codex High, round 15) --
      # A DELETE contributes no assigned columns, so on its own it asks the
      # digest to cover row ids and nothing else. Substitute the target table's
      # material columns (see MATERIAL_COLS_MAP above) so the SAME coverage
      # machinery that binds an UPDATE's assigned columns now binds a DELETE's
      # lifecycle and financial before-values. If a row's status or money moved
      # after approval, the digest no longer matches and the migration aborts.
      #
      # A table the registry gives no material column for is refused outright
      # rather than passed on ids alone — recorded here, decided in the chain
      # below so it reads next to the other structural refusals.
      DELETE_TABLES=$(printf '%s\n' "$REWRITES" | awk -F'\t' '$3 == "delete" { print $2 }' | sort -u)
      DELETE_UNBINDABLE=""
      if [ -n "$DELETE_TABLES" ]; then
        while IFS= read -r d_tbl; do
          if [ -z "$d_tbl" ]; then
            continue
          fi
          d_cols=$(printf '%s\n' "$MATERIAL_COLS_MAP" \
                     | awk -F'\t' -v t="$d_tbl" '$1 == t { print $2 }')
          if [ -z "$d_cols" ]; then
            DELETE_UNBINDABLE="$DELETE_UNBINDABLE $d_tbl"
          else
            REWRITE_COLS="$REWRITE_COLS $d_cols"
          fi
        done <<< "$DELETE_TABLES"
        # Word-split on purpose: re-flatten the appended groups into one sorted,
        # de-duplicated list, in the single-space-separated shape line ~1051
        # hands to awk.
        # shellcheck disable=SC2086
        REWRITE_COLS=$(printf '%s\n' $REWRITE_COLS | { grep -v '^$' || true; } \
                         | sort -u | tr '\n' ' ')
      fi

      # The declared digest, from a comment marker.
      DIGEST_HEX=$(grep -oiE 'APPROVED_SET_DIGEST:[[:space:]]*[0-9a-f]{64}' "$file" \
                     | grep -oiE '[0-9a-f]{64}' | head -1 | tr '[:upper:]' '[:lower:]' || true)

      # An opt-out must NAME every business table it waives, so it cannot be a
      # blanket wave-through, and it is never silent — see the WARNING below.
      OPT_OUT=$(grep -iE 'APPROVED_SET_DIGEST:[[:space:]]*NOT-REQUIRED' "$file" | head -1 || true)

      REWRITE_TABLE_COUNT=$(printf '%s\n' "$REWRITE_TABLES" | { grep -c . || true; })
      REWRITE_TABLES_ONE_LINE=$(printf '%s\n' "$REWRITE_TABLES" | tr '\n' ' ' | sed 's/ *$//')

      DIGEST_BOUND=0
      DIGEST_WHY=""
      # ---- ONE TABLE PER APPROVED-SET REPAIR (Codex High, round 11) ---------
      # Round 10 tracked the captured id set per table so a two-table repair
      # could carry one array each. Codex broke that in round 11: coverage
      # accumulates across every hash statement assigned to the compared
      # variable, but only ONE comparison is ever verified fail-closed. Delete
      # the second table's IF/RAISE and the migration still passed — table,
      # column and set coverage were all satisfied by a digest nothing checked.
      #
      # Proving "each table's digest is coupled to its own fail-closed
      # comparison" means re-deriving, for every hash statement, which
      # comparison governs it and whether the variable was overwritten in
      # between. That is a dataflow analysis over PL/pgSQL text, and a guard
      # that is wrong about it is worse than no guard. So the unverifiable shape
      # is refused instead, exactly as the second predicate was in round 10: one
      # rewritten table, one digest, one comparison. A repair spanning two
      # tables is two migrations, each binding its own approved population.
      if [ "$REWRITE_TABLE_COUNT" -gt 1 ]; then
        DIGEST_WHY="this migration rewrites $REWRITE_TABLE_COUNT business tables in one file ($REWRITE_TABLES_ONE_LINE). An approved-set repair binds ONE table to ONE digest and ONE fail-closed comparison; with several, the guard cannot tell which comparison governs which digest, and dropping one table's comparison leaves its rows unprotected while the other table's check still passes. Split this into one migration per table."
      # ---- A DELETE WITH NOTHING TO BIND IS REFUSED (Codex High, round 15) --
      # The generic digest path proves "these exact rows, in this exact state,
      # were the ones approved". For a table the registry records no lifecycle
      # or financial column on, the second half of that sentence has no
      # material to stand on, and the check would decay to ids alone — which is
      # the hole this round closes. Refuse instead of passing on a technicality.
      elif [ -n "$DELETE_UNBINDABLE" ]; then
        DIGEST_WHY="this migration DELETEs rows from$DELETE_UNBINDABLE, and the schema registry records no lifecycle or financial column on that table for the digest to bind. A DELETE assigns no columns, so an id-only digest still matches after the row's status or money has moved, and the approved set would certify destroying a row that is no longer the row that was approved. Either delete through a migration that can bind material before-values, or waive it with an APPROVED_SET_DIGEST: NOT-REQUIRED marker that names that table and says why it carries no material state."
      elif [ -n "$DIGEST_HEX" ]; then
        # Where is that hex first compared for INEQUALITY in executable sql?
        # Only a mismatch operator counts. `IF actual = '<approved>' THEN RAISE`
        # reads like a guard and is the exact inversion of one: it aborts when
        # the data is right and writes when it has drifted. Equality is not a
        # near-miss here, it is the bypass, so it is rejected outright.
        #
        # Also capture the identifier on the left of that operator, so the next
        # check can prove THAT variable is the one the hash was computed into —
        # otherwise any unrelated hash call anywhere above satisfies the guard.
        #
        # Round 10 (Codex High): "an inequality occurs somewhere to the left" is
        # not the same claim as "the computed hash is compared against the
        # approved digest", and the gap between those two is a working bypass:
        #
        #   IF actual <> actual OR actual = '<approved digest>' THEN RAISE ...
        #
        # The old scan saw a mismatch operator, recovered the correct variable
        # name from its left side, and passed — while the operator that actually
        # governs the digest is `=`. At runtime that raises when the data is
        # APPROVED and writes when it has DRIFTED: the precise polarity
        # inversion this guard exists to stop, wearing the shape of a guard.
        #
        # So the mismatch operator must now be the one that governs the digest,
        # proven structurally rather than positionally:
        #
        #   ADJACENCY — nothing but whitespace and the opening quote may sit
        #   between the operator and the digest literal. In the decoy, `<>` is
        #   separated from the hex by `actual or actual = '`, so it no longer
        #   counts as the digest's operator.
        #
        #   NO COMPOUND CONDITION — adjacency alone still admits
        #   `IF false AND v_actual <> '<hex>' THEN RAISE`, where the RAISE is
        #   unreachable. A boolean or conditional keyword anywhere in the
        #   condition means the polarity is no longer decidable by reading the
        #   operator, so the canonical single-comparison shape is required:
        #
        #     IF v_actual IS DISTINCT FROM '"'"'<approved digest>'"'"' THEN
        #       RAISE EXCEPTION ...;
        #     END IF;
        #
        # This is deliberately narrow. A migration is free to write any guard it
        # likes; it just cannot claim digest binding for one the validator
        # cannot read the polarity of.
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
            if (k == 0) { print FNR "\t\tno-mismatch"; exit }
            # ADJACENCY: only blanks and the digest literal'"'"'s opening quote may
            # stand between that operator and the digest itself.
            gap = substr(pre, k + 1)
            if (gap !~ /^[ \t]*'"'"'?[ \t]*$/) { print FNR "\t\tdecoy"; exit }
            lhs = substr(pre, 1, k - 1)
            # NO COMPOUND CONDITION: the governing operator must be the only one.
            if (lhs ~ /(^|[^a-z0-9_])(or|and|not|case|when|coalesce|nullif)([^a-z0-9_]|$)/) {
              print FNR "\t\tcompound"; exit
            }
            sub(/[^a-z0-9_]+$/, "", lhs)
            if (match(lhs, /[a-z0-9_]+$/)) { print FNR "\t" substr(lhs, RSTART, RLENGTH) "\tok" }
            else { print FNR "\t\tok" }
            exit
          }
        ' "$file")
        DIGEST_CMP_STATUS=$(printf '%s' "$DIGEST_CMP" | cut -f3)
        DIGEST_EXEC_LINE=$(printf '%s' "$DIGEST_CMP" | cut -f1)
        DIGEST_VAR=$(printf '%s' "$DIGEST_CMP" | cut -f2)
        # A rejected comparison is NOT a comparison. Blank the line so every
        # downstream test treats it as "never compared", and carry a reason that
        # names the specific shape rather than the generic one.
        DIGEST_CMP_WHY=""
        case "$DIGEST_CMP_STATUS" in
          decoy)
            DIGEST_CMP_WHY="the digest at line $DIGEST_EXEC_LINE is not governed by the mismatch operator on that line — something else sits between them (a decoy such as \`IF actual <> actual OR actual = '<digest>'\` compares the digest with =, which aborts when the data is right and writes when it has drifted)"
            DIGEST_EXEC_LINE="" ;;
          compound)
            DIGEST_CMP_WHY="the digest at line $DIGEST_EXEC_LINE is compared inside a compound condition — its polarity is not readable. Use the canonical single test: IF <computed> IS DISTINCT FROM '<digest>' THEN RAISE EXCEPTION"
            DIGEST_EXEC_LINE="" ;;
          no-mismatch)
            DIGEST_EXEC_LINE="" ;;
        esac
        DIGEST_MENTION_LINE=$(awk -v hex="$DIGEST_HEX" '
          { l = tolower($0); sub(/--.*/, "", l); if (index(l, hex) > 0) { print FNR; exit } }
        ' "$file")
        if [ -n "$DIGEST_CMP_WHY" ]; then
          DIGEST_WHY="$DIGEST_CMP_WHY"
        elif [ -z "$DIGEST_EXEC_LINE" ] && [ -n "$DIGEST_MENTION_LINE" ]; then
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
          # then compare a hand-set variable to the literal and pass.
          #
          # Round 7 checked that by looking for the table name, `id` and a
          # written column ANYWHERE in the assigning statement, which Codex broke
          # in round 8: those tokens are all over an ordinary
          # `SELECT ... FROM orders`, so `encode(digest('approved','sha256'),'hex')`
          # — a hash of a constant string — passed while the surrounding SELECT
          # supplied the vocabulary. Mentioning a column is not hashing it.
          #
          # So the MATERIAL check now reads the ARGUMENTS OF THE HASH CALL, not
          # the statement around it: find the first hash-family call, walk the
          # parentheses to its matching close, drop string literals, and require
          # the aggregate, the ids and the before-values to appear INSIDE that
          # span. The mandated shape is
          #
          #   SELECT encode(digest(
          #            string_agg(id::text || ':' || total_profit::text,
          #                       ',' ORDER BY id),
          #            'sha256'), 'hex')
          #     INTO v_actual FROM public.orders WHERE ...;
          #
          # string_agg() is required because a digest that is not an ordered
          # aggregate over the affected rows cannot be a digest OF those rows;
          # dropping literals first is what kills `digest('id total_profit',
          # 'sha256')`, whose argument merely spells the column names.
          #
          # The table stays a statement-level check — in that shape the FROM
          # sits outside the hash call, and it was never the vector.
          #
          # Statement-level, not line-level: a SELECT ... INTO routinely spans
          # several lines, so the text before the write is joined and split on
          # `;`, and the hash call and the assignment must land in one statement.
          DIGEST_VAR_RE=$(printf '%s' "$DIGEST_VAR" | sed 's/[^a-z0-9_]//g')
          DIGEST_SRC_WHY=""
          DIGEST_SET_PAIRS=""
          if [ -z "$DIGEST_VAR_RE" ]; then
            COMPUTED=0
          else
            REWRITE_TABLES_LIST=$(printf '%s\n' "$REWRITE_TABLES" | tr '\n' ' ')
            DIGEST_SRC_WHY=$(awk -v fl="$FIRST_REWRITE_LINE" -v var="$DIGEST_VAR_RE" \
                                 -v tbls="$REWRITE_TABLES_RE" -v cols="$REWRITE_COLS" \
                                 -v tbllist="$REWRITE_TABLES_LIST" '
              # Arguments of the FIRST hash-family call in str, found by walking
              # parentheses to the matching close. Returns "" when there is no
              # such call. Callers pass literal-stripped text, so a quote cannot
              # hide an unbalanced paren.
              function hash_args(str,   i, ch, depth, start, n) {
                if (match(str, /(md5|sha224|sha256|sha384|sha512|digest|encode)[ \t]*\(/) == 0) return ""
                start = RSTART + RLENGTH
                depth = 1
                n = length(str)
                for (i = start; i <= n; i++) {
                  ch = substr(str, i, 1)
                  if (ch == "(") depth++
                  else if (ch == ")") { depth--; if (depth == 0) return substr(str, start, i - start) }
                }
                return substr(str, start)
              }
              # Does token t appear in str, optionally alias- or schema-qualified
              # (`o.id`, `public.orders`) but never as part of a longer
              # identifier (`order_id` must NOT satisfy `id`)?
              function tok_in(str, t) {
                return (str ~ ("(^|[^a-z0-9_])([a-z0-9_]+\\.)?" t "([^a-z0-9_]|$)"))
              }
              # The array variable a statement restricts its rows to, from
              # `WHERE o.id = ANY(v_ids)`. "" when the statement chooses its rows
              # by some other predicate. (Codex High, round 10, finding 2.)
              function id_set_var(str,   v) {
                if (match(str, /(^|[^a-z0-9_.])([a-z0-9_]+\.)?id[ \t]*=[ \t]*any[ \t]*\([ \t]*[a-z0-9_]+/) == 0) return ""
                v = substr(str, RSTART, RLENGTH)
                sub(/.*[ \t(]/, "", v)
                return v
              }
              FNR >= fl { next }
              { l = tolower($0); sub(/--.*/, "", l); buf = buf " " l }
              END {
                ncol = split(cols, c, / +/)
                ntbl = split(tbllist, tb, / +/)
                n = split(buf, st, /;/)
                # EVERY qualifying hash statement must be well formed, and
                # TOGETHER they must cover EVERY rewritten table and EVERY
                # assigned column (Codex High, round 9). Round 8 accepted the
                # first statement that covered any ONE table and any ONE
                # column, because the tables and columns arrived here already
                # unioned: a migration could hash orders.id + total_profit and,
                # in the same breath, overwrite an unhashed money column on a
                # second table and satisfy the guard with the first one. So the
                # spans and statements are accumulated and the coverage test
                # moved after the loop.
                found = 0
                for (i = 1; i <= n; i++) {
                  s = st[i]
                  if (s !~ /(md5|sha224|sha256|sha384|sha512|digest|encode)[ \t]*\(/) continue
                  if (s !~ ("into[ \t]+(strict[ \t]+)?" var "([^a-z0-9_]|$)") &&
                      s !~ (var "[ \t]*:=")) continue
                  # This statement does assign a hash to the compared variable.
                  # Now prove the material being rewritten is INSIDE the hash.
                  sl = s
                  gsub(/'"'"'[^'"'"']*'"'"'/, " ", sl)
                  span = hash_args(sl)
                  if (span == "") { print "has no parsable hash-call arguments"; exit }
                  if (span !~ /(^|[^a-z0-9_.])string_agg[ \t]*\(/) {
                    print "does not hash a string_agg() over the affected rows — a digest that is not an ordered aggregate of those rows is not a digest OF them"; exit
                  }
                  if (!tok_in(span, "id")) {
                    print "does not cover the row ids inside the hashed expression"; exit
                  }
                  # The hashed rows must be a CAPTURED SET, not a predicate.
                  # A predicate is re-evaluated by every statement that repeats
                  # it, and nothing forces the writes to repeat it at all — the
                  # hole Codex found: hash `orders WHERE stale`, then update
                  # every order. An array of ids captured once cannot drift
                  # between the digest and the write.
                  #
                  # Per TABLE, not per migration: a repair spanning orders and
                  # order_items needs one captured array each, because their ids
                  # are different id spaces. One set per table, shared by that
                  # the digest and the writes for that one table.
                  sv = id_set_var(s)
                  if (sv == "") {
                    print "chooses the hashed rows with a predicate instead of a captured id set — the digest statement must read WHERE id = ANY(<captured ids>), the same array every write is restricted to"; exit
                  }
                  for (k = 1; k <= ntbl; k++) {
                    if (tb[k] == "") continue
                    if (s !~ ("(^|[^a-z0-9_.])(public\\.)?" tb[k] "([^a-z0-9_]|$)")) continue
                    if ((tb[k] in tblvar) && tblvar[tb[k]] != sv) {
                      print "hashes " tb[k] " against two different id sets (" tblvar[tb[k]] " and " sv ") — one captured set has to drive the digest and the writes for a table"; exit
                    }
                    tblvar[tb[k]] = sv
                  }
                  found = 1
                  nstmt++
                  stmtall = stmtall " " s
                  spanall = spanall " " span
                }
                # ONE digest, not a union of them (Codex High, round 11). The
                # comparison below tests whatever the variable held LAST, so a
                # second hash assigned to the same variable is coverage the
                # guard cannot tie to any verified comparison — and in a repair
                # with two of them, deleting one comparison left its material
                # covered and unchecked. One statement has to satisfy the whole
                # coverage test on its own.
                if (nstmt > 1) {
                  print "computes " nstmt " separate digests into " var " before the write — only the last one survives to be compared, so the rest is coverage no verified comparison governs. Compute one digest over the approved set and compare that one"; exit
                }
                # No statement assigns a hash into the compared variable at all.
                # Printing nothing is the signal for that case; the caller
                # reports it separately.
                if (!found) exit
                # The tables stay a statement-level check: in the mandated shape
                # the FROM sits OUTSIDE the hash call
                # (SELECT encode(digest(string_agg(...))) FROM orders), and it
                # was never the bypass vector. What must be inside the hash is
                # the MATERIAL — the aggregate, the ids, the before-values.
                misst = ""
                for (k = 1; k <= ntbl; k++) {
                  if (tb[k] == "") continue
                  if (stmtall !~ ("(^|[^a-z0-9_.])(public\\.)?" tb[k] "([^a-z0-9_]|$)")) {
                    misst = misst " " tb[k]
                  }
                }
                if (misst != "") {
                  print "never reads the rewritten table(s)" misst " — every table the migration rewrites has to be hashed, not just one of them"; exit
                }
                missc = ""
                for (k = 1; k <= ncol; k++) {
                  if (c[k] == "") continue
                  if (!tok_in(spanall, c[k])) missc = missc " " c[k]
                }
                if (missc != "") {
                  print "leaves the rewritten column(s)" missc " outside the hashed expression — every column the migration assigns has to be covered, not just one of them"; exit
                }
                # One captured set PER TABLE, reported as "table=var" pairs so the
                # caller can hold every write on a table to the set for it.
                pairs = ""
                for (k = 1; k <= ntbl; k++) {
                  if (tb[k] == "") continue
                  if (!(tb[k] in tblvar)) {
                    print "never restricts its hash of " tb[k] " to a captured id set"; exit
                  }
                  pairs = pairs " " tb[k] "=" tblvar[tb[k]]
                }
                print "OK\t" substr(pairs, 2)
              }
            ' "$file")
            case "$DIGEST_SRC_WHY" in
              OK*)
                DIGEST_SET_PAIRS=$(printf '%s' "$DIGEST_SRC_WHY" | cut -f2)
                COMPUTED=1
                DIGEST_SRC_WHY=""
                ;;
              *) COMPUTED=0 ;;
            esac
          fi

          # Fail-closed: the mismatch branch must abort. Require the RAISE to sit
          # inside the SAME IF block as the comparison — a RAISE that merely
          # happens to be nearby, in an unrelated or unreachable branch, is not
          # the guard it looks like. Walk forward from the comparison, tracking
          # IF depth, and stop at the END IF that closes it.
          #
          # DEPTH 1 ONLY (Codex High, round 12). Accepting a RAISE at any depth
          # inside the block accepted an UNREACHABLE one: `IF false THEN RAISE
          # EXCEPTION ...; END IF;` nested under the digest comparison satisfied
          # the check while the mismatch branch fell through and the write ran
          # anyway. The abort has to be in the comparison's own immediate body,
          # unconditionally — which is also the only shape this validator can
          # read without evaluating conditions it has no way to evaluate.
          #
          # THE MISMATCH BRANCH, NOT THE BLOCK (Codex High, round 13). Depth
          # alone still counted a RAISE in the ELSE arm, which is the polarity
          # inversion again wearing a different hat:
          #
          #   IF actual IS DISTINCT FROM '<digest>' THEN NULL;
          #   ELSE RAISE EXCEPTION '...'; END IF;
          #
          # That aborts when the data MATCHES and falls through to the write
          # when it has DRIFTED. So the scan now stops at the first depth-1
          # ELSE/ELSIF: only the mismatch arm itself can satisfy the check.
          #
          # A DECOY IS NOT AN ABORT (Codex High, round 14). This matched the
          # raw line, so RAISE NOTICE <q>RAISE EXCEPTION<q>; read as a real
          # abort: prose inside a string literal satisfying the fail-closed
          # check while the mismatch branch fell straight through to the write.
          # Block comments were the same trick with different delimiters.
          # Strings and block comments are now removed before anything is
          # matched, with the state carried across lines so a multi-line literal
          # cannot smuggle text through either — and EVERY line is stripped,
          # not just the ones from the comparison onward, or that state would
          # start out wrong.
          RAISE_IN_BRANCH=$(awk -v dl="$DIGEST_EXEC_LINE" -v Q="'" '
            function strip(l,   out, a, b, c, m, p) {
              l = tolower(l)
              out = ""
              while (l != "") {
                if (instr) { p = index(l, Q); if (p == 0) return out; l = substr(l, p + 1); instr = 0; continue }
                if (inblk) { p = index(l, "*/"); if (p == 0) return out; l = substr(l, p + 2); inblk = 0; continue }
                a = index(l, "--"); b = index(l, "/*"); c = index(l, Q)
                m = 0
                if (a > 0) m = a
                if (b > 0 && (m == 0 || b < m)) m = b
                if (c > 0 && (m == 0 || c < m)) m = c
                if (m == 0) { out = out l; break }
                out = out substr(l, 1, m - 1) " "
                if (m == a) break
                if (m == b) { inblk = 1; l = substr(l, m + 2); continue }
                instr = 1; l = substr(l, m + 1)
              }
              return out
            }
            {
              l = strip($0)
              if (FNR < dl) next
              if (FNR == dl) { depth = 1 }
              else {
                if (l ~ /(^|[^a-z0-9_])if([^a-z0-9_]|$)/ && l !~ /end[[:space:]]+if/) depth++
                if (l ~ /end[[:space:]]+if/) { depth--; if (depth <= 0) exit }
              }
              if (depth == 1 && l ~ /(^|[^a-z0-9_])(else|elsif|elseif)([^a-z0-9_]|$)/) exit
              if (depth == 1 && l ~ /raise[[:space:]]+exception/) { print "yes"; exit }
            }
          ' "$file" | grep -c yes || true)

          # ---- SAME-SET BINDING (Codex High, round 10, finding 2) ------------
          # Everything above proves the digest is real, fail-closed, and covers
          # the rewritten tables and columns. None of it proved the digest
          # covers the rows the migration actually WRITES. It did not, and the
          # gap was a working bypass: hash `orders WHERE stale`, then run an
          # unrestricted `UPDATE public.orders`. Two predicates, no requirement
          # that they select the same ids, and the second one is the one that
          # touches the data.
          #
          # There is no static way to prove two arbitrary SQL predicates are
          # equivalent, so the shape removes the second predicate instead:
          #
          #   SELECT array_agg(s.id ORDER BY s.id) INTO v_ids
          #     FROM (SELECT o.id FROM public.orders o
          #            WHERE <approved predicate> ORDER BY o.id FOR UPDATE) s;
          #   SELECT encode(digest(string_agg(o.id::text || ':' ||
          #                                   o.total_profit_cents::text,
          #                                   ',' ORDER BY o.id), 'sha256'), 'hex')
          #     INTO v_actual FROM public.orders o WHERE o.id = ANY(v_ids);
          #   IF v_actual IS DISTINCT FROM '<digest>' THEN RAISE EXCEPTION ...; END IF;
          #   UPDATE public.orders SET ... WHERE id = ANY(v_ids);
          #   GET DIAGNOSTICS v_n = ROW_COUNT;
          #   IF v_n <> array_length(v_ids, 1) THEN RAISE EXCEPTION ...; END IF;
          #
          # Three properties, each checked below:
          #   1. every write is restricted to the SAME array the digest hashed,
          #      so the write set cannot exceed the approved set;
          #   2. that array is captured once, under FOR UPDATE, so nothing can
          #      change between the digest and the write (the subselect is not
          #      decoration — Postgres rejects FOR UPDATE alongside array_agg);
          #   3. the row count is asserted against the captured set, so a write
          #      silently narrowed to FEWER rows than were approved also aborts.
          #
          # The sets are tracked PER TABLE: a repair spanning orders and
          # order_items needs one captured array each, since their ids are
          # different id spaces. DIGEST_SET_PAIRS carries "table=var" for every
          # rewritten table.
          SET_BIND_WHY=""
          if [ "$COMPUTED" -eq 1 ] && [ -n "$DIGEST_SET_PAIRS" ]; then
            UNBOUND=""
            while IFS=$'\t' read -r b_ln b_tbl b_kind b_cols b_var b_raw; do
              [ -z "$b_tbl" ] && continue
              WANT=""
              for pair in $DIGEST_SET_PAIRS; do
                [ "${pair%%=*}" = "$b_tbl" ] && WANT="${pair#*=}"
              done
              [ -z "$WANT" ] && continue   # coverage check above already reported it
              [ "$b_var" = "$WANT" ] && continue
              if [ -z "$b_var" ] || [ "$b_var" = "-" ]; then
                UNBOUND="$UNBOUND
    line $b_ln ($b_kind on $b_tbl): chooses its own rows — no WHERE id = ANY($WANT)"
              elif [ "$b_var" = "~shape" ]; then
                UNBOUND="$UNBOUND
    line $b_ln ($b_kind on $b_tbl): its row selection is not exactly WHERE id = ANY($WANT) — anything else in that clause (an OR, a second predicate, a concatenated array) decides rows the digest never covered"
              else
                UNBOUND="$UNBOUND
    line $b_ln ($b_kind on $b_tbl): writes through '$b_var', not the hashed set '$WANT'"
              fi
            done <<< "$REWRITES"
            if [ -n "$UNBOUND" ]; then
              SET_BIND_WHY="the digest covers the captured id set(s) $DIGEST_SET_PAIRS, but these writes are not restricted to the same set:$UNBOUND
  A digest over one predicate authorizes nothing about rows selected by another. Capture the approved ids once, hash those, and write WHERE id = ANY(<that same array>)."
            fi
          fi

          # Every distinct captured array must be locked at capture and asserted
          # against the row count of the writes it drives.
          DIGEST_SET_VARS=$(printf '%s\n' $DIGEST_SET_PAIRS | sed 's/^[^=]*=//' | sort -u)

          for DIGEST_SET_VAR in $DIGEST_SET_VARS; do
          if [ -z "$SET_BIND_WHY" ] && [ "$COMPUTED" -eq 1 ] && [ -n "$DIGEST_SET_VAR" ]; then
            CAPTURE_STATUS=$(awk -v fl="$FIRST_REWRITE_LINE" -v var="$DIGEST_SET_VAR" '
              { l = tolower($0); sub(/--.*/, "", l); all = all " " l; if (FNR < fl) buf = buf " " l }
              END {
                # ---- ONE CAPTURE, NEVER REASSIGNED (Codex High, round 12) ----
                # Everything downstream reasons about "the approved set" as if
                # the variable holding it never changes. Nothing checked that.
                # Capture the approved ids, hash them, pass the comparison —
                # then reassign the same variable and let the write and the
                # row-count assertion operate on an entirely different
                # population, with the guard still reporting the migration
                # bound to the approved set. Proving which assignment reaches
                # which statement is dataflow analysis over PL/pgSQL text; the
                # answer here is the same as for digests and for multi-table
                # repairs — refuse the shape. One capture, one digest, one
                # comparison, and the variable is never written again.
                m = split(all, at, /;/)
                for (i = 1; i <= m; i++) {
                  s = at[i]
                  if (s ~ ("into[ \t]+(strict[ \t]+)?" var "([^a-z0-9_]|$)") || s ~ (var "[ \t]*:="))
                    assigns++
                }
                if (assigns > 1) { print "reassigned\t" assigns; exit }

                n = split(buf, st, /;/)
                for (i = 1; i <= n; i++) {
                  s = st[i]
                  if (s !~ ("into[ \t]+(strict[ \t]+)?" var "([^a-z0-9_]|$)") &&
                      s !~ (var "[ \t]*:=")) continue
                  if (s !~ /(^|[^a-z0-9_.])array_agg[ \t]*\(/) { nagg = 1; continue }
                  found = 1
                  if (s !~ /(^|[^a-z0-9_])for[ \t]+update([^a-z0-9_]|$)/) { nolock = 1; continue }
                  print "OK"; exit
                }
                if (found && nolock) { print "no-lock"; exit }
                if (nagg) { print "no-agg"; exit }
                print "no-capture"
              }
            ' "$file")
            case "$CAPTURE_STATUS" in
              OK) ;;
              reassigned*)
                SET_BIND_WHY="'$DIGEST_SET_VAR' is assigned $(printf '%s' "$CAPTURE_STATUS" | cut -f2) times in this migration. The digest, the write and the row-count assertion all name that one variable, so a second assignment means the rows hashed and the rows written need not be the same rows — and this validator cannot tell which assignment reaches which statement. Capture the approved ids once and never write to '$DIGEST_SET_VAR' again; if a second population genuinely needs repairing, that is a second migration." ;;
              no-lock)
                SET_BIND_WHY="'$DIGEST_SET_VAR' is captured without FOR UPDATE, so the approved rows are not locked between the digest and the write and a concurrent change lands unnoticed. Capture them as: SELECT array_agg(s.id ORDER BY s.id) INTO $DIGEST_SET_VAR FROM (SELECT t.id FROM <table> t WHERE <approved predicate> ORDER BY t.id FOR UPDATE) s;" ;;
              no-agg)
                SET_BIND_WHY="'$DIGEST_SET_VAR' is assigned before line $FIRST_REWRITE_LINE but not by an array_agg() capture of the approved ids, so what the digest and the writes are restricted to is not a set this migration read out of the table" ;;
              *)
                SET_BIND_WHY="the digest and the writes are restricted to '$DIGEST_SET_VAR', but nothing before line $FIRST_REWRITE_LINE captures that array from the table — an id set that is not read out of the database approves nothing" ;;
            esac
          fi

          if [ -z "$SET_BIND_WHY" ] && [ "$COMPUTED" -eq 1 ] && [ -n "$DIGEST_SET_VAR" ]; then
            COUNT_STATUS=$(awk -v var="$DIGEST_SET_VAR" -v Q="'" '
              function strip(l,   out, a, b, c, m, p) {
                l = tolower(l)
                out = ""
                while (l != "") {
                  if (instr) { p = index(l, Q); if (p == 0) return out; l = substr(l, p + 1); instr = 0; continue }
                  if (inblk) { p = index(l, "*/"); if (p == 0) return out; l = substr(l, p + 2); inblk = 0; continue }
                  a = index(l, "--"); b = index(l, "/*"); c = index(l, Q)
                  m = 0
                  if (a > 0) m = a
                  if (b > 0 && (m == 0 || b < m)) m = b
                  if (c > 0 && (m == 0 || c < m)) m = c
                  if (m == 0) { out = out l; break }
                  out = out substr(l, 1, m - 1) " "
                  if (m == a) break
                  if (m == b) { inblk = 1; l = substr(l, m + 2); continue }
                  instr = 1; l = substr(l, m + 1)
                }
                return out
              }
              # ---- THE ASSERTION MUST BE A MISMATCH (Codex High, round 13) ---
              # Round 12 accepted any IF that mentioned array_length(<var>) and
              # reached a RAISE, which accepted the inversion:
              #
              #   IF n = array_length(v_ids, 1) THEN RAISE EXCEPTION ...; END IF;
              #
              # That aborts when the write touched exactly the approved rows and
              # succeeds when it touched some other number of them — the guard
              # running backwards. `<`, `>` and `<=` are the same failure in
              # milder form: they leave one direction of drift unasserted.
              #
              # So the condition has to be the canonical single mismatch, read
              # structurally: exactly one of <>, != or IS DISTINCT FROM, nothing
              # else comparing anything, and no boolean or conditional keyword
              # that would make the polarity unreadable. Either operand order is
              # fine (`n <> array_length(...)` or `array_length(...) <> n`).
              #
              # AND IT MUST COMPARE THE COUNT THAT WAS ACTUALLY MEASURED
              # (Codex High, round 14). Round 13 only required that a
              # GET DIAGNOSTICS ... ROW_COUNT existed *somewhere* in the file,
              # never that the value it assigned was the value being tested. So
              #
              #   IF cardinality(v_ids) <> cardinality(v_ids) THEN RAISE ...
              #
              # passed: perfect canonical shape, comparing a thing to itself,
              # asserting nothing. The other side of the mismatch now has to be
              # a variable some GET DIAGNOSTICS <var> = ROW_COUNT assigned, and
              # the assertion has to come after that assignment. Return 1 = the
              # canonical assertion, 2 = right shape but the operands are not
              # tied to a measured count, 0 = wrong operator shape entirely.
              function cond_ok(l, rcre,   c, q, lhs, rhs) {
                c = l
                if (!match(c, /(^|[^a-z0-9_])if([^a-z0-9_]|$)/)) return 0
                c = substr(c, RSTART + RLENGTH)
                q = index(c, "then")
                if (q > 0) c = substr(c, 1, q - 1)
                gsub(/is[ \t]+distinct[ \t]+from/, " @ ", c)
                gsub(/<>/, " @ ", c)
                gsub(/!=/, " @ ", c)
                gsub(/(array_length|cardinality)[ \t]*\([^)]*\)/, " arr ", c)
                if (gsub(/@/, "@", c) != 1) return 0
                if (c ~ /[=<>]/) return 0
                if (c ~ /(^|[^a-z0-9_])(or|and|not|case|when|coalesce|nullif)([^a-z0-9_]|$)/) return 0
                q = index(c, "@")
                lhs = substr(c, 1, q - 1); rhs = substr(c, q + 1)
                gsub(/[^a-z0-9_]/, " ", lhs); gsub(/^[ \t]+|[ \t]+$/, "", lhs)
                gsub(/[^a-z0-9_]/, " ", rhs); gsub(/^[ \t]+|[ \t]+$/, "", rhs)
                if (lhs == "arr" && rhs ~ ("^(" rcre ")$")) return 1
                if (rhs == "arr" && lhs ~ ("^(" rcre ")$")) return 1
                return 2
              }
              { ln[FNR] = strip($0); n = FNR }
              END {
                # Which identifiers actually hold a measured row count, and from
                # which line onward. A line may assign more than one.
                rcre = ""
                for (i = 1; i <= n; i++) {
                  if (ln[i] !~ /get[ \t]+diagnostics/) continue
                  s = ln[i]
                  while (match(s, /get[ \t]+diagnostics[ \t]+(strict[ \t]+)?[a-z0-9_]+[ \t]*:?=[ \t]*row_count/)) {
                    d = substr(s, RSTART, RLENGTH)
                    s = substr(s, RSTART + RLENGTH)
                    sub(/[ \t]*:?=[ \t]*row_count$/, "", d)
                    sub(/.*[ \t]/, "", d)
                    if (!(d in rcln)) { rcln[d] = i; rcre = (rcre == "" ? d : rcre "|" d) }
                  }
                }
                if (rcre == "") { print "no-count"; exit }
                for (i = 1; i <= n; i++) {
                  if (ln[i] !~ /(^|[^a-z0-9_])if([^a-z0-9_]|$)/) continue
                  if (ln[i] !~ ("(array_length|cardinality)[ \t]*\\([ \t]*" var "([^a-z0-9_]|$)")) continue
                  ck = cond_ok(ln[i], rcre)
                  if (ck != 1) { if (ck == 2) operand = 1; else polarity = 1; continue }
                  after = 0
                  for (v in rcln) { if (ln[i] ~ ("(^|[^a-z0-9_])" v "([^a-z0-9_]|$)") && rcln[v] < i) after = 1 }
                  if (!after) { operand = 1; continue }
                  if (ln[i] ~ /raise[ \t]+exception/) { print "OK"; exit }
                  depth = 1
                  for (j = i + 1; j <= n; j++) {
                    # Depth 1 only — same reason as the digest branch above
                    # (Codex High, round 12): a RAISE nested under `IF false`
                    # is not an abort, it is decoration. And the ELSE arm is not
                    # the mismatch arm (round 13), so the walk stops there.
                    if (depth == 1 && ln[j] ~ /(^|[^a-z0-9_])(else|elsif|elseif)([^a-z0-9_]|$)/) break
                    if (depth == 1 && ln[j] ~ /raise[ \t]+exception/) { print "OK"; exit }
                    if (ln[j] ~ /(^|[^a-z0-9_])if([^a-z0-9_]|$)/ && ln[j] !~ /end[ \t]+if/) depth++
                    if (ln[j] ~ /end[ \t]+if/) { depth--; if (depth <= 0) break }
                  }
                }
                if (operand) { print "unbound-count"; exit }
                if (polarity) { print "polarity"; exit }
                print "no-assert"
              }
            ' "$file")
            case "$COUNT_STATUS" in
              OK) ;;
              no-count)
                SET_BIND_WHY="the writes never capture GET DIAGNOSTICS <n> = ROW_COUNT, so a rewrite that silently touched fewer rows than were approved would still report success" ;;
              unbound-count)
                SET_BIND_WHY="the mismatch test against array_length($DIGEST_SET_VAR, 1) does not compare a measured row count — the other side has to be the variable a GET DIAGNOSTICS <n> = ROW_COUNT actually assigned, on an earlier line. Comparing the approved set to itself is the canonical shape asserting nothing" ;;
              polarity)
                SET_BIND_WHY="the row count IS compared against array_length($DIGEST_SET_VAR, 1), but not by a plain mismatch — an = test aborts when the write hit exactly the approved rows and passes when it hit some other number of them, and <, > or a compound condition leaves one direction of drift unasserted. Use the canonical form: IF <n> <> array_length($DIGEST_SET_VAR, 1) THEN RAISE EXCEPTION ...; END IF;" ;;
              *)
                SET_BIND_WHY="the row count is never asserted against the approved set. After the write add: IF <n> <> array_length($DIGEST_SET_VAR, 1) THEN RAISE EXCEPTION ...; END IF;" ;;
            esac
          fi
          done

          if [ "$COMPUTED" -eq 0 ] && [ -n "$DIGEST_SRC_WHY" ]; then
            DIGEST_WHY="the hash assigned to '${DIGEST_VAR}' before line $FIRST_REWRITE_LINE $DIGEST_SRC_WHY — a digest that does not cover the rewritten rows and their before-values authorizes nothing. Required shape: v := encode(digest((SELECT string_agg(t.id::text || ':' || t.<col>::text, ',' ORDER BY t.id) FROM <rewritten table> t WHERE ...), 'sha256'), 'hex')"
          elif [ "$COMPUTED" -eq 0 ]; then
            DIGEST_WHY="the value compared to the digest at line $DIGEST_EXEC_LINE is not one this migration computed — no statement before line $FIRST_REWRITE_LINE assigns a hash (md5/sha256/digest/encode) into '${DIGEST_VAR:-<no identifier>}'"
          elif [ "$RAISE_IN_BRANCH" -eq 0 ]; then
            DIGEST_WHY="the comparison at line $DIGEST_EXEC_LINE does not RAISE EXCEPTION inside its own IF block — a mismatch would not abort"
          elif [ -n "$SET_BIND_WHY" ]; then
            DIGEST_WHY="$SET_BIND_WHY"
          else
            DIGEST_BOUND=1
          fi
        fi
      fi

      if [ "$DIGEST_BOUND" -eq 1 ]; then
        # Bound to an approved-set digest and asserted fail-closed before the
        # write — which is exactly what makes this file a ONE-SHOT repair, not
        # an idempotent schema change. The apply-time replay guard and the
        # replay-plan builder both look a migration up in
        # supabase/baselines/one-shot-migrations.json and act only on what they
        # find there, so an unregistered repair is contained by nothing: a
        # replay onto a restored or drifted database hands it straight through.
        # The digest does not cover that case — it binds the rows approved when
        # it was written, and after a restore those are different rows wearing
        # the same ids. Registration is the containment, so require it here
        # rather than trusting the author to remember.
        ONE_SHOT_REGISTRY="$(dirname "$MIGRATION_DIR")/baselines/one-shot-migrations.json"
        MIG_STEM="${MIG_BASENAME%.sql}"
        if [ ! -f "$ONE_SHOT_REGISTRY" ]; then
          echo "VIOLATION: $file"
          echo "  Approved-set repair with no one-shot registry to contain it."
          echo "  Expected: $ONE_SHOT_REGISTRY"
          echo ""
          VIOLATIONS=$((VIOLATIONS + 1))
        elif ! grep -qE "^[[:space:]]*\"${MIG_STEM}\"[[:space:]]*:" "$ONE_SHOT_REGISTRY"; then
          echo "VIOLATION: $file"
          echo "  Approved-set repair is not registered as one-shot."
          echo "  Add \"$MIG_STEM\" to the one_shot map in:"
          echo "    ${ONE_SHOT_REGISTRY#./}"
          echo "  with one line saying which population it was approved against."
          echo "  Until it is there, list-post-baseline-migrations.mjs will put it"
          echo "  in a replay plan and the apply-time one-shot guard will not"
          echo "  recognise it, so it can rewrite a restored population that never"
          echo "  approved it."
          echo ""
          VIOLATIONS=$((VIOLATIONS + 1))
        fi
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
        while IFS=$'\t' read -r r_ln r_tbl r_kind r_cols r_var r_raw; do
          [ -z "$r_tbl" ] && continue
          if ! echo "$OPT_OUT" | grep -qiE "(^|[^a-z0-9_])${r_tbl}([^a-z0-9_]|$)"; then
            case " $MISSING_TBL " in
              *" $r_tbl "*) ;;
              *) MISSING_TBL="$MISSING_TBL $r_tbl" ;;
            esac
            continue
          fi
          if [ -z "$r_cols" ] || [ "$r_cols" = "-" ]; then
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
        printf '%s\n' "$REWRITES" | awk -F'\t' '{ printf "    line %s (%s): %s\n", $1, $3, $6 }'
        # Covers both shapes: a digest that is present but not enforced, and a
        # rewrite this path refuses to bind at all (several tables in one file,
        # or a DELETE with no material before-values to hash).
        [ -n "$DIGEST_WHY" ] && echo "  Not bound to an approved set: $DIGEST_WHY"
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
