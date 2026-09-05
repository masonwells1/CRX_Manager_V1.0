## 2026-09-05 - Keep commission history loading state honest

- Keep both commission-history tables in their loading state until the newest snapshot request finishes, even if an older shared financial request settles first.
- Add regression coverage for the overlapping-request race so stale report rows are never presented as the completed replacement snapshot.
