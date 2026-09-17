## 2026-09-17 — keep pending commission recorders in the mutator inventory after the registry high-water moved

**What changed.** Refreshing `.claude/schema-registry.json` for this PR moved `migrations_high_water`
from `20260904152221` to `20260915033227`, the ledger version of the applied
`20260908130000` hold migration. That field carries a ledger apply VERSION while
`generatedMutatingRpcInventory()` compares it against AUTHORED file stamps, so
nine unapplied migrations went from sorting above the high-water to sorting below
it and stopped being discovered as pending:

```
20260908120000  20260911120000  20260914100100  20260914100200  20260914100300
20260914100400  20260914100500  20260914100600  20260914100900
```

`20260911120000` is this PR's own migration. The `timestamp > highWater` arm of
the discovery rule went false for all nine, dropping their trigger-only mutators
out of the inventory. Two of them had `MUTATOR_INVENTORY_EXEMPT` entries, so the
loss surfaced as `mutator inventory exemptions are current, explicit, and
non-empty` failing in CI with `record_commission_earned_state` and
`record_commission_settlement_event` reported stale. A mutator in that group
WITHOUT an exemption would have dropped out with no signal at all — the exact
silent weakening the surrounding gate exists to prevent.

The obvious way to go green was to delete the two stale exemptions. That would
have removed two mutators from oversight along with the justification describing
them, so it was rejected.

## What changed

`MIGRATIONS_AWAITING_TYPE_REGENERATION` now also registers `20260914100300`
(which last defines `record_commission_settlement_event`) and `20260914100900`
(which last defines `record_commission_earned_state`), keeping both recorders in
the inventory and their exemptions current.

Registering them was impossible before this change: the status gate accepted only
`**PENDING APPLY` and `**APPLIED LIVE`, while all nine rows use the project's
third wording, `**LOCAL CANDIDATE — not applied.**`. Registering such a timestamp
threw even though the row was real and correctly worded. The gate now also
accepts the `LOCAL CANDIDATE ... NOT APPLIED` shape, the same shape
`localCandidateMigrationPathsFromHistory` in `.claude/hooks/worktree-awareness-lib.mjs`
already keys on, so both guards agree on which rows are pending.

## Proof

Two mutation experiments on throwaway copies of the test file, since a test
cannot certify its own edit:

- **Coverage restored, not silenced.** Deleting the two exemptions from a copy
  made the escape-class assertion fail naming exactly
  `record_commission_earned_state` and `record_commission_settlement_event`.
  Had they still been outside the inventory, that deletion would have changed
  nothing and stayed green.
- **Fail-closed.** Registering row 808 / `20260722105402`, which reads
  `RETIRED CODE-ONLY ARTIFACT; NOT APPLIED LIVE; SUPERSEDED BY LIVE ROW 811` —
  `NOT APPLIED` present, `LOCAL CANDIDATE` absent — is rejected with
  `must state PENDING APPLY, APPLIED LIVE, or LOCAL CANDIDATE ... NOT APPLIED`.
  This repo has been bitten before by a loose matcher reading
  `NOT YET APPLIED LIVE` as settled across six real rows.

`src/lib/rpcContracts.test.ts` passes 94/94 and `npm run test:correction-guards`
exits 0 (243 predicate fingerprints, 121 ledger assertions).

## Not fixed here

The other seven migrations in that list remain undiscovered by the reverse
`unregisteredBelowHighWater` check, which still only recognises
`**PENDING APPLY` rows. Widening it would demand registering all nine and pull
unrelated commission work into this PR, so it is filed separately. The deeper
issue is that `migrations_high_water` stores an apply version but is compared
against authored stamps; a refresh will re-open this every time.
