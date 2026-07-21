# Per-Line Split Billing — SAVE/POST RPC Design + Build Handoff

Companion to `per-line-item-split-billing-spec-2026-07-17.md` (the spec) and
`per-line-split-billing-READINESS-2026-07-17.md` (grounding + 11 corrections).
This doc is the **grounded, ready-to-build design for Phase 4 (the save RPC)**,
produced against the LIVE code + DB on 2026-07-17 night. The two foundation
migrations it depends on are already **written, proven, and committed** on branch
`claude/per-line-split-billing-build`.

---

## WHERE THIS STANDS (read first)

**Built + proven + committed this run (autonomous, Opus-orchestrated):**
- **Phase 2 — schema** (`supabase/migrations/20260718010000_per_line_split_billing_schema.sql`,
  commit `4346fb11`): 4 tables + 3 additive columns + freeze trigger. Reviewed by 3
  reviewers, proven via `BEGIN…ROLLBACK` smoke against live schema. **Not applied live.**
- **Phase 3 — the penny-exact calculator** (`supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`,
  commit `a24e8f8a`): the 3 pure functions that are the money crux. **Proven by executing
  in the real Postgres engine** — all 11 hard cases pass (1¢ 50/50→1¢, even 3-way→1.0000,
  return −13¢→−7/−6, per-person prices, 100/0 with $0 row, flat 1001→334/334/333, +3
  malformed-input guards). Opus adversarial review: no numeric bug on any valid input.
  **Not applied live.**

**NOT built this run — this design is the handoff for it:**
- **Phase 4 — the SAVE RPC + resolver + post snapshot** (designed below).
- **Phase 5 — UI editor + 5-site email gate + InvoiceDetail lock** (spec §6.6; UI, not SQL).

**Why Phase 4 stopped at design, not code:** its input contract (`p_lines`/`shares`)
is pinned to a frontend that does not exist yet, so building it now risks rework once
that UI is designed; and the spec sequences it after a preview-parity step that needs
Mason's first real field-application billing cycle (spec §6.1). The design below is
grounded in the real engine so the build is mechanical.

**Nothing has been applied to the live database, pushed, or merged.** The two proven
migrations sit on the local build branch. Live apply + flag-on + go-live remain
owner-gated (spec §6.1 baseline first).

---

## Grounding — what the live engine actually does

**Save path:** `save_field_app_invoice` (guard wrapper) → `_save_field_app_invoice_impl_20260714`
(writer). The wrapper enforces `auth.uid()`, `p_performed_by = auth.uid()`, active
`admin`/`sales_rep`, `check_idempotency`, `pg_advisory_xact_lock(hashtextextended(group_id,0))`,
anchor-then-full-set `FOR UPDATE`, status `draft`/`unposted`, no member posted/voided.
The writer DELETE-and-rebuilds child `invoice_items`/`invoice_shares`, calls
`derive_customer_shares_from_fields`, and loops one invoice per customer.
`invoice_number` = `next_invoice_number('field_application')`. **Grouping = a shared
`invoices.invoice_group_id` uuid; there is no groups table.** Per customer it writes one
`invoice_shares` row that **statements and year-end reads** (`amount_cents`), so the split
writer MUST keep writing it.

**Post path:** `post_invoice_group` → `_post_invoice_group_customer_scope_impl` →
`_post_invoice_impl_20260714` (a pure status flip draft/unposted→`posted`, sets `due_date`,
writes `financial_audit_log('invoice_posted')`, `generate_rup_sales_records`). It touches
no share/allocation tables. **CONFIRMED reusable unchanged:** flipping the child invoices
to `posted` auto-freezes `invoice_line_shares` via `prevent_invoice_line_shares_edit_after_post()`
(keyed on `invoices.status`).

**Idempotency template** = the `post_invoice_group` wrapper (advisory lock +
`check_idempotency` + cached-payload compare → `IDEMPOTENCY_PAYLOAD_CONFLICT`).

---

## A. RPC signature + ordered writes

New **net-new parallel writer** (does NOT reuse the acre-weighted `_save_..._impl`).
Public wrapper + `_impl`, SECURITY DEFINER, `SET search_path = public, pg_temp`.

```
save_field_app_split_invoice(
  p_billing_set_id          uuid,     -- NULL = new; else re-save an existing DRAFT set
  p_source_job_id           uuid,     -- optional job context for the resolver
  p_invoice                 jsonb,    -- header: invoice_date, header_notes, salesman_id
  p_fields                  jsonb,    -- [{field_id, applied_acres}] (Mode-A gate + resolver input)
  p_lines                   jsonb,    -- [{line_kind, product_id|application_service_id, description,
                                      --   source_quantity, source_acres, source_unit_price_cents,
                                      --   source_flat_cents, base_price_source,
                                      --   shares:[{customer_id, micro_pct|null, split_mode,
                                      --            price_mode, override_unit_price_cents}]}]
  p_application_service_id  uuid DEFAULT NULL,
  p_performed_by            uuid,
  p_idempotency_key         text DEFAULT NULL
) RETURNS jsonb   -- {billing_set_id, invoice_group_id, invoice_ids, line_vector_hashes}
```

Ordered writes:
1. **Guards** — copy the live wrapper verbatim (auth.uid, actor match, active admin/sales_rep, `check_idempotency('save_field_app_split_invoice')`).
2. **Mode-A rejection** — any `p_fields` field with `field_billing_defaults.price_override_cents IS NOT NULL` → `RAISE 'MODE_A_UNSUPPORTED'` (spec §5).
3. **Re-save locks** (if `p_billing_set_id` given) — advisory lock on the set, `FOR UPDATE` the child invoices, assert all `draft`/`unposted`, delete prior `field_app_billing_lines` (cascade clears shares), `invoice_items`, `invoice_shares`, child invoices.
4. **`field_app_billing_sets`** — INSERT/reuse one row.
5. **Per source line → `field_app_billing_lines`** (server-created).
6. **Resolve + compute per line** — resolver (part C) fills null `micro_pct`; **two base-price resolvers** (readiness #1: product manual→quoted→tier; service fee `customer_application_rates`→`application_services.default_rate_per_acre_cents`); build `p_line` jsonb; call **`compute_line_split_allocation(p_line)`** — the single engine (preview calls the same fn).
7. **One child invoice per customer** — customer set = union of all lines' shares (must be identical per line). INSERT `invoices` (`invoice_type='field_application'`, `status='draft'`, `field_app_billing_set_id`, **`invoice_group_id` always assigned** so posting is uniformly `post_invoice_group`, `season`, `created_by`, `salesman_id`).
8. **Per allocation row** — INSERT `invoice_items` using the live canonical column set with `billing_line_id` set, `quantity=allocated_quantity`, `acres=allocated_acres`, `unit_price_cents`, **`extended_cents = amount_cents`** (authoritative, residual-adjusted; never recompute qty×price), `price_source=base_price_source`. Then INSERT `invoice_line_shares` (all calculator outputs, bound to that `invoice_item_id`).
9. **Per child** — `UPDATE invoices SET total_amount_cents=…`; `send_disposition = CASE WHEN total=0 THEN 'suppressed_zero_total' ELSE 'normal'`; write one compatibility `invoice_shares` self-100% row (statements tie); `financial_audit_log('invoice_created')`.
10. **Post-time SUM assertions** (spec §5 — check the allocator's output, don't trust it): per `field_app_billing_lines`, `SUM(invoice_line_shares.amount_cents)=source_line_cents` (source_lr/flat_lr); `SUM(allocated_quantity)=source_quantity` @4dp; `SUM(split_micro_pct)=100000000`; share customer set **exactly equals** the billing-set member set.
11. `save_idempotency`; RETURN.

**Posting stays `post_invoice_group(invoice_group_id, performed_by, key)` unchanged.**

## B. The resolver

```
resolve_line_split_vector(p_field_ids uuid[], p_source_job_id uuid, p_applied_acres_map jsonb)
  RETURNS jsonb   -- [{customer_id, micro_pct}] summing to exactly 100000000
```
Precedence per field (spec §5, readiness #7): **job snapshot `job_field_shares`(p_source_job_id,field_id)
→ `field_billing_defaults` → `fields.customer_id` owner @100%**. Acre-weight-aggregate across
fields, then convert split% → integer `micro_pct` by **largest-remainder (tie-break customer_id ASC)**
so it sums to exactly 100000000 (never naive `round(pct*1e6)`). For the even default, call the
existing `compute_even_split_vector(customer_ids)`.

## C. End-to-end rollback proof plan (the build must run this and pass before commit)

One transaction, `ROLLBACK` at the end. Two scaffolds: (1) apply the two parked migrations'
SQL in-transaction first (the tables/columns aren't live yet); (2) simulate auth —
`select id from profiles where role='admin' and is_active limit 1`, then
`set_config('request.jwt.claims', json_build_object('sub',<id>,'role','authenticated')::text, true)`.

FK dependencies to satisfy with synthetic rows (discovered live): `profiles.id→auth.users(id)`
(**reuse an existing admin, don't create**); `customers`(farm_name, assigned_tier dflt 1,
is_active, crops); `fields`(customer_id, field_name); `field_billing_defaults`(field_id,
customer_id, split_pct NOT NULL, is_primary); `products`(product_name, is_active, **is_rup=false**
so RUP post no-ops, pricing_version, tier1_price, inventory_unit, product_form);
`application_services`(name, default_rate_per_acre_cents); for the resolver test:
`jobs`,`job_fields`,`job_field_shares`. Use `invoice_date=CURRENT_DATE` with no closed
`accounting_periods` covering it.

Assertions: the §5 SUM invariants; every `invoice_items.extended_cents = invoice_line_shares.amount_cents`;
the $0 child has `total=0, send_disposition='suppressed_zero_total'`, unpaid; preview total ==
stored total (single-engine parity); post flips all children to `posted`; a post-post
`UPDATE/INSERT/DELETE` on `invoice_line_shares` raises the freeze exception; same idempotency
key → identical result, changed payload → `IDEMPOTENCY_PAYLOAD_CONFLICT`; resolver follows
`job_field_shares` over `field_billing_defaults`.

## D. Decisions / risks for Mason (resolve before or during the build)

- **R1 — post snapshot.** `post_invoice_group` writes no `invoice_line_share_snapshots`.
  Recommended: an AFTER UPDATE trigger on `invoices` that, on `status→posted` with
  `field_app_billing_set_id IS NOT NULL`, copies `invoice_line_shares` → snapshots
  (smallest blast radius; keeps post unchanged). Alternative: a thin post wrapper.
- **R2 — keep the compatibility `invoice_shares` self-100% row** per child, or statements /
  year-end won't tie (they read `invoice_shares.amount_cents`). Do NOT drop as "redundant."
- **R3 — headless auth is only simulated** in the rollback proof; true actor/role/sales_rep-scope
  behavior needs an authenticated client. Residual unverified surface.
- **R4 — `transfer_job_to_invoice`** bills off `field_billing_defaults` live, ignoring
  `job_field_shares`. For split sets, either call `resolve_line_split_vector` there or
  explicitly block it — else scheduling and billing diverge.
- **R5 — two base-price resolvers** (product vs service fee) — don't flatten tier/service pricing.
- **R6 — `invoices.balance_cents` is GENERATED** — never write; the billing-set/group total is
  reporting-only, not a fifth balance lever.
- **R7 — always-assign `invoice_group_id`** (even single-recipient) differs from the legacy
  single→NULL behavior; intended (the billing set is the durable anchor) — don't "fix" it back.
- **Before go-live:** the spec §6.1 baseline cycle; live apply of all 3 migrations (gated);
  the UI/email-gate/InvoiceDetail-lock; a build-time re-check of live pg_proc/pg_policies/constraints.

## E. Build order for the next session
1. Implement `resolve_line_split_vector` + `save_field_app_split_invoice`(+`_impl`) + the R1
   snapshot trigger as ONE migration `20260718030000_per_line_split_billing_save_rpc.sql`.
2. Run the part-C rollback proof; iterate until every assertion passes; nothing persists.
3. rls-security-reviewer + Opus adversarial + Codex money/RLS gate.
4. Then Phase 5 UI (editor, 5-site email gate on `send_disposition`, InvoiceDetail lock).
5. Then Mason: baseline cycle → live apply (all migs) → flag on → go-live.
