// Pending-set preflight — the durable prevention for the 2026-08-26
// "high-water advanced past a waiting migration" defect.
//
// WHAT WENT WRONG (verified against the live ledger)
//   20260825190000_quote_version_restore_trust_boundary was merged to main and
//   was waiting to be applied. Before it went in,
//   20260826150000_fix_save_job_comment_refusal_count applied live at
//   20:59:35Z. That advanced the ledger's effective high-water from
//   20260820120000 to 20260826150000, which put the older security migration
//   BELOW the high-water — and the ordering guard in ./migration-ordering-lib.mjs
//   then refuses it forever. A migration that was merely waiting became
//   mechanically unappliable, and had to be renumbered to move at all.
//
// This was not the first time. 20260825190000 had ALREADY been renumbered once
// from 20260813180000 for exactly this reason (PR #401). Renumbering is not a
// fix; it is the cost of a check that runs too late.
//
// THE GAP
//   checkMigrationOrdering() compares the candidate only against what is ALREADY
//   APPLIED. Nothing looks at what is WAITING. So an apply can legally step over
//   a tracked, unapplied, older migration and the guard raises no objection —
//   the refusal surfaces later, aimed at the innocent party.
//
// THE RULE
//   Applying migration X while an OLDER tracked-but-unapplied migration exists is
//   an out-of-order apply. It is not always wrong, but it is never accidental, so
//   it must be stated rather than discovered. Apply the older one first, or say
//   explicitly that you are stepping over it.
//
// WHY A SEPARATE MARKER FROM intentional-replay
//   `-- ordering-guard: intentional-replay <reason>` means "this file is an old
//   file I am deliberately re-running". Stepping over a pending migration is a
//   different intent entirely: the candidate is NEW, it is the queue that is out
//   of order. Reusing one marker for both would collapse two distinct decisions
//   into "whatever unblocks the guard", which is how an escape hatch stops
//   carrying information. Hence `-- ordering-guard: ahead-of-pending <reason>`.
//
// TWO SCOPING DECISIONS, BOTH FORCED BY REAL DATA
//   Measured on 2026-08-26 against origin/main (892 migration files) and the live
//   ledger (977 rows), the naive definition of pending — "a file on main whose
//   14-digit stamp is absent from the ledger" — classifies 448 files as pending.
//   They are not. They are applied. Two things break the match:
//
//   1. RENUMBERING. A renumbered migration is recorded with the NEW stamp as the
//      row `version` and the OLD stamp inside the row `name` — e.g. disk
//      20260728182141_secdef_pricing_reads_office_only.sql is live as
//      version 20260728182141 / name 20260728123224_secdef_pricing_reads_office_only.
//      The applied-migration snapshot keeps `name` when it carries a timestamp
//      (scripts/refresh-applied-migrations.mjs), so the version is not available
//      to compare against and the stamps will never agree. The SLUG does agree.
//      So a file counts as applied when EITHER its stamp or its slug matches.
//
//   2. PRE-BASELINE HISTORY. Migrations from the project's early months carry
//      hand-written and sometimes impossible stamps (20260332000000 — month 33),
//      and were applied under versions bearing no relation to the filename. They
//      are unreconstructable, and they are also already settled: the schema
//      baseline in supabase/baselines/manifest.json declares everything at or
//      below `migrations_high_water` to be captured. So the pending scan starts
//      ABOVE that high-water, the same floor scripts/list-post-baseline-migrations.mjs
//      already uses.
//
//   With both rules applied, the pending set on 2026-08-26 was exactly one file:
//   20260825190000_quote_version_restore_trust_boundary.sql. That is the correct
//   answer, and it is the file the incident stranded.
//
//   RESIDUAL, STATED RATHER THAN HIDDEN: a genuinely unapplied migration at or
//   below the baseline high-water is invisible to this check. The baseline
//   asserts there are none. If that assertion is ever falsified, this check will
//   not be what catches it.

const TS_ONLY = /^(\d{14})/;
// 8 to 14 leading digits. The repository's earliest migrations are dated to the
// DAY only — 20260207_gap_analysis_fixes.sql, 20260210_fix_rls_critical_issues.sql —
// and both are on main right now. Treating them as undated made this check abstain,
// and therefore refuse, on every apply forever; the first run of the test suite
// caught exactly that. A day-precision date is still a date, so it is padded to a
// comparable stamp rather than thrown away.
const DATE_PREFIX = /^(\d{8,14})(?:_|$)/;

/** Strip directories and the .sql suffix; keep the rest verbatim. */
export function migrationStem(raw) {
  const BACKSLASH = String.fromCharCode(92);
  return String(raw ?? "")
    .trim()
    .split(BACKSLASH)
    .join("/")
    .split("/")
    .pop()
    .replace(/\.sql$/i, "")
    .trim();
}

/**
 * The identity of a migration with every timestamp prefix removed.
 *
 * A ledger row may carry one stamp (`20260812130145_fix_thing`), two (a
 * renumbered row recorded as `<version>_<original filename>`), or none. The slug
 * is what survives all three, and it is the only field that reliably links a
 * renumbered ledger row back to the file on disk.
 */
export function migrationSlug(raw) {
  return migrationStem(raw).replace(/^(\d{14}_)+/, "").toLowerCase();
}

/** The leading 14-digit stamp of a migration filename, or null. */
export function fileStamp(raw) {
  const m = migrationStem(raw).match(TS_ONLY);
  return m ? m[1] : null;
}

/**
 * A comparable 14-digit stamp for ANY dated migration filename, including the
 * day-precision legacy ones, or null when the name carries no leading date.
 * Padding with zeros puts a day-dated file at the start of its day, which is the
 * conservative end: it can only ever sort EARLIER, never later than it belongs.
 */
export function orderingStamp(raw) {
  const m = migrationStem(raw).match(DATE_PREFIX);
  return m ? m[1].padEnd(14, "0") : null;
}

/**
 * An explicit, auditable escape hatch, deliberately NOT the replay marker.
 *
 *   -- ordering-guard: ahead-of-pending <reason>
 *
 * The reason is required and must be substantive — a bare marker does not unlock
 * the guard, so it cannot be pasted in reflexively to make a block go away.
 */
export function hasAheadOfPendingMarker(sql) {
  const m = String(sql ?? "")
    .match(/--\s*ordering-guard:\s*ahead-of-pending\s+(\S.*)$/im);
  if (!m) return { marked: false, reason: "" };
  const reason = m[1].trim();
  return { marked: reason.length >= 8, reason };
}

/**
 * Build the lookup sets a tracked file is matched against.
 *
 * `slugCounts` — how many applied entries carry each slug — is what makes the
 * slug fallback attributable rather than a bare yes/no. One ledger row bearing a
 * slug can vouch for exactly ONE tracked file with that slug; a second file needs
 * its own evidence. Counting is what lets the check say "that row is already
 * spoken for, so this other file is definitely pending" instead of shrugging.
 *
 * @param {string[]} appliedNames effective names from the applied-migration
 *   snapshot — the same array checkMigrationOrdering() consumes.
 */
export function appliedIndex(appliedNames) {
  const stamps = new Set();
  const slugs = new Set();
  const slugCounts = new Map();
  for (const raw of Array.isArray(appliedNames) ? appliedNames : []) {
    const stem = migrationStem(raw);
    if (!stem) continue;
    // Every 14-digit run in the name counts, not just the leading one: a
    // renumbered row carries the version AND the original stamp, and either may
    // be the one that matches a file on disk.
    for (const m of stem.matchAll(/\d{14}/g)) stamps.add(m[0]);
    const slug = migrationSlug(stem);
    if (slug) {
      slugs.add(slug);
      slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
    }
  }
  return { stamps, slugs, slugCounts };
}

/**
 * Decide whether this apply would step over an older migration that is tracked
 * on main and still waiting.
 *
 * Fails closed by ABSTAINING: like checkMigrationOrdering(), an abstention is
 * `{ok: true, abstained: true}` and the caller is expected to surface it as a
 * refusal, never read it as a pass. Returning ok:false here would conflate
 * "there is a pending migration in the way" with "I could not tell", and the two
 * need different messages.
 *
 * @param {object} args
 * @param {string} args.name            migration name being applied
 * @param {string} args.sql             its SQL body (searched for the marker)
 * @param {string[]} args.appliedNames  effective applied names from the snapshot
 * @param {string[]} args.trackedFiles  paths under supabase/migrations/ present
 *   on origin/main. NOT the working tree: an unmerged file is not yet something
 *   the team is waiting on.
 * @param {string} args.baselineHighWater 14-digit floor from the schema baseline
 * @returns {{ok: boolean, abstained?: boolean, abstainReason?: string, reason?: string,
 *            timestamp?: string, pending?: string[], allowedBy?: string}}
 */
export function checkPendingMigrations({
  name,
  sql,
  appliedNames,
  trackedFiles,
  baselineHighWater,
}) {
  const ts = fileStamp(name);
  if (!ts) {
    return { ok: true, abstained: true, abstainReason: "the migration name carries no 14-digit timestamp" };
  }

  if (!/^\d{14}$/.test(String(baselineHighWater ?? ""))) {
    return {
      ok: true,
      abstained: true,
      abstainReason:
        "the schema baseline high-water is missing or is not a 14-digit version, so the pending " +
        "scan has no floor and would have to judge unreconstructable pre-baseline history",
    };
  }

  if (!Array.isArray(trackedFiles) || trackedFiles.length === 0) {
    return {
      ok: true,
      abstained: true,
      abstainReason: "the set of migrations tracked on origin/main could not be read",
    };
  }

  const { stamps, slugCounts } = appliedIndex(appliedNames);
  if (stamps.size === 0) {
    return {
      ok: true,
      abstained: true,
      abstainReason: "no applied migration carries a 14-digit timestamp to match against",
    };
  }

  // ATTRIBUTION, NOT A YES/NO (Codex P2 rounds 1-2, PR #502).
  //
  // The slug fallback exists for renumbered rows, whose stamps can never match.
  // But a slug is not a unique key here — 20260718225511 and 20260718230000 both
  // end in _supplier_price_evidence_phase1b, and there are two more such pairs.
  // Asking "is this slug in the ledger?" is then the wrong question twice over:
  //
  //   Answer it YES unconditionally and the unapplied twin is marked applied and
  //   silently deleted from the pending set — the exact stranding this guard
  //   exists to prevent, reintroduced inside it.
  //
  //   Answer it "ambiguous" whenever the slug is shared and the check gives up
  //   even when the evidence is conclusive: if one twin matched by its own exact
  //   stamp, that ledger row is spoken for, and the OTHER twin is definitively
  //   pending. Abstaining there is both less accurate and unfixable — renaming
  //   the candidate cannot resolve a pair it is not part of.
  //
  // So COUNT instead. One ledger row bearing a slug vouches for exactly one file.
  // Rows already claimed by an exact-stamp match are spent; only the remainder can
  // vouch for the files that did not match. Then it is arithmetic:
  //   spare >= unmatched  → all applied
  //   spare == 0          → all definitively PENDING
  //   otherwise           → genuinely ambiguous, and only then
  const unmatchedBySlug = new Map();
  const spentBySlug = new Map();
  for (const raw of trackedFiles) {
    const stem = migrationStem(raw);
    if (!stem) continue;
    const slug = migrationSlug(stem);
    const stamp = fileStamp(stem);
    // Applied under its own stamp — conclusive, and settled first so a file that
    // ran can never reach the unorderable branch and abstain the whole check.
    // It also SPENDS one ledger row for its slug, which is what lets a twin be
    // called pending rather than ambiguous.
    if (stamp && stamps.has(stamp)) {
      spentBySlug.set(slug, (spentBySlug.get(slug) ?? 0) + 1);
      continue;
    }
    if (!unmatchedBySlug.has(slug)) unmatchedBySlug.set(slug, []);
    unmatchedBySlug.get(slug).push(stem);
  }

  const pending = [];
  const ambiguous = [];
  const unorderable = [];
  for (const [slug, stems] of unmatchedBySlug) {
    const rows = slugCounts.get(slug) ?? 0;
    const spare = Math.max(0, rows - (spentBySlug.get(slug) ?? 0));
    // Every unmatched file here can be vouched for by a spare row.
    if (spare >= stems.length) continue;

    for (const stem of stems) {
      const ordering = orderingStamp(stem);
      if (!ordering) {
        // No leading date at all: genuinely unorderable, and unapplied. Collected
        // rather than skipped — skipping is how a pending migration goes unseen.
        unorderable.push(stem);
        continue;
      }
      if (ordering <= baselineHighWater) continue;  // captured by the schema baseline
      if (ordering >= ts) continue;                 // not older than the candidate
      // No row left to vouch for anything with this slug → definitively pending.
      // Some rows left but not enough to cover every file → cannot say which.
      (spare === 0 ? pending : ambiguous).push(stem);
    }
  }

  if (unorderable.length) {
    return {
      ok: true,
      abstained: true,
      abstainReason:
        `${unorderable.length} migration file(s) tracked on origin/main carry no 14-digit ` +
        `timestamp (${unorderable.slice(0, 3).join(", ")}), so whether they are older than this ` +
        `apply cannot be determined`,
    };
  }

  // An ambiguity is an UNKNOWN, and it is checked before the marker on purpose:
  // `ahead-of-pending` states an intent about a queue the operator can see, and
  // this queue cannot be seen. Letting the marker wave it through would turn the
  // one escape hatch into a way to skip the check entirely — which is precisely
  // why the marker is separate from intentional-replay in the first place.
  if (ambiguous.length) {
    ambiguous.sort();
    pending.sort();
    return {
      ok: true,
      abstained: true,
      ambiguous,
      pending,
      abstainReason:
        `${ambiguous.length} migration file(s) in the scan window share a slug with another file ` +
        `tracked on origin/main (${ambiguous.join(", ")}), and the applied-migration snapshot ` +
        `records that slug WITHOUT the stamp that would say which one ran — so whether these are ` +
        `applied or still waiting cannot be determined` +
        (pending.length
          ? ` (separately, ${pending.join(", ")} is definitely unapplied)`
          : "") +
        `. Give the new migration a distinct slug and retry; the ahead-of-pending marker ` +
        `deliberately does not cover this, because it states an intent about a KNOWN queue`,
    };
  }

  if (!pending.length) return { ok: true, timestamp: ts };

  pending.sort();

  const marker = hasAheadOfPendingMarker(sql);
  if (marker.marked) {
    return { ok: true, timestamp: ts, pending, allowedBy: `ahead-of-pending: ${marker.reason}` };
  }

  const list = pending.map((p) => `  - ${p}`).join("\n");
  return {
    ok: false,
    timestamp: ts,
    pending,
    reason:
      `MIGRATION PENDING-SET GUARD: refusing to apply "${migrationStem(name)}".\n` +
      `Its timestamp is ${ts}, but ${pending.length} OLDER migration(s) are tracked on origin/main ` +
      `and have NOT been applied:\n${list}\n\n` +
      `Applying this one first advances the live ledger's high-water past them. The ordering guard ` +
      `then refuses each of them permanently, because it sees an older file being applied after a ` +
      `newer one. They do not become wrong — they become mechanically unappliable, and the only way ` +
      `out is to renumber them.\n\n` +
      `That is what happened on 2026-08-26: applying 20260826150000_fix_save_job_comment_refusal_count ` +
      `stranded 20260825190000_quote_version_restore_trust_boundary, a security migration that had ` +
      `ALREADY been renumbered once (from 20260813180000) for the same reason.\n\n` +
      `Apply the older migration(s) FIRST, in ascending order, then apply this one.\n\n` +
      `If stepping over them is genuinely the intent — they are parked, superseded, or must not go ` +
      `live yet — say so in this migration's own SQL:\n` +
      `  -- ordering-guard: ahead-of-pending <why the pending migration must wait, 8+ chars>\n` +
      `Do NOT use the intentional-replay marker for this. That one means "I am deliberately ` +
      `re-running an old file", which is a different decision.`,
  };
}
