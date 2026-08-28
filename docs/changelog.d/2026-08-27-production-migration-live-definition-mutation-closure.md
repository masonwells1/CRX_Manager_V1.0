## 2026-08-27 - Production migration live definition mutation closure

Exact-commit adversarial review proved that broad `ALTER SEQUENCE` and `ALTER TYPE` admission could
reset live invoice numbering or rename lifecycle values. Both statement classes are now parked for
manual review. View and index drops are also excluded from the automated definition-only path.
`CREATE SEQUENCE` is parked too: the database baseline may grant browser roles access to a new public
sequence, and the automated path cannot safely admit the matching permission cleanup while all grants
and revokes remain manual-review-only.

Regression coverage rejects invoice-sequence resets, cycling and bounds changes; enum value rename
and addition; new sequence creation; and view/index drops.
