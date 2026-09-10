## 2026-09-04 - Migration proof base and routine binding

- Bound migration-review evidence to the fetched protected `origin/main` commit and reject proof generation or migration application when the candidate checkout does not contain that base.
- Replaced routine-name regex extraction with a fail-closed PostgreSQL-aware parser, so legal `$`, quoted Unicode, spaces, hyphens, quoted semicolons, nested block comments, and escape strings cannot hide prior routine definitions or ACL history from a migration review.
- Let ordinary table and schema privileges pass the owner-privileged routine gate while continuing to reject malformed or schema-wide routine ACLs that could restore anonymous execution.
- Refuse migration proof generation for role definitions and canonical role-membership grants or revokes, because inherited anonymous privileges cannot be safely proven from source alone.
- Added the routine-reference parser regression suite to the CI correction-guard command.
