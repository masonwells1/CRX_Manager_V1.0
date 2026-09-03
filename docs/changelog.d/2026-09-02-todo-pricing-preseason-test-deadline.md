## 2026-09-02 — TODO: pre-season test of the bulk-reprice path (owner-deferred, dated)

Adds a dated callout at the top of `TODO.md` section 1 (Owner actions) recording Mason's
2026-09-02 decision: the pricing/repricing path needs a real-eyes test before sales season, and he
has no time for it now. Deferred deliberately — not blocked, not forgotten.

Docs only. No code, schema, or behavior change.

### Why it is dated rather than open-ended

Verified live on 2026-09-02: of 604 `product_cost_basis` rows, **602 are the original
`migration_baseline` load**, `effective_from` spanning 2026-03-04 to 2026-07-18. Exactly one row
came from a supplier price selection (2026-07-22) and one from a product-page override
(2026-08-18). **No cost of any kind has moved since 2026-07-18.** Tier prices derive from
`current_cost`, and the dashboards, profitability views, and commission math all compute from
those, so every margin figure currently reads against costs up to six months old.

### What was proven, so it is not rebuilt

The tooling already exists and works; the gap is adoption, not construction. A real round trip ran
on 2026-09-02 against `src/lib/productPricingWorkbook.ts`: generated a 9,628-byte workbook, edited
it through ExcelJS the way a person would in Excel (one `margin_driven` cost change, one
`price_driven` price change), and parsed it back. Both edits returned on the correct rows, the
untouched row correctly reported no change, money survived as exact decimal strings (`125.40`,
`131.00`) rather than floats, and the parser reports `has_formula` / `formula_cells` so a leftover
Excel formula is caught instead of silently applied. The repo's 14 existing workbook tests pass.

Both RPCs are live and `SECURITY DEFINER`: `preview_product_cost_basis_changes` and
`apply_product_cost_basis_change_set`. UI is wired in `src/pages/Products.tsx` behind the admin-only
**"Pricing .xlsx"** and **"Review Pricing File"** buttons. `MAX_PRICING_WORKBOOK_ROWS` is 5,000,
comfortably above the ~604-product catalog.

Usage to date: one workbook export and 4 changed rows, all on 2026-08-18.

### Verification limit

The round trip and the live counts were executed and observed. The two buttons were confirmed by
reading the wiring in `src/pages/Products.tsx` — handler → library → live RPC — **not** by clicking
them in a browser; the page is admin-gated and would need a stubbed harness. That is exactly what
the deferred pre-season test is for.
