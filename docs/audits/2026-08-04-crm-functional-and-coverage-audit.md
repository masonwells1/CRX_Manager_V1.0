# CRM Audit — Functional State and Coverage Gaps

**Date:** 2026-08-04 · **Scope:** the whole customer-relationship surface — `/customers`, `/customers/:id` (11 tabs), `/call-lists`, `/compliance` (customer licenses), the six CRM tables, and their RPCs.
**Evidence:** current source on `claude/crm-audit-functionality-fww9ve`, live read-only introspection of Supabase `rhyzpcqhnizqbxphqdkr`, full test suite, typecheck, build.

---

## Verdict

**The CRM machinery is sound. The CRM is not being used.** Every feature shipped in the July relationship-intelligence loop is live, wired, RLS-protected, and works. But after ~three weeks in production it holds **zero interactions, zero grower facts, zero documents, and zero customer applicator licenses**, and 97% of the customer book has no assigned sales rep. The single biggest thing standing between CRX and a working CRM is not code — it is that the records that feed it are empty.

Two real code defects were found and fixed in this pass. One further correctness weakness is documented below and remains open — the add-fact path is still retry-unsafe, so a committed response lost in transit can double-log a fact (section 4); it predates this pass and was not introduced here. Everything else below is a coverage or adoption gap with a recommendation attached.

---

## 1. Live data reality (read-only, 2026-08-04)

| CRM table | Rows |
|---|---|
| `customers` | 153 (150 active) |
| `customer_contacts` | 135 (134 active) — backfilled from legacy `customers.phone` |
| `customer_addresses` | 5 |
| `customer_interactions` | **0** |
| `customer_facts` | **0** |
| `customer_documents` | **0** |
| `applicator_licenses` | **0** |
| `interaction_transcripts` | 0 (expected — Phase 5 not built) |
| `external_identities` | 0 (expected — Phase 5 not built) |

Completeness across the 150 active customers:

| Field | Missing | Share |
|---|---:|---:|
| `assigned_sales_rep` | 146 | **97%** |
| `crops` | 150 | **100%** |
| `credit_limit_cents` (0 or null) | 149 | **99%** |
| `payment_terms` | 147 | 98% |
| `total_acres` | 147 | 98% |
| `email` | 132 | 88% |
| `phone` | 104 | 69% |
| `billing_address` | 21 | 14% |

Pricing tier: **149 of 150 customers are Tier 1**, one is Tier 3. Tier 2 is unused.

### What that data state actually breaks

These are not hypothetical — they follow directly from the numbers above.

1. **"Unassigned accounts" call list returns ~146 rows.** It was designed as an exception list; at 97% it is the whole book and carries no signal.
2. **The crop filter on Call Lists can never match.** Zero customers have `crops` set, so selecting any crop always yields an empty list. The filter works correctly; it has nothing to filter on.
3. **The tier filter is effectively a no-op**, and 3-tier pricing is not being exercised — everyone is quoted at Tier 1.
4. **Credit limits are inert across the entire book.** `check_customer_credit_limit` treats `credit_limit_cents <= 0` as "no limit set" and returns `exceeded: false`. With 149/150 at zero, the credit guard never fires for anyone. This is correct code behaving as designed on empty data, but it means CRX currently has **no credit control**.
5. **Statements and invoices can't be emailed to 88% of customers.** No email on file means the send path has nowhere to go.
6. **Every RUP sale is recorded as `non_compliant`.** `generate_rup_sales_records` looks up `applicator_licenses` by `customer_id`; with zero rows it writes `compliance_status = 'non_compliant'` and the note *"No applicator license on file for this customer."* For a restricted-use pesticide dealer this is the highest-consequence item on this page — dealer records are a legal obligation, not a nice-to-have. (No RUP sales have been recorded yet, so nothing is currently mis-filed; the exposure begins with the first RUP invoice.)
7. **Prepay-prospect and lapsed-product call lists are empty** — correctly so, per the July ledger: they compare season-over-season and the live DB has no prior-season invoices. These start working at season rollover, not before.

**Recommendation (highest value, no code required):** a data-completion pass over the 150 active customers — assign a rep, set crops, set credit limit and terms, capture email. That one pass turns four shipped features from decorative into operational. Sections 2 and 3 below include the code changes that make that pass practical.

---

## 2. Defects found and fixed in this pass

### D1 — Cross-customer financial data leak on the Financials tab (HIGH, fixed)

`CustomerDetail` caches its Financials fetch in a ref (`financialsFetched`) and the route element `customers/:id` carries no key, so React Router keeps **the same component instance mounted** when only the `:id` param changes. The command palette navigates directly between customer profiles. The sequence:

> Open customer A → Financials tab → ⌘K → jump to customer B → **customer B's page renders customer A's AR aging, 90-day statement transactions, and prepay credits under B's name.**

This is the same bug class Sol blocked twice during the July CRM loop (fixed there with `key={id}` remounts on the CRM child components). The Financials tab predates that loop and was outside the reviewed delta, so it was never covered.

The same file also had **no request-sequence guard anywhere in `fetchTabData`** — an in-flight Quotes/Orders/Deliveries/Fields/Timeline/History load for customer A could resolve after navigation and write A's rows into B's view.

**Fix** (`src/pages/CustomerDetail.tsx`): a `tabRequestSeq` guard on every state write in `fetchTabData`, plus an effect on `id` that clears all per-customer tab state and resets the financials cache flag.

**Proof:** new regression test `reloads the financials tab when the route switches customers without remounting the page` in `src/pages/CustomerDetail.test.tsx`. Verified failing without the fix (customer 2 rendered customer 1's `$1,234.00`) and passing with it.

### D2 — Customer list silently truncated and unfilterable (MEDIUM, fixed)

`/customers` fetched with a hard `.limit(500)` and no indication when the cap was hit — the list simply read as "this is everyone". It also had **no active/inactive filter**, so deactivated customers stayed mixed into the working list permanently (the Deactivate bulk action's only visible effect was a badge change), and **no sales-rep column or filter**, despite rep assignment being the axis the call lists and RLS scoping are built on.

**Fix** (`src/pages/Customers.tsx`):
- Cap raised to 1,000 with an explicit truncation banner when reached.
- Status filter (Active / Inactive / All), defaulting to **Active** so the list stays a worklist.
- Sales-rep column (resolving names via `profile_public_view`) and a rep filter including an **Unassigned** option.
- Email column — makes the 88%-missing gap visible where it can be fixed.
- A dismissible callout counting active customers with no rep, with a one-click jump to them. This is the practical entry point for the assignment pass in section 1.

**Proof:** new `src/pages/Customers.filters.test.tsx` — 5 tests covering the default-active behavior, rep and unassigned filtering, the unassigned callout jump, and truncation warning on/off.

---

## 3. Coverage gaps — what a modern ag retailer needs that CRX does not have

Ranked by value to CRX specifically. Nothing here is broken; these are things that do not exist.

### G1 — Customer applicator licenses are invisible where they matter (HIGH)

`applicator_licenses` supports `customer_id` and drives RUP compliance status, but the **only** place to view or edit one is the `/compliance` page. A rep looking at a customer profile — or building a quote containing an RUP product — cannot see whether that grower's private applicator certification is current, expired, or absent. There is no license status on the customer record, the Call Prep card, or the quote flow.

**Recommendation:** surface license status on `CustomerDetail` (info tab) and on `CustomerPrepCard`, and warn at quote/order time when an RUP line is added for a customer with no current license. The customer-side read is a simple RLS-governed query on `applicator_licenses`; adding it to the prep card payload would need a migration to `get_customer_prep_card`. **Needs your go-ahead** — it touches a compliance path.

### G2 — No sales pipeline before the quote (HIGH)

Identified in the June 2026 idea-mining audit as CRX's loudest CRM gap and still open. There is no lead, no opportunity, no stage, no probability, no expected close date, and therefore no forecast. Work only becomes visible once someone builds a quote. For a dealer working a book of growers through a booking season, "what deals are we working and what will they close at" is not answerable today.

**Recommendation:** the design is already written up in `docs/audits/2026-06-19-future-projects-idea-mining/theme-CRM-UX.md` (candidate #1: `sales_opportunities` + admin-editable `sales_stages`, Kanban by stage, weighted forecast, convert-to-quote). This is a net-new subsystem — table, RLS, page, report — and needs your decision before anyone starts.

### G3 — No duplicate-customer detection (MEDIUM)

Nothing prevents two reps entering the same farm twice, and nothing detects it afterward. There is no `merge_customer` path either, so a duplicate discovered later has no clean resolution — it splits AR, purchase history, commissions, and every call list. With 153 customers this is manageable by hand; it stops being manageable as the book grows.

**Recommendation:** a soft "did you mean this existing customer?" warning on new-customer save (fuzzy farm name + phone match), non-blocking. Cheap. The merge path is a much larger job and should wait until a duplicate actually appears.

### G4 — Bulk import cannot set the fields the CRM runs on (MEDIUM)

`BulkCustomerImport` maps only `farm_name`, `contact_name`, `phone`, `email`, `billing_address`, `payment_terms`, `assigned_tier`. It cannot set `assigned_sales_rep`, acres, crops, credit limit, or address components. This is a direct cause of the data state in section 1 — the import that created the book had no way to carry rep assignment or acreage.

**Recommendation:** either extend the importer's field mapping, or add a **bulk "Assign sales rep"** action to the Customers page selection bar (the same shape as the existing Deactivate action, admin-only). The bulk action is the smaller change and solves the immediate 146-customer problem. **Needs your go-ahead** — it is a new write path on customer ownership.

### G5 — Outbound email and texts never reach the interaction timeline (MEDIUM)

Statements, invoices, and order confirmations are sent through `emailService`, but none of them write a `customer_interactions` row. The timeline therefore shows only what a rep manually logged, and "last contact" on the call lists ignores every automated touch. A customer emailed a statement yesterday still shows as "no contact in 30 days".

**Recommendation:** log an `interaction_type = 'email'`, `source = 'system'` row on successful send. Small and self-contained, but it writes to a CRM table on a money-adjacent path, so it should go through the normal migration/review gate.

### G6 — No customer or grower portal (LOW for now)

Growers cannot see their own statements, prepay balance, application records, or documents. Everything is rep-mediated. This is a strategic build, not a gap to close this month, and it depends on G2 and the field/program model maturing first.

### G7 — Segmentation stops at tier (LOW)

There is no customer type (prospect / active / dormant), no lifecycle stage, no tags, no campaign or bulk-messaging surface. Tier is a pricing axis, not a relationship axis, and it is currently unused anyway. Worth revisiting only after G2 lands, since opportunity stage covers most of the need.

### Already covered — no action needed

Contacts with roles and permissions · call logging with idempotent retry · grower knowledge base with review queue · call prep card · five seasonal call lists · per-customer documents with expiry warnings · activity timeline · tasks and notes on any record · AR aging, statements, payment history, prepay · purchase history · field/agronomy linkage · planned-vs-actual via quote programs and ProgramTracker · year-end season summary · customer profitability reporting · commission splits.

---

## 4. Security and correctness posture

Verified live, read-only:

- **RLS is enabled with policies on all nine customer-domain tables** — `customers` (5 policies), `customer_contacts` (3), `customer_interactions` (6), `customer_facts` (4), `customer_documents` (6), `customer_addresses` (4), `interaction_transcripts` (4), `external_identities` (3), `applicator_licenses` (4).
- `save_customer` ownership enforcement is applied (migration `20260717123000`), closing the pre-existing gap where any rep could edit any customer including credit fields.
- `log_customer_interaction` is a SECURITY DEFINER RPC with canonical idempotency and an exact-request fingerprint; the modal resets its key per open and handles the replay-mismatch case.
- Money handling in the CRM surface is correct. `formatCents` / `formatUSD` are used per their documented semantics throughout; the Purchase History tab's `order_items.total_price` is legacy `numeric` dollars and is formatted as such.
- The stale-response discipline (`requestSeq` guards, per-customer remounts) is applied correctly in every CRM component built during the July loop. The gap was in `CustomerDetail`'s own tab loader, which predates it — fixed as D1.

### Known remaining weakness (documented, not introduced here)

**The add-fact path is still retry-unsafe.** `CustomerFacts` adds a new fact with a direct table insert. A committed response lost in transit, then retried, double-logs the fact. The interaction path got its idempotent RPC on 2026-07-17; the fact path was left as a tracked follow-up in the loop ledger and is still open. Low blast radius (facts are advisory, and the review/supersede RPCs already carry idempotency keys), but it should be closed the same way.

---

## 5. Verification

| Check | Result |
|---|---|
| `npm run typecheck` | Pass |
| `eslint` on changed files | Clean |
| `src/pages/CustomerDetail.test.tsx` | 9/9 pass; D1 regression test verified failing without the fix |
| `src/pages/Customers.filters.test.tsx` | 5/5 pass (new) |
| Page render smoke | Pass |
| Full vitest suite | Pass |
| `npm run build` | Pass |
| Live DB introspection | Read-only only; no writes, no migrations applied |

---

## 6. Recommended next step

**One thing, in this order:**

1. **Do the data-completion pass** on the 150 active customers — rep, crops, credit limit, terms, email. Nothing else on this list pays off until this is done, and the Customers-page changes shipped here are built to make it practical.
2. Then decide on **G1 (license visibility)** — it is the one item with legal exposure behind it.
3. Then decide on **G2 (sales pipeline)** — the largest build, and the one that changes how the season is worked.

G3, G4, and G5 are small and can be picked up whenever; G6 and G7 should wait.
