## 2026-09-05 - Harden commission history review fixes

- Marked the historical commission smoke chain as container-only so it cannot be selected against the live database.
- Stabilized commission-history lock proofs and isolated Docker cleanup for timed-out proof wrappers.
- Corrected generated snapshot-proof newline parsing and documented all four parked commission follow-up migrations.
- Added a typed quote-version adapter that rejects malformed snapshot JSON before version history is rendered.
