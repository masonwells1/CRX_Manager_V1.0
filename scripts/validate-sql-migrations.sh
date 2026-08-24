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

# ---------------------------------------------------------------------------
# HASH-PINNED VIOLATION EXEMPTIONS (Codex Medium, round 24)
# ---------------------------------------------------------------------------
# --max-violations is an AGGREGATE allowance, and an aggregate is a pool. When
# a new check starts firing on old migrations nobody may edit, the obvious move
# is to raise the number — and that hands the corpus N free slots. If one of
# the old findings is later fixed, its slot does not close; a genuinely new
# violation can take it and CI stays green.
#
# So an acknowledged finding is pinned instead: <sha256>  <basename>  <count>.
# The exemption applies only while that file's bytes still hash to the recorded
# value, and only up to `count` violations in that one file. Edit the file and
# the exemption is void. A different file cannot use it. A tenth violation in a
# file allowed nine still counts. And when a pinned file stops violating, the
# audit says so, so the row can be removed rather than lingering as headroom.
#
# Hashes are computed over CR-stripped bytes, exactly like the grandfather
# manifest, so a CRLF checkout on Windows and an LF checkout on Linux agree.
#
# A missing or unreadable manifest means NO exemptions — the failure direction
# is more violations, not fewer, so there is nothing to fail closed against.
SQL_AUDIT_EXEMPTIONS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sql-audit-hash-exemptions.txt"

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
UNSUPPORTED_ROUTINE_SCANNER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/find-unsupported-routine-identities.mjs"

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

# ---- EVERY WRITE TARGET MUST RESOLVE (Codex High, round 21) ----------------
# The scan above only ever emitted a rewrite when the target was a PROTECTED
# table, so an unrecognized target was silently nothing. PostgreSQL will happily
# write business rows through a name this list has never heard of: create an
# automatically updatable view over order_items, update through the view, and
# the underlying rows change while the scanner sees an unregistered name and
# asks for no digest at all. Renaming the migration evades the apply-time guard
# the same way.
#
# So resolution is now mandatory, and it needs the FULL registry — the protected
# list has the exempt tables subtracted out of it, and a write to a queue or a
# watchdog table is legitimately unbound, not unresolved.
REGISTRY_TABLES=$(node -e "
const fs = require('fs');
const reg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const tables = Object.keys(reg.columns || {}).filter((n) => /^[a-z0-9_]+\$/.test(n)).sort();
if (tables.length < 100) {
  throw new Error('schema registry yielded only ' + tables.length + ' known tables');
}
process.stdout.write(tables.join('|'));
" "$APPROVED_SET_REGISTRY" 2>/dev/null || true)

# Fail closed. A guessed or empty list would turn the approved-set binding check
# into a silent no-op — exactly the failure mode this replaced.
if [ -z "$BUSINESS_ROW_TABLES" ] || [ -z "$REGISTRY_TABLES" ]; then
  echo "❌ FATAL: could not derive the protected table set from $APPROVED_SET_REGISTRY"
  echo "   (needs a readable registry with a 'columns' map of at least 100 tables, and node on PATH)."
  echo "   The approved-set binding check is default-deny and must not run on a partial list."
  exit 1
fi

# ---- A TRIGGER REWRITE IS STILL A REWRITE (Codex High, round 31) -----------
# Everything above proves that a repair rewrote exactly the rows it hashed — for
# the table named in the UPDATE. Triggers were invisible to it, so:
#
#   UPDATE public.order_items SET total_price = 0 WHERE id = ANY(v_ids);
#
# read as fully bound while `trg_recalc_order_totals` fired underneath and
# rewrote public.orders. Those order rows were never captured, never hashed, and
# are not counted by the ROW_COUNT assertion: an approved repair on a child
# table silently rewrote authoritative money on its parent with no proof at all.
#
# A text scanner cannot know the live trigger graph, so the graph is checked in
# (scripts/trigger-fanout.json, written by scripts/generate-trigger-fanout.mjs
# from the live catalog) and each cascade target is folded into the set of
# tables the repair has to bind. UPDATE/DELETE/MERGE only: an INSERT creates
# rows that did not exist when the digest was taken, so no before-state digest
# could have covered them.
#
# Resolved relative to THIS SCRIPT for the same reason the registry is.
TRIGGER_FANOUT_MANIFEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/trigger-fanout.json"

# One node call, three sections, so a missing or unparseable manifest leaves all
# three empty at once and the per-table check below treats every table as
# unscanned. Prefixes are colon-delimited because a bare identifier cannot hold
# a colon.
TRIGGER_FANOUT_RAW=$(node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const registry = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ok = (n) => typeof n === 'string' && /^[a-z0-9_]+\$/.test(n);
const sourceOk = (n) => typeof n === 'string' && /^[a-z0-9_]+(?:\.[a-z0-9_]+)?\$/.test(n);
if (!m._meta || m._meta.format_version !== 6 ||
    m._meta.generator !== 'scripts/generate-trigger-fanout.mjs' ||
    m._meta.capture_method !== 'supabase-cli-db-query-linked' ||
    m._meta.source_project !== 'rhyzpcqhnizqbxphqdkr' ||
    m._meta.bootstrap_policy !== 'all-captured-sources-opaque-until-independent-attestation' ||
    typeof m._meta.captured_at !== 'string' || !Number.isFinite(Date.parse(m._meta.captured_at))) {
  throw new Error('trigger fan-out manifest has no verified linked-production provenance');
}
const scanned = (m.tables_scanned || []).filter(ok);
if (scanned.length < 100) {
  throw new Error('trigger fan-out manifest scanned only ' + scanned.length + ' tables');
}
const registryTables = Object.keys(registry.columns || {}).filter(ok).sort();
const scannedSorted = [...new Set(scanned)].sort();
if (JSON.stringify(scannedSorted) !== JSON.stringify(registryTables)) {
  throw new Error('trigger fan-out source universe does not equal the schema registry');
}
const sourceNames = Object.keys(m.fanout || {});
if (sourceNames.some((name) => !sourceOk(name))) {
  throw new Error('trigger fan-out has an invalid source relation');
}
const capturedSources = new Set([...scanned, ...sourceNames]);
const opaque = m.opaque_on_tables || [];
if (!Array.isArray(opaque) ||
    opaque.some((name) => !sourceOk(name) || !capturedSources.has(name))) {
  throw new Error('trigger fan-out opacity names a source outside the captured universe');
}
if (!m.reachable_routines || typeof m.reachable_routines !== 'object' ||
    Array.isArray(m.reachable_routines) || !m.routine_hashes ||
    typeof m.routine_hashes !== 'object' || Array.isArray(m.routine_hashes)) {
  throw new Error('trigger fan-out manifest has no routine dependency binding');
}
for (const [src, names] of Object.entries(m.reachable_routines)) {
  if (!sourceOk(src) || !capturedSources.has(src) || !Array.isArray(names) || names.length === 0) {
    throw new Error('trigger fan-out manifest has an invalid routine dependency source');
  }
  for (const name of names) {
    if (!ok(name) || typeof m.routine_hashes[name] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(m.routine_hashes[name])) {
      throw new Error('trigger fan-out manifest has an invalid routine dependency hash');
    }
  }
}
if (!Array.isArray(m.event_triggers)) {
  throw new Error('trigger fan-out manifest has no event-trigger state');
}
for (const trigger of m.event_triggers) {
  const keys = Object.keys(trigger || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    'effect', 'enabled', 'enabled_mode', 'event', 'has_sql_body', 'language', 'name',
    'routine_config', 'routine_hash', 'routine_name', 'routine_oid', 'routine_schema',
  ]) || typeof trigger.enabled !== 'boolean' ||
      typeof trigger.enabled_mode !== 'string' || !/^[ODRA]$/.test(trigger.enabled_mode) ||
      trigger.enabled !== (trigger.enabled_mode !== 'D') ||
      !ok(trigger.name) || !ok(trigger.event) || !ok(trigger.routine_name) ||
      !ok(trigger.routine_schema) || !ok(trigger.language) ||
      !Array.isArray(trigger.routine_config) ||
      trigger.routine_config.some((entry) => typeof entry !== 'string' || /[\r\n\0]/.test(entry)) ||
      typeof trigger.routine_oid !== 'string' || !/^\d+$/.test(trigger.routine_oid) ||
      typeof trigger.has_sql_body !== 'boolean' ||
      !trigger.effect || typeof trigger.effect !== 'object' || Array.isArray(trigger.effect) ||
      JSON.stringify(Object.keys(trigger.effect).sort()) !== JSON.stringify([
        'dynamic_write_count', 'safe', 'session_catalog_required', 'tables', 'targets',
        'unknown_calls', 'unresolved', 'unsupported_routine_identity',
      ]) || typeof trigger.effect.safe !== 'boolean' ||
      typeof trigger.effect.session_catalog_required !== 'boolean' ||
      typeof trigger.effect.unresolved !== 'boolean' ||
      typeof trigger.effect.unsupported_routine_identity !== 'boolean' ||
      !Number.isInteger(trigger.effect.dynamic_write_count) || trigger.effect.dynamic_write_count < 0 ||
      !Array.isArray(trigger.effect.unknown_calls) || !Array.isArray(trigger.effect.targets) ||
      !Array.isArray(trigger.effect.tables) ||
      trigger.effect.safe !== (!trigger.effect.session_catalog_required &&
        !trigger.effect.unresolved &&
        !trigger.effect.unsupported_routine_identity && trigger.effect.dynamic_write_count === 0 &&
        trigger.effect.unknown_calls.length === 0 && trigger.effect.targets.length === 0 &&
        trigger.effect.tables.length === 0) ||
      typeof trigger.routine_hash !== 'string' || !/^[0-9a-f]{64}$/.test(trigger.routine_hash)) {
    throw new Error('trigger fan-out manifest has invalid event-trigger evidence');
  }
}
if (!Array.isArray(m.rules)) {
  throw new Error('trigger fan-out manifest has no rewrite-rule state');
}
if (!Array.isArray(m.check_constraints)) {
  throw new Error('trigger fan-out manifest has no persisted CHECK-routine state');
}
for (const constraint of m.check_constraints) {
  const keys = Object.keys(constraint || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    'definition_hash', 'name', 'oid', 'relation', 'routine_name', 'routine_oid',
    'routine_schema',
  ]) || typeof constraint.oid !== 'string' || !/^\d+$/.test(constraint.oid) ||
      typeof constraint.routine_oid !== 'string' || !/^\d+$/.test(constraint.routine_oid) ||
      typeof constraint.name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(constraint.name) ||
      !ok(constraint.relation) || !capturedSources.has(constraint.relation) ||
      !ok(constraint.routine_schema) || !ok(constraint.routine_name) ||
      typeof constraint.definition_hash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(constraint.definition_hash)) {
    throw new Error('trigger fan-out manifest has invalid persisted CHECK-routine evidence');
  }
}
for (const rule of m.rules) {
  const keys = Object.keys(rule || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    'definition_hash', 'event', 'name', 'oid', 'relation',
  ]) || typeof rule.oid !== 'string' || !/^\d+$/.test(rule.oid) ||
      typeof rule.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(rule.name) ||
      !sourceOk(rule.relation) || !/^(select|insert|update|delete)$/.test(rule.event) ||
      typeof rule.definition_hash !== 'string' || !/^[0-9a-f]{64}$/.test(rule.definition_hash)) {
    throw new Error('trigger fan-out manifest has invalid rewrite-rule evidence');
  }
}
const out = [];
out.push('v:event-state');
for (const trigger of m.event_triggers) {
  if (!trigger.enabled || trigger.effect.safe) continue;
  const noWriteProof = !trigger.effect.unresolved &&
    !trigger.effect.unsupported_routine_identity && trigger.effect.dynamic_write_count === 0 &&
    trigger.effect.unknown_calls.length === 0 && trigger.effect.targets.length === 0 &&
    trigger.effect.tables.length === 0;
  if (trigger.effect.session_catalog_required && noWriteProof) out.push('c:' + trigger.name);
  else out.push('g:' + trigger.name);
}
for (const n of capturedSources) out.push('s:' + n);
for (const n of opaque) out.push('o:' + n);
for (const constraint of m.check_constraints) out.push('o:' + constraint.relation);
for (const rule of m.rules) out.push('q:' + rule.event + ' ' + rule.relation);
for (const [src, rows] of Object.entries(m.fanout || {})) {
  if (!sourceOk(src)) continue;
  for (const r of rows || []) {
    if (ok(r && r.target) && ok(r && r.via)) out.push('e:' + src + ' ' + r.target + ' ' + r.via);
  }
}
process.stdout.write(out.join('\n'));
" "$TRIGGER_FANOUT_MANIFEST" "$APPROVED_SET_REGISTRY" 2>/dev/null || true)

TRIGGER_FANOUT_SCANNED=$(printf '%s\n' "$TRIGGER_FANOUT_RAW" | sed -n 's/^s://p')
TRIGGER_FANOUT_OPAQUE=$(printf '%s\n' "$TRIGGER_FANOUT_RAW" | sed -n 's/^o://p')
TRIGGER_FANOUT_PAIRS=$(printf '%s\n' "$TRIGGER_FANOUT_RAW" | sed -n 's/^e://p')
TRIGGER_FANOUT_EVENT_STATE=$(printf '%s\n' "$TRIGGER_FANOUT_RAW" | sed -n 's/^v://p')
TRIGGER_FANOUT_ENABLED_EVENTS=$(printf '%s\n' "$TRIGGER_FANOUT_RAW" | sed -n 's/^g://p')
TRIGGER_FANOUT_SESSION_EVENTS=$(printf '%s\n' "$TRIGGER_FANOUT_RAW" | sed -n 's/^c://p')
TRIGGER_FANOUT_RULES=$(printf '%s\n' "$TRIGGER_FANOUT_RAW" | sed -n 's/^q://p' | tr '\n' '|')
TRIGGER_FANOUT_SOURCES_PADDED="|$(printf '%s\n' "$TRIGGER_FANOUT_SCANNED" | tr '\n' '|')"

# Event triggers fire database-wide on DDL, with no relation to use as a fan-out
# source. Missing state and any enabled live entry whose bound routine lacks a
# complete no-write proof are therefore global violations, not per-table
# warnings. Local CREATE/ALTER/DROP EVENT TRIGGER DDL is separately reported
# through the shared analyzer below.
if [ "$TRIGGER_FANOUT_EVENT_STATE" != "event-state" ]; then
  echo "VIOLATION: $TRIGGER_FANOUT_MANIFEST"
  echo "  Linked event-trigger evidence is missing or unreadable; DDL effects are unknown."
  echo ""
  VIOLATIONS=$((VIOLATIONS + 1))
elif [ -n "$TRIGGER_FANOUT_ENABLED_EVENTS" ]; then
  echo "VIOLATION: $TRIGGER_FANOUT_MANIFEST"
  echo "  Enabled PostgreSQL event trigger(s) make migration DDL effects unbounded: $(printf '%s' "$TRIGGER_FANOUT_ENABLED_EVENTS" | tr '\n' ' ')"
  echo "  Disable/remove them through a separately reviewed path and regenerate the linked manifest."
  echo ""
  VIOLATIONS=$((VIOLATIONS + 1))
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
# "Material" is what makes this row THIS row: the state it is in, the money it
# carries, the lifecycle timestamps that record an irreversible transition, and
# — since round 20 — who owns it and what it hangs off. Notification
# bookkeeping (`*_sent_at`, reminder stamps) is excluded: it moves on its own
# without the row meaning anything different, and requiring it would push
# authors toward the opt-out for no safety gained.
MATERIAL_COLS_MAP=$(node -e "
const fs = require('fs');
const reg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const cols = reg.columns || {};
const LIFECYCLE_AT = /^[a-z0-9_]*(deleted|voided|paid|posted|invoiced|delivered|completed|cancelled|canceled|approved|finalized|refunded|closed|applied|archived|shipped|received|fulfilled|reconciled|settled|locked|signed)_at\$/;
// Money concepts can occur inside compound names, not only at the end:
// total_margin_pct, price_per_unit and net_margin are authoritative values too.
// Match complete underscore-delimited tokens so pricing_status does not turn
// into a false price hit.
const MONEY = /(^|_)(cents|price|cost|profit|amount|balance|total|subtotal|rate|margin)(_|\$)/;
// Quantity matches anywhere in the name, not only at the end: the inventory
// columns are quantity_on_hand / quantity_available, and a stock level is as
// material to a deletion as a dollar figure is.
const QUANTITY = /(^|_)(qty|quantity)(_|\$)/;
const LIFECYCLE = /(^|_)(status|state|stage|phase)\$/;
// ---- OWNERSHIP AND PARENT IDENTITY (Codex High, round 20) ------------------
// Lifecycle and money describe what STATE a row is in; they say nothing about
// WHOSE row it is or WHAT it hangs off. Codex broke round 19 on exactly that
// gap: an approved-set digest over orders.id + total_profit still matched after
// the order was reassigned to a different customer or re-parented to a
// different quote, so a stale approval could rewrite authoritative money on a
// row that was no longer the row anyone approved. Every reference column is
// therefore material — the owning party (customer_id, salesman_id,
// recipient_user_id) and the parent identifiers Codex named for DELETE
// coverage (order_id, invoice_id, product_id) alike. \`id\` itself is excluded
// because the coverage check already requires it separately.
const REFERENCE = (c) => c !== 'id' && /_id\$/.test(c);
// The by-whom columns that carry no \`_id\` suffix.
const ACTOR = /^(created_by|updated_by|deleted_by|voided_by|approved_by|posted_by|performed_by|assigned_to|owner|recipient)\$/;
// ---- LIFECYCLE BOOLEANS AND ROW VERSIONS (Codex High, round 21) ------------
// Round 20 read lifecycle as a status word or a transition timestamp. Half the
// lifecycle in this schema is neither: a customer is switched off with
// \`is_active\`, finance charges are turned on with \`finance_charge_enabled\`, and
// a service is retired the same way. An approval to rewrite a service rate or a
// credit limit therefore survived the entity being deactivated — the digest
// covered none of it. A boolean that says whether the row is live IS its state.
// Concurrency stamps come along for the same reason: \`row_version\` exists
// precisely so a writer can tell that someone else got there first, and a
// before-state digest that ignores it is throwing away the one column designed
// to catch exactly this.
const LIFECYCLE_BOOL = /^(is|has|was|are|can)_[a-z0-9_]+\$/;
const LIFECYCLE_FLAG = /(^|_)(active|enabled|disabled|archived|locked|hidden|published|confirmed|verified|suspended|blocked|void|voided|closed|approved|billable|taxable)\$/;
const VERSION = /(^|_)(version|revision)\$/;
const material = (c) => LIFECYCLE.test(c) || MONEY.test(c) || QUANTITY.test(c) || LIFECYCLE_AT.test(c) || REFERENCE(c) || ACTOR.test(c) ||
  LIFECYCLE_BOOL.test(c) || LIFECYCLE_FLAG.test(c) || VERSION.test(c);
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

# The scanners below deliberately operate on shell word lists for speed across
# the historical corpus. Migration names are operational identifiers, not
# prose: accept only the repository's ASCII basename convention before any list
# is expanded. This excludes whitespace AND Git C-quote triggers such as quotes,
# backslashes, control bytes, and non-ASCII characters. Without this rule,
# `git diff --name-only` can print a quoted display spelling which fails `-f`,
# silently dropping a changed migration from the zero-tolerance scan.
migration_name_is_safe() {
  local base_name=${1##*/}
  [[ "$base_name" =~ ^[0-9]{8}([0-9]{6})?_[A-Za-z0-9_-]+\.sql$ ]]
}

report_unsafe_migration_name() {
  echo "VIOLATION: $1"
  echo "  Unsafe migration filename: whitespace is not allowed, and names must match <8-or-14-digit timestamp>_<ASCII letters, digits, underscores, or hyphens>.sql."
  echo ""
}

UNSAFE_MIGRATION_NAME=false
while IFS= read -r -d '' candidate; do
  if ! migration_name_is_safe "$candidate"; then
    report_unsafe_migration_name "$candidate"
    UNSAFE_MIGRATION_NAME=true
  fi
done < <(find "$MIGRATION_DIR" -name '*.sql' -type f -print0 2>/dev/null)
if [ "$UNSAFE_MIGRATION_NAME" = true ]; then exit 1; fi

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
#
# ROUND 30 (Codex High). The index was not TRANSITIVE. It asked only whether a
# body spells DML on a protected table, so one level of indirection walked past
# it untouched:
#
#   -- migration A
#   CREATE FUNCTION _mutate() ... AS $x$ BEGIN UPDATE public.orders ...; END $x$;
#   CREATE FUNCTION _wrap()   ... AS $y$ BEGIN PERFORM _mutate();     END $y$;
#   -- migration B
#   SELECT _wrap();
#
# `_mutate` was indexed and `_wrap` was not, so B's call was read as a call to
# an ordinary read-only helper and no approved-set digest was ever demanded —
# while PostgreSQL performed the whole protected rewrite. Any depth of wrapping
# worked, and the wrapper did not even have to live in the same migration.
#
# The index is therefore closed transitively: a function that calls a mutating
# function IS a mutating function. The closure runs over the union of records
# from every awk process rather than inside one, because `xargs` may split the
# migration list across several — a closure computed per batch would silently
# lose every edge whose two ends landed in different batches, which is the same
# failure this fix exists to remove.
# ---- ONE LEXER, SHARED (round 31, Codex High) -------------------------------
# `strip_noise` lived inside the primary scanner and the mutating-function index
# had its OWN, cruder copy: `sub(/--.*/)`, blank quoted literals, and no block
# comment handling whatever. That is the exact naive sequence the comment on the
# scanner's version says not to write, reintroduced twenty lines away.
#
# It was not merely imprecise. The index tracks a function body by DOLLAR QUOTE,
# so a `$x$` sitting inside a block comment was read as a live opening tag:
#
#   /* CREATE FUNCTION fake() RETURNS void LANGUAGE plpgsql AS $x$ */
#   CREATE FUNCTION public._real() ... AS $f$ BEGIN UPDATE public.orders ...; END $f$;
#   SELECT public._real();
#
# The commented-out decoy claimed the body, `_real` never entered the index, and
# its call at the bottom read as an ordinary call to a read-only helper — so a
# rewrite of a protected table was demanded of no digest at all. Two lexers is
# the defect; one is the fix. Defined here as a shell variable and interpolated
# into both awk programs, because awk has no include and a second copy is how
# this happened the first time.
AWK_STRIP_NOISE=$(cat <<'AWK_SN'
      # Comments and literals are not three independent removals, and running
      # them in sequence got the interleaving wrong in both directions. Block
      # comments came out first, so `-- see /* note` opened a block comment that
      # no `*/` ever closed and every following line was blanked — a fail-OPEN
      # in the primary money scanner, hiding whatever rewrite came next. A `/*`
      # inside a string literal did the same. Read left to right instead, once,
      # and let whichever construct opens first own the text until it closes.
      #
      # Callers must clear inblk/instr/estr at FNR == 1: an unterminated
      # construct at the end of one file must not blank the start of the next.
      function strip_noise(s,   out, i, c, d, n, p, q) {
        out = ""; i = 1; n = length(s)
        while (i <= n) {
          c = substr(s, i, 1)
          d = substr(s, i, 2)
          if (inblk > 0) {
            if (d == "/*") { inblk++; i += 2; continue }
            if (d == "*/") { inblk--; i += 2; continue }
            i++; continue
          }
          if (instr) {
            # `it''s` is one literal, not two. Reading the doubled quote
            # as a close would put the rest of the literal back into the syntax
            # stream, which is how a quoted UPDATE becomes a real one.
            if (c == "'" && substr(s, i + 1, 1) == "'") { i += 2; continue }
            # A backslash escapes the next character only in an E-string.
            # Elsewhere PostgreSQL treats it as an ordinary character, and
            # skipping it would eat the closing quote of a Windows path.
            if (c == "\\" && estr) { i += 2; continue }
            if (c == "'") { instr = 0; estr = 0 }
            i++; continue
          }
          if (inident) {
            # A quoted identifier is syntax, but its contents are not comment
            # delimiters. Canonicalize punctuation so public."--now" remains
            # one callable identifier instead of truncating the line at `--`.
            if (c == "\"" && substr(s, i + 1, 1) == "\"") {
              out = out "_"; i += 2; continue
            }
            if (c == "\"") { inident = 0; i++; continue }
            out = out (c == "$" ? "_dollar_" : (c ~ /[a-z0-9_]/ ? c : "_"))
            i++; continue
          }
          if (d == "/*") { inblk++; i += 2; out = out " "; continue }
          if (d == "--") break
          if (c == "'") {
            p = substr(out, length(out), 1)
            q = (length(out) > 1 ? substr(out, length(out) - 1, 1) : " ")
            estr = (p == "e" && q !~ /[a-z0-9_]/)
            instr = 1; out = out " "; i++; continue
          }
          if (c == "\"") { inident = 1; i++; continue }
          if (c == "$") {
            # Preserve dollar-quote delimiters for the routine-body extent
            # tracker, but canonicalize every other dollar sign as part of an
            # identifier. This keeps unquoted foo$bar paired with its call while
            # leaving $body$ ... $body$ parseable.
            tail = substr(s, i)
            p = substr(out, length(out), 1)
            if (p !~ /[a-z0-9_]/ && match(tail, /^\$[a-z0-9_]*\$/)) {
              out = out substr(tail, 1, RLENGTH); i += RLENGTH; continue
            }
            out = out "_dollar_"; i++; continue
          }
          out = out c; i++
        }
        return out
      }
      # Preserve PostgreSQL operator runs as safe identifier-shaped tokens.
      # A custom operator dispatches to a routine without ever spelling
      # `routine_name(...)`; dropping punctuation from the token stream made
      # that invocation invisible. A lone `=` stays `=` because the approved-
      # set parser uses it for assignments and comparisons.
      function op_char_name(c) {
        if (c == "+") return "plus"; if (c == "-") return "minus"
        if (c == "*") return "star"; if (c == "/") return "slash"
        if (c == "<") return "lt"; if (c == ">") return "gt"
        if (c == "=") return "eq"; if (c == "~") return "tilde"
        if (c == "!") return "bang"; if (c == "@") return "at"
        if (c == "#") return "hash"; if (c == "%") return "pct"
        if (c == "^") return "caret"; if (c == "&") return "amp"
        if (c == "|") return "pipe"; if (c == "`") return "tick"
        if (c == "?") return "q"
        return "unknown"
      }
      function encode_operator_run(run,   out, i) {
        out = "crxop"
        for (i = 1; i <= length(run); i++) out = out "_" op_char_name(substr(run, i, 1))
        return out
      }
      function protect_operators(s,   out, i, j, c, run, chars) {
        out = ""; i = 1; chars = "+-*/<>=~!@#%^&|`?"
        while (i <= length(s)) {
          c = substr(s, i, 1)
          if (index(chars, c) == 0) { out = out c; i++; continue }
          run = c; j = i + 1
          while (j <= length(s) && index(chars, substr(s, j, 1)) > 0) {
            run = run substr(s, j, 1); j++
          }
          out = out (run == "=" ? " = " : " " encode_operator_run(run) " ")
          i = j
        }
        return out
      }
AWK_SN
)

CUSTOM_OPERATORS_RE=""
CUSTOM_OPERATORS_BUILT=false
build_custom_operator_index() {
  if [ "$CUSTOM_OPERATORS_BUILT" = true ]; then return 0; fi
  CUSTOM_OPERATORS_BUILT=true
  CUSTOM_OPERATORS_RE=$(find "$MIGRATION_DIR" -name '*.sql' -type f -print0 \
    | xargs -0 awk '
        '"$AWK_STRIP_NOISE"'
        FNR == 1 { inblk = 0; instr = 0; estr = 0; inident = 0; saw_create = 0; want_operator = 0 }
        {
          line = protect_operators(strip_noise(tolower($0)))
          gsub(/;/, " ; ", line)
          gsub(/[^a-z0-9_.$;=]+/, " ", line)
          n = split(line, part, / +/)
          for (i = 1; i <= n; i++) {
            token = part[i]; if (token == "") continue
            if (token == ";") { saw_create = 0; want_operator = 0; continue }
            if (token == "create") { saw_create = 1; continue }
            if (saw_create && token == "operator") { want_operator = 1; continue }
            if (want_operator && token ~ /^crxop_/) {
              print token; saw_create = 0; want_operator = 0
            }
          }
        }
      ' 2>/dev/null | sort -u | tr '\n' '|' | sed 's/|$//')
  return 0
}

CUSTOM_CAST_TARGETS_RE=""
CUSTOM_COERCIVE_CASTS=false
CUSTOM_CASTS_BUILT=false
build_custom_cast_index() {
  if [ "$CUSTOM_CASTS_BUILT" = true ]; then return 0; fi
  CUSTOM_CASTS_BUILT=true
  local cast_index
  cast_index=$(find "$MIGRATION_DIR" -name '*.sql' -type f -print0 \
    | xargs -0 awk '
        '"$AWK_STRIP_NOISE"'
        function inspect_cast(s,   flat,n,p,i,target,context,iscast,isdomain) {
          iscast = (s ~ /create[ \t]+cast[ \t]*\(/)
          isdomain = (s ~ /create[ \t]+domain[ \t]+/)
          if (!iscast && !isdomain) return
          flat = s
          gsub(/"/, "", flat)
          gsub(/[ \t]*\.[ \t]*/, ".", flat)
          gsub(/[(),]/, " ", flat)
          n = split(flat, p, /[ \t\r\n]+/)
          target = ""
          if (isdomain) {
            for (i = 1; i < n; i++) {
              if (p[i] == "domain") {
                target = p[i + 1]
                if (target == "if" && p[i + 2] == "not" && p[i + 3] == "exists") target = p[i + 4]
                break
              }
            }
            if (target == "") return
            sub(/^.*\./, "", target)
            print target "\tdomain"
            return
          }
          if (!iscast) return
          for (i = 1; i < n; i++) {
            if (p[i] == "as") { target = p[i + 1]; break }
          }
          if (target == "") return
          sub(/^.*\./, "", target)
          context = (flat ~ /as[ \t]+(implicit|assignment)([ \t;]|$)/ ? "coercive" : "explicit")
          print target "\t" context
        }
        FNR == 1 {
          if (NR > 1) inspect_cast(stmt)
          inblk = 0; instr = 0; estr = 0; inident = 0; stmt = ""
        }
        {
          line = strip_noise(tolower($0))
          stmt = stmt " " line
          while (index(stmt, ";") > 0) {
            semi = index(stmt, ";")
            inspect_cast(substr(stmt, 1, semi))
            stmt = substr(stmt, semi + 1)
          }
        }
        END { inspect_cast(stmt) }
      ' 2>/dev/null | sort -u)
  CUSTOM_CAST_TARGETS_RE=$(printf '%s\n' "$cast_index" \
    | awk -F '\t' '$1 != "" { print $1 }' | sort -u | tr '\n' '|' | sed 's/|$//')
  if printf '%s\n' "$cast_index" | awk -F '\t' '$2 == "coercive" { found=1 } END { exit(found ? 0 : 1) }'; then
    CUSTOM_COERCIVE_CASTS=true
  fi
  return 0
}

MUTATING_FNS_RE=""
MUTATING_FNS_BUILT=false
build_mutating_fn_index() {
  if [ "$MUTATING_FNS_BUILT" = true ]; then return 0; fi
  MUTATING_FNS_BUILT=true
  build_custom_operator_index
  build_custom_cast_index
  if [ "$CUSTOM_COERCIVE_CASTS" = true ]; then
    echo "VIOLATION: custom PostgreSQL cast catalog" >&2
    echo "  AS IMPLICIT/AS ASSIGNMENT custom casts require live type resolution and are refused fail-closed." >&2
    echo "" >&2
    return 1
  fi
  MUTATING_FNS_RE=$(find "$MIGRATION_DIR" -name '*.sql' -type f -print0 \
    | xargs -0 awk -v tables="$BUSINESS_ROW_TABLES" -v customops="$CUSTOM_OPERATORS_RE" \
        -v customcasts="$CUSTOM_CAST_TARGETS_RE" '
        '"$AWK_STRIP_NOISE"'
        # Per-file reset: an unterminated body — or an unterminated block comment
        # or string literal — must not leak into the next file.
        FNR == 1 { infn = 0; curfn = ""; tag = ""; inblk = 0; instr = 0; estr = 0; inident = 0 }
        {
          l = strip_noise(tolower($0))
          gsub(/"/, "", l)
          # ROUND 31 (Codex High). `CREATE FUNCTION public . _fix()` is legal, and
          # the name was extracted by truncating at the first character outside
          # [a-z0-9_.] — which is the space. The function was therefore indexed
          # under the name `public`, `_fix` never entered the index at all, and
          # its call read as a call to an ordinary read-only helper while it
          # rewrote a protected table. The body already gets this treatment
          # further down; the NAME did not. Weld qualified names back together
          # before anything reads one, so both halves see the same spelling.
          gsub(/[ \t]*\.[ \t]*/, ".", l)
          if (!infn) {
            if (l !~ /create[ \t]+(or[ \t]+replace[ \t]+)?(function|procedure)[ \t]/) next
            f = l
            sub(/^.*create[ \t]+(or[ \t]+replace[ \t]+)?(function|procedure)[ \t]+/, "", f)
            sub(/[^a-z0-9_.$].*$/, "", f)
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
            # ROUND 30. Records, not verdicts. `F` names a routine this batch
            # defines, `M` one whose own body mutates, `C` a call edge. The
            # transitive closure runs downstream over every batch at once.
            print "F\t" f
            # `UPDATE public . orders` is legal, and the body arrives here with
            # its newlines already flattened to spaces, so a qualification split
            # by either would not match `(public\.)?` and the helper would look
            # read-only. Close the gap the same way the top-level scanner does:
            # weld the pieces of a qualified name back together first.
            b = buf[f]
            gsub(/[ \t]*\.[ \t]*/, ".", b)
            # A custom operator call is a routine dispatch written as
            # punctuation. Treat a function body that uses any operator this
            # migration corpus defines as mutating/opaque; the ordinary reverse
            # call-graph closure below then propagates that classification
            # through wrappers to any top-level call.
            if (customops != "") {
              ob = protect_operators(b)
              gsub(/[^a-z0-9_]+/, " ", ob)
              nop = split(ob, optok, / +/)
              for (oi = 1; oi <= nop; oi++) {
                if (optok[oi] ~ ("^(" customops ")$")) { print "M\t" f; break }
              }
            }
            # A custom cast is also hidden routine dispatch. If a function body
            # casts to any target this migration corpus defines, classify the
            # body as mutating/opaque and let the reverse call graph propagate
            # that result through wrappers.
            if (customcasts != "") {
              cb = b
              gsub(/::[ \t]*/, " crxcast_to ", cb)
              gsub(/[^a-z0-9_.$]+/, " ", cb)
              nc = split(cb, ctok, / +/)
              for (ci = 1; ci <= nc; ci++) {
                ctarget = ""
                if (ctok[ci] == "crxcast_to") ctarget = ctok[ci + 1]
                else if (ctok[ci] == "cast") {
                  for (cj = ci + 1; cj <= nc && cj <= ci + 40; cj++) {
                    if (ctok[cj] == "as") { ctarget = ctok[cj + 1]; break }
                  }
                }
                sub(/^.*\./, "", ctarget)
                if (ctarget != "" && ctarget ~ ("^(" customcasts ")$")) {
                  print "M\t" f; break
                }
              }
            }
            # Every `name(` in the body is emitted as a call edge. Which of those
            # names is really a routine is decided downstream by intersecting
            # with the F set, so a type modifier like `numeric(12,2)` or a
            # builtin simply has no F record to match and drops out.
            e = b
            gsub(/[ \t]+\(/, "(", e)
            ne = split(e, part, /\(/)
            for (pi = 1; pi < ne; pi++) {
              nm = part[pi]
              sub(/^.*[^a-z0-9_.$]/, "", nm)
              sub(/^.*\./, "", nm)
              if (nm ~ /^[a-z_][a-z0-9_$]*$/ && nm != f) print "C\t" f "\t" nm
            }
            if (b ~ ("(^|[^a-z0-9_])(update|merge([ \t]+into)?|delete[ \t]+from|insert[ \t]+into|truncate([ \t]+table)?)[ \t]+(only[ \t]+)?(public\\.)?(" tables ")([^a-z0-9_]|$)")) {
              print "M\t" f
              continue
            }
            # A body containing dynamic SQL counts too, and it has to, because
            # the write is unreadable twice over: this index blanks quoted
            # literals before looking for DML, so `EXECUTE '"'"'UPDATE public.orders
            # ...'"'"'` shows no UPDATE and the function looks read-only; and the
            # top-level scanner removes function bodies before it looks for
            # EXECUTE, so the dynamic SQL is not seen there either. A helper
            # like that, then called, was an unbound rewrite of a protected
            # table that no channel reported. Which table it writes cannot be
            # known statically — that is the whole problem — so the call is
            # refused on the dynamic SQL alone.
            #
            # `EXECUTE FUNCTION` / `EXECUTE PROCEDURE` (trigger actions) and
            # `EXECUTE ON` (privilege grants, which is how GRANT/REVOKE spell
            # it) are the non-dynamic uses of the keyword; blank them first and
            # ask whether any EXECUTE survives.
            t = b
            gsub(/(^|[^a-z0-9_])execute[ \t]+(function|procedure|on)([^a-z0-9_]|$)/, " x ", t)
            if (t ~ /(^|[^a-z0-9_])execute([^a-z0-9_]|$)/) { print "M\t" f }
          }
        }
      ' 2>/dev/null | node -e '
      const lines = require("fs").readFileSync(0, "utf8").split(/\r?\n/);
      const defined = new Set(), mutating = new Set(), callersOf = new Map();
      for (const ln of lines) {
        if (!ln) continue;
        const p = ln.split("\t");
        if (p[0] === "F") defined.add(p[1]);
        else if (p[0] === "M") mutating.add(p[1]);
        else if (p[0] === "C" && p[1] && p[2] && p[1] !== p[2]) {
          if (!callersOf.has(p[2])) callersOf.set(p[2], new Set());
          callersOf.get(p[2]).add(p[1]);
        }
      }
      // A function or procedure that calls a mutating routine is itself mutating. Walk the
      // call graph BACKWARDS from every known mutator, marking callers, to
      // whatever depth the wrapping goes. Only defined routines are marked, so
      // an edge to a builtin or a type modifier leads nowhere.
      //
      // Indented deliberately: a line starting with `}` in column 0 sits inside
      // a shell function, and anything reading this file by brace depth — the
      // test harness does — would take it for the function`s own closing brace.
      const queue = [...mutating];
      while (queue.length) {
        for (const caller of callersOf.get(queue.pop()) || []) {
          if (defined.has(caller) && !mutating.has(caller)) {
            mutating.add(caller);
            queue.push(caller);
          }
        }
      }
      process.stdout.write([...mutating].filter((n) => defined.has(n)).sort().join("\n"));
      ' 2>/dev/null | sort -u | tr '\n' '|' | sed 's/|$//')
  return 0
}

# ---- EVERY VIEW THIS REPO HAS EVER DEFINED (Codex High, round 21) ----------
# A view is a writable alias. PostgreSQL makes a single-table view over
# order_items automatically updatable, so `UPDATE v SET total_profit = ...`
# rewrites the protected rows while the scanner reads an unregistered name and
# asks for no digest at all. Renaming the migration then walks past the
# apply-time guard as well, because that guard matches the write statement.
#
# Indexed across ALL migrations, not just the file being scanned, for the same
# reason the mutating-function index is: defining the view in one migration and
# writing through it in the next would otherwise land in the gap between them.
# The schema registry cannot substitute here — it does not distinguish a view
# from a table, so a refreshed registry would quietly turn a view into a
# recognized name and hand the bypass back.
KNOWN_VIEWS_RE=""
KNOWN_VIEWS_BUILT=false
build_known_view_index() {
  if [ "$KNOWN_VIEWS_BUILT" = true ]; then return 0; fi
  KNOWN_VIEWS_BUILT=true
  KNOWN_VIEWS_RE=$(find "$MIGRATION_DIR" -name '*.sql' -type f -print0 \
    | xargs -0 awk '
        {
          l = tolower($0)
          sub(/--.*/, "", l)
          gsub(/"/, "", l)
          if (l !~ /create[ \t]+(or[ \t]+replace[ \t]+)?(temp[ \t]+|temporary[ \t]+|recursive[ \t]+|materialized[ \t]+)*view[ \t]/) next
          sub(/^.*view[ \t]+/, "", l)
          sub(/^if[ \t]+not[ \t]+exists[ \t]+/, "", l)
          sub(/[^a-z0-9_.].*$/, "", l)
          sub(/^public\./, "", l)
          if (l ~ /^[a-z_][a-z0-9_]*$/) print l
        }
      ' 2>/dev/null | sort -u | tr '\n' '|' | sed 's/|$//')
  return 0
}

# ---- DOLLAR-QUOTED TEXT IS NOT PROOF (Codex High, round 22) -----------------
# Every proof scanner below reads the migration line by line and strips only
# `--` comments, so it cannot tell code from a string that is shaped like code.
# PostgreSQL's dollar quoting makes that a working bypass, because the decoy
# needs no escaping and reads exactly like the real thing:
#
#   DO $$
#   BEGIN
#     PERFORM $decoy$ IF v_actual IS DISTINCT FROM '<approved digest>'
#                     THEN RAISE EXCEPTION 'drift'; END IF; $decoy$;
#     UPDATE public.orders SET total_profit = 0;   -- bound to nothing
#   END $$;
#
# The digest scan stops at the FIRST occurrence of the hex, finds a canonical
# mismatch test on that line, prints `ok` and exits — while the statement that
# actually runs is a bare UPDATE. The same trick supplies a fake GET DIAGNOSTICS
# row-count assertion and a fake capture.
#
# So the proof scanners no longer read the file. They read this: a copy in which
# every dollar-quoted region that is NOT executable code has its contents
# replaced by spaces, newlines preserved so every line number stays valid.
#
#   executable = top-level SQL, plus the body of a top-level DO
#   inert      = a CREATE FUNCTION body, a dollar-quoted literal, and any tag
#                nested inside a DO body (nothing nested is ever executed here;
#                dynamic SQL is refused separately)
#
# Both directions fail closed. The WRITE scanner keeps reading the raw file, so
# a write hidden in a string is still counted as a write (over-approximation).
# The PROOF scanners read the blanked copy, so text nobody can classify as
# executable can never supply proof (under-approximation).
dq_proof_text() {
  awk '
    # The tag of a dollar-quote delimiter starting at p, or "@" when the
    # character is not one. "" is a real tag: it is the `$$` delimiter.
    function dqtag(s, p, n,   j, ch, tag) {
      tag = ""
      j = p + 1
      while (j <= n) {
        ch = substr(s, j, 1)
        if (ch == "$") return tag
        if (ch !~ /[A-Za-z0-9_]/) return "@"
        if (tag == "" && ch ~ /[0-9]/) return "@"   # $1 is a parameter, not a tag
        tag = tag ch
        j++
      }
      return "@"
    }
    function emit(c) { if (c == "\n") { print line; line = "" } else line = line c }
    function blankrun(s, p, len,   j, ch) {
      for (j = p; j < p + len; j++) { ch = substr(s, j, 1); emit(ch == "\n" ? "\n" : " ") }
    }
    function copyrun(s, p, len,   j) { for (j = p; j < p + len; j++) emit(substr(s, j, 1)) }
    { src = src $0 "\n" }
    END {
      n = length(src)
      depth = 0; head = ""; word = ""; line = ""
      i = 1
      while (i <= n) {
        c = substr(src, i, 1)
        # Inside an inert region only its OWN tag closes it — that is exactly
        # PostgreSQL: in `$$ ... $x$ ... $$` the inner tag is body text.
        if (depth > 0 && !keepd[depth]) {
          if (c == "$") {
            tag = dqtag(src, i, n)
            if (tag != "@" && tag == tagd[depth]) {
              blankrun(src, i, length(tag) + 2); i += length(tag) + 2; depth--
              continue
            }
          }
          emit(c == "\n" ? "\n" : " ")
          i++
          continue
        }
        # Executable region: lex enough that quoted text cannot be mistaken for
        # a delimiter, and that a comment cannot supply the statement keyword.
        if (c == "-" && substr(src, i, 2) == "--") {
          j = index(substr(src, i), "\n")
          len = (j == 0) ? n - i + 1 : j - 1
          copyrun(src, i, len); i += len; word = ""
          continue
        }
        if (c == "/" && substr(src, i, 2) == "/*") {
          d = 0; j = i
          while (j <= n) {
            if (substr(src, j, 2) == "/*") { d++; j += 2; continue }
            if (substr(src, j, 2) == "*/") { d--; j += 2; if (d == 0) break; continue }
            j++
          }
          copyrun(src, i, j - i); i = j; word = ""
          continue
        }
        if (c == "\047" || c == "\"") {
          q = c; j = i + 1
          while (j <= n) {
            if (substr(src, j, 1) == q) {
              if (substr(src, j + 1, 1) == q) { j += 2; continue }   # doubled = escaped
              j++; break
            }
            j++
          }
          copyrun(src, i, j - i); i = j; word = ""
          continue
        }
        if (c == "$") {
          tag = dqtag(src, i, n)
          if (tag != "@") {
            len = length(tag) + 2
            if (depth > 0 && tag == tagd[depth]) {          # closes the DO body
              copyrun(src, i, len); i += len; depth--; word = ""
              continue
            }
            depth++
            tagd[depth] = tag
            # Only a top-level DO body is executable. Anything opened deeper is
            # a literal inside one, and a CREATE FUNCTION body is code this
            # migration defines rather than code it runs.
            keepd[depth] = (depth == 1 && head == "do") ? 1 : 0
            if (keepd[depth]) copyrun(src, i, len); else blankrun(src, i, len)
            i += len; word = ""
            continue
          }
        }
        emit(c)
        # First word of the current top-level statement, which is what decides
        # whether the next dollar quote is a DO body.
        if (depth == 0) {
          if (c ~ /[A-Za-z0-9_]/) word = word c
          else {
            if (word != "" && head == "") head = tolower(word)
            word = ""
            if (c == ";") head = ""
          }
        }
        i++
      }
      if (line != "") print line
    }
  ' "$1"
}

# One reused scratch file for the blanked proof copy. The scanners take it as a
# FILE rather than on a pipe deliberately: several of them `exit` on their first
# match, and under `set -o pipefail` a writer killed by SIGPIPE would abort the
# whole validator.
PROOF_TMP=""
cleanup_proof_tmp() { if [ -n "$PROOF_TMP" ]; then rm -f "$PROOF_TMP"; fi; }
trap cleanup_proof_tmp EXIT

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
    # Git's ordinary --name-only output is a human display format: unusual
    # paths are C-quoted, so treating those display strings as filesystem paths
    # silently skips the file. Consume NUL-delimited raw paths first, validate
    # each basename, and only then convert the now-safe ASCII paths back to the
    # historical word-list representation used by the scanners below.
    CHANGED=""
    UNSAFE_CHANGED_NAME=false
    while IFS= read -r -d '' f; do
      case "$f" in
        *.sql)
          if ! migration_name_is_safe "$f"; then
            report_unsafe_migration_name "$f"
            UNSAFE_CHANGED_NAME=true
          else
            CHANGED="${CHANGED}${f}"$'\n'
          fi
          ;;
      esac
    done < <(
      git diff -M --name-only -z --diff-filter=AMR "$MB" -- "$MIGRATION_DIR" 2>/dev/null || true
      git ls-files -z --others --exclude-standard -- "$MIGRATION_DIR" 2>/dev/null || true
    )

    DELETED=""
    while IFS= read -r -d '' f; do
      case "$f" in
        *.sql)
          if ! migration_name_is_safe "$f"; then
            report_unsafe_migration_name "$f"
            UNSAFE_CHANGED_NAME=true
          else
            DELETED="${DELETED}${f}"$'\n'
          fi
          ;;
      esac
    done < <(git diff -M --name-only -z --diff-filter=D "$MB" -- "$MIGRATION_DIR" 2>/dev/null || true)
    if [ "$UNSAFE_CHANGED_NAME" = true ]; then exit 1; fi
    CHANGED=$(printf '%s' "$CHANGED" | sort -u)
    DELETED=$(printf '%s' "$DELETED" | sort -u)
    EXISTING=""
    for f in $CHANGED; do
      if [ -f "$f" ]; then EXISTING="${EXISTING}${f} "; fi
    done
    ALL_SQL=$(printf '%s\n' $EXISTING)
    SCAN_MODE="changed-only vs $BASE_REF (merge-base)"

    # ROUND 33. Bind routine changes to the exact trigger sources that depend on
    # them. A generic "some graph field changed" check is not evidence: an
    # unrelated edge can hide a changed ordinary helper called by a trigger.
    # The live manifest therefore records transitive routine dependencies and
    # body hashes per source table. Affected sources must be explicitly opaque,
    # or a live regeneration must change the affected routine hash/source slice.
    # Use a file-backed parser so Bash interpolation cannot alter JavaScript
    # regular expressions or the routine names they extract.
    TRIGGER_FANOUT_STALENESS_CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-trigger-fanout-staleness.mjs"
    FANOUT_STALE_SOURCES=$(node "$TRIGGER_FANOUT_STALENESS_CHECK" \
      "$MB" scripts/trigger-fanout.json $CHANGED 2>/dev/null || echo __analysis_failed__)
    if [ -n "$FANOUT_STALE_SOURCES" ]; then
      echo "VIOLATION: scripts/trigger-fanout.json"
      echo "  Trigger fan-out evidence is stale for affected source(s): $FANOUT_STALE_SOURCES"
      echo "  Regenerate from the linked live catalog after apply, or fail closed by adding each affected source table to opaque_on_tables."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

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

# Resolve the hash-pinned exemptions for the scanned set, in one process, the
# same way the grandfather manifest is resolved. Output is `<basename> <count>`
# per line, and ONLY for files whose bytes still match the recorded hash — a row
# whose file has since been edited simply does not appear, so its violations
# count in full. Absent or unreadable manifest => no exemptions.
EXEMPT_ROWS=$(printf '%s\n' "$ALL_SQL" | node -e "
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const manifest = new Map();
let raw = '';
try { raw = fs.readFileSync(process.argv[1], 'utf8'); } catch { process.exit(0); }
for (const line of raw.split(/\r?\n/)) {
  if (!line || line.trim().startsWith('#')) continue;
  const m = line.match(/^([0-9a-f]{64})\s+(\S+)\s+(\d+)/);
  if (m) manifest.set(m[2], { hash: m[1], count: Number(m[3]) });
}
const out = [];
for (const f of fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const row = manifest.get(path.basename(f));
  if (!row) continue;
  let norm;
  try { norm = Buffer.from(fs.readFileSync(f, 'latin1').replace(/\r/g, ''), 'latin1'); } catch { continue; }
  if (createHash('sha256').update(norm).digest('hex') === row.hash) {
    out.push(path.basename(f) + ' ' + row.count);
  }
}
process.stdout.write(out.join('\n'));
" "$SQL_AUDIT_EXEMPTIONS" 2>/dev/null || true)

# ROUND 26. Both manifests above are written by the same branch they judge, so
# on the changed-only path they are an unlocked door: add the new migration's
# basename to the grandfather list, or its hash and violation count to the
# exemptions list, and the zero-tolerance scan waves the migration through. That
# is self-authorization, and a gate a candidate can widen is not a gate.
#
# The changed-only scan therefore ignores both. Nothing is lost by it. A NEW
# migration is not in the grandfather manifest to begin with, and an OLD one
# cannot legitimately appear in a change at all — editing an applied migration is
# forbidden outright. The manifests exist so the aggregate full-corpus scan can
# hold a baseline over history; history is not what this path measures.
#
# The companion half of this rule lives in CI, which rejects any ADDITION to
# either manifest relative to the merge base. Both halves are needed: this one
# stops a candidate exempting itself, that one stops a candidate quietly
# widening the baseline the full scan trusts.
#
# Gated on SCAN_MODE, not on CHANGED_ONLY. When the base ref is missing the flag
# stays true while the scan silently becomes a FULL one, and a full scan over all
# of history without its baseline is thousands of legacy violations — a red build
# nobody can act on, which is how a guard gets switched off.
case "$SCAN_MODE" in changed-only*) SCAN_IS_CHANGED_ONLY=true ;; *) SCAN_IS_CHANGED_ONLY=false ;; esac
if [ "$SCAN_IS_CHANGED_ONLY" = true ]; then
  GRANDFATHERED=""
  EXEMPT_ROWS=""
  echo "NOTE: changed-only scan ignores the grandfather and hash-exemption manifests"
  echo "      (a change may not exempt itself); CI separately rejects additions to them."
  echo ""
fi

EXEMPTED_TOTAL=0
EXEMPT_STALE=""

# ROUND 44. The Bash/AWK routine index intentionally uses an ASCII token
# language. PostgreSQL identifiers do not: `public.修復()` is valid, and used to
# be truncated out of both the deferred definition and the top-level call. Ask
# the shared apply-time analyzer once for the complete scan set and refuse any
# file whose routine identity it cannot represent. One parser owns the boundary;
# the Bash lane must not grow another almost-equivalent Unicode lexer.
if ! UNSUPPORTED_CONSTRUCTS=$(printf '%s\n' $ALL_SQL | node "$UNSUPPORTED_ROUTINE_SCANNER"); then
  echo "ERROR: shared unsupported-construct scan failed; refusing SQL validation."
  exit 1
fi
UNSUPPORTED_ROUTINE_FILES=$(printf '%s\n' "$UNSUPPORTED_CONSTRUCTS" | awk -F '\t' '$2 == "routine-identity" { print $1 }')
EVENT_TRIGGER_FILES=$(printf '%s\n' "$UNSUPPORTED_CONSTRUCTS" | awk -F '\t' '$2 == "event-trigger" { print $1 }')
EVENT_CATALOG_RISK_FILES=$(printf '%s\n' "$UNSUPPORTED_CONSTRUCTS" | awk -F '\t' '$2 == "event-catalog-risk" { print $1 }')
PERSISTED_RULE_FILES=$(printf '%s\n' "$UNSUPPORTED_CONSTRUCTS" | awk -F '\t' '$2 == "persisted-rule" { print $1 }')

for file in $ALL_SQL; do
  # Strip SQL comments for pattern matching
  CODE_ONLY=$(grep -v '^\s*--' "$file" 2>/dev/null || true)

  if [ -z "$CODE_ONLY" ]; then
    continue
  fi

  # Violations this file contributes, so a hash-pinned allowance can be applied
  # to THIS file at the end of the iteration rather than to a global pool.
  FILE_VIOL_BEFORE=$VIOLATIONS

  if [ -n "$UNSUPPORTED_ROUTINE_FILES" ] &&
     printf '%s\n' "$UNSUPPORTED_ROUTINE_FILES" | grep -Fqx -- "$file"; then
    echo "VIOLATION: $file"
    echo "  Unsupported non-ASCII routine identity: static routine binding is fail-closed."
    echo "  Use an ASCII routine name, or extend the shared analyzer before applying this migration."
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
  if [ -n "$EVENT_TRIGGER_FILES" ] &&
     printf '%s\n' "$EVENT_TRIGGER_FILES" | grep -Fqx -- "$file"; then
    echo "VIOLATION: $file"
    echo "  PostgreSQL event-trigger DDL is unsupported: database-wide DDL effects are fail-closed."
    echo "  Use a separately reviewed removal path; do not create, alter, or drop event triggers in an ordinary migration."
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
  if [ -n "$PERSISTED_RULE_FILES" ] &&
     printf '%s\n' "$PERSISTED_RULE_FILES" | grep -Fqx -- "$file"; then
    echo "VIOLATION: $file"
    echo "  This migration fires a PostgreSQL rewrite rule installed by an earlier migration."
    echo "  Stored rule actions are executable catalog state and are refused until their effects are fully modeled."
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
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
    # `INSERT INTO <tbl> ... ON CONFLICT ... DO UPDATE` and
    # `MERGE [INTO] [ONLY] <tbl>` (`INTO` is optional in PostgreSQL).
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
    build_known_view_index
    SCAN_HITS=$(awk -v tables="$BUSINESS_ROW_TABLES" -v mutfns="$MUTATING_FNS_RE" \
                    -v customops="$CUSTOM_OPERATORS_RE" \
                    -v customcasts="$CUSTOM_CAST_TARGETS_RE" \
                    -v regtables="$REGISTRY_TABLES" -v knownviews="$KNOWN_VIEWS_RE" \
                    -v fanouts="$TRIGGER_FANOUT_SOURCES_PADDED" \
                    -v knownrules="$TRIGGER_FANOUT_RULES" '
      # ---- ONE SCANNER, ONE PASS (CodeRabbit Major, PR #364) -----------------
      # Shared with the mutating-function index since round 31 — see ONE LEXER,
      # SHARED above for why this is a variable and not a second copy.
      '"$AWK_STRIP_NOISE"'
      BEGIN {
        nknownrules = split(knownrules, knownrule, "|")
        for (nri = 1; nri <= nknownrules; nri++) {
          split(knownrule[nri], nrparts, " ")
          if (nrparts[1] == "" || nrparts[2] == "") continue
          rulerel[nrparts[2]] = 1
          if (nrparts[1] == "select") ruleselect[nrparts[2]] = 1
          # The static SQL token pass below intentionally collapses relation
          # schemas. Preserve the full captured identity above, but also seed
          # the bare name so an unqualified reference that may resolve through
          # search_path cannot evade a non-public stored rule.
          nrdots = split(nrparts[2], nrsegments, ".")
          nrbare = nrsegments[nrdots]
          rulerel[nrbare] = 1
          if (nrparts[1] == "select") ruleselect[nrbare] = 1
        }
      }
      {
        raw[FNR] = $0
        line = strip_noise(tolower($0))
        # Drop quoting BEFORE normalizing, so "public"."orders" survives as one
        # dotted token instead of splitting into public . orders.
        gsub(/"/, "", line)
        # Routine-body mode, bounded by DOLLAR QUOTES — not by the LANGUAGE
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
            if (!match(rest, /create[ \t]+(or[ \t]+replace[ \t]+)?(function|procedure)/)) {
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
        line = protect_operators(top)
        # Preserve PostgreSQL shorthand-cast syntax before punctuation is
        # normalized away. The target token remains available for comparison
        # with the corpus-wide custom-cast catalog.
        gsub(/::[ \t]*/, " crxcast_to ", line)
        # Normalize every non-identifier character to a space. This also strips
        # quotes, so "public"."orders" collapses to the token public.orders.
        # `;` `,` and `=` survive as tokens of their own: statement boundaries
        # are what bound an UPSERT search, and `,`/`=` are what identify the
        # columns a SET clause actually assigns.
        gsub(/;/, " ; ", line)
        gsub(/,/, " , ", line)
        gsub(/[^a-z0-9_.$;,=]+/, " ", line)
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
      # ALTER DOMAIN ... ADD CHECK (...) NOT VALID stores the expression for
      # future rows but does not scan existing domain values while this
      # migration applies. A routine named inside that CHECK is therefore a
      # definition, not a top-level invocation. Keep the immediate-validation
      # spelling (the same statement without NOT VALID) executable, and keep a
      # later ALTER DOMAIN ... VALIDATE CONSTRAINT fail-closed in the shared
      # apply-time analyzer.
      function deferred_domain_check(p,   s,e,k,checkp,sawnotvalid) {
        for (s = p - 1; s >= 1 && tok[s] != ";"; s--) { }
        s++
        if (tok[s] != "alter" || tok[s + 1] != "domain") return 0
        checkp = 0; sawnotvalid = 0
        for (e = s; e <= ntok && tok[e] != ";"; e++) {
          if (tok[e] == "check" && checkp == 0) checkp = e
          if (tok[e] == "not" && tok[e + 1] == "valid") sawnotvalid = 1
        }
        if (!sawnotvalid || checkp == 0 || p <= checkp) return 0
        for (k = s + 2; k < checkp; k++) {
          if (tok[k] == "add") return 1
        }
        return 0
      }
      function operator_metadata_token(p,   k, h) {
        h = stmt_head(p)
        if (h == "drop" || h == "alter" || h == "comment") return 1
        if (h != "create") return 0
        for (k = p - 1; k >= 1 && tok[k] != ";"; k--) {
          if (tok[k] == "operator") return 1
        }
        return 0
      }
      # Is a cast expression evaluated while this statement applies? Plain
      # CREATE CAST/VIEW/FUNCTION/TABLE metadata is deferred; ordinary running
      # statements and CREATE INDEX / CREATE ... AS query expressions execute.
      function cast_expression_runs(p,   h,k,saw_index,saw_table,saw_materialized,saw_as) {
        h = stmt_head(p)
        if (h != "create") return (h != "grant" && h != "revoke" && h != "comment" && h != "drop")
        saw_index = 0; saw_table = 0; saw_materialized = 0; saw_as = 0
        for (k = p - 1; k >= 1 && tok[k] != ";"; k--) {
          if (tok[k] == "index") saw_index = 1
          if (tok[k] == "table") saw_table = 1
          if (tok[k] == "materialized") saw_materialized = 1
          if (tok[k] == "as") saw_as = 1
        }
        if (saw_index) return 1
        if (saw_as && (saw_table || saw_materialized)) return 1
        return 0
      }
      # Does a write to `t` fire a mutating trigger this migration attached?
      # (Codex High, round 28.) Reported on the `indirect` channel, which is
      # already a refusal for the same reason: a body that writes a protected
      # table has run, and no digest bound the rows it touched.
      function fires_trigger(t, p,   n, arr, k, original, schema, source) {
        if (t == "") return
        original = t
        gsub(/"/, "", t)
        gsub(/"/, "", original)
        schema = ""
        if (original ~ /\./) {
          schema = original
          sub(/\..*$/, "", schema)
        }
        sub(/^[a-z0-9_]+\./, "", t)
        source = ((schema == "" || schema == "public") ? t : schema "." t)
        # Preserve the relation as a live-catalog fan-out source even when this
        # migration defines no trigger itself. Plain INSERTs reach this function
        # and then leave the rewrite scanner; without this separate channel the
        # checked-in trigger/FK manifest is never consulted for them.
        if ((index(fanouts, "|" source "|") > 0 ||
             ((schema == "" || schema == "public") && t ~ ("^(" tables ")$"))) &&
            !seenfanout[source]) {
          seenfanout[source] = 1
          printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[p], source, "fanout-source", "-", "-", raw[tokln[p]]
        }
        if (rulerel[t] && !seenrule[t]) {
          seenrule[t] = 1
          printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[p], "rule_on_" t, "indirect", "-", "-", raw[tokln[p]]
        }
        if (trigfn[t] == "") return
        n = split(trigfn[t], arr, " ")
        for (k = 1; k <= n; k++) {
          if (seenfn[arr[k]]) continue
          seenfn[arr[k]] = 1
          printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[p], arr[k], "indirect", "-", "-", raw[tokln[p]]
        }
      }
      # ---- A WRITE TARGET THIS FILE CANNOT ACCOUNT FOR (Codex High, round 21) --
      # Until now the scan only ever spoke up when the target was a PROTECTED
      # table, so a name it did not recognize was silently nothing. That is the
      # bypass: create an automatically updatable view over order_items, write
      # through the view, and the protected rows change while the scanner sees an
      # unregistered name and asks for no digest.
      #
      # Three outcomes, and the order matters. A view is refused outright, and
      # being created in this same migration is NOT an excuse — that is precisely
      # the attack. A table this migration creates for itself is fine: scratch
      # rows are not business rows. Anything else is refused for being
      # unaccounted-for, because a name nobody can resolve is exactly what an
      # unbound rewrite of protected rows looks like from here.
      function unresolved_write(t, kind, p,   sch, bare) {
        if (t == "") return
        # A NAME IN ANOTHER SCHEMA IS NOT AUTOMATICALLY OUT OF SCOPE
        # (Codex High, round 22). Through round 21 ANY dotted name returned here
        # unexamined, on the reasoning that `auth.` / `storage.` are not business
        # tables. But the caller has already stripped `public.`, so every name
        # still carrying a dot reached this line — including one pointing at a
        # schema the attacker just created:
        #
        #   CREATE SCHEMA repair;
        #   CREATE VIEW repair.orders_v AS SELECT * FROM public.orders;
        #   UPDATE repair.orders_v SET total_profit = 0;
        #
        # PostgreSQL makes that view automatically updatable, so protected rows
        # change while the round-21 view refusal never sees a bare name to match.
        # The schema qualifier WAS the bypass, not a reason to stop looking.
        #
        # So only the fixed set of Supabase/PostgreSQL infrastructure schemas is
        # exempt, and an unrecognized schema is refused for being
        # unaccounted-for. Measured across all 876 migrations, the only schemas
        # any write actually names are public (stripped by the caller), storage,
        # and auth — so this costs the existing repository nothing.
        if (t ~ /\./) {
          sch = t; sub(/\..*$/, "", sch)
          bare = t; sub(/^[^.]*\./, "", bare)
          # THE VIEW CHECK RUNS BEFORE THE SCHEMA EXEMPTION (Codex High, round
          # 27). Round 22 kept a fixed list of infrastructure schemas whose names
          # are out of scope, and returned on it FIRST. `pg_temp` is on that list,
          # and a temporary view is not scratch — it is a writable alias for
          # permanent rows:
          #
          #   CREATE TEMP VIEW oi_shim AS SELECT * FROM public.order_items;
          #   UPDATE pg_temp.oi_shim SET profit = 0;
          #
          # The view is single-table, so PostgreSQL makes it automatically
          # updatable and real order_items rows change. The creation WAS recorded
          # (made_view drops the schema prefix), but the write never reached that
          # check: `pg_temp.` matched the exemption one line earlier and returned.
          # The apply-time guard sees only `oi_shim` too, so nothing else catches
          # it. Resolve the view identity first, on the bare name, and let the
          # exemption apply only to what is left.
          if ((knownviews != "" && bare ~ ("^(" knownviews ")$")) || made_view[bare]) {
            if (seen_unres[t]) return
            seen_unres[t] = 1
            printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[p], t, "viewwrite", kind, "-", raw[tokln[p]]
            return
          }
          if (sch ~ /^(auth|storage|cron|net|extensions|graphql|graphql_public|realtime|supabase_functions|supabase_migrations|vault|pgsodium|pgbouncer|information_schema|pg_catalog|pg_temp|pg_toast)$/) return
          if (seen_unres[t]) return
          seen_unres[t] = 1
          printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[p], t, "unresolved", kind, "-", raw[tokln[p]]
          return
        }
        if (t !~ /^[a-z_][a-z0-9_]*$/) return
        if (seen_unres[t]) return
        seen_unres[t] = 1
        if (knownviews != "" && t ~ ("^(" knownviews ")$")) {
          printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[p], t, "viewwrite", kind, "-", raw[tokln[p]]
          return
        }
        if (made_view[t]) {
          printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[p], t, "viewwrite", kind, "-", raw[tokln[p]]
          return
        }
        if (made_table[t]) return
        if (regtables != "" && t ~ ("^(" regtables ")$")) return
        printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[p], t, "unresolved", kind, "-", raw[tokln[p]]
      }
      END {
        # `UPDATE public . orders SET ...` is legal PostgreSQL, and so is the
        # same qualification broken across lines. The tokenizer keeps `.` as an
        # ordinary character but splits on whitespace, so either spelling
        # arrives here as three tokens — and every target read below takes the
        # SINGLE token after UPDATE / DELETE FROM / INSERT INTO as the table.
        # It would read `public`, find no protected table by that name, and
        # report no rewrite at all: an unapproved money rewrite needing neither
        # a digest nor one-shot registration. Join the pieces back into one
        # qualified name first. Done over the finished token array rather than
        # per line so a name split by a newline is joined too. `;` `,` and `=`
        # are never absorbed — they are statement and clause boundaries, and
        # welding one into a name would silently move those boundaries.
        m = 0
        for (i = 1; i <= ntok; i++) {
          if (m > 0 &&
              tok[i] != ";" && tok[i] != "," && tok[i] != "=" &&
              jtok[m] != ";" && jtok[m] != "," && jtok[m] != "=" &&
              (jtok[m] ~ /\.$/ || tok[i] ~ /^\./)) {
            jtok[m] = jtok[m] tok[i]
            continue
          }
          m++; jtok[m] = tok[i]; jtokln[m] = tokln[i]
        }
        for (i = 1; i <= m; i++) { tok[i] = jtok[i]; tokln[i] = jtokln[i] }
        for (i = m + 1; i <= ntok; i++) { delete tok[i]; delete tokln[i] }
        ntok = m
        # ---- WHAT THIS MIGRATION MAKES FOR ITSELF (Codex High, round 21) ----
        # A write has to resolve to something before it can be judged, and the
        # one honest reason a target is absent from the registry is that this
        # migration just created it. A scratch table is fine: it holds no
        # business rows and binding it would be theatre.
        #
        # A VIEW is deliberately NOT fine. That is the whole finding — an
        # automatically updatable view over order_items is a writable alias for
        # rows that DO need binding, and accepting it because the migration
        # created it would hand back the bypass in the name of convenience.
        for (i = 1; i <= ntok; i++) {
          if (tok[i] != "create") continue
          k = i + 1
          while (tok[k] == "or" || tok[k] == "replace" || tok[k] == "temp" ||
                 tok[k] == "temporary" || tok[k] == "unlogged" || tok[k] == "global" ||
                 tok[k] == "local" || tok[k] == "materialized" || tok[k] == "recursive") k++
          if (tok[k] != "table" && tok[k] != "view") continue
          j = k + 1
          if (tok[j] == "if" && tok[j + 1] == "not" && tok[j + 2] == "exists") j += 3
          nm = tok[j]
          sub(/^[a-z0-9_]+\./, "", nm)
          if (nm == "") continue
          if (tok[k] == "table") made_table[nm] = 1; else made_view[nm] = 1
        }
        # ---- A TRIGGER IS A STANDING INVOCATION (Codex High, round 28) -------
        # The indirect-rewrite reader below excludes the statement head `create`,
        # and rightly: `CREATE TRIGGER ... EXECUTE FUNCTION f()` binds a function,
        # it does not run one. But the very next statement can run it. Attach a
        # mutating function to a scratch table, insert one row, and its UPDATE of
        # a protected table applies with no channel reporting anything — the
        # scratch table is a table this migration made for itself, and a plain
        # INSERT is not even examined below because it adds rows rather than
        # rewriting them. Neither exemption is wrong on its own; together they
        # spell an unbound money rewrite.
        #
        # So attachments are indexed here, and the DML that fires one is read on
        # its own terms further down. Only functions the mutating index already
        # flags are indexed — attaching an ordinary trigger stays free, which is
        # what keeps every `updated_at` migration in this repository quiet.
        for (i = 1; i <= ntok; i++) {
          if (tok[i] != "trigger" || stmt_head(i) != "create") continue
          trel = ""; tfn = ""
          for (k = i + 1; k <= ntok && tok[k] != ";"; k++) {
            if (tok[k] == "on") { trel = tok[k + 1]; break }
          }
          for (k = i + 1; k <= ntok && tok[k] != ";"; k++) {
            if (tok[k] == "execute" &&
                (tok[k + 1] == "function" || tok[k + 1] == "procedure")) {
              tfn = tok[k + 2]; break
            }
          }
          if (trel == "" || tfn == "") continue
          gsub(/"/, "", trel); sub(/^[a-z0-9_]+\./, "", trel)
          gsub(/"/, "", tfn);  sub(/^[a-z0-9_]+\./, "", tfn)
          if (mutfns == "" || tfn !~ ("^(" mutfns ")$")) continue
          if (index(" " trigfn[trel] " ", " " tfn " ") == 0) {
            trigfn[trel] = (trigfn[trel] == "" ? tfn : trigfn[trel] " " tfn)
          }
        }
        # A PostgreSQL rule is another standing invocation. Its action can call
        # a database-resident mutator whose body this file cannot inspect, so a
        # later matching event on the rule relation is refused as an indirect
        # rewrite. ON SELECT is tracked separately because reading the relation,
        # rather than writing it, executes the stored rule action.
        for (i = 1; i <= ntok; i++) {
          if (tok[i] != "rule" || stmt_head(i) != "create") continue
          rrel = ""; revent = ""
          for (k = i + 1; k <= ntok && tok[k] != ";"; k++) {
            if (tok[k] == "on" &&
                (tok[k + 1] == "select" || tok[k + 1] == "insert" ||
                 tok[k + 1] == "update" || tok[k + 1] == "delete")) {
              revent = tok[k + 1]
            }
            if (tok[k] == "to") { rrel = tok[k + 1]; break }
          }
          if (rrel == "" || revent == "") continue
          gsub(/"/, "", rrel); sub(/^[a-z0-9_]+\./, "", rrel)
          rulerel[rrel] = 1
          if (revent == "select") ruleselect[rrel] = 1
        }
        for (i = 1; i <= ntok; i++) {
          # Selecting from an ordinary view executes its stored query. The
          # migration corpus tells us the object is a view but cannot prove the
          # live definition is still byte-identical or free of resident routine
          # calls, so executing any repo-known/same-file view fails closed.
          # CREATE VIEW ... AS SELECT FROM another_view remains deferred because
          # cast_expression_runs() excludes ordinary view definitions.
          if ((tok[i] == "from" || tok[i] == "join" || tok[i] == "table") &&
              cast_expression_runs(i)) {
            vname = tok[i + 1]
            gsub(/"/, "", vname); sub(/^.*\./, "", vname)
            if (vname != "" && ruleselect[vname] && !seenruleselect[vname]) {
              seenruleselect[vname] = 1
              printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], "rule_on_select_" vname, "indirect", "-", "-", raw[tokln[i]]
              continue
            }
            if (vname != "" &&
                ((knownviews != "" && vname ~ ("^(" knownviews ")$")) || made_view[vname]) &&
                !seenviewread[vname]) {
              seenviewread[vname] = 1
              printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], "view_select_" vname, "indirect", "-", "-", raw[tokln[i]]
              continue
            }
          }
          # Explicit custom casts dispatch to their backing routines without a
          # conventional `name(...)` call. Recognize both `expr::target` and
          # `CAST(expr AS target)` against every target type defined anywhere
          # in migration history, then refuse through the existing indirect
          # rewrite channel. Function-body casts are handled by the mutating
          # function index and propagate through its reverse call graph.
          if (customcasts != "" && cast_expression_runs(i)) {
            ctarget = ""
            if (tok[i] == "crxcast_to") ctarget = tok[i + 1]
            else if (tok[i] == "cast") {
              for (cj = i + 1; cj <= ntok && tok[cj] != ";" && cj <= i + 80; cj++) {
                if (tok[cj] == "as") { ctarget = tok[cj + 1]; break }
              }
            }
            sub(/^.*\./, "", ctarget)
            if (ctarget != "" && ctarget ~ ("^(" customcasts ")$") && !seencast[ctarget]) {
              seencast[ctarget] = 1
              printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], ctarget, "indirect", "-", "-", raw[tokln[i]]
              continue
            }
          }
          # A custom operator is a hidden routine call. Its punctuation token is
          # indexed across the migration corpus above, so an invocation in this
          # file cannot disappear merely because it lacks `routine_name(...)`.
          # Defining/dropping/commenting the operator is metadata; using it in
          # SELECT, DML, DO, CREATE INDEX, or another executing expression is
          # an opaque indirect rewrite and is refused.
          if (customops != "" && tok[i] ~ ("^(" customops ")$") &&
              !operator_metadata_token(i) && !seenop[tok[i]]) {
            seenop[tok[i]] = 1
            printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], tok[i], "indirect", "-", "-", raw[tokln[i]]
            continue
          }
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
          # PostgreSQL accepts database.schema.routine() when the database
          # qualifier names the current database. Strip every qualifier before
          # comparing with the bare mutating-routine index; limiting this to a
          # leading public. lets postgres.public._fix() execute unseen.
          sub(/^([a-z0-9_]+\.)+/, "", callee)
          if (mutfns != "" && callee ~ ("^(" mutfns ")$") && !seenfn[callee] &&
              !deferred_domain_check(i)) {
            h = stmt_head(i)
            if (h != "grant" && h != "revoke" && h != "comment" && h != "drop" &&
                h != "create" &&
                tok[i - 1] != "function" && tok[i - 1] != "procedure") {
              seenfn[callee] = 1
              printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], callee, "indirect", "-", "-", raw[tokln[i]]
              continue
            }
          }
          if (tok[i] == "truncate" && tok[i - 1] != "grant" && tok[i - 1] != "revoke" &&
              tok[i - 1] != ",") {
            j = i + 1
            if (tok[j] == "table") j++
            while (j <= ntok && tok[j] != ";") {
              if (tok[j] == "only") { j++; continue }
              tt = tok[j]
              fires_trigger(tt, i)
              gsub(/"/, "", tt)
              sub(/^public\./, "", tt)
              if (tt ~ ("^(" tables ")$")) {
                printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], tt, "truncate", "-", "-", raw[tokln[i]]
              } else {
                unresolved_write(tt, "truncate", i)
              }
              if (tok[j + 1] == ",") { j += 2; continue }
              break
            }
            continue
          }
          # ---- A TYPE CHANGE IS A WHOLE-TABLE REWRITE (Codex High, round 29) ---
          # Every channel below reads a DML verb, and
          #
          #   ALTER TABLE public.order_items
          #     ALTER COLUMN profit TYPE numeric(12,2) USING round(profit, 2);
          #
          # spells none of them while rewriting every row of the table — the USING
          # expression is evaluated per row and the result is what gets stored.
          # There is no way to bind which rows changed, because all of them did,
          # so it is reported as a rewrite of the whole table exactly as TRUNCATE
          # is, and needs the same approved-set digest. The apply-time analyzer
          # already reads this shape as `table.*`; this closes the same gap on the
          # scanner side. Measured over all 882 migrations in this tree, NONE
          # changes a column type — the 11 files that say `ALTER COLUMN` all
          # SET/DROP NOT NULL or SET/DROP DEFAULT — so this costs the existing
          # repository nothing at all.
          if (tok[i] == "alter" && tok[i + 1] == "table" && stmt_head(i) == "alter") {
            j = i + 2
            if (tok[j] == "if" && tok[j + 1] == "exists") j += 2
            if (tok[j] == "only") j++
            at = tok[j]
            retype = 0
            for (k = j + 1; k <= ntok && tok[k] != ";"; k++) {
              # Read the action list FORWARDS from each ALTER, not backwards from
              # TYPE. `ALTER [COLUMN] <name> [SET DATA] TYPE t` is the only shape
              # that rewrites rows, and only a forward walk can tell it from
              # `ALTER COLUMN type SET DEFAULT ...` — a column actually named
              # `type`, which reading backwards mistakes for the TYPE keyword.
              # Every other action (ALTER CONSTRAINT, SET/DROP NOT NULL,
              # SET/DROP DEFAULT) lands on something that is not TYPE and is
              # skipped.
              if (tok[k] != "alter") continue
              p = k + 1
              if (tok[p] == "column") p++
              p++                                    # the column name itself
              if (tok[p] == "type") { retype = 1; break }
              if (tok[p] == "set" && tok[p + 1] == "data" && tok[p + 2] == "type") {
                retype = 1
                break
              }
            }
            if (retype) {
              fires_trigger(at, i)
              gsub(/"/, "", at)
              sub(/^public\./, "", at)
              if (at ~ ("^(" tables ")$")) {
                printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], at, "retype", "-", "-", raw[tokln[i]]
              } else {
                unresolved_write(at, "retype", i)
              }
              continue
            }
          }
          # `COPY t FROM ...` loads rows and fires their triggers. It is not a
          # bindable rewrite of existing rows, so it is read for nothing else.
          if (tok[i] == "copy" && stmt_head(i) == "copy") fires_trigger(tok[i + 1], i)
          target = ""; kind = ""; setp = 0
          # `UPDATE` is also a lock strength (`FOR UPDATE`, `FOR NO KEY UPDATE`),
          # a privilege (`GRANT SELECT, UPDATE ON ...`), and a trigger event
          # (`BEFORE INSERT OR UPDATE ON ...`). Reading the next token as a table
          # in those spellings used to be harmless — an unrecognized name was
          # silently nothing — but now an unrecognized name is a refusal, so the
          # non-DML uses have to be excluded by name or every FK clause in the
          # repo becomes a violation.
          if (tok[i] == "update" && tok[i - 1] != "do" && tok[i - 1] != "for" &&
              tok[i - 1] != "key" && tok[i - 1] != "on" && tok[i - 1] != "before" &&
              tok[i - 1] != "after" && tok[i - 1] != "or" && tok[i - 1] != "grant" &&
              tok[i - 1] != "revoke" && tok[i - 1] != "instead" && tok[i - 1] != ",") {
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
            # A plain INSERT is out of scope for binding — but it FIRES TRIGGERS
            # (round 28), so the relation is checked before the statement is
            # dropped. This is the exact statement the reproducer used.
            fires_trigger(tok[j], i)
            if (setp == 0) continue
            target = tok[j]; kind = "upsert"
          } else if (tok[i] == "merge") {
            j = i + 1
            if (tok[j] == "into") j++
            if (tok[j] == "only") j++
            if (j > ntok || tok[j] == ";") {
              target = "__unreadable_merge_target__"; kind = "merge"; setp = 0
            } else {
              target = tok[j]; kind = "merge"; setp = j + 1
            }
          }
          if (target == "") continue
          fires_trigger(target, i)
          gsub(/"/, "", target)
          sub(/^public\./, "", target)
          if (target ~ ("^(" tables ")$")) {
            sc = (setp ? set_cols(setp) : "")
            printf "%d\t%s\t%s\t%s\t%s\t%s\n", tokln[i], target, kind,
                   (sc == "" ? "-" : sc), bound_var(i), raw[tokln[i]]
            continue
          }
          unresolved_write(target, kind, i)
        }
      }
    ' "$file")

    # ── An executable body written as a single-quoted string ────────────────
    # PostgreSQL accepts `CREATE FUNCTION f() ... AS 'BEGIN UPDATE ...; END;'`.
    # Every scanner in this file strips single-quoted literals before it looks
    # for writes, so a body written that way is invisible three times over: the
    # rewrite is not seen, the function is not indexed as mutating, and a later
    # `SELECT f()` is not refused. That is an unbound rewrite of a protected
    # table with nothing standing in its way.
    #
    # Anonymous DO blocks have the same lexical hole and a worse execution
    # boundary: unlike a routine definition, their body runs immediately.
    # PostgreSQL accepts plain, E-string, and U&-string bodies. Rather than teach
    # four scanners every escape form, refuse those shapes too. CRX writes
    # dollar-quoted bodies everywhere, so this closes the hole fail-closed.
    QUOTED_BODIES=$(awk '
      # Comments out, literals KEPT — this detector exists to see `AS '"'"'`, so
      # it is the one scanner that must not blank quoted text. It still has to
      # read left to right: taking block comments out first meant a line ending
      # `-- see /* note` opened a comment nothing closed, and every following
      # line was blanked, which is a fail-OPEN for exactly the shape being
      # hunted (CodeRabbit Major, PR #364).
      function strip_comments(s,   out, i, c, d, n) {
        out = ""; i = 1; n = length(s)
        while (i <= n) {
          c = substr(s, i, 1)
          d = substr(s, i, 2)
          if (inblk > 0) {
            if (d == "/*") { inblk++; i += 2; continue }
            if (d == "*/") { inblk--; i += 2; continue }
            i++; continue
          }
          if (instr) {
            if (c == "'"'"'" && substr(s, i + 1, 1) == "'"'"'") { out = out "  "; i += 2; continue }
            if (c == "'"'"'") instr = 0
            out = out c; i++; continue
          }
          if (d == "/*") { inblk++; i += 2; out = out " "; continue }
          if (d == "--") break
          if (c == "'"'"'") { instr = 1; out = out c; i++; continue }
          out = out c; i++
        }
        return out
      }
      { line = strip_comments(tolower($0))
        # A dollar-quoted DO block is readable by the main scanner. Once a DO
        # statement starts, its first string delimiter is the body — even when
        # LANGUAGE, a quoted language name, and the body span several lines.
        # Carry that head until a dollar quote (safe), single quote (refuse), or
        # statement terminator (malformed, left to PostgreSQL) appears.
        if (!indo && match(line, /(^|;)[ \t]*do([ \t]|$)/)) {
          line = substr(line, RSTART)
          sub(/^(;[ \t]*)?do([ \t]|$)/, "", line)
          indo = 1
        }
        if (indo) {
          if (line ~ /\$[a-z0-9_]*\$/) { indo = 0 }
          else if (line ~ /'"'"'/) {
            printf "%d\t%s\n", FNR, $0; indo = 0; next
          } else if (line ~ /;/) { indo = 0 }
          else next
        }
        if (line ~ /create[ \t]+(or[ \t]+replace[ \t]+)?(function|procedure)[ \t]/) { pending = 1 }
        if (!pending) next
        # A dollar quote opens the body: this is the shape we want, stand down.
        if (line ~ /\$[a-z0-9_]*\$/) { pending = 0; awaitq = 0; next }
        if (line ~ /(^|[^a-z0-9_])as[ \t]*(e|u&)?'"'"'/) {
          printf "%d\t%s\n", FNR, $0; pending = 0; awaitq = 0; next
        }
        # `AS` at end of line, body opens on the next one.
        if (line ~ /(^|[^a-z0-9_])as[ \t]*$/) { awaitq = 1; next }
        if (awaitq && line ~ /^[ \t]*(e|u&)?'"'"'/) {
          printf "%d\t%s\n", FNR, $0; pending = 0; awaitq = 0; next
        }
        if (awaitq && line ~ /[^ \t]/) { awaitq = 0 }
      }
    ' "$file")

    if [ -n "$QUOTED_BODIES" ]; then
      echo "VIOLATION: $file"
      echo "  Executable body written as a non-dollar-quoted single-quoted string:"
      printf '%s\n' "$QUOTED_BODIES" | while IFS=$'\t' read -r q_ln q_raw; do
        echo "    line $q_ln: $q_raw"
      done
      echo "  Every scanner in this validator strips single-quoted literals before"
      echo "  it looks for writes, so a body written this way is invisible. That"
      echo "  can hide direct DML in a DO block or a mutating routine call."
      echo "  Use a dollar-quoted body"
      echo "  (\$\$ ... \$\$) so the statements inside can be read and bound."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    # Dynamic SQL rides the same scan but is not a bindable rewrite — it is a
    # refusal, and it stands on its own whether or not any table rewrite was
    # also found.
    DYNAMIC_HITS=$(printf '%s\n' "$SCAN_HITS" | awk -F'\t' 'NF && $3 == "dynamic"')
    INDIRECT_HITS=$(printf '%s\n' "$SCAN_HITS" | awk -F'\t' 'NF && $3 == "indirect"')
    VIEWWRITE_HITS=$(printf '%s\n' "$SCAN_HITS" | awk -F'\t' 'NF && $3 == "viewwrite"')
    UNRESOLVED_HITS=$(printf '%s\n' "$SCAN_HITS" | awk -F'\t' 'NF && $3 == "unresolved"')
    FANOUT_SOURCES=$(printf '%s\n' "$SCAN_HITS" | awk -F'\t' 'NF && $3 == "fanout-source"')
    REWRITES=$(printf '%s\n' "$SCAN_HITS" | awk -F'\t' 'NF && $3 != "dynamic" && $3 != "indirect" && $3 != "viewwrite" && $3 != "unresolved" && $3 != "fanout-source"')

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
      echo "  Top-level call to a routine whose body is an unbindable rewrite:"
      printf '%s\n' "$INDIRECT_HITS" | while IFS=$'\t' read -r n_ln n_fn n_kind n_cols n_var n_raw; do
        echo "    line $n_ln: $n_fn() — its body writes a protected table, or"
        echo "              builds SQL at runtime so no guard can see what it writes"
      done
      echo "  Calling it makes this migration a one-shot rewrite, but the rows it"
      echo "  touches are decided by the routine's own runtime predicates — or by"
      echo "  a string assembled while it runs — so no digest can be shown to cover"
      echo "  them. Inline the DML here, written out literally, so it can be read"
      echo "  and bound to an approved set."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    if [ -n "$VIEWWRITE_HITS" ]; then
      echo "VIOLATION: $file"
      echo "  Data written through a view:"
      printf '%s\n' "$VIEWWRITE_HITS" | while IFS=$'\t' read -r v_ln v_rel v_kind v_cols v_var v_raw; do
        echo "    line $v_ln: $v_kind on $v_rel, which is a view"
      done
      echo "  PostgreSQL makes a single-table view automatically updatable, so a"
      echo "  write through one changes the underlying rows while this scan sees"
      echo "  only the view's name — no protected table, no digest required. That"
      echo "  is true even when this same migration creates the view. Write the"
      echo "  base table directly so the rewrite can be read and bound."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    if [ -n "$UNRESOLVED_HITS" ]; then
      echo "VIOLATION: $file"
      echo "  Write to a relation this validator cannot account for:"
      printf '%s\n' "$UNRESOLVED_HITS" | while IFS=$'\t' read -r u_ln u_rel u_kind u_cols u_var u_raw; do
        echo "    line $u_ln: $u_kind on $u_rel — not a known table in the schema"
        echo "              registry, and not created by this migration"
      done
      echo "  A name nobody can resolve is indistinguishable from an unbound"
      echo "  rewrite of protected rows, so it is refused rather than ignored."
      echo "  If the relation is real, refresh the schema registry"
      echo "  (/regen-schema-registry). If this migration creates it, create it"
      echo "  as a TABLE before writing to it."
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

    if [ -n "$REWRITES" ] || [ -n "$FANOUT_SOURCES" ]; then
      # ---- FOLD IN WHAT THE TRIGGERS REWRITE (Codex High, round 31) --------
      # See the manifest block near the top of this script. A cascade target is
      # appended as a synthetic rewrite row so that EVERY existing mechanism
      # applies to it unchanged: its material columns join the union the digest
      # must cover, it joins the per-table captured set, and it counts toward
      # the one-table-per-repair rule.
      #
      # Only cascade targets that are themselves protected are folded in — a
      # trigger appending to a log or queue table is legitimately unbound, the
      # same way a direct write to one is.
      #
      # One hop, not the transitive closure. A second hop can only be reached
      # through a first-hop target, and a first-hop target is either folded in
      # here (making this at least two tables, which is already refused below)
      # or skipped because the migration rewrites it directly (making it at
      # least two tables by itself). So no chain that would pass can hide behind
      # the missing hops.
      CASCADE_UNKNOWN=""
      CASCADE_WHY=""
      DIRECT_TABLES=$(
        { printf '%s\n' "$REWRITES"; printf '%s\n' "$FANOUT_SOURCES"; } |
          awk -F'\t' 'NF >= 2 && $2 != "" { print $2 }' | sort -u
      )
      while IFS= read -r c_src; do
        if [ -z "$c_src" ]; then
          continue
        fi
        # Fail closed per table, not globally: a manifest that predates this
        # table cannot say what fires on it, and a trigger body PostgreSQL
        # stores parsed rather than as source (BEGIN ATOMIC) cannot be read at
        # all. Either way the answer is unknown, and unknown is refused —
        # without wedging migrations on tables the manifest does cover.
        # Do not use `printf ... | grep -q` under pipefail here. Once grep finds
        # an early source it closes the pipe; a large linked manifest then gives
        # printf SIGPIPE and turns a successful lookup into failure. That exact
        # Linux-CI shape falsely declared covered order_items/quote_items unknown.
        # `grep -F -x` deliberately consumes the complete here-string. Do not
        # add `-q`: its early exit recreates the SIGPIPE/pipefail false negative.
        if ! grep -F -x "$c_src" <<< "$TRIGGER_FANOUT_SCANNED" >/dev/null \
           || grep -F -x "$c_src" <<< "$TRIGGER_FANOUT_OPAQUE" >/dev/null; then
          CASCADE_UNKNOWN="$CASCADE_UNKNOWN $c_src"
          continue
        fi
        while IFS=' ' read -r f_src f_tgt f_via; do
          if [ -z "$f_src" ] || [ "$f_src" != "$c_src" ]; then
            continue
          fi
          if printf '%s\n' "$DIRECT_TABLES" | grep -qx "$f_tgt"; then
            continue
          fi
          if ! printf '%s\n' "$BUSINESS_ROW_TABLES" | tr '|' '\n' | grep -qx "$f_tgt"; then
            continue
          fi
          c_line=$(
            { printf '%s\n' "$REWRITES"; printf '%s\n' "$FANOUT_SOURCES"; } |
              awk -F'\t' -v t="$c_src" '$2 == t { print $1; exit }'
          )
          cascade_row="$c_line	$f_tgt	cascade	-	-	trigger $f_via on $c_src"
          if [ -n "$REWRITES" ]; then
            REWRITES="$REWRITES
$cascade_row"
          else
            REWRITES="$cascade_row"
          fi
          if [ -z "$CASCADE_WHY" ]; then
            CASCADE_WHY="the write to $c_src at line $c_line fires the trigger function $f_via, which rewrites $f_tgt. Those $f_tgt rows are not in the captured id set, are not in the digest, and are not counted by the ROW_COUNT assertion, so this repair would rewrite them with no approval covering them at all. An approved-set repair binds ONE table; rewrite $f_tgt through its own migration, or waive it with an APPROVED_SET_DIGEST: NOT-REQUIRED marker that names both $c_src and $f_tgt and says why the cascade needs no approval."
          fi
        done <<< "$TRIGGER_FANOUT_PAIRS"
      done <<< "$DIRECT_TABLES"

      # A plain INSERT on a fully covered source with no protected fan-out is
      # still not a rewrite. Its marker existed only to ask the manifest this
      # question; once the answer is a trusted empty set, preserve the original
      # noise-free behavior and move to the next migration.
      if [ -z "$REWRITES" ] && [ -z "$CASCADE_UNKNOWN" ]; then
        continue
      fi

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

      # ---- EVERY REWRITE BINDS ITS TABLE'S BEFORE-VALUES -------------------
      # Round 15 (Codex High) established this for DELETE: a DELETE contributes
      # no assigned columns, so on its own it asks the digest to cover row ids
      # and nothing else. Substituting the target table's material columns (see
      # MATERIAL_COLS_MAP above) binds its lifecycle and financial before-values
      # instead.
      #
      # Round 20 (Codex High) showed the same hole one step to the left, on
      # UPDATE. An UPDATE does contribute assigned columns, so it looked bound —
      # but only to what it assigns. A digest over orders.id + total_profit
      # still matched after the order changed hands, changed status, or was soft
      # deleted, so an approval granted in one lifecycle state silently
      # authorized rewriting authoritative money in another. Assigned columns
      # are a floor, not the binding.
      #
      # So the substitution now runs for EVERY rewritten table, whatever the
      # verb. A table's material columns are unioned with whatever that
      # migration assigns, and the digest must cover the union.
      #
      # The REFUSAL stays DELETE-only, and deliberately so. A DELETE on a table
      # the registry gives no material column for would decay to ids alone —
      # nothing left to bind — so it is refused outright rather than passed on a
      # technicality. An UPDATE in that position still binds the columns it
      # assigns, which is strictly more than ids; refusing it would break
      # column-bound repairs on bookkeeping tables for no safety gained.
      # Recorded here, decided in the chain below so it reads next to the other
      # structural refusals.
      DELETE_TABLES=$(printf '%s\n' "$REWRITES" | awk -F'\t' '$3 == "delete" { print $2 }' | sort -u)
      DELETE_UNBINDABLE=""
      if [ -n "$REWRITE_TABLES" ]; then
        while IFS= read -r d_tbl; do
          if [ -z "$d_tbl" ]; then
            continue
          fi
          d_cols=$(printf '%s\n' "$MATERIAL_COLS_MAP" \
                     | awk -F'\t' -v t="$d_tbl" '$1 == t { print $2 }')
          if [ -z "$d_cols" ]; then
            if printf '%s\n' "$DELETE_TABLES" | grep -qx "$d_tbl"; then
              DELETE_UNBINDABLE="$DELETE_UNBINDABLE $d_tbl"
            fi
          else
            REWRITE_COLS="$REWRITE_COLS $d_cols"
          fi
        done <<< "$REWRITE_TABLES"
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
      if [ -n "$CASCADE_UNKNOWN" ]; then
        DIGEST_WHY="the trigger fan-out manifest (scripts/trigger-fanout.json) does not cover$CASCADE_UNKNOWN, so what a write to that table cascades into is unknown. A trigger that rewrites a second table does it outside the captured id set, outside the digest and outside the ROW_COUNT assertion, so an unknown fan-out is refused rather than assumed empty. Regenerate the manifest with scripts/generate-trigger-fanout.mjs."
      # A cascade is reported on its own terms rather than through the
      # one-table-per-repair message below, which would otherwise leave the
      # author hunting for a second table their migration never names.
      elif [ -n "$CASCADE_WHY" ]; then
        DIGEST_WHY="$CASCADE_WHY"
      elif [ "$REWRITE_TABLE_COUNT" -gt 1 ]; then
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
        # Everything from here down is PROOF reading, so it reads the copy with
        # inert dollar-quoted text blanked (see dq_proof_text). Line numbers are
        # preserved, so every message below still points at the real file.
        if [ -z "$PROOF_TMP" ]; then
          PROOF_TMP=$(mktemp)
        fi
        dq_proof_text "$file" > "$PROOF_TMP"
        PROOF_FILE="$PROOF_TMP"
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
        ' "$PROOF_FILE")
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
        ' "$PROOF_FILE")
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
              # ---- THE PROJECTION MUST BE THE REWRITTEN ROW (Codex High, r31) --
              # A whole-row projection excuses the entire column-coverage check,
              # and it was accepted on the strength of its SHAPE alone: any alias
              # would do. So a join could park the projection on something that
              # is not the rewritten table at all —
              #
              #   SELECT encode(digest(string_agg(o.id::text || <sep> ||
              #                        to_jsonb(x.*)::text, ...)))
              #     FROM public.orders o CROSS JOIN LATERAL (SELECT 1) x
              #    WHERE o.id = ANY(v_ids);
              #
              # — where every rewritten column is excused by a projection of a
              # constant row and the digest binds nothing but the ids. The alias
              # now has to be the rewritten table itself, or an alias declared ON
              # it in the same statement.
              function wr_alias_ok(span, stmt, tbl,   rest, a) {
                rest = span
                while (match(rest, /(to_jsonb|to_json|row_to_json|hstore)[ \t]*\([ \t]*[a-z0-9_]+\.\*/) > 0) {
                  a = substr(rest, RSTART, RLENGTH)
                  rest = substr(rest, RSTART + RLENGTH)
                  sub(/\.\*$/, "", a)
                  sub(/^.*[( \t]/, "", a)
                  if (a == tbl) return 1
                  if (stmt ~ ("(^|[^a-z0-9_.])(public\\.)?" tbl "([ \t]+as)?[ \t]+" a "([^a-z0-9_]|$)")) return 1
                }
                return 0
              }
              # ---- A ROW THAT HASHES TO NULL IS NOT HASHED (Codex High, r31) ---
              # In SQL any concatenation with NULL is NULL, and string_agg SKIPS
              # NULL inputs rather than aggregating them. So a hand-enumerated
              # payload that touches one nullable column —
              #
              #   string_agg(id::text || <sep> || deleted_at::text || ..., ...)
              #
              # — silently drops every row whose deleted_at is unset OUT of the
              # digest entirely. Those rows are inside the captured id set, pass
              # the count assertion, and are rewritten with nothing about their
              # before-state ever hashed. Choosing a nullable column is enough to
              # carve an arbitrary subset out of the proof.
              #
              # The first top-level comma ends the aggregated expression; the
              # delimiter and ORDER BY follow it.
              function agg_payload(str,   i, ch, depth, start, n) {
                if (match(str, /(^|[^a-z0-9_.])string_agg[ \t]*\(/) == 0) return ""
                start = RSTART + RLENGTH
                depth = 1
                n = length(str)
                for (i = start; i <= n; i++) {
                  ch = substr(str, i, 1)
                  if (ch == "(") depth++
                  else if (ch == ")") { depth--; if (depth == 0) break }
                  else if (ch == "," && depth == 1) break
                }
                return substr(str, start, i - start)
              }
              # Every top-level `||` operand has to be one that cannot be NULL:
              # the row id (a primary key), a whole-row projection, or a value
              # the author wrapped in coalesce/concat_ws. Callers pass
              # literal-stripped text, so quoted separators arrive blank and are
              # skipped.
              function nullsafe(pay,   i, n, ch, depth, cur, parts, np, j, t) {
                np = 0; cur = ""; depth = 0; n = length(pay)
                for (i = 1; i <= n; i++) {
                  ch = substr(pay, i, 1)
                  if (ch == "(") depth++
                  if (ch == ")") depth--
                  if (depth == 0 && ch == "|" && substr(pay, i + 1, 1) == "|") {
                    parts[++np] = cur; cur = ""; i++; continue
                  }
                  cur = cur ch
                }
                parts[++np] = cur
                for (j = 1; j <= np; j++) {
                  t = parts[j]
                  gsub(/[ \t]+/, "", t)
                  if (t == "") continue
                  if (t ~ /^([a-z0-9_]+\.)?id(::[a-z0-9_]+)*$/) continue
                  if (t ~ /^(coalesce|concat_ws|concat|quote_nullable|to_jsonb|to_json|row_to_json|hstore)\(/) continue
                  return 0
                }
                return 1
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
                  # Count assignments to the compared variable BEFORE asking
                  # whether they compute a hash. The check below only ever
                  # counted hash-producing ones, so a plain overwrite —
                  #   SELECT <real digest> INTO actual ...;
                  #   actual := <q><approved digest><q>;
                  # sailed through: the digest is genuinely computed, the
                  # comparison genuinely reads `actual`, and the value it reads
                  # is a constant the author typed. The comparison then passes
                  # no matter how far the population drifted.
                  if (s ~ ("into[ \t]+(strict[ \t]+)?" var "([^a-z0-9_]|$)") ||
                      s ~ ("(^|[^a-z0-9_])" var "[ \t]*:=") ||
                      s ~ ("get[ \t]+((current|stacked)[ \t]+)?diagnostics[ \t]+([^;]*,[ \t]*)?" var "[ \t]*:?=")) nassign++
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
                  if (!nullsafe(agg_payload(span))) {
                    print "builds the hashed value by concatenating something that can be NULL — in SQL any concatenation with NULL is NULL and string_agg() skips NULL inputs, so every row with an unset value in that expression drops OUT of the digest while still passing the count assertion, and is rewritten with nothing about it ever hashed. Hash to_jsonb(<alias>.*) over the rewritten table, or wrap each value in coalesce()"; exit
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
                # Exactly one assignment, all the way through to the comparison.
                # One hash statement is not enough on its own if something else
                # writes the same variable afterwards, because the comparison
                # tests whatever it holds LAST.
                if (nassign > nstmt) {
                  print "assigns " var " again without computing a digest — the comparison tests whatever that later statement left there, so the digest it appears to check proves nothing. Assign the compared variable exactly once"; exit
                }
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
                # ---- THE CANONICAL FULL BEFORE-STATE (Codex High, round 20) --
                # Round 20 widened what a digest has to cover from "the columns
                # you assign" to "everything material about the row" — for
                # `orders` that is nine columns, and an author enumerating nine
                # columns by hand will eventually drop one. The first remedy
                # Codex recommended was a canonical full before-state, so
                # that shape is accepted here as satisfying coverage outright:
                # `to_jsonb(o.*)` hashes every column the row has, which is a
                # provable superset of any list this check could name.
                #
                # Single-table repairs ONLY. A whole-row projection names no
                # table, so on a two-table repair one `to_jsonb(o.*)` would
                # excuse the columns of the table it does NOT cover. Enumerate
                # in that case; the shortcut is not worth a fail-open.
                # Count the REAL entries: tbllist arrives space-terminated, so
                # split() hands back a trailing empty field and a plain
                # `ntbl == 1` would never be true for a single-table repair.
                nrealtbl = 0
                wrtbl = ""
                for (k = 1; k <= ntbl; k++) if (tb[k] != "") { nrealtbl++; wrtbl = tb[k] }
                # The alias inside the projection has to be the rewritten table
                # or an alias declared on it — see THE PROJECTION MUST BE THE
                # REWRITTEN ROW above.
                wholerow = 0
                if (nrealtbl == 1 && wr_alias_ok(spanall, stmtall, wrtbl)) wholerow = 1
                missc = ""
                for (k = 1; k <= ncol; k++) {
                  if (c[k] == "") continue
                  if (!tok_in(spanall, c[k])) missc = missc " " c[k]
                }
                if (missc != "" && !wholerow) {
                  print "leaves the rewritten column(s)" missc " outside the hashed expression — every column the migration assigns has to be covered, not just one of them. Hash to_jsonb(<alias>.*), where <alias> is the rewritten table itself, to bind the whole row at once"; exit
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
            ' "$PROOF_FILE")
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
            # EVERY line is stripped, but only the lines from the comparison
            # onward are walked.
            {
              l = strip($0)
              if (FNR >= dl) buf = buf " " l
            }
            # SCOPE IS A STATEMENT, NOT A PHYSICAL LINE (Codex High, round 19).
            # The old walk gave each line a single depth, so a line that opened
            # an IF and closed it again changed nothing — and
            #
            #   IF actual IS DISTINCT FROM <q>...<q> THEN
            #     IF false THEN RAISE EXCEPTION <q>drift<q>; END IF;
            #   END IF;
            #
            # put a RAISE the guard would find at depth one while the branch
            # fell straight through to the write, because the raise it found
            # can never run. Walking words instead means a nested block opens
            # and closes exactly where it really does, on one line or twenty.
            END {
              gsub(/[^a-z0-9_]+/, " ", buf)
              n = split(buf, w, / +/)
              started = 0; depth = 0; nested = 0
              for (i = 1; i <= n; i++) {
                # Anything ahead of the comparison IF is not inside its branch.
                if (!started) {
                  if (w[i] == "end" && w[i + 1] == "if") { i++; continue }
                  if (w[i] == "if") { started = 1; depth = 1 }
                  continue
                }
                # A BLOCK THAT NEVER RUNS IS NOT AN ABORT (Codex High, round 31).
                # Reaching the RAISE was measured by IF nesting alone, so a RAISE
                # parked inside a block that never iterates counted as the abort:
                #
                #   IF actual IS DISTINCT FROM <approved hex> THEN
                #     WHILE false LOOP
                #       RAISE EXCEPTION APPROVED_SET_DRIFTED ...;
                #     END LOOP;
                #   END IF;
                #
                # The branch falls straight through to the write. A LOOP or CASE
                # opened inside the branch must now close before a RAISE counts.
                # A nested BEGIN is equally unsafe: its EXCEPTION handler can
                # swallow the RAISE and let the protected write continue. The
                # accepted abort therefore has to be directly in the mismatch
                # arm, outside every nested procedural block.
                # A CASE *expression* ends with a bare END rather than END CASE,
                # so one in this branch leaves the nesting open and the migration
                # is reported: a false alarm, not a hole, and this branch is a
                # single RAISE in every real repair.
                if (w[i] == "end" && (w[i + 1] == "loop" || w[i + 1] == "case")) {
                  if (nested > 0) nested--
                  i++
                  continue
                }
                if (w[i] == "loop" || w[i] == "case") { nested++; continue }
                if (w[i] == "begin") { nested++; continue }
                if (w[i] == "end" && w[i + 1] != "if" && w[i + 1] != "loop" && w[i + 1] != "case") {
                  if (nested > 0) nested--
                  continue
                }
                if (w[i] == "end" && w[i + 1] == "if") {
                  depth--
                  if (depth <= 0) exit
                  i++
                  continue
                }
                if (w[i] == "if") { depth++; continue }
                if (depth == 1 && nested == 0 && (w[i] == "else" || w[i] == "elsif" || w[i] == "elseif")) exit
                if (depth == 1 && nested == 0 && w[i] == "raise" && w[i + 1] == "exception") { print "yes"; exit }
              }
            }
          ' "$PROOF_FILE" | grep -c yes || true)

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
              # ---- A COMMENT IS NOT A ROW LOCK (Codex High, round 21) --------
              # This check used to remove `--` comments and nothing else, then
              # search the capture statement textually for FOR UPDATE. So
              # `SELECT array_agg(...) /* FOR UPDATE */ FROM ...` satisfied it
              # while taking no lock at all, and so did a string literal saying
              # the same thing. Both decoys leave the approved rows unlocked
              # between the digest and the write — the exact race the lock
              # exists to close. Comments and quoted literals now come out
              # through a stateful scanner, the same shape used by the
              # apply-time guard: nesting is tracked, a literal is not read as
              # syntax, and a `--` inside either is not read as a comment.
              function strip_noise(s,   out, i, c, d, n) {
                out = ""; i = 1; n = length(s)
                while (i <= n) {
                  c = substr(s, i, 1)
                  d = substr(s, i, 2)
                  if (blk > 0) {
                    if (d == "/*") { blk++; i += 2; continue }
                    if (d == "*/") { blk--; i += 2; continue }
                    i++; continue
                  }
                  if (instr) {
                    if (c == "'"'"'") {
                      # Two in a row is an escaped quote INSIDE the literal, not
                      # the end of it. Reading it as the end would put the rest
                      # of the literal back into the syntax stream.
                      if (substr(s, i + 1, 1) == "'"'"'") { i += 2; continue }
                      instr = 0
                    }
                    i++; continue
                  }
                  if (d == "/*") { blk++; i += 2; out = out " "; continue }
                  if (d == "--") break
                  if (c == "'"'"'") { instr = 1; out = out " "; i++; continue }
                  out = out c; i++
                }
                return out
              }
              { l = strip_noise(tolower($0)); all = all " " l; if (FNR < fl) buf = buf " " l }
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
                #
                # ROUND 31 (Codex High). An ELEMENT write is a write, and none of
                # them were counted: `v_ids[1] := <some other id>` puts a subscript
                # between the name and the `:=`, so the pattern below matched
                # nothing and the approved set could be edited id by id after the
                # digest had already passed. Every write reachable to the digest
                # comparison had been closed except the narrowest one. A subscript
                # cannot contain `=`, so it can be skipped over without needing to
                # parse what is inside it.
                #
                # ROUND 53 (Codex High). A procedure call can write an OUT or
                # INOUT argument back into the caller variable without either
                # assignment spelling appearing at the call site. For example,
                # `CALL swap_ids(v_ids)` can replace the approved array after it
                # was hashed, then let the write and same-length count assertion
                # operate on an unapproved population. Parameter modes cannot be
                # proven for every resident or overloaded procedure from this
                # migration alone, so a CALL that receives the captured variable
                # is conservatively a second write. A procedure that only needs
                # to read the ids must receive a derived value instead of the
                # load-bearing proof variable.
                m = split(all, at, /;/)
                for (i = 1; i <= m; i++) {
                  s = at[i]
                  callarg = 0
                  looptarget = 0
                  if (match(s, /(^|[^a-z0-9_])call([^a-z0-9_]|$)/)) {
                    # Inspect only text after the procedure identity and its
                    # opening parenthesis. Otherwise `CALL v_ids(1)` mistakes
                    # the routine name for an argument that can be written back.
                    calltail = substr(s, RSTART + RLENGTH)
                    callopen = index(calltail, "(")
                    if (callopen > 0 && substr(calltail, callopen + 1) ~ ("(^|[^a-z0-9_])" var "([^a-z0-9_]|$)"))
                      callarg = 1
                  }
                  # FOR and FOREACH assign into their loop target on every
                  # iteration. That write-back can replace a captured proof
                  # variable without spelling INTO, :=, =, or CALL.
                  if (s ~ ("(^|[^a-z0-9_])foreach[ \t]+" var "([^a-z0-9_]|$)") ||
                      s ~ ("(^|[^a-z0-9_])for[ \t]+" var "([^a-z0-9_]|$)"))
                    looptarget = 1
                  if (s ~ ("into[ \t]+(strict[ \t]+)?" var "([^a-z0-9_]|$)") ||
                      s ~ (var "[ \t]*(\\[[^=]*\\][ \t]*)*:=") ||
                      callarg || looptarget)
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
            ' "$PROOF_FILE")
            case "$CAPTURE_STATUS" in
              OK) ;;
              reassigned*)
                SET_BIND_WHY="'$DIGEST_SET_VAR' is assigned or passed to a possibly OUT/INOUT procedure $(printf '%s' "$CAPTURE_STATUS" | cut -f2) times in this migration. The digest, the write and the row-count assertion all name that one variable, so a second write-back means the rows hashed and the rows written need not be the same rows — and this validator cannot prove procedure parameter modes or tell which value reaches which statement. Capture the approved ids once and never write to or pass '$DIGEST_SET_VAR' through CALL again; if a second population genuinely needs repairing, that is a second migration." ;;
              no-lock)
                SET_BIND_WHY="'$DIGEST_SET_VAR' is captured without FOR UPDATE, so the approved rows are not locked between the digest and the write and a concurrent change lands unnoticed. Capture them as: SELECT array_agg(s.id ORDER BY s.id) INTO $DIGEST_SET_VAR FROM (SELECT t.id FROM <table> t WHERE <approved predicate> ORDER BY t.id FOR UPDATE) s;" ;;
              no-agg)
                SET_BIND_WHY="'$DIGEST_SET_VAR' is assigned before line $FIRST_REWRITE_LINE but not by an array_agg() capture of the approved ids, so what the digest and the writes are restricted to is not a set this migration read out of the table" ;;
              *)
                SET_BIND_WHY="the digest and the writes are restricted to '$DIGEST_SET_VAR', but nothing before line $FIRST_REWRITE_LINE captures that array from the table — an id set that is not read out of the database approves nothing" ;;
            esac
          fi

          if [ -z "$SET_BIND_WHY" ] && [ "$COMPUTED" -eq 1 ] && [ -n "$DIGEST_SET_VAR" ]; then
            COUNT_STATUS=$(awk -v var="$DIGEST_SET_VAR" -v Q="'" -v tables="$BUSINESS_ROW_TABLES" '
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
              # Does a RAISE EXCEPTION govern the branch opened at line `from`?
              # Scope is a STATEMENT, not a physical line (Codex High, round
              # 19): a line holding both an IF and its END IF used to change
              # nothing, so `IF false THEN RAISE EXCEPTION ...; END IF;` written
              # on the assertion line itself read as an abort while being
              # unreachable. Walking words puts every nested block exactly where
              # it opens and closes.
              # ROUND 31 (Codex High). Reaching the RAISE was read as depth of IF
              # nesting alone, so a RAISE wrapped in a block that never iterates
              # counted as an abort:
              #
              #   IF actual IS DISTINCT FROM <approved hex> THEN
              #     WHILE false LOOP
              #       RAISE EXCEPTION APPROVED_SET_DRIFTED ...;
              #     END LOOP;
              #   END IF;
              #
              # The mismatch arm is entered and nothing happens — the same shape
              # round 19 closed for `IF false THEN RAISE`, rebuilt out of a loop.
              # So LOOP, CASE, and nested BEGIN blocks count as nesting too,
              # and the RAISE has to sit outside all of it. A nested BEGIN can
              # catch its own RAISE in an EXCEPTION handler and continue. A
              # CASE *expression* closes with a bare END
              # rather than END CASE, so one in this branch leaves the nesting
              # open and the migration is reported: a false alarm, not a hole,
              # and this branch is a single RAISE in every real repair.
              function raise_at_depth1(from,   j, b, nn, w, k, depth, started, nested) {
                b = ""
                for (j = from; j <= n; j++) b = b " " ln[j]
                gsub(/[^a-z0-9_]+/, " ", b)
                nn = split(b, w, / +/)
                started = 0; depth = 0; nested = 0
                for (k = 1; k <= nn; k++) {
                  if (!started) {
                    if (w[k] == "end" && w[k + 1] == "if") { k++; continue }
                    if (w[k] == "if") { started = 1; depth = 1 }
                    continue
                  }
                  if (w[k] == "end" && (w[k + 1] == "loop" || w[k + 1] == "case")) {
                    if (nested > 0) nested--
                    k++
                    continue
                  }
                  if (w[k] == "loop" || w[k] == "case") { nested++; continue }
                  if (w[k] == "begin") { nested++; continue }
                  if (w[k] == "end" && w[k + 1] != "if" && w[k + 1] != "loop" && w[k + 1] != "case") {
                    if (nested > 0) nested--
                    continue
                  }
                  if (w[k] == "end" && w[k + 1] == "if") {
                    depth--
                    if (depth <= 0) return 0
                    k++
                    continue
                  }
                  if (w[k] == "if") { depth++; continue }
                  # The ELSE arm is not the mismatch arm (round 13).
                  if (depth == 1 && nested == 0 && (w[k] == "else" || w[k] == "elsif" || w[k] == "elseif")) return 0
                  if (depth == 1 && nested == 0 && w[k] == "raise" && w[k + 1] == "exception") return 1
                }
                return 0
              }
              # How many times is `v` assigned before line `stop`? Every form
              # counts: every CURRENT/STACKED diagnostics target, a plain `:=`,
              # and a SELECT ... INTO. Each diagnostics prefix is blanked as it
              # is counted so its target is not counted again as plain syntax.
              function assign_count(v, stop,   j, c, na) {
                na = 0
                for (j = 1; j < stop; j++) {
                  c = ln[j]
                  na += gsub(("get[ \t]+((current|stacked)[ \t]+)?diagnostics[ \t]+([^;]*,[ \t]*)?" v "[ \t]*:?=[^,;]*"), " @ ", c)
                  na += gsub(("(^|[^a-z0-9_])" v "[ \t]*:="), " @ ", c)
                  na += gsub(("into[ \t]+(strict[ \t]+)?" v "([^a-z0-9_]|$)"), " @ ", c)
                }
                return na
              }
              # ---- ROW_COUNT BELONGS TO THE LAST STATEMENT (Codex High, r31) --
              # Every check above treats the counter as though it measured the
              # protected write. It does not. ROW_COUNT is a property of the most
              # recent statement the engine ran, whatever that was, so one
              # statement slipped in between detaches the measurement from the
              # write without touching anything the earlier rounds look at:
              #
              #   UPDATE public.orders SET total_profit = 0 WHERE id = ANY(v_ids);
              #   PERFORM 1 FROM unnest(v_ids);
              #   GET DIAGNOSTICS n = ROW_COUNT;
              #   IF n <> array_length(v_ids, 1) THEN RAISE EXCEPTION ...
              #
              # `unnest` returns exactly array_length(v_ids, 1) rows, so `n` is
              # the approved count by construction and the assertion compares it
              # with itself — the round-19 defect again, rebuilt out of an extra
              # statement instead of an extra assignment. The UPDATE meanwhile
              # may have touched no rows at all and the migration reports success.
              #
              # So the statement immediately before the GET DIAGNOSTICS has to be
              # DML on a protected table. Statements are split on `;` and empty
              # chunks skipped, which is what lets a comment or a blank line sit
              # between the write and its measurement; anything that executes may
              # not.
              function dml_precedes(gline,   j, s, nc, ch, k, last) {
                s = ""
                for (j = 1; j <= gline; j++) s = s " " ln[j]
                if (match(s, /get[ \t]+diagnostics/)) s = substr(s, 1, RSTART - 1)
                nc = split(s, ch, /;/)
                for (k = nc; k >= 1; k--) {
                  last = ch[k]
                  gsub(/[ \t]+/, " ", last)
                  gsub(/^ +| +$/, "", last)
                  if (last == "") continue
                  return (last ~ ("(^|[^a-z0-9_])(update|merge([ \t]+into)?|delete[ \t]+from|insert[ \t]+into|truncate([ \t]+table)?)[ \t]+(only[ \t]+)?(public\\.)?(" tables ")([^a-z0-9_]|$)"))
                }
                return 0
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
                  # AND ASSIGNED EXACTLY ONCE ON THE WAY THERE (Codex High,
                  # round 19). Requiring only that SOME GET DIAGNOSTICS had
                  # written the variable earlier let a later plain assignment
                  # replace the measurement:
                  #   GET DIAGNOSTICS v_n = ROW_COUNT;
                  #   v_n := array_length(v_ids, 1);
                  # The assertion then compares the approved count with itself
                  # — canonical shape, measuring nothing. If a repair really
                  # writes twice, give each write its own counter.
                  reasg = 0
                  for (v in rcln) {
                    if (ln[i] !~ ("(^|[^a-z0-9_])" v "([^a-z0-9_]|$)")) continue
                    if (assign_count(v, i) != 1) reasg = 1
                  }
                  if (reasg) { reassigned = 1; continue }
                  # ...and it must have measured the WRITE, not whatever ran last.
                  detached = 0
                  for (v in rcln) {
                    if (ln[i] !~ ("(^|[^a-z0-9_])" v "([^a-z0-9_]|$)")) continue
                    if (rcln[v] >= i) continue
                    if (!dml_precedes(rcln[v])) detached = 1
                  }
                  if (detached) { intervening = 1; continue }
                  if (raise_at_depth1(i)) { print "OK"; exit }
                }
                if (intervening) { print "intervening-statement"; exit }
                if (reassigned) { print "reassigned-count"; exit }
                if (operand) { print "unbound-count"; exit }
                if (polarity) { print "polarity"; exit }
                print "no-assert"
              }
            ' "$PROOF_FILE")
            case "$COUNT_STATUS" in
              OK) ;;
              no-count)
                SET_BIND_WHY="the writes never capture GET DIAGNOSTICS <n> = ROW_COUNT, so a rewrite that silently touched fewer rows than were approved would still report success" ;;
              intervening-statement)
                SET_BIND_WHY="another statement runs between the protected write and the GET DIAGNOSTICS that is supposed to measure it. ROW_COUNT reports the LAST statement the engine ran, not the write, so the counter holds that statement's row count — a PERFORM over the approved ids, for example, makes the assertion compare the approved count with itself while the write may have touched no rows at all. Put GET DIAGNOSTICS <n> = ROW_COUNT immediately after the write, with nothing executable between them" ;;
              reassigned-count)
                SET_BIND_WHY="the row count it compares is assigned more than once before the assertion, so what the assertion reads is whatever was written last — a later \`<n> := array_length($DIGEST_SET_VAR, 1)\` turns the check into the approved count compared with itself. Let exactly one GET DIAGNOSTICS <n> = ROW_COUNT assign it, and give a second write its own counter" ;;
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
        else
          # Ask the registry the same question the guards ask it. A text search
          # for the stem is not that question: `"20260810_x": "…"` sitting in
          # the `_comment` block, or in any other object in the file, matches a
          # grep and means nothing to the apply-time guard or the replay
          # planner, both of which read `registry.one_shot` and nothing else. So
          # parse the JSON, insist `one_shot` really is a plain object, and
          # require the stem to be an OWN property of it — inherited names like
          # `constructor` or `toString` would otherwise answer yes for free.
          # Anything unreadable, unparseable, or shaped wrong fails closed.
          REGISTRY_WHY=$(ONE_SHOT_REGISTRY="$ONE_SHOT_REGISTRY" MIG_STEM="$MIG_STEM" node -e "
            const fs = require('fs');
            const path = process.env.ONE_SHOT_REGISTRY;
            const stem = process.env.MIG_STEM;
            let raw;
            try { raw = fs.readFileSync(path, 'utf8').replace(/^﻿/, ''); }
            catch (e) { console.log('could not be read: ' + e.message); process.exit(0); }
            let reg;
            try { reg = JSON.parse(raw); }
            catch (e) { console.log('is not valid JSON: ' + e.message); process.exit(0); }
            if (reg === null || typeof reg !== 'object' || Array.isArray(reg)) {
              console.log('is not a JSON object'); process.exit(0);
            }
            const map = reg.one_shot;
            if (map === null || typeof map !== 'object' || Array.isArray(map)) {
              console.log('has no one_shot object'); process.exit(0);
            }
            if (!Object.prototype.hasOwnProperty.call(map, stem)) {
              console.log('does not list this migration in one_shot'); process.exit(0);
            }
            const why = map[stem];
            if (typeof why !== 'string' || why.trim() === '') {
              console.log('lists this migration in one_shot with no note saying which population approved it');
              process.exit(0);
            }
          " 2>&1)

          if [ -n "$REGISTRY_WHY" ]; then
            echo "VIOLATION: $file"
            echo "  Approved-set repair is not registered as one-shot."
            echo "  The registry ${ONE_SHOT_REGISTRY#./}"
            echo "    $REGISTRY_WHY."
            echo "  Add \"$MIG_STEM\" as a key of the one_shot object, with one line"
            echo "  saying which population it was approved against. Until it is"
            echo "  there, list-post-baseline-migrations.mjs will put it in a replay"
            echo "  plan and the apply-time one-shot guard will not recognise it, so"
            echo "  it can rewrite a restored population that never approved it."
            echo "  A key anywhere else in the file does not count: both guards read"
            echo "  registry.one_shot and nothing else."
            echo ""
            VIOLATIONS=$((VIOLATIONS + 1))
          fi
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

        # A NO-OP `ADD COLUMN` IS NOT AN ADDED COLUMN (Codex High, round 23).
        # The scan above accepts `ADD COLUMN IF NOT EXISTS total_profit` as
        # proof the migration adds that column. On a column that already
        # exists the ALTER does nothing at all, so the very next statement
        # rewrites a pre-existing money population under a waiver that claims
        # there was nothing there to protect:
        #
        #   -- APPROVED_SET_DIGEST: NOT-REQUIRED (orders)
        #   ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total_profit numeric;
        #   UPDATE public.orders SET total_profit = 0;
        #
        # The file alone cannot tell the two apart — whether the column is new
        # is a fact about the database, not about this text. So the claim is
        # checked against the trusted base: a column the schema registry
        # already lists is not one this migration adds, and drops out of the
        # added set, which puts its rewrite back under the digest requirement.
        # Fails closed — if the registry cannot be read, nothing counts as
        # added and every waived column is refused.
        if [ -n "$ADDED_COLS" ]; then
          ADDED_COLS=$(printf '%s\n' "$ADDED_COLS" | node -e "
const fs = require('fs');
const reg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const cols = reg.columns || {};
const known = (t, c) => {
  const v = cols[t];
  if (!v) return false;                       // not in the trusted base
  const list = Array.isArray(v) ? v : Object.keys(v);
  return list.includes(c);
};
const out = [];
for (const line of fs.readFileSync(0, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [t, c] = line.split('\t');
  if (!t || !c) continue;
  if (known(t, c)) continue;                  // pre-existing: the ALTER is a no-op
  out.push(t + '\t' + c);
}
process.stdout.write(out.join('\n'));
" "$APPROVED_SET_REGISTRY" 2>/dev/null || true)
        fi

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
          echo "  Note: an ADD COLUMN IF NOT EXISTS on a column the schema registry"
          echo "  already lists does nothing, so it does not make that column new."
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

  # The ordinary migration diagnostics above are more specific. Report the
  # session-catalog boundary last so it cannot hide the direct write/dynamic
  # routine reason, but still before per-file hash reconciliation.
  if [ "$MIG_IS_HISTORY" -eq 0 ] && [ -n "$TRIGGER_FANOUT_SESSION_EVENTS" ] &&
     [ -n "$EVENT_CATALOG_RISK_FILES" ] &&
     printf '%s\n' "$EVENT_CATALOG_RISK_FILES" | grep -Fqx -- "$file"; then
    echo "VIOLATION: $file"
    echo "  Session-dependent PostgreSQL event trigger helper cannot be bound safely for this migration."
    echo "  The migration changes search_path or has an unresolved apply-time effect."
    echo "  Affected live trigger(s): $(printf '%s' "$TRIGGER_FANOUT_SESSION_EVENTS" | tr '\n' ' ')"
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # ----- hash-pinned exemption for THIS file (see SQL_AUDIT_EXEMPTIONS) -----
  # Reached only on the full check path; --idempotency-only continues above and
  # is never run with a baseline, so there is nothing to exempt there.
  EX_BASE=$(basename "$file")
  EX_ALLOW=$(printf '%s\n' "$EXEMPT_ROWS" | awk -v b="$EX_BASE" '$1 == b { print $2; exit }')
  if [ -n "$EX_ALLOW" ]; then
    FILE_VIOL=$((VIOLATIONS - FILE_VIOL_BEFORE))
    EX_USED=$FILE_VIOL
    if [ "$EX_USED" -gt "$EX_ALLOW" ]; then EX_USED=$EX_ALLOW; fi
    VIOLATIONS=$((VIOLATIONS - EX_USED))
    EXEMPTED_TOTAL=$((EXEMPTED_TOTAL + EX_USED))
    if [ "$FILE_VIOL" -gt "$EX_ALLOW" ]; then
      echo "NOTE: $EX_BASE has $FILE_VIOL violation(s) but only $EX_ALLOW are exempt —"
      echo "  the extra $((FILE_VIOL - EX_ALLOW)) count against the baseline."
      echo ""
    elif [ "$FILE_VIOL" -lt "$EX_ALLOW" ]; then
      EXEMPT_STALE="${EXEMPT_STALE}    $EX_BASE: exempts $EX_ALLOW, now violates $FILE_VIOL
"
    elif [ "$FILE_VIOL" -gt 0 ]; then
      # Say so explicitly. The VIOLATION block above was printed before this
      # reconciliation ran, so without this line the log shows findings and a
      # total of zero, and an exempted finding reads exactly like a live one.
      echo "NOTE: the $FILE_VIOL violation(s) above in $EX_BASE are hash-pinned"
      echo "  exemptions and do NOT count against the baseline."
      echo ""
    fi
  fi
done

echo "============================================"
echo "  Audit Complete"
echo "  Files scanned: $FILE_COUNT"
echo "  Violations:    $VIOLATIONS"
echo "  Warnings:      $WARNINGS"
if [ "$EXEMPTED_TOTAL" -gt 0 ]; then
  echo "  Exempted:      $EXEMPTED_TOTAL (hash-pinned, see scripts/sql-audit-hash-exemptions.txt)"
fi
echo "============================================"

# A pinned row that no longer fires is headroom nobody is watching. Say so, so
# it gets removed instead of quietly staying available to something else.
if [ -n "$EXEMPT_STALE" ]; then
  echo ""
  echo "STALE EXEMPTIONS — these rows now allow more than the file produces."
  echo "Lower or delete them in scripts/sql-audit-hash-exemptions.txt:"
  printf '%s' "$EXEMPT_STALE"
fi

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
