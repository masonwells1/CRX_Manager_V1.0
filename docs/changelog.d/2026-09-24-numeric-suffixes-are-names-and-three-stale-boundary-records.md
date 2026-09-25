## 2026-09-24 — a numeric migration suffix is still a name; the missing-dependency proof now isolates; and five stale records are corrected

PR #788 review round (CodeRabbit: one Major, six Minor). All seven addressed. No migration SQL and
no product code changed.

## Major — my own previous fix had the same hole it closed

The stamp-collision fix landed earlier today decided whether an applied ledger row "names a
migration" with `/[a-z]/.test(slug)`. A slug of `12345` has no letters, so the row
`20260905210000_12345` was recorded as naming nothing — and a *different* tracked migration
`20260905210000_67890.sql` then passed `stampIdentifies()` and vanished from the pending set. That
is the very collision the fix was written to close, reintroduced through too coarse a predicate.

A new exported `namesOnlyStamps()` replaces it: a row names nothing only when its slug is empty or
consists entirely of 14-digit stamps (`20260812130145`, `<version>_<stamp>`, or a trailing
separator). Any other suffix is a name, including a purely numeric one.

Proven backwards against the version committed an hour earlier, same input, through the real
`checkPendingMigrations`:

```
PREV (letters test):     ok=true   names 67890: no
NOW  (stamps-only test): ok=false  names 67890: YES
```

`.claude/hooks/migration-pending-lib.test.mjs`: **60 assertions** (was 49). New cases pin
`namesOnlyStamps` directly (empty, bare stamp, stamps-only pair, trailing separator, short numeric
suffix, descriptive slug, stamp-after-word) and re-run the end-to-end collision with numeric
suffixes.

## Minor — the missing-dependency proof did not isolate what it claimed

`prove-actor-allowlist.mjs` dropped `public.wrapped_actor(uuid)` *and*
`public.owner_only_actor(uuid)` before asserting "missing exact dependency fails closed". With the
wrapper gone, the **primary** violation-key pin was absent too, so the matcher failed closed on
that — meaning the check would still have passed had a regression ignored absent *dependency* pins
entirely. Same false-green class as the `auth.uid()` restore three lines above it, which a previous
round already fixed.

Only the delegate is dropped now. PL/pgSQL records no dependency on a called function, so the
wrapper survives — confirmed by the run, since the new assertion requires the catalog to return
**two** rows (wrapper and `auth.uid()`) at their reviewed digests with only the delegate absent.
`ACTOR_ALLOWLIST_DISPOSABLE_PROOF_PASS`, 34 checks.

## Minor — five stale or self-contradicting records

- **`docs/reference/rpc-functions.md`** still said phase 2 "refuses installation while any unexpired
  generic `save_invoice` receipt remains". That is no longer true after yesterday's narrowing, and
  an operator reading it would wait out unrelated receipts for nothing. It now states which receipts
  block (field-application, and unresolvable ones) and which do not. This was my omission: the
  narrowing changed the behaviour without updating its reference record.
- **`docs/manual/CURRENT_STATE.md`** asserted the boundary was the September 20 one with high-water
  `20260911120000`, then, in the same paragraph, said the effective high-water is `20260914100600`
  and "not the `20260911120000`". A reader stopping at the first sentence got the wrong boundary.
  The current value is now stated once, with the superseded ones listed as history.
- **`docs/reference/migration-history.md`** called `20260911120000` "the current effective live
  high-water" in row 934's follow-on note, while line 92 of the same file gives `20260914100600`
  after the 2026-09-22 applies. Now points at the authoritative boundary block and dates the old
  value.
- **Three changelogs gave the wrong apply position** for the unchanged-date correction, calling it
  "third of four". The apply sequence is season guard → correction → phase 1 → phase 2, so it is
  **second**, which row 934 states explicitly. One of the three contradicted the sequence printed
  one line above it; another contradicted its own "between the season guard and phase 1" in the same
  sentence. Corrected in all three, each marked as an ordinal correction. The apply order itself
  never changed.
- **`docs/changelog.d/2026-09-14-invoice-review-reconciliation.md`** said "three explicit
  pre-mutation retries (150/300ms)". Two delays are two retries after the first request — three
  requests total, which is what the 2026-09-13 entries call "maximum three requests". Reworded so an
  auditor cannot read it as four. The bound is unchanged.

## Proof

- `.claude/hooks/migration-pending-lib.test.mjs` — **60 assertions**, and the Major proven backwards
  against the previously committed version.
- `node scripts/db-invariant-sweeps/prove-actor-allowlist.mjs` →
  **`ACTOR_ALLOWLIST_DISPOSABLE_PROOF_PASS` 34 checks**, `postgres:17-alpine`, `--network none`.
- `typecheck`, `lint`, `npx vitest run`, `build`, `test:correction-guards`, `test:agent-workflows`,
  `check:docs` all green.

## Live impact

**None.** All four field-season candidates remain LOCAL CANDIDATE / UNAPPLIED. The guard change is a
local pre-apply check that now blocks in a case where it previously waved work through.
