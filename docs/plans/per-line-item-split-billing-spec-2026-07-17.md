# Per-Line-Item Split Billing — Design Spec v2 (FUTURE build)

**Status:** DESIGN SPEC — v2, review-hardened. Approved in concept by Mason 2026-07-17. **Not
started.** Mason will start the build in **Codex next week** (once usage credits reset). Do NOT begin
without a first real field-application billing cycle on the existing engine (baseline proof) first.

**How this spec was produced:** live DB + code audit (session 2026-07-17) → `gpt-5.6-terra` design
advisory → this spec → `gpt-5.6-terra` **xhigh plan review** (4 blockers, folded in) → **`claude-fable-5`
money-math review** of §4 (2 real bugs + ~8 unpinned rules, all folded into §4/§5). (`gpt-5.6-sol`, the
Codex frontier tier, was at capacity across 3 attempts — its independent pass is optional now that Fable
covered the money math.) **Codex is the intended builder; a final build-time review must re-check live
`pg_proc`/`pg_policies`/constraints/generated types against production before any migration apply.**

---

## 1. Owner workflow model (the anchor)

Two separate things, kept separate:

1. **Field ownership split** (`field_billing_defaults`) — e.g. a field is 50/50 tenant/landlord. This
   is the **stable default only**; it does not change job-to-job.
2. **The actual bill** — all real adjustments (who pays which product, a one-off price, 0% a line)
   happen in the **UNPOSTED (draft) field-application invoice**. **Posting produces the actual
   invoice.**

**Unpost is reversible (Mason, 2026-07-17):** a posted split invoice CAN be unposted and edited (like
regular invoices today), then re-posted. Immutability therefore applies **only while posted** — not
forever. Every post writes an **append-only post snapshot** so history is preserved across
unpost/edit/re-post cycles. (This is the existing `unpost_invoice` / `unpost_invoice_group` behavior;
the split feature must respect it, not fight it.)

---

## 2. Requirements (settled with Mason 2026-07-17)

- **Default** every line's split from field ownership (as today).
- **Even splits are the norm** (50/50, 33.33/66.67, 60/40 — display shorthand; the stored vector is
  exact micro-percent per §4, e.g. 33,333,333 / 66,666,667) applied to applied quantity/acres; each
  person billed at **their own applicable price**.
- **Per-line % override** — a different share on a specific product/service line. An override is a
  **complete vector** ("100% tenant" ⇒ the landlord's **0% row is still stored** — see §3).
- **Per-person PRICE override (rare, ~1/200)** — hand-edit the unit price a specific person pays for a
  specific product OR the application. Driver: one party prepaid (locked price), the other pays current
  price, on the same job. Gated as an "advanced" one-off so it never clutters the common flow.
- **Show all prices** on the split screen.
- **$0 recipient:** still **post and record** the invoice (shows in the customer's account summary) at
  `total=balance=0`, flagged server-side as **not-to-send** (do NOT mark it paid). See §3/§5.
- **No fuel surcharge, no "discount earned" line.**

---

## 3. Data model (review-hardened)

Use **real database parent records** — not a browser-supplied UUID — so the structure is auditable
and sturdy:

- `field_app_billing_sets` — one durable set per billing event (covers grouped AND single-recipient
  invoices; replaces relying on nullable `invoice_group_id`).
- `field_app_billing_lines` — one **server-created** logical source line per chemical/service/flat fee.
- Each child `invoice_item` and each `invoice_line_share` references that logical line.

`invoice_line_shares` — the immutable per-line allocation snapshot. Minimum properties:

```sql
create table public.invoice_line_shares (
  id uuid primary key default gen_random_uuid(),
  billing_line_id uuid not null references public.field_app_billing_lines(id) on delete cascade,
                                          -- draft-only cascade (line → shares); NOT the immutability mechanism (§5)
  invoice_item_id uuid not null references public.invoice_items(id) on delete cascade,  -- child item, this customer
  customer_id uuid not null references public.customers(id),

  split_mode text not null check (split_mode in ('field_default','custom')),
  split_micro_pct integer not null check (split_micro_pct >= 0 and split_micro_pct <= 100000000),
                                          -- 0..100% in micro-percent so exact vectors are integer-exact
  allocated_quantity numeric(12,4),       -- MATCH invoice_items.quantity precision; deterministic residual
  allocated_acres numeric(12,4),          -- must not silently truncate the higher-precision allocation

  base_unit_price_cents bigint not null,  -- resolved base (global manual / quote / tier / customer_application_rates)
  base_price_source text not null,        -- which source the base came from
  price_mode text not null check (price_mode in ('default','override')),
  unit_price_cents bigint not null,       -- effective price (= base unless overridden)
  amount_cents bigint not null,           -- = the child invoice_item's extended cents

  split_override_reason text,             -- required when split_mode='custom'
  price_override_reason text,             -- required when price_mode='override'
  calculation_hash text not null,         -- SERVER-computed; never a browser value
  vector_hash text not null,              -- SERVER-computed
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),

  unique (invoice_item_id),
  unique (billing_line_id, customer_id)   -- a customer appears once per line → tie-break is deterministic
);
```

Enforce (constraint triggers / inside the RPC):
- store a row for **every billing-set member on every logical line, including 0% / $0 rows**;
- each line's customer set **exactly equals** the billing-set member set;
- every vector **sums to exactly 100%** (integer micro-percent);
- the child item belongs to **that customer's** child invoice;
- `amount_cents` = `invoice_items.extended_cents`; child headers = sum of their child lines;
- **no update/delete after the post boundary** (immutable *while posted*; unpost is the sanctioned
  reopen — see §1);
- RLS on: scoped `SELECT` through `invoice_items → invoices`; **no browser INSERT/UPDATE/DELETE**
  policies + explicit revoke of direct mutation; all writes stay inside the locked SECURITY DEFINER
  save path. (`ON DELETE CASCADE` is acceptable only for editable drafts — it is NOT the immutability
  mechanism.)

---

## 4. Penny-exact algorithm — CORRECTED

**Correction to spec v1:** "independent per-customer computation is penny-safe by construction" is
**not fully true.** Independent rounding makes the group total = sum of child totals, but that does NOT
always equal a canonical unsplit source-line total. Examples: 1 unit @ 1¢ split 50/50 → 1¢+1¢ = **2¢**
(unsplit line = 1¢); an even 3-way quantity split → `1.0000/3` = .3333×3 = **.9999**. So
largest-remainder allocation is needed for **quantities/acres AND cents**, not just flat fees.

Rules:
- Allocate quantities/acres at final storage precision (`numeric(12,4)`) with **deterministic
  largest-remainder residual assignment** (tie-break by `customer_id`).
- **Same-price lines:** allocate the canonical source-line cents by largest remainder.
- **Different per-person prices:** there is no single natural parent total — the authoritative total is
  `SUM(round(person_price × allocated_quantity))`. Document this as the group total.
- **Flat fees** (fixed bigint cents): largest-remainder by percentage, tie-break by `customer_id`.
- Never distribute a remainder at the customer/invoice level (it would land a stray cent on the wrong
  product line).

**Do NOT promise "byte-for-byte identical to today's output when no custom rules are set"** — that
conflicts with fixing today's 2-decimal/4-decimal rounding. Instead: **keep the old engine unchanged
while the feature flag is off**, and give the new feature an explicit **versioned rounding policy**.

### Pinned rules (claude-fable-5 money-math review, 2026-07-17) — put these verbatim in the build

1. **All arithmetic in Postgres `numeric`/bigint — never float, anywhere, including the TS preview.**
   ONE shared SQL function computes the split; the preview calls the SAME function posting uses
   (single-engine rule). Otherwise the JS preview and PG post round negatives differently and ship a
   1¢ preview/post mismatch on every return/credit that lands on a half-cent (proven example below).
2. **Rounding mode = half-away-from-zero** (Postgres native `round(numeric)`); audit-explainable, NOT
   banker's.
3. **Round exactly once per money figure** — unit-converted prices/quantities stay at full numeric
   precision through the multiply; only the final to-cents step rounds. Never round a conversion factor
   or an intermediate.
4. **Largest remainder, defined precisely:** compute ideal shares in numeric; `floor` each **on the
   absolute value**; distribute the residual one cent (or one 0.0001-unit) at a time ordered by
   `(fractional_remainder DESC, customer_id ASC)`; then reapply the sign. Abs-then-negate makes returns
   / negative lines mirror positive ones exactly.
5. **Same ordering in BOTH passes** (quantities AND cents): `customer_id ASC` breaks every tie — no
   exceptions — so the "extra" quantity-tick and the "extra" cent land on the same customer. Enforce
   `UNIQUE (billing_line_id, customer_id)` so a customer can't appear twice in one vector.
6. **The default/even vector is built by the same largest-remainder rule** (micro-percent, same
   tie-break): `33,333,333 ×3 = 99,999,999 ≠ 100,000,000`, so an even 3-way split needs
   `33,333,334 / 33,333,333 / 33,333,333` or the most common preset violates the sum-to-100% invariant.
7. Do the `price × micro_pct` intermediate in `numeric` (overflow-safe) rather than reasoning about
   bigint limits.

**Proven failing examples this pins shut:** (A) return line 25¢/unit × −0.5 → JS `Math.round(-12.5)=−12`
but PG `round(-12.5)=−13` → 1¢ preview/post gap; (B) 1 acre @ $99.99 split 50/50 stores 5000/4999¢ but a
renderer recomputing `qty × price` prints $50.00/$50.00 = $100.00 ≠ $99.99 (see the display-authority
invariant in §5); (E) the even-3-way vector above.

---

## 5. Other required behaviors

- **One server-side calculator/resolver** that takes the **source job context** and applies precedence
  **job snapshot → field default → field-owner fallback**, complete custom vectors, price precedence,
  quantity residuals, and cents. Preview AND save both call it (no copy-pasted preview/save math).
  Today `derive_customer_shares_from_fields` reads only `field_billing_defaults` and the preview/save
  payloads don't carry `job_id` — that must change. **Wire the resolver into `transfer_job_to_invoice`
  too**, or explicitly block that path for this feature, else scheduling notices and billing still
  diverge.
- **Price precedence preserved:** snapshot the resolved base price + its source (global manual / quote /
  tier / `customer_application_rates`), then layer the person-specific override on top. Don't flatten
  the existing per-customer tier/service pricing.
- **Grower-share "Mode A" fields:** reject the **entire** per-line feature for any selected Mode A field
  (not just one UI control) — Mode A zeros chemical lines and suppresses the service fee, incompatible
  with product-vs-service splitting. Its own design comes later.
- **$0 / not-to-send invoice:** a normal **posted** invoice at `total=balance=0` with a server-controlled
  `send_disposition = 'suppressed_zero_total'`; contributes zero to AR/aging/finance charge; **not**
  marked paid. **Gate ALL email paths** (`FieldApplicationInvoice`, `InvoiceDetail`, field-invoice list
  panels) — the server computes suppression; the browser only displays it.

### Money-integrity invariants (claude-fable-5 review, 2026-07-17)

- **Display authority + residual persistence:** the split writer sets each child
  `invoice_items.extended_cents` to the **residual-adjusted allocation from §4** (NOT an independent
  per-child round of `qty × unit_price`) — e.g. a 25¢/unit × −0.5 return whose canonical value is −13¢
  is stored as −7¢ / −6¢ across the two children, never −6¢ / −6¢. That stored `extended_cents` is
  **authoritative**; renderers (PDF, statement, portal) **must print it and NEVER recompute
  `qty × unit_price`**. Add a test that every PDF/statement path sums stored cents and ties to the source
  line.
- **Post-time assertions** (in the posting RPC or a trigger — don't trust the allocation code, check its
  output): for every source line, `SUM(child amount_cents) = source cents` (same-price + flat-fee paths);
  `SUM(allocated qty) = source qty` at 4dp; `SUM(micro_pct) = 100,000,000`; and **the share-vector count
  ≥ 1 covering exactly the group's customers** (catches a line whose whole vector silently vanished).
- **Different-price path total is documented, not reconciled** — with per-line amount = `round(price ×
  qty)` each line ties by construction and the group total is definitionally the sum; there is no parent
  figure it should equal (an auditor will ask — the answer is "nothing; per-person pricing makes the sum
  primary").
- **Freeze-on-post + idempotency:** share edits trigger-blocked once posted; the posting RPC enforces
  `p_idempotency_key` — a double-post is a full duplicate child-invoice set (the largest possible cent
  error).
- **Atomic reallocation + cascade:** editing/removing a draft line rewrites its whole vector in one
  transaction; `ON DELETE CASCADE` line → shares so a removed line leaves no orphaned share cents.
- **`invoices.balance_cents` is GENERATED — never written.** Children are ordinary invoices whose totals
  flow through the normal item path; the group total is **derived reporting only, NOT a fifth balance
  lever** (see the credit-memo four-lever history — do not desync it).

---

## 6. Build order for Codex (+ proof checklist)

1. **Baseline first (exactly as spec).** Run one standard direct field-application cycle; prove
   preview → saved lines → headers → `invoice_shares` → PDF/statement → atomic post. (Ties to owner
   action #1 on the roadmap.)
2. **Additive schema migration (reviewed on its own, flag OFF):** billing-set/line records, the share
   table, precision changes, immutable/`send_disposition` fields, indexes, RLS, constraint triggers.
3. **One private SQL calculator/resolver:** job-share/default/fallback precedence, complete vectors,
   price precedence, quantity residuals, cents. Preview calls it first.
4. **Prove preview parity before enabling writes:** feature-off/default cases match the old calculator
   on the baseline; feature-on cases assert the returned calculation/vector hash is internally balanced.
5. **Separate RPC migration:** preserve the current public save wrapper's actor check, advisory/row
   locks, and group-status recheck (no blind `CREATE OR REPLACE`); preserve the customer-scope wrapper
   around `post_invoice_group`; the locked save writer consumes only the calculator's plan.
6. **UI + mail gates** added only after server validation exists; gate every invoice-email path.
7. **Legacy order-side cleanup stays a later, separate migration sequence** (see §7).

**Hard proofs on staging/test data (all required):** 50/50 product + 100/0 service with a real $0
child line and $0 child invoice · three-way fractional quantity and a 1¢ split · **a return/negative
line whose ideal lands on a half-cent — preview total MUST equal posted total** (the JS-vs-PG rounding
bug) · a renderer/PDF that must show stored `amount_cents`, not recomputed qty×price · different customer
prices + a per-person override · Mode A rejection before any write · job-snapshot wins after a field
default changes, default-only draft refreshes correctly · same idempotency key retries safely, same
key + changed payload → `IDEMPOTENCY_PAYLOAD_CONFLICT` · concurrent save/post → complete-then-post or
refused-save, never partial rows · posting rejects malformed vectors / header mismatch · $0 invoice
posts, shows in account history, contributes zero AR/aging/finance charge, every email route refuses
it · RLS proof as admin / sales_rep / applicator + direct browser DML denied.

---

## 7. Corrections carried from v1 (do not repeat)

- **The order-side split engine is NOT dead code.** `OrderDetail.tsx` still writes `order_shares` +
  `order_item_field_allocations` and calls `create_split_invoices_from_order` (hardened + tested); it is
  *unproven* (0 live rows), not dead. Retire it LATER in a coordinated cleanup after confirming zero
  real executions — NOT as part of this feature.
- **`order_line_allocations` cannot be dropped standalone** — nothing inserts it, but
  `_update_order_items_impl` still `DELETE`s from it; remove those references first, then drop it in a
  separate migration.
- Live split-table data (2026-07-17): only `job_field_shares` had rows (5); `order_shares` /
  `order_item_field_allocations` / `field_app_location_shares` / `invoice_shares` all 0.
  `field_billing_defaults` = 6 (ownership source of truth).

---

## 8. Residual risks / open before build

- Final **`gpt-5.6-sol`** money-math confirmation pass on §3–§4 (was at capacity 2026-07-17).
- The versioned-rounding policy (§4) must be written down explicitly rather than promising parity with
  today's every-case output.
- Build-time review must re-check live `pg_proc` / `pg_policies` / constraints / generated types
  against production before any migration apply (this spec was read-only, no live-grant access).
- Mason's explicit go-ahead + the §6.1 baseline cycle.
