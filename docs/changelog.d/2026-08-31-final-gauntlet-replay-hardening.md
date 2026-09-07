## 2026-08-31 - Close final gauntlet replay and lifecycle gaps

The final adversarial review found four remaining boundary cases in the parked
gauntlet candidate. Vendor-bill creation now fingerprints nullable text exactly,
including the material distinction between defaulted and explicitly empty
payment terms. Damaged-receipt notifications are bound in PostgreSQL to the
authenticated actor and exact PO/message payload. New Vendor Bill retires a
database-rejected retry key and clearly reports that the current bill was not
submitted. Cycle Count items can no longer move between parent counts and bypass
the source revision used by completion.

Focused mutation guards, the rollback-only Section 9 smoke, and the disposable
two-session PostgreSQL proof cover these corrections. The migrations remain
parked and unapplied until the governed live-apply gate is authorized.
