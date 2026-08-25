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
//   Applying a migration that is OLDER than something ALREADY APPLIED is a
//   replay of superseded SQL. Forward-only means the fix goes in a NEW file
//   with a NEW timestamp — never by re-running an old one.
//
// COMPARE AGAINST THE APPLIED LEDGER, NOT THE DISK
//   An earlier draft of this module compared against every filename in
//   supabase/migrations/. That was wrong, and both Codex and CodeRabbit caught
//   it independently on PR #348: a file on disk is not proof it was applied.
//   Applying a batch of four new migrations in correct ascending order would
//   have blocked the first three, because each would see the later siblings
//   sitting on disk. The comparison set must be what the DATABASE has already
//   run.
//
// WHY THE EFFECTIVE ROW STAMP AND NOT A BARE LEDGER VERSION
//   This is the "B7 class" trap the audit documented: live ledger `name`
//   values are inconsistently formatted — some carry the authored timestamp,
//   some carry `.sql`, and some are bare slugs. The snapshot producer in
//   scripts/refresh-applied-migrations.mjs keeps a timestamped `name` when one
//   exists and otherwise synthesizes `<version>_<name>` for that row. This
//   module then normalizes either shape and extracts the row's effective stamp.
//   Comparing against a bare version aggregate loses the name context and
//   manufactures false drift; dropping timestamp-less names loses their only
//   conservative ordering signal.

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
  // original filename itself starts with its own timestamp. Collapse that —
  // this is the exact shape of the row that caused the 2026-07-15 revert.
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
 * @param {string} args.name          migration name being applied
 * @param {string} args.sql           its SQL body (searched for the marker)
 * @param {string[]} args.appliedNames names ALREADY APPLIED per the live
 *   ledger (supabase_migrations.schema_migrations). NOT filenames from disk.
 *   When this is empty or unavailable the check abstains — see `abstained`.
 * @returns {{ok: boolean, abstained?: boolean, reason?: string, newestApplied?: string, timestamp?: string}}
 */
export function checkMigrationOrdering({ name, sql, appliedNames }) {
  const ts = migrationTimestamp(name);

  // No parseable timestamp: not this guard's business. Naming conventions are
  // enforced elsewhere, and blocking here would be a false positive on any
  // ad-hoc apply.
  if (!ts) return { ok: true, abstained: true };

  // No knowledge of what has been applied → no basis for a verdict. Abstain
  // rather than guess: a wrong block here would stop legitimate forward
  // migrations, and the apply guard's proof/Codex gates still apply. The
  // caller is expected to surface the abstention rather than read it as a pass.
  if (!Array.isArray(appliedNames) || appliedNames.length === 0) {
    return { ok: true, abstained: true };
  }

  const stamps = appliedNames
    .map(migrationTimestamp)
    .filter(Boolean)
    // A re-apply of the very same migration is a different concern (idempotency,
    // not ordering), so its own timestamp never counts against it.
    .filter((s) => s !== ts);

  if (!stamps.length) return { ok: true, abstained: true };

  const newestApplied = stamps.reduce((a, b) => (b > a ? b : a));
  if (ts >= newestApplied) return { ok: true, timestamp: ts, newestApplied };

  const marker = hasIntentionalReplayMarker(sql);
  if (marker.marked) {
    return { ok: true, timestamp: ts, newestApplied, reason: `intentional replay: ${marker.reason}` };
  }

  return {
    ok: false,
    timestamp: ts,
    newestApplied,
    reason:
      `MIGRATION ORDERING GUARD: refusing to apply "${normalizeMigrationName(name)}".\n` +
      `Its filename timestamp is ${ts}, but ${newestApplied} has ALREADY BEEN APPLIED — this is an ` +
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
