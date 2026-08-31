## 2026-08-31 - Serialize final gauntlet write boundaries

Receiving reversal now takes the linked purchase-order row lock and the shared accounting-month lock before rechecking period and active-bill safeguards. Cycle Count item mutations now lock and revalidate the parent count in a `BEFORE` trigger, so a late insert either advances the revision before completion or fails after completion. The new migration is local only and has not been applied to production; a deterministic network-isolated PostgreSQL 17 proof exercises both winning orders for all three corrected races.
