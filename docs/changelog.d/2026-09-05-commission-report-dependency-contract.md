## 2026-09-05 - Commission report replay guard now pins its privileged dependencies

- Fixed the parked commission-history report replay migration so it refuses to
  reissue the public snapshot wrapper when either privileged child report has
  drifted. The guard now pins each child's exact overload, argument and return
  shape, body, admin check, owner, security mode, search path, grants, comment,
  and behavior-bearing PostgreSQL function attributes before and after replay.
- Expanded the wrapper contract to pin its argument-default, set-returning,
  strictness, leakproof, parallel-safety, and cost attributes instead of
  allowing a replay to silently normalize unreviewed catalog state.
- Added disposable-PostgreSQL mutations for wrapper default and cost drift plus
  child body, overload, anonymous grant, security-mode, and search-path drift.
  Each must abort before the replay can certify the report contract.

This is source and proof hardening only. No migration was applied and no live
database was queried or changed.
