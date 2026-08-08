// Migration ordering preflight — the durable prevention for the 2026-08-08
// "out-of-order replay" defect (docs/audits/2026-08-08-foundation-ultra-review.md §2).
//
// WHAT WENT WRONG
//   20260714220000_shared_idempotency_and_hold_hardening renamed
//   batch_apply_prepayments to _batch_apply_prepayments_impl and added a thin
//   wrapper enforcing AUTH_REQUIRED / ACTOR_MISMATCH. The ledger then recorded:
//
//     20260714220000 | shared_idempotency_and_hold_hardening
//     20260715134618 | 20260714185130_gate_batch_prepay_admin   <-- OLDER file
//
//   The older FILE was applied under a NEWER ledger version, re-creating the
//   function from its pre-rename body and silently discarding the guard. No
//   test, hook, or gate caught it. It surfaced only because an audit
//   hash-compared all 566 live functions against disk.
//
// THE RULE
//   Applying a migration whose own filename timestamp is OLDER than the newest
//   migration already on disk is a replay of superseded SQL. Forward-only means
//   the fix goes in a NEW file with a NEW timestamp — never by re-running an
//   old one. This module makes that mechanical rather than a matter of
//   remembering.
//
// WHY THE FILENAME AND NOT THE LEDGER VERSION
//   This is the "B7 class" trap the audit documented: live ledger `name` values
//   are inconsistently formatted — some carry the version prefix, some carry
//   `.sql`, some carry neither. Comparing versions to versions manufactures
//   false drift. The FILENAME timestamp is the stable, self-describing fact, so
//   that is what this compares. Normalisation below strips the prefix/suffix
//   noise before reading the timestamp.

const TS_RE = /(\d{14})/;

/**
 * Strip the noise the live ledger adds to migration names so a name from any
 * source reduces to the same shape: leading path, trailing `.sql`, and a
 * duplicated leading `<version>_` prefix.
 */
export function normalizeMigrationName(raw) {
  let name = (raw ?? "").toString().trim();
  if (!name) return "";
  name = name.replace(/^.*[/\\]/, "");
  name = name.replace(/\.sql$/i, "");
  // A ledger row may be recorded as "<version>_<original-filename>", where the
  // original filename itself starts with its own timestamp. Collapse that.
  const doubled = name.match(/^(\d{14})_(\d{14}_.*)$/);
  if (doubled) name = doubled[2];
  return name;
}

/** Extract the 14-digit timestamp a migration name embeds, or null. */
export function migrationTimestamp(raw) {
  const name = normalizeMigrationName(raw);
  const m = name.match(/^(\d{14})/) || name.match(TS_RE);
  return m ? m[1] : null;
}

/**
 * An explicit, auditable escape hatch. A migration that genuinely must carry an
 * older timestamp states so in its own SQL:
 *
 *   -- ordering-guard: intentional-replay <reason>
 *
 * The reason is required — a bare marker does not unlock the guard, so this
 * cannot be pasted in reflexively to make the block go away.
 */
export function hasIntentionalReplayMarker(sql) {
  const m = (sql ?? "").toString()
    .match(/--\s*ordering-guard:\s*intentional-replay\s+(\S.*)$/im);
  if (!m) return { marked: false, reason: "" };
  const reason = m[1].trim();
  return { marked: reason.length >= 8, reason };
}

/**
 * Decide whether an apply is an out-of-order replay.
 *
 * @param {object} args
 * @param {string} args.name        migration name being applied
 * @param {string} args.sql         its SQL body (searched for the marker)
 * @param {string[]} args.diskNames every filename in supabase/migrations/
 * @returns {{ ok: boolean, reason?: string, newest?: string, timestamp?: string }}
 */
export function checkMigrationOrdering({ name, sql, diskNames }) {
  const ts = migrationTimestamp(name);

  // No parseable timestamp: not this guard's business. Naming conventions are
  // enforced elsewhere, and blocking here would be a false positive on any
  // ad-hoc apply.
  if (!ts) return { ok: true };

  const stamps = (diskNames || [])
    .map(migrationTimestamp)
    .filter(Boolean)
    // The file being applied is normally already on disk; it cannot supersede
    // itself, so drop every copy of its own timestamp.
    .filter((s) => s !== ts);

  if (!stamps.length) return { ok: true };

  const newest = stamps.reduce((a, b) => (b > a ? b : a));
  if (ts >= newest) return { ok: true, timestamp: ts, newest };

  const marker = hasIntentionalReplayMarker(sql);
  if (marker.marked) {
    return { ok: true, timestamp: ts, newest, reason: `intentional replay: ${marker.reason}` };
  }

  return {
    ok: false,
    timestamp: ts,
    newest,
    reason:
      `MIGRATION ORDERING GUARD: refusing to apply "${normalizeMigrationName(name)}".\n` +
      `Its filename timestamp is ${ts}, but ${newest} already exists on disk — this is an ` +
      `OLDER migration being applied AFTER a newer one.\n\n` +
      `That is exactly how the batch_apply_prepayments actor guard was silently reverted on ` +
      `2026-07-15 (see docs/audits/2026-08-08-foundation-ultra-review.md §2): replaying a stale ` +
      `file re-created a function from its pre-fix body and discarded a security guard, and ` +
      `nothing detected it for three weeks.\n\n` +
      `Migrations are FORWARD-ONLY. Write a NEW migration with a CURRENT timestamp that makes ` +
      `the change you want, rather than re-running this file.\n\n` +
      `If this really is a deliberate replay, say so in the migration's own SQL:\n` +
      `  -- ordering-guard: intentional-replay <why this is safe, 8+ chars>`,
  };
}
