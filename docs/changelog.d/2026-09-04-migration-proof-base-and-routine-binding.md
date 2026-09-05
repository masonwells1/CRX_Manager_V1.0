## 2026-09-04 - Migration proof base and routine binding

- Bound migration-review evidence to the fetched protected `origin/main` commit and reject proof generation or migration application when the candidate checkout does not contain that base.
- Replaced routine-name regex extraction with a fail-closed PostgreSQL-aware parser, so legal `$`, quoted Unicode, spaces, hyphens, quoted semicolons, and nested block comments cannot hide prior routine definitions or ACL history from a migration review.
