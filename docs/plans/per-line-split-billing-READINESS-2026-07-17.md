# Per-Line Split Billing — Readiness Report (grounding for the build)

Companion to `per-line-item-split-billing-spec-2026-07-17.md`. Produced by 4 parallel grounding agents
(2 Opus: engine + pricing/Mode-A; 2 Sonnet: post/unpost/transfer + frontend) against the LIVE code + DB
on 2026-07-17 night. This is the "get ready to build" verification the spec §8 asked for.

## Bottom line
The spec is **sound and buildable**. The feature is **entirely net-new** on top of today's
acre-weighted, one-invoice-per-owner engine — nothing today splits a single line across customers.
No blockers found; a handful of spec assumptions needed correcting (below). All money math today is
already SQL/`numeric` (no JS on the authoritative path) and already rounds half-away-from-zero, so the
spec's biggest rounding trap is forward-looking, not a live bug.

## Corrections to the spec (fold into the build)

1. **Two base-price resolvers, not one.** Chemical line base price resolves **manual → quoted → tier → 0**
   (`20260630180000...:413-444`). `customer_application_rates` is the **service-fee** per-acre rate only
   (`:497-503`), a separate axis. The spec §5 conflated them. The calculator needs a product-price
   resolver AND a service-fee resolver.
2. **`invoice_items.acres` is `numeric(12,2)`**, `quantity` is `(12,4)` (`phase2 billing arch`). Store the
   authoritative allocated acres at 4dp in `quantity`/the share table; treat `invoice_items.acres` as 2dp
   display (or bump it to 4dp in the additive migration).
3. **`safe_cents_qty` is half-away-from-zero, but its comment falsely says "banker's rounding"**
   (`20260513030000...:51`). Fix the comment so nobody "corrects" the engine. Postgres `round(numeric)` =
   half-away-from-zero (banker's applies only to `double precision`).
4. **Preview and save are two copy-pasted SQL bodies** (save uses `safe_cents_qty`, preview uses inline
   `ROUND`). Identical today by luck. The new **one shared calculator** must replace BOTH — never add a 3rd.
5. **No post snapshot, no freeze trigger today.** `invoice_items`/`invoice_shares` RLS allows direct
   `is_admin()` UPDATE/DELETE with no status check; child rows are hard-DELETEd + rebuilt on every save.
   Both the append-only post snapshot AND the immutability lock are net-new. **Proven precedent to copy:**
   `prevent_order_shares_edit_after_post()` (`20260504100000`) — a BEFORE INS/UPD/DEL trigger that raises
   when a sibling invoice is posted/paid/overdue and naturally reopens on unpost. Reuse this shape for
   `invoice_line_shares`.
6. **Unpost IS reversible today** (MATCH spec §1): `unpost_invoice` / `unpost_invoice_group` flip status
   back to `unposted`, refuse if money is attached, and re-save is allowed on draft/unposted. The build
   must preserve this and NOT let the hard-delete-rebuild path destroy the posted allocation snapshot.
7. **`transfer_job_to_invoice` reads `field_billing_defaults` LIVE** (not `job_field_shares`), while
   scheduling/notifications read the `job_field_shares` snapshot (precedence: job snapshot → field default
   → primary owner). Divergence is real. The one shared resolver must be wired into `transfer_job_to_invoice`
   too, or that path explicitly blocked for split invoices.
8. **Email gating is load-bearing: 5 send sites in 2 shapes.** Shape A routes through
   `buildInvoiceEmailPayload` (`emailService.ts:114`): `FieldApplicationInvoice.tsx:1997`,
   `FieldInvoicesListPanel.tsx:285`. Shape B builds payload inline (NOT via the shared builder):
   `InvoiceDetail.tsx:1055-1107`, `FieldInvoicesPostedPanel.tsx:266-320`, `FieldInvoicesUnpostedPanel.tsx:257-309`.
   Gating only the shared builder leaves 3 of 5 unguarded. Gate on the new server-computed
   `send_disposition = 'suppressed_zero_total'` — **NOT** on `balance_cents === 0` (a paid-in-full invoice is
   also 0 and must stay emailable). Best: consolidate all 5 onto one builder + gate.
9. **`InvoiceDetail.tsx` editable qty/price inputs** (`:1543-1567`, recompute at `:561`, gated by
   `editable` on draft/unposted) could overwrite a server-allocated split `extended_cents`. Add a per-item
   read-only lock for any item carrying a `billing_line_id`/split marker, or confirm split invoices never
   route through that editor while draft.
10. **Idempotency template = the live `post_invoice_group`** (`20260716224000...:373-528`): advisory lock +
    `check_idempotency` + `IDEMPOTENCY_PAYLOAD_CONFLICT` on cache-hit mismatch. Reuse for new save/post.
11. **Mode-A detection** = any selected field with `field_billing_defaults.price_override_cents IS NOT NULL`.
    Reject the whole per-line feature for those fields (chemicals are $0 grower-share, fee suppressed).

## Display authority — already compliant
Every render/print site (`CustomerSharesTable.tsx:257`, `invoicePdf.ts:817-828/1043-1051`,
`InvoiceDetail.tsx:1577`) prints stored `extended_cents`/`amount_cents`; none recompute qty×price for a
line amount. The build just has to KEEP populating `extended_cents` with the residual-adjusted allocation.

## Live schema facts
- `field_app_billing_sets` / `field_app_billing_lines` / `invoice_line_shares` — do NOT exist (clean to create).
- `invoice_items`: `quantity numeric(12,4)`, `unit_price_cents bigint`, `extended_cents bigint`,
  `acres numeric(12,2)`; no `split_source_key` yet (additive).
- `invoices.balance_cents` GENERATED (never write).

## Build order (this run) + autonomous scope
Per spec §6, and bounded by the hard gates (live apply needs Mason + baseline cycle):
1. **[TONIGHT] Additive schema migration** — 3 new tables + RLS + immutability trigger + `send_disposition`
   + `split_source_key` (+ acres precision decision). Flag OFF. Proven via BEGIN…ROLLBACK smoke. Reviewed
   (Opus adversarial + Codex).
2. **[TONIGHT] The one shared SQL calculator/resolver** — standalone, pure function of inputs: two
   base-price resolvers, grower-share/Mode-A exclusion, complete vectors incl. 0% rows, largest-remainder
   for qty(4dp) AND cents (abs-floor-negate, `customer_id ASC` tie-break), per-person price override, job
   → field → owner precedence. Proven against the spec's hard cases (1¢ 50/50, even 3-way, negative return,
   different per-person prices, grower-share exclusion) via SQL smoke. Reviewed.
3. **[AS FAR AS PROVABLE] RPC wiring + frontend editor + 5-site email gate + InvoiceDetail lock** — built
   behind the flag; each piece proven before it counts.
4. **[PARKED — Mason] Live migration apply + flag flip + baseline real-billing cycle + go-live.**

**Nothing is applied to the live DB in this run.** Migrations are proven by rollback smoke only. The
feature flag stays OFF. Go-live is a separate, owner-gated session.
