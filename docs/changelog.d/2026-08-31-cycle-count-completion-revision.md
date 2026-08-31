## 2026-08-31 - Cycle Count completion revision guard

Cycle Count item writes now advance an authoritative parent revision, lock their item before the parent, and return that revision. Completion requires a retained idempotency key, locks all item rows before the parent and affected inventory, and rejects a changed cross-tab snapshot through `p_expected_item_revision`. This local migration has not been applied to production; focused static and mutation proof is recorded in `cycleCountCompletionRevision.test.ts`.
