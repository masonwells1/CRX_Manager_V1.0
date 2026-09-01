## 2026-08-26 — Section 9 cross-tab intent and claim races fail closed

The exact-commit review found two remaining HIGH duplicate-mutation paths in the
durable AP and receiving coordinator. Two different submissions racing from the
same screen could silently share whichever request won the storage transaction,
and one tab's definitive rejection could delete the entire shared record while a
peer tab using the same key was still in flight.

Same-surface coordination now requires the exact canonical request fingerprint,
so only identical active mutations share a request version and key. Definitive
failure removes only that tab's claim; the record is deleted only when no claimant
remains, and a late rejection cannot erase a peer's resolved completion tombstone.
Race tests cover different and identical same-screen submissions plus both orders
of peer success and definitive rejection. The focused six-file suite passes 50/50;
the complete suite passes 342 files and 4,826 tests with 123 skipped; typecheck,
full lint, production build, documentation drift, and diff hygiene also pass.
Exact-head review remains to be refreshed before release. No live migration or
production change was applied.
