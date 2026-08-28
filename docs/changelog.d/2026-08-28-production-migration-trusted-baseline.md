## 2026-08-28 - Production migration trusted baseline

- Anchored predecessor selection to the Git commit immediately before the selected migration first appeared on protected-main history. The production batch now rejects a migration-introduction commit that changes its baseline manifest, preventing a raised cutoff from hiding an unapplied predecessor.

No production migration, live data, secret, or GitHub environment setting was changed.
