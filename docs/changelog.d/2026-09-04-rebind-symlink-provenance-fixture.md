## 2026-09-04 - Rebind symlink provenance fixture

The migration-apply guard test now refreshes its evidence fingerprint after replacing a deliberately unsafe symlink with the same real migration file. This keeps the test focused on source containment across Linux and Windows rather than testing stale proof evidence.
