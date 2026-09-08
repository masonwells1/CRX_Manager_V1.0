## 2026-09-03 - Commission history report replay guard

- Added a local-candidate follow-up migration that fails closed on a shadow commission-report overload, changed function identity/body/security attributes, or any unexpected execute grant.
- Extended the disposable PostgreSQL proof to mutate each newly guarded overload and ACL path before asserting the exact function contract can replay unchanged.

The original commission-history and snapshot migrations remain applied and byte-for-byte unchanged. This guard is not yet applied to production.
