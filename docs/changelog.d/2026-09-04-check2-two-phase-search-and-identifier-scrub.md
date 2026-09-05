## 2026-09-04 - CHECK 2's search method becomes two-phase, and the F2 verification record drops its live identifiers

Both changes answer the CodeRabbit review of PR #594 on commit `21fec2b16`
(`CHANGES_REQUESTED`, two actionable comments, both accepted).

## 1. The prescribed search could not answer its own check

`.claude/agents/migration-drift-reviewer.md` CHECK 2 told the reviewer to answer the
overload-collision question with "ideally ONE `grep -rnoiE`" and to "not read migration files one
at a time".

`-o` prints **only the matched substring**. With a pattern of function names, its output is names
and `file:line` — nothing else. But the two rules immediately below it consume (a) the **argument
types** of each prior definition and (b) whether a `DROP FUNCTION` precedes it. The prescribed
command discards both, and the "one at a time" prohibition read as banning the follow-up that
recovers them. The method was, in other words, a check that looks thorough and cannot reach its own
verdict.

The METHOD paragraph is now explicitly **two-phase**:

- **Phase A — discovery.** One local `grep -rniE` over `supabase/migrations/` covering every
  function name at once. It finds candidates and nothing more; the charter now states outright that
  a name-level match does NOT decide the check, names `-o` as the reason, and calls clearing CHECK 2
  on phase A alone *a false clean*.
- **Phase B — read the candidates.** For each file phase A named, read the full
  `CREATE OR REPLACE FUNCTION` declaration — complete argument list, and any preceding
  `DROP FUNCTION` in the same migration — then apply steps 2 and 3.

The speed property that motivated the paragraph survives, because **phase B is bounded by the
number of matches, not by the ~900-file corpus**. The remote-enumeration ban is unchanged and now
explicitly scoped: it forbids walking the corpus, never reading the files phase A identified.

`scripts/check-agent-guidance.mjs` grows from 6 CHECK 2 assertions to 13, pinning both phases *and*
the sentence that denies phase A the verdict — pinning phase A alone would have been satisfied by
the very defect this fixes. Mutation-tested with five mutants, each caught: deleting phase B (3
assertions red), flipping "does NOT decide" to "decides", dropping the false-clean warning, dropping
the `-o` explanation, and reverting phase A to the old `-rnoiE` wording. Charter restored
byte-identical afterwards, suite back to green.

Two of those mutants initially reported NO-OP because the sentences they targeted wrap across a line
break; they were rewritten to match real text rather than accepted as passes.

## 2. Live identifiers removed from the F2 verification record

The F2 role-simulation table named two live `profiles` UUID prefixes and the real cycle-count number
the admin case generated, across `docs/changelog.d/2026-09-04-f2-number-generator-gates-applied-live.md`,
`docs/manual/KNOWN_ISSUES.md` and `docs/reference/migration-history.md` row 910. This repository is
public.

Each is now a role label with the outcome kept intact — `deactivated sales_rep → INSUFFICIENT_ROLE`,
`unauthenticated → AUTH_REQUIRED`, `active admin → a cycle-count number issued normally` — with a
line in each file saying the omission is deliberate. **The outcome is the entire proof; the identity
of the account it ran as proves nothing additional.** A verification record leaks by its nature, so
this is worth treating as the default shape for future ones.

Not changed here: the same two identifiers appear in `docs/audits/2026-06-15-...`,
`docs/audits/2026-07-27-...` and `migration-history.md` row 828, all pre-existing on `main` and
outside this pull request. Flagged for Mason rather than scrubbed unilaterally.

## Merge

Brought up to date with `origin/main` (10 commits). Two conflicts, both resolved by content:

- `KNOWN_ISSUES.md` header — took main's newer ordering boundary
  (`20260903230000_commission_report_snapshot_contract`) and its two ledger-reading traps, kept this
  branch's 2026-09-04 F2 verification date. Also corrected the F06 paragraph's "it is also the
  current ordering boundary", which the merge made false.
- `migration-history.md` row 910 — kept this branch's applied-live text. Main's copy still reads
  "LOCAL CANDIDATE — NOT APPLIED LIVE", which its own row 911 contradicts, and it spells out the
  parked-candidate marker phrase that `worktree-awareness-lib.test.mjs` counts. Main's new row 911
  kept.

## Verification

- `node scripts/check-agent-guidance.mjs` — 13/13 CHECK 2 assertions green.
- Mutation test — 5 mutants, 5 caught, charter byte-identical after restore.
- `npm run test:agent-workflows` — pass.
- `npm run test:correction-guards` — pass, `SCHEMA_BASELINE_PASS high_water=20260727174805`.
