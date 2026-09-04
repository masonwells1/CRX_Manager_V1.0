## 2026-09-04 - Commission replay-guard candidate status

Marked `20260903231000_commission_history_report_replay_guard.sql` with the repository's explicit leading **NOT APPLIED / DO NOT APPLY** status. The migration-history row already records it as a local candidate; the matching SQL header lets the correction guard prove that relationship instead of failing CI. This is documentation-only status metadata: the replay guard remains un-applied to production and still requires Mason's explicit in-chat approval for any live apply.

Proof observed: `npm run test:correction-guards` passed its parked-migration cross-reference assertion after staging the header. Full CI has not yet been rerun for this amended commit.
