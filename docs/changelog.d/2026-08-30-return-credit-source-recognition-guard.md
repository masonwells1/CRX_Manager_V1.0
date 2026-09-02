## 2026-08-30 - Return-credit source recognition guard

- Persist exact recognized source-line lineage for damaged or non-restocked zero-COGS return credits, while keeping delivered-but-unbilled remainders explicit.
- Preserve same-customer split-invoice independence, and refuse a cross-customer split return only for quantity the order customer's own recognized lots cannot cover, so ordinary split-billed returns stay creditable instead of failing closed with no workaround.
- Count prior credit lines that carry no exact source lineage when consuming source quantity, and honour them in both source-invoice freeze guards, so an already-credited quantity can no longer be reported as available and credited twice.
- Keep returned-quantity consumption separate from COGS-rounding consumption so damaged returns cannot shift later fractional reversals.
- Bind the two order-invoice creators to one explicit America/Chicago business date for both `invoice_date` and the season fallback, replacing a bare `CURRENT_DATE`/`current_season()` pair that followed the UTC database date and could stamp tomorrow's date and the wrong season during the Chicago evening.
- Install the return-credit source-shape CHECK as `NOT VALID` plus a separate `VALIDATE CONSTRAINT`.
- Extend the disposable real-schema prover with zero-COGS mutation coverage, forward delivery-before-billing preservation, a mixed-ownership split-billing case that distinguishes a remainder-scoped refusal from an over-broad one, and current exact function hashes.
- Restore the order-gate helper bodies for the canonical re-apply probe from a verbatim pre-migration snapshot instead of reversing one known snippet, so the probe cannot break when the migration changes anything else in those bodies.
