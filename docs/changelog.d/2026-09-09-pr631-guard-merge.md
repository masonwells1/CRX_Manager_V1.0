## 2026-09-09 - Preserve both autopilot deny-set hardenings in PR 631

Merged the global-option and Windows command-head protections from main with the
recursive-delete alias, token-scanned option, and clustered short no-verify
protections from this branch. The merged guard suite passed 345 assertions, and
the full correction-guards suite passed. No database or production action was
performed.
