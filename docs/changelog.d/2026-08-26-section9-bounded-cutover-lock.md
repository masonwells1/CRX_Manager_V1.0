## 2026-08-26 - Bound the Section 9 receipt-table cutover lock

- Added a transaction-local 10-second `lock_timeout` before the Section 9 migration takes its `ACCESS EXCLUSIVE` receipt-table cutover lock.
- A busy database now aborts the migration for a quiet-window retry instead of allowing an indefinitely waiting migration to queue AP and receiving writers.
- The Section 9 contract test requires the timeout to remain before the lock and mutation-tests its removal.
- The disposable PostgreSQL replay holds a conflicting writer for 12 seconds and proves the migration aborts at the 10-second lock timeout, then separately proves the normal 8-second cutover drain still succeeds.
