## 2026-09-06 - PR #535 brought current with `main`, and its review backlog triaged against current source

**Type:** merge + fix (frontend copy, proof harness, test pin — no migration, no live database change)

## Merge

`codex/gauntlet-s9-safety-20260831` was `DIRTY` against `main`. Exactly one file conflicted:
`docs/manual/KNOWN_ISSUES.md`. Both sides were purely additive at the top of the entry list —
this branch had added four 2026-09-0x entries, `main` had added the PARKED
`next_invoice_number` UTC-year entry — and neither side contained the other's headings.
Resolved by keeping **both**, branch entries first, with `main`'s block left byte-identical
so a concurrent lane editing it does not conflict twice.

`docs/reference/migration-history.md` auto-merged. Its rows 904-909 (this PR's six
`20260831*` migrations) occupy slots `main` had deliberately reserved — `main` holds
900-903 and 910/911/916/917 — so no renumbering was needed and none was done.

The resolution was verified by **running the parser, not by reading the file**:
`localCandidateMigrationPathsFromHistory` and `validateParkedMigrationCrossReferences`
(`.claude/hooks/worktree-awareness-lib.mjs`) both return `state: "known"` with a
non-empty, one-to-one candidate set of 2.

## What changed in code

- **`scripts/smoke/prove-gauntlet-write-boundary-concurrency.mjs` — the expired-receipt and
  bound-receipt cutover cases now run for every operation in a spec, not just the first.**
  They previously ran once per `guardSpec` against `guardSpec.operations[0]`. The cycle-count
  spec is `['update_cycle_count_item', 'complete_cycle_count']`, so the representative was
  always `update_cycle_count_item` and the intent-shaped `complete_cycle_count` payload
  branch was unreachable dead code. **The proof still exited 0**, so the missing coverage was
  silent — the failure mode this harness exists to prevent.

- **`src/pages/Reports.tsx` — retracted a banner claim that had become false.** The Commission
  Balance note said historical cutoffs were disabled *"until immutable payout history exists"*.
  That history now exists: the ledger-backed commission history went live 2026-09-03 and
  `commission_history_cutover.first_supported_date` reads `2026-09-04` (read-only live check,
  2026-09-06). Behaviour is unchanged and still safe — the screen requests today only, and the
  date controls stay disabled. Only the false statement was corrected. **Enabling dated
  Commission Balance reporting against that cutover is a product decision for Mason and was
  deliberately not taken here.**

- **`src/lib/section9ReceivingApSafety.test.ts`** re-pinned to the corrected wording, plus a
  negative assertion that the retracted claim cannot silently return. Mutation-proven:
  restoring the old sentence turns the test red.

## Review triage

All 52 unresolved threads on the PR were enumerated by every author, including the Codex
connector (which reports through an edited summary comment, not review objects, and whose
threads are therefore never resolved even when the finding is fixed). 42 of the 52 were
verified **already fixed in current source**; the thread simply stayed open. The remainder are
recorded as open, with reasons, in the PR discussion — the largest group is one bug class
(a payload-derived idempotency scope with no freeze after an uncertain outcome) whose fix is a
risky money/inventory diff requiring an exact-SHA `gpt-5.6-sol` proof that cannot be minted
while Codex credits are exhausted.

## Verification

`npm run typecheck`, `npm run lint`, `npm run test` (367 files, 5152 passed) and `npm run build`
all pass locally; full CI green on the merge commit `def90294c` before these three edits.
The concurrency proof itself was not executed — it needs Docker — so the harness change is
verified structurally and by syntax check, not by a run.
