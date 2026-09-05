## 2026-09-04 - Whole-audit truthful states

- Added executable coverage proving inconsistent verifier results remain `UNVERIFIED` and block a clean audit outcome.
- Made unknown or malformed audit-dimension filters stop with an explicit blocked result instead of returning a misleading empty success.
- Aligned preflight's accepted ledger list with the enforced migration-history rule.
