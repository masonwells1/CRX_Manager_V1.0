## 2026-09-05 - Mark Chicago-date migration candidates as parked

- Add the repository's machine-readable not-applied header to both Chicago-date migrations.
- This lets the parked-migration correction guard prove the source files match their `LOCAL CANDIDATE — not applied` history rows instead of failing closed.
- Neither migration was applied, and this correction does not query or mutate production.
