## 2026-08-27 - Production migration live definition mutation closure

Exact-commit adversarial review proved that broad `ALTER SEQUENCE` and `ALTER TYPE` admission could
reset live invoice numbering or rename lifecycle values. Both statement classes are now parked for
manual review. View and index drops are also excluded from the automated definition-only path.

Regression coverage rejects invoice-sequence resets, cycling and bounds changes; enum value rename
and addition; and view/index drops.
