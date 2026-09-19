## 2026-09-08 — Fail closed on transfer-invoice receipt security drift

Hardened the parked transfer-invoice intent migration after exact-SHA review.
Its cutover now treats legacy receipts with no expiry as still live and refuses
before changing shared state if the idempotency table owner, RLS state, sole
deny-all policy, browser-role privilege inheritance, or PUBLIC/anonymous write
grants differ from the reviewed security boundary.

The disposable PostgreSQL 17 proof mutation-tests each guard, including a
custom `BYPASSRLS` role inherited by `authenticated`, and verifies that every
drift case aborts before the existing transfer function is renamed. This entry
does not claim a live migration apply; the commission cohort remains parked.
