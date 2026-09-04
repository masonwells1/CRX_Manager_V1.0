## 2026-09-03 - Route MultiEdit through migration safety hooks

- Claude and Codex now route `MultiEdit` through the shared write/edit safety-hook group, so the
  actor-binding guard's full-file reconstruction runs for real MultiEdit tool calls.
- A routing-level regression test reads both hook manifests and proves that their MultiEdit path
  reaches `actor-binding-check.mjs`.
- This closes the exact-head Codex review finding on the pending-migration guard repair; it does not
  broaden the actor-pattern analysis or change any database or production state.
