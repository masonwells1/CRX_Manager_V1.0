## 2026-08-26 - Return credits no longer block order invoice recovery

- Added a forward migration that aligns both order-level invoice creators with the UI and delivery-recovery rule: only active, non-deleted sale invoices count as existing billing coverage. A posted return credit or soft-deleted invoice can no longer make the server reject the Create Invoice recovery path.
- The migration aborts on source drift, changes one exact guard in each private implementation, pins both outgoing function bodies, and preserves their private execution posture.
- The disposable production-schema proof restores the stale guards as mutants and proves both public invoice-creation paths fail, reapplies the canonical migration, and proves ordinary and split-order recovery succeed.
- Added fail-closed rollout preflights for linked nonterminal return unit drift and recognized source-line unit drift. Removing either guard is mutation-tested.
- Final database proof: eight candidate/compatibility entries, 51 load-bearing proofs, `SMOKE_PASS_ROLLBACK`, and zero residue. No migration was applied to production.
