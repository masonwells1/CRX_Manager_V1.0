## 2026-08-31 - Cycle Count completion revision guard

Cycle Count item writes now advance an authoritative parent revision, lock their item before the parent, and return that revision. Completion locks all item rows before the parent and can reject a changed cross-tab snapshot through `p_expected_item_revision`, while preserving legacy callers that omit the optional argument. This local migration has not been applied to production; focused static proof is recorded in `cycleCountCompletionRevision.test.ts`.
