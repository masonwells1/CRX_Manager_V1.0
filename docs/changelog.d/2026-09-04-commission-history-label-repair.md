## 2026-09-04 - Commission history label repair candidate

Adds a forward-only, not-yet-applied repair for commission-history labels. It appends revised earned-state observations for un-settled rows whose opening label fell back to a UUID or unknown customer, and changes the recorder to snapshot canonical order, job, invoice, and customer labels for new events. Existing ledger and settlement records are not rewritten.

The candidate is intentionally blocked when any settlement event exists and still requires an explicit live-apply approval, fresh migration proof, and exact-head review. Focused disposable-database proof is pending.
