## 2026-09-05 - Pin document-writer argument defaults before replacement

- Added a fail-closed preflight catalog check to the parked Chicago document-date migration so a default-only live function change cannot be silently overwritten by `CREATE OR REPLACE FUNCTION`.
- Pinned every accepted pre-image and post-image argument-default list for all four replaced writers, and now certify the exact post-image defaults as well as the absence of `CURRENT_DATE`.
- Added a disposable PostgreSQL mutation that changes only the quick-delivery implementation's date default while preserving its body hash, then proves the migration aborts before replacing anything.
- Corrected the migration's risk note: the known frontend supplies the date, but authenticated and service-role direct RPC callers can still reach the unchanged public wrapper's UTC default.

This migration remains parked and has not been applied to production.
