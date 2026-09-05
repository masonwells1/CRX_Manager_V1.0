## 2026-09-04 - Whole-audit finder evidence

- Required every whole-codebase audit worker to report whether its evidence completed and what sources it checked.
- Made missing, blocked, or malformed worker output block the audit instead of returning a false clean result, while preserving partial findings as unverified.
- Added executable null-worker, blocked-worker, partial-finding, and malformed-finding regression coverage.
- Corrected the final quote-review ledger rationale and aligned adjacent inventory and ledger guidance.
