## 2026-08-28 - Production migration current-review hardening

The current-head CodeRabbit review found that PostgreSQL escape strings could make the destructive
scanner mistake string data for a block comment, allowing later destructive SQL to disappear from
the hands-free classifier. A pinned one-use producer and direct plus end-to-end regressions now bind
the exact scanner repair; the old scanner is proven to fail both tests before the reviewed write.

The same review consolidated both workflow environment checks into one executable assertion, made
Node interpreter calls visible to repository guards, changed the ledger function-body pin to SHA-256,
required the migration itself to reject a second non-internal ledger trigger, and aligned the trigger
search path with the repository rule. GitHub review and freeze calls now have finite timeouts; freeze
cleanup retries deletion and absence confirmation and records the exact run-scoped freeze name.
