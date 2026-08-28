## 2026-08-28 - Production migration provenance and UTC hardening

- Kept GitHub review provenance reads bounded through response parsing and paginated the reviewed-commit pull-request lookup so an older matching pull request cannot be hidden beyond the first API page.
- Made the global migration-ledger trigger validate authored timestamps in UTC, including a local Docker proof that a daylight-saving-time gap timestamp remains valid regardless of the caller session time zone.
- Bound both release jobs to the protected `main` checkout and exact inputs before any repository-local script can run, so a caller-selected commit cannot receive a production secret or influence the batch.

No production migration, live data, secret, or GitHub environment setting was changed.
