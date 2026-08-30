## 2026-08-30 - Return-credit source recognition guard

- Persist exact recognized source-line lineage for damaged or non-restocked zero-COGS return credits, while keeping delivered-but-unbilled remainders explicit.
- Preserve same-customer split-invoice independence and refuse cross-customer split returns until the return model can represent the billed owner safely.
- Keep returned-quantity consumption separate from COGS-rounding consumption so damaged returns cannot shift later fractional reversals.
- Keep the order-invoice recovery migration limited to its reviewed credit/deleted-invoice filters without overwriting current season or invoice-date behavior.
- Extend the disposable real-schema prover with zero-COGS mutation coverage, forward delivery-before-billing preservation, and current exact function hashes.
