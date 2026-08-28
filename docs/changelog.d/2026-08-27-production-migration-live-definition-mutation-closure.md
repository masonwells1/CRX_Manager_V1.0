## 2026-08-27 - Production migration live definition mutation closure

Exact-commit adversarial review proved that broad `ALTER SEQUENCE` and `ALTER TYPE` admission could
reset live invoice numbering or rename lifecycle values. Both statement classes are now parked for
manual review. View and index drops are also excluded from the automated definition-only path.
`CREATE SEQUENCE` is parked too: the database baseline may grant browser roles access to a new public
sequence, and the automated path cannot safely admit the matching permission cleanup while all grants
and revokes remain manual-review-only. `CREATE TYPE` and `CREATE DOMAIN` are also parked because their
definitions can persist function calls or lifecycle semantics. Candidate-supplied `SET LOCAL` is fully
parked so a migration cannot disable wrapper timeouts or change name-resolution and parser behavior.
Among the statement classes discussed above, only `COMMENT ON` remains admitted by the candidate-SQL allowlist.

Regression coverage rejects invoice-sequence resets, cycling and bounds changes; enum value rename
and addition; new sequence, type, and domain creation; timeout and parser-setting changes; and
view/index drops. The wrapper now takes the migration-ledger table lock before its advisory lock,
matching the ordinary ledger-insert trigger's lock order. Workflow dispatch is also bound to `main`.
