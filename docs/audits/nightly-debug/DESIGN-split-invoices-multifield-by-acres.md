# Design: Multi-field split invoices, allocated by acres

**Status:** DESIGN COMPLETE — all decisions captured (2026-06-17, see §9). Not built. The build is a
focused next session (new tables + split-function rewrite + builder UI), gated on Mason's plan OK and
then the live-migration apply OK.
**Finding:** nightly-debug `money:create_split_invoices_from_order:independent-per-line-rounding`
**Severity:** MEDIUM · **Live risk today:** none (fully dormant — 0 split invoices ever, 0 multi-field quotes)
**Date:** 2026-06-17

---

## 1. Plain-English summary

"Split invoices" let one order be billed to several customers — e.g. a field that a
landowner and a renter share, or an order that covers two fields owned by two different
people. Today that feature has two real flaws, and Mason has confirmed the harder of the
two cases (multiple fields, different owners, divided **by acres**) is a real part of the
business. The catch: **the app can't even record an order line "spread across fields by
acres" today**, so fixing this properly is a small new *feature*, not a one-line bug fix.
It's completely unused right now, so nothing live is wrong — we can design it carefully.

---

## 2. The two flaws (verified against live code 2026-06-16/17)

The live function `create_split_invoices_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key)`:

1. **Penny drift.** Each customer's share of each line is rounded on its own:
   `v_split_ext := round(round(total_price*100) * total_pct / 100)`. With several owners,
   the rounded shares can sum to one or two cents off the line total, so the split invoices
   don't add up exactly to the order.

2. **Multi-field double-bill (the serious one).** It reads billing splits via
   `get_field_billing_splits_for_order`, which `sum(split_pct)` **per customer across all
   fields**, then bills each customer that summed percentage of **every** line. So an order
   covering 2 fields, each 100%-owned by a different customer, makes each customer's summed
   pct = 100 → **each is billed 100% of every line → 200% total billed.**

The data to do this right partially exists (each field's owner split lives in
`field_billing_defaults`), but the order lines themselves carry **no field attribution**, so
the function throws the per-field detail away.

## 3. What Mason decided (2026-06-17)

- **Multi-field splits are real:** one order can span several fields owned by different customers. (Confirmed; matches the earlier nightly-debug note.)
- **Allocation = "spread by acres":** a product applied across several fields should have its
  cost divided among those fields by each field's acres, then each field's portion split among
  that field's owners.

## 4. Verified current data model (the gap)

| Table | Has | Missing for this feature |
|---|---|---|
| `fields` | `id`, `customer_id` (owner), `total_acres` | — |
| `field_billing_defaults` | `field_id`, `customer_id`, `split_pct`, `is_primary` | the per-field owner split (this is the source of truth for "who pays for this field") |
| `quote_sections` | `quote_id`, `section_name`, **one** `field_id` | a section maps to exactly ONE field |
| `order_items` | `section_name` (free text), single `acres`, `quote_item_id` | **no `field_id`, no per-field acre breakdown** |

**Conclusion:** an order line can today be associated (loosely, by `section_name`) with at most
ONE field. There is no way to say "this 500 gal line covers Field A (100 ac) + Field B (150 ac)."
That capability has to be **added** — it's the heart of the work.

## 5. THE decision I need from you (drives the whole data model)

> In your real workflow, when a single product covers more than one field, how do you enter it?
>
> **Option A — one line per field.** You already list the product separately under each field's
> section (Field A: 500 gal; Field B: 750 gal), each line tied to its own field. *Simpler:* we
> just need to reliably tag each existing line with its field; no per-line acre-splitting math,
> no new child table.
>
> **Option B — one line, spread across fields.** You enter the product once (1,250 gal total)
> and the system divides it across Field A and Field B by their acres. *Heavier:* needs a new
> "this line covers these fields, these acres" record per line, plus builder UI to capture it.

Your answer "spread by acres" leans toward **B**, but A is far cheaper and may already match how
your reps actually build quotes (section-by-section). **I recommend confirming which it is before
I design the table** — it changes whether this is a ~2-file change or a ~6-file feature.

## 6. Proposed design (by option)

### If Option A (one line = one field) — smaller
1. **Migration:** add `field_id uuid REFERENCES fields(id)` to `order_items` (and carry it from
   `quote_items`/`quote_sections` on conversion). Backfill is unnecessary (no split invoices exist).
2. **Rewrite `create_split_invoices_from_order`:** for each line, look up THAT line's field →
   its owners in `field_billing_defaults` → bill each owner their `split_pct` of that line.
   Accumulate per customer across lines. Apply **largest-remainder (Hamilton) rounding per line**
   so each line's owner-shares sum exactly to the line total (mirrors
   `_insert_commissions_for_order` / `calculate_billing_splits`).
3. **Guard:** each field's `field_billing_defaults` must sum to 100% (validate; today all 3 live fields do).
4. **UI:** ensure the quote/order builder sets each line's field (it already groups by section/field).

### If Option B (one line, spread by acres) — feature
1. **Migration:** new child table
   `order_item_field_allocations(order_item_id, field_id, acres)` (+ a `quote_item_field_allocations`
   twin so quotes capture it and conversion copies it). RLS like the parent.
2. **Rewrite the split function:** for each line, split `line_total` across its fields **by acres**
   (Hamilton round so the field-portions sum to the line total) → for each field, split its portion
   among owners by `split_pct` (Hamilton again) → accumulate per customer.
3. **Builder UI:** a per-line "fields & acres" editor; validate acres > 0 and (optionally) that the
   line's total maps to the sum of field acres × rate.
4. Same per-field 100% guard as A.

### Common to both
- Replace the buggy `sum(split_pct) across fields` logic entirely.
- Use the existing canonical helper `calculate_billing_splits(line_cents, pcts[])` (already live,
  anon-exec-allowlisted) for the largest-remainder math so it's consistent with the rest of the app.
- Keep credit-memo / no-order exemptions intact; keep `invoice_group_id` grouping.
- Full gate before apply: rls + drift reviewers, Codex, JWT-spoofed rolled-back smoke on a synthetic
  2-field/2-owner order proving each customer is billed exactly their share and totals reconcile to the penny.

## 7. Risk / safety
- **Dormant:** 0 split invoices have ever been created and there are 0 multi-field quotes, so there's
  no live data to migrate and no live behavior to break while we build. The current buggy path simply
  isn't reachable in production today.
- The change is additive (new column/table + a rewritten dormant RPC). Existing single-customer
  invoicing (`create_invoice_from_order`) is untouched.

## 8. Open questions for Mason
1. **Option A or B?** (Section 5 — the gating decision.)
2. If B: where do the per-field acres come from — typed per line, or derived from the field's
   `total_acres` × the line's rate?
3. Should a split invoice ever mix fields with different owners **and** shared owners on the same
   line (e.g. Field A = 60/40 landlord/tenant, Field B = 100% co-op)? (The design above handles it;
   just confirming it's a real shape.)

Once you pick A vs B (and answer 2–3 if B), I'll turn this into a concrete build plan + migration and
bring it back for your OK before writing code.

---

## 9. Decisions locked (2026-06-17) + build plan

**Mason's decisions:**
- Multi-field splits are **real**; allocation is **by acres**.
- **Option B** — a product that covers several fields is entered **once** and the system spreads it across the fields.
- **Acres source = prefill + override:** auto-pull each field's acres from `fields.total_acres`, but allow a **per-line manual override** for when only part of a field is applied.
- **Owner split per field (v1):** use the field's default split in `field_billing_defaults` (no per-order owner override in v1).

**Build plan (a focused next session — multi-file + drift-sensitive; Opus/high-effort; dormant so no time pressure):**
1. **Migration A — new child tables** (each line's field+acre breakdown):
   - `quote_item_field_allocations(id, quote_item_id → quote_items, field_id → fields, acres numeric, created_at)` + RLS mirroring `quote_items`.
   - `order_item_field_allocations(id, order_item_id → order_items, field_id → fields, acres numeric, created_at)` + RLS mirroring `order_items`.
   - Indexes on the FK columns; both tables get RLS (architecture rule #2).
2. **Migration B — rewrite the split math.** Replace the buggy `sum(split_pct) across fields` in
   `create_split_invoices_from_order` (and adjust `get_field_billing_splits_for_order`): for each line →
   split `line_total` across its `order_item_field_allocations` **by acres** (largest-remainder via the
   live `calculate_billing_splits` helper) → for each field, split that portion among its
   `field_billing_defaults` owners **by split_pct** (largest-remainder) → accumulate per customer →
   one invoice per customer (keep `invoice_group_id`). Penny-exact by construction.
3. **Conversion paths:** `convert_quote_to_order` (+ draw/quick-delivery order creators) copy
   `quote_item_field_allocations` → `order_item_field_allocations`.
4. **Frontend builder:** per-line "spread across fields" editor — pick fields; acres prefill from
   `total_acres`, editable; live per-customer split preview. Update `src/types/index.ts`, the typed
   client `src/types/supabase.ts`, and RPC fixtures if a signature changes.
5. **Guards:** each field's `field_billing_defaults` must sum to 100%; `acres > 0`; a "spread" line must
   have ≥1 allocation.
6. **Full gate:** rls-security + migration-drift reviewers, Codex, a JWT-spoofed rolled-back smoke on a
   synthetic 2-field / 2-owner order proving each customer is billed exactly their acre-weighted share and
   the split invoices reconcile to the order to the penny; apply-guard proof; **Mason's apply OK**; invariant
   sweeps; docs.

**Recommendation:** build this as its own fresh session — it's a real feature (2 tables + RPC + UI), and
a long context erodes care on drift-sensitive DB work. It stays dormant and safe until then.
