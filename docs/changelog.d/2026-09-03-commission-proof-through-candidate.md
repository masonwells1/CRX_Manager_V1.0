## 2026-09-03 - Keep commission proof bound to its candidate

- The commission-history replay proof now stops at its own migration and reports any later migration
  files instead of failing merely because a newer candidate landed on `main`.
- This preserves the proof's exact apply-order boundary while allowing the independently reviewed
  `20260903160000` migration to remain on disk after the commission candidate.
