## 2026-09-05 - Register the commission date guard as unapplied

- Added the repository's canonical `NOT APPLIED` header to the source-only commission payment business-date migration.
- This lets the correction guard reconcile the SQL file with migration-history row 918 and prevents the candidate from being mistaken for an applied migration.
- The header does not authorize or perform a live apply; fresh in-chat approval and apply gates remain required.
