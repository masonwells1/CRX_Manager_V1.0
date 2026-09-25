## 2026-09-24 — one applied ledger row now settles at most one migration file, and a refused predicate exits 2 instead of crashing

PR #791 review round (CodeRabbit: one Major, two Minor). All three addressed. No migration SQL and no
product code changed.

## Major — one row could settle two files

`checkPendingMigrations` settled a tracked file the moment `stampIdentifies()` said an applied row
*could* name it. That is not the same as "this file ran", because **one row can carry several
stamps**: a renumbered row recorded as `20260905200000_20260905100000_shared` carries both, with the
same slug, so `20260905100000_shared.sql` **and** `20260905200000_shared.sql` each looked applied —
from a single row. A bare-stamp row has the same shape when two tracked files share its stamp.

Settling both drops a genuinely unapplied file from the pending set, which is the stranding this
module exists to prevent. This was pre-existing on the exact-stamp path — the earlier fixes in this
delivery narrowed *which* rows count, not how many files one row may settle.

The evidence is now treated as a **bipartite matching**: an edge means a row could name the file, each
row may be spent once, and a file is settled by stamp only if the matching gives it a row of its own.
Unmatched files fall through to the existing slug accounting, which already reaches
pending/ambiguous on the remaining evidence. Maximum matching via augmenting paths, over a
deterministic file order so identical inputs always produce identical attribution. The row a file
spends is charged against **that row's** slug, not the file's, because a bare-stamp row contributes
nothing to `slugCounts` and charging the file's slug would invent a budget that never existed.

Proven backwards on the same input, through the real `checkPendingMigrations`:

```
PREV: ok=true   names an unsettled same-slug file: no
NOW : ok=false  names an unsettled same-slug file: YES
```

`.claude/hooks/migration-pending-lib.test.mjs`: **66 assertions** (was 60). New cases cover one
compound-stamp row settling exactly one of two files, one bare-stamp row settling exactly one of two,
two rows still settling two files (the fix must not over-abstain), no rows settling nothing, and the
end-to-end consequence that the leftover file is still reported and named.

## Minor — a refused predicate crashed the runner

`buildSweepQuery` can now refuse a predicate, and neither call site in `run-sweeps.mjs` was guarded,
so a bad predicate would surface as an uncaught `TypeError` and a stack trace rather than the
documented exit 2 for a predicate-contract error. Both call sites now go through `buildOrExit()`,
which reports the predicate name and the reason.

Tested end to end from a **copy** of the sweeps directory with one `VALUES (1)` predicate in it — the
repo's own `predicates/` is left untouched, because a stray file there would break the fingerprint
and sweep gates. Observed: exit 2, `Invalid predicate bad-shape: …`, no `TypeError` in stderr.
`ACTOR_ALLOWLIST_MATCH_PASS` — **548 assertions** (was 545).

## Minor — the 2026-09-22 changelog still carried the coverage claim I got wrong

That entry recorded removing a false `post_invoice_group` coverage claim and replacing it with the
`unpost_invoice_group` spec, "whose chain really does call it (14 occurrences)". The replacement was
also wrong, as the previous head recorded: all 14 occurrences are `unpost_invoice_group`. The entry
now carries that correction inline, and its proof line — which said `--spec post_invoice_group` selects
`unpost_invoice_group` — records what that selection actually was and what it is now. Verified by
running it: `--spec post_invoice_group` selects `save_field_app_invoice`, the chain that genuinely
calls it twice.

## Proof

- `.claude/hooks/migration-pending-lib.test.mjs` — **66 assertions**, Major proven backwards.
- `ACTOR_ALLOWLIST_MATCH_PASS` — **548 assertions**, including the runner's exit 2.
- `node scripts/smoke/run-smoke.mjs --spec post_invoice_group` → selects `save_field_app_invoice`.
- `typecheck`, `lint`, `npx vitest run` (**5,448 passed** / 123 skipped), `build`,
  `test:correction-guards`, `test:agent-workflows` (37 Codex adapters synced), `check:docs` all green.

## Live impact

**None.** All four field-season candidates remain LOCAL CANDIDATE / UNAPPLIED. The guard change is a
local pre-apply check that now refuses in a case where it previously waved work through.
