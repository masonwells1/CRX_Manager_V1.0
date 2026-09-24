## 2026-09-24 — a 14-digit migration stamp is not a unique identity, so the pending-migration guard no longer treats a shared stamp as proof a candidate ran

PR #787 review round (CodeRabbit, one Major). The fix is in
`.claude/hooks/migration-pending-lib.mjs`; no migration and no product code changed.

## The defect

`checkPendingMigrations` settled a tracked file as applied whenever its leading 14-digit stamp
appeared **anywhere** in the applied-migration snapshot:

```js
if (stamp && stamps.has(stamp)) { /* conclusive: applied */ }
```

`stamps` is a flat set of every 14-digit run in every applied name, so the test asked only "did some
applied row carry this number?", never "was that row this migration?". Stamps here are hand-written
and get **reassigned during restamping** — this delivery alone restamped four files twice — so an
applied row and an unapplied local candidate can carry the same stamp while being different
migrations.

When that happens the candidate is dropped from the pending set entirely. Below the baseline
high-water its migration-only mutators can then leave `generatedMutatingRpcInventory`, and a pending
migration goes unseen: the exact stranding this guard exists to prevent, reintroduced inside it.

## The fix

`appliedIndex` now also returns `stampSlugs`, mapping each stamp to the slugs of the rows carrying
it, and a new exported `stampIdentifies()` decides whether a stamp actually identifies the candidate.
An exact-stamp hit stays conclusive when the row's slug agrees, **or** when the row names nothing
beyond its digits — the snapshot can carry a bare `20260812130145` with no descriptive name, which
contradicts nothing and must keep vouching for its file exactly as before. When every row carrying
the stamp names a *different* migration, the stamp collided and the candidate falls through to the
existing slug-counting attribution, which reaches pending/ambiguous on the evidence instead of
guessing.

Renumbering attribution is untouched: a renumbered row recorded as `<version>_<original>_<slug>`
still matches its file by either stamp, because the slug agrees.

## Proof

Before/after on the same input, through the real `checkPendingMigrations`:

```
OLD: ok=true   reports the colliding pending migration: no
NEW: ok=false  reports the colliding pending migration: YES
     pending=["20260905210000_shared_recorder"]
```

The old library silently accepted a candidate sharing `20260905210000` with the unrelated applied row
`20260905210000_other_migration` and dropped the genuinely unapplied
`20260905210000_shared_recorder`. The new one refuses and names it.

An earlier attempt at this fix keyed on "the row has no slug". The new test caught that as wrong —
`migrationSlug("20260812130145")` returns the stamp itself, not `""`, because only a stamp followed
by `_` is stripped — so a bare-stamp ledger row would have regressed from applied to pending. The
predicate keys on whether the row has a descriptive part at all.

- `.claude/hooks/migration-pending-lib.test.mjs`: **49 assertions** (was 41). New cases cover slug
  agreement, the same stamp not identifying a different migration, a renumbered row's trailing stamp
  still matching by slug, a bare-stamp row still vouching for its file, an unknown stamp, a missing
  index not throwing, and the end-to-end consequence that a stamp-colliding candidate is still
  reported and named.
- `node scripts/sync-agent-workflows.mjs --write` re-synced 37 Codex adapters.
- `typecheck`, `lint`, `npx vitest run`, `build`, `test:correction-guards`, `test:agent-workflows`,
  `check:docs` all green.

## Live impact

**None.** This is a local pre-apply guard: it decides whether an apply is blocked, and it now blocks
in a case where it previously waved work through. All four field-season candidates remain LOCAL
CANDIDATE / UNAPPLIED.
