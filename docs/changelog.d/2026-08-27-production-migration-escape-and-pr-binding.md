## 2026-08-27 — Production migration escape parsing and PR binding

Exact-commit adversarial review found that PostgreSQL `E'...'` escape strings could confuse the
destructive migration scanner and hide a following real `DELETE`. The production gate now classifies
destructive operations from its single escape-aware top-level SQL skeleton, and the focused suite
reproduces and rejects that exact pattern.

The release verifier now also requires the migration path to be absent from the merge commit's first
parent and present as the same regular Git blob at both the reviewed PR head and current `main`.
This prevents an old migration from borrowing CodeRabbit approval from an unrelated pull request;
the exact reviewed PR must newly introduce the migration it authorizes.
