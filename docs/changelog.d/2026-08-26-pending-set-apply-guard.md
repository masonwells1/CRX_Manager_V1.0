## 2026-08-26 — the apply guard now asks whether an OLDER migration is still waiting

`checkMigrationOrdering()` only ever compared a candidate against what was ALREADY APPLIED.
Nothing looked at what was WAITING, so an apply could legally advance the live ledger's
high-water past a tracked, unapplied migration and the guard raised no objection — the
refusal surfaced later, aimed at the innocent party. That is exactly what happened this
morning: `20260826150000_fix_save_job_comment_refusal_count` applied at 20:59:35Z while
`20260825190000_quote_version_restore_trust_boundary` was merged to main and still unapplied,
which pushed the security migration below the high-water and made it mechanically
unappliable. It was the second time that file was stranded — it had already been renumbered
once from `20260813180000` for the same reason (PR #401). Renumbering is not a fix; it is the
cost of a check that runs too late.

New `.claude/hooks/migration-pending-lib.mjs` adds a pending-set preflight to
`evaluateMigrationApply()`, so both doors get it — the MCP `apply_migration` hook and
`scripts/apply-migration-file.mjs`. It refuses an apply while an older-stamped,
tracked-but-unapplied migration exists on origin/main, and fails closed on every unknown
(unreadable `origin/main`, empty tracked set, missing or malformed schema-baseline manifest,
untimestamped candidate) using the same abstain-and-let-the-caller-refuse contract as the
ordering check. The override is a DELIBERATELY separate marker —
`-- ordering-guard: ahead-of-pending <reason, 8+ chars>` — because "I am replaying an old
file" and "I am stepping over the queue" are different decisions, and one marker meaning both
degrades into "whatever unblocks the guard". The replay marker does not unlock it; that is a
pinned test.

Two scoping rules, both forced by measurement rather than taste. Against the real ledger
(977 rows) and origin/main (892 files), the naive definition of pending — a file whose
14-digit stamp is absent from the ledger — returns **448 files**, essentially all of them
applied. Renumbered migrations are recorded with the new stamp as the row `version` and the
OLD stamp inside the row `name`, and the snapshot keeps `name`, so their stamps can never
agree; the migration SLUG does, so a file counts as applied on stamp OR slug. Pre-baseline
history carries hand-written and impossible stamps (`20260332000000` — month 33) applied
under unrelated versions, so the scan starts above `migrations_high_water` from
`supabase/baselines/manifest.json`, the same floor `scripts/list-post-baseline-migrations.mjs`
already uses. With both rules the pending set on 2026-08-26 is exactly one file:
`20260825190000_quote_version_restore_trust_boundary.sql` — the correct answer, and the file
the incident stranded. Stated residual: a genuinely unapplied migration at or below the
baseline high-water is invisible to this check; the baseline asserts there are none.

The slug fallback is sound only when a slug names exactly ONE tracked file (Codex P2 on the
PR). Two files sharing a slug with only one in the ledger makes "this slug is applied" true of
the pair and false of the individual, so an unconditional match marked the unapplied one as
applied and deleted it from the pending set — stranding it, the exact failure the guard
exists to prevent. Duplicate slugs are already real history here
(`20260718225511`/`20260718230000_supplier_price_evidence_phase1b` and two more pairs), all
below the baseline today, so this was latent rather than live. A shared slug in the scan
window now abstains and names the files, and the `ahead-of-pending` marker deliberately does
NOT unlock it: that marker states an intent about a queue the operator can see, and this queue
cannot be seen — letting it through would turn the one escape hatch into a way to skip the
check. The remedy the message gives is a distinct slug, not a marker.

Mutation-tested, not merely observed passing: removing the slug fallback, letting the replay
marker unlock the guard, and turning an abstention into a silent pass each turn the suite red,
and the incident sequence is reproduced end-to-end through the real gate in both
`migration-pending-lib.test.mjs` (34 assertions) and `migration-apply-lib.test.mjs`
(123 → 135). The two subprocess fixtures now build a real `origin/main` with a GIT_*-scrubbed
env rather than stubbing the lookup, so the second door's git path is genuinely exercised.
Separately: `migration-ordering-lib.test.mjs` existed but was wired into no npm script and had
never run in CI — both it and the new suite are now in `test:correction-guards`.
