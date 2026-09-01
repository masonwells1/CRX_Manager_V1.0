## 2026-08-31 - Fail closed on legacy gauntlet retry receipts

The final exact-SHA review identified a deployment cutover where an uncertain
success written by an older key-only RPC could be rejected after migration and
then repeated under a fresh browser key. Each affected gauntlet migration now
runs in an explicit transaction, locks the shared receipt table across function
replacement, and refuses to apply while an unexpired legacy receipt exists for
receiving, reversal, vendor billing/payment, damaged-receipt alerts, or Cycle
Count item/completion operations.

This is an apply-time safety gate only. It does not delete or rewrite receipts,
and the migrations remain parked and unapplied until the governed live rollout.
