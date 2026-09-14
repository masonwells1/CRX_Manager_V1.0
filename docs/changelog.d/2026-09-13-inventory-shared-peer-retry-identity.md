## 2026-09-13 - Keep exact peer retries on the original request version

Exact retries preserve the original request version as well as its receipt key, so two tabs awaiting the same peer-completed result can both acknowledge it. A focused regression reproduced the second tab being refused when the first retry changed that version. Retaining it fixes recovery without allowing older acknowledgments to replace newer work.

The written, parked inventory-hold migration header now clarifies that raw psql is only an isolated/local proof option; production requires the protected apply gate. No executable SQL body or smoke harness changed, and no live apply or inventory transaction was performed.

Verification: 185 checks across 12 affected inventory, shared receiving, payment and idempotency suites passed, with typecheck and lint clean. The new two-unacknowledged-tab regression failed on the prior published candidate, then passed after the request-version correction. A fresh exact-candidate independent review and normal publication checks remain required before delivery.
