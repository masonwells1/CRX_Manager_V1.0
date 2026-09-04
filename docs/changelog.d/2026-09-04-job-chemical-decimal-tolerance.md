## 2026-09-04 - Match the job chemical quantity guard to exact SQL decimals

- Changed the equal-unit chemical quantity guard to compare the canonical payload quantity, rate, acreage, and server tolerance with scaled `BigInt` decimal arithmetic. JobDetail now requires and carries a separate exact field-total string into that SQL-parity check while retaining its existing Number total for display and calculator behavior, including when that display total overflows. Values exactly on PostgreSQL's inclusive boundary are no longer rejected because of JavaScript floating-point drift.
- Added focused coverage for the tolerance floor and absolute cap, the first values outside them, noncanonical rate text, ordinary and deliberately synthetic high-precision multi-field acreage, overflowed display acreage, the existing acreage-scaled boundary, and the real JobDetail save paths.
- Tracked the different-unit chemical guard's remaining floating-point conversion separately; this exact-decimal change covers the equal-unit SQL predicate only.
- Added a client save-boundary acreage check so nonblank non-finite or negative values cannot reach `save_job`, including through the expired-license override; intentional blank acreage still becomes 0 in the payload.
- Added mounted JobDetail regressions for non-finite, negative, blank, and expired-license override behavior.
- Verified the focused calculator and JobDetail billing-hazard suites locally. No production save, migration, push, deployment, or live database mutation was performed.
