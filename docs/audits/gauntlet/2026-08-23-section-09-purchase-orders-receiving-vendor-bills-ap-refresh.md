# Section 09 — Purchase Orders, Receiving, Vendor Bills, Vendor Payments, and AP Safety

Date: 2026-08-23  
Audited source: remote `main` `780e88aae7fc2ca0b6ae66e402608be866b03bb3` (confirmed with read-only `git ls-remote`)  
Checkout: `6f766135fddb687727f88d11e5a03a81fec1388f`, 50 commits behind and 2 ahead of `origin/main`, with 7 pre-existing uncommitted paths  
Live project: `rhyzpcqhnizqbxphqdkr` — PostgreSQL catalog and function definitions only

## Verdict

**INCOMPLETE — 0 BLOCKER / 2 HIGH / 0 MED / 0 LOW, plus 1 open product decision.** Section 9 has two production-risk defects: the dashboard's “Due This Month” card is a rolling 30-day window rather than the calendar month it names, and high-impact AP/receiving retries are operation-only rather than bound to the authenticated actor and exact payload. A third item — AP aging measuring from the vendor's bill date rather than its due date — is **not scored as a defect**: both bases are legitimate accounting views and no authoritative source in this repo states which one these buckets are meant to express, so it is recorded as an open product decision for Mason (re-classified 2026-08-24 from HIGH after CodeRabbit P2 on PR #457). The former vendor-bill/accounting-period race is resolved live, and the live RLS, routine grants, search paths, PO serialization wrappers, and core AP locks remain present.

**This section is NOT settled.** The deterministic section gate was not run because its contract rejects a checkout that is behind `origin/main` and cannot settle a dirty tree. The findings were independently reverified against the exact remote-main objects and the live function bodies, which makes them credible evidence — but evidence is not a settlement. Section 9 remains the current queue position and must be re-run from a clean, current checkout.

## Scope and method

- Read the required agent, safe-development, gotchas, Codex Gauntlet, and Section Gauntlet instructions.
- Used Graphify built from commit `6f766135`; queries: `graphify query "what connects PurchaseOrders, Receiving, Vendor Bills, Vendor Payments, AP Aging, and AP Dashboard?" --budget 1200`, then focused `graphify explain` calls for `get_ap_aging`, `get_ap_dashboard_summary`, `record_vendor_payment`, and `receive_po_items`. The broad query was noisy; the focused results narrowed source review to `AccountsPayable.tsx`, `VendorBillDetail.tsx`, `PurchaseOrderDetail.tsx`, and the latest function-replacement migrations. Graphify was navigation only.
- Verified the Git remote tip without changing refs. The relevant files have no diff between the checkout and `origin/main`, so the file:line citations below describe both.
- Queried only live PostgreSQL structure: `pg_proc.prosrc`, function security/config/ACL fields, table RLS/ACL fields, policies, and non-internal triggers. No business rows, Sentry, Vercel, GitHub PRs, browser sessions, logs, or runtime telemetry were inspected.
- Supabase's `list_tables` connector automatically returned aggregate row-count metadata together with structure. Those counts were outside the requested evidence boundary and were not used or scored; no row contents or business-row probes were requested.
- No tests were run because the audit allows writes only in this folder and the repository's test tooling can create state elsewhere.

## Findings

### OPEN PRODUCT DECISION 1 — AP aging buckets are based on bill age; no authoritative source says they should be days past due

> **Re-classified 2026-08-24 (CodeRabbit P2 on PR #457, accepted).** This was originally scored HIGH. The
> evidence below proves only *which* basis the report uses; it does not prove that basis is wrong.
> Invoice-date aging and due-date aging are both standard, materially different accounting views, and
> neither the UI nor `docs/reference/rpc-functions.md` defines these buckets as days past due. Calling the
> current basis a production defect — and queueing a SQL change on that footing — would silently make a
> business-policy choice that belongs to Mason. **It is recorded here as an unresolved product decision.**
> If Mason confirms due-date aging is the intended contract, this becomes a HIGH defect with the fix below.

**Evidence**

- `supabase/migrations/20260726190515_section9_po_ap_high_remediation.sql:555-623` defines `get_ap_aging(date)`. Every bucket subtracts `vb.bill_date` from the report date (`:588`, `:594`, `:601`, `:608`); `vb.due_date` is never used.
- `src/pages/AccountsPayable.tsx:82-110` presents the returned values as `Current`, `31-60 Days`, `61-90 Days`, and `90+ Days` without telling the user they mean days since the bill was issued.
- Fresh live `pg_proc.prosrc` for the single `public.get_ap_aging(date)` overload matches the disk definition: it fails closed for historical dates but still uses `p_as_of_date - vb.bill_date` for all four buckets.

**Plain-English business risk**

Under the current basis, a bill with long payment terms can show in the 31, 60, or 90 day column while it is not yet due. Whether that is *wrong* depends on what the columns are meant to say. Aging from the invoice date answers "how long have we owed this?"; aging from the due date answers "how late are we?". Both are legitimate; the report currently answers the first while the column labels (`Current`, `31-60 Days`, `61-90 Days`, `90+ Days`) do not say which.

**Decision needed from Mason**

Which question should the AP aging report answer? The unambiguous, no-code-change part of this either way: the UI labels and exported CSV should state the basis, because today they do not.

**Fix if Mason chooses due-date aging**

Define the bucket contract explicitly as days past `due_date`, then age from `p_as_of_date - vb.due_date` using clear boundary rules for not-yet-due, 1-30, 31-60, 61-90, and 90+ amounts. Align the UI labels and exported CSV with that contract.

**Prevention action (only once the contract is settled)**

Add a rollback-only AP-aging smoke with bills sharing a bill date but different due dates, including not-yet-due and exact 30/31/60/61/90/91-day boundaries, asserting whichever contract Mason confirms. Writing that test now would freeze an unconfirmed policy into an executable check.

### HIGH 2 — “Due This Month” is actually “Due in the next 30 days”

**Evidence**

- `supabase/migrations/20260716120112_gauntlet_money_workflows.sql:452-485` defines the current dashboard RPC. At `:468`, `due_this_month_cents` includes due dates from `CURRENT_DATE` through `CURRENT_DATE + 30`.
- `src/pages/AccountsPayable.tsx:172-180` labels that value `Due This Month`.
- Fresh live `pg_proc.prosrc` for the single `public.get_ap_dashboard_summary(text)` overload contains the same rolling 30-day predicate and no calendar-month boundary.

**Plain-English business risk**

Near month end, the card includes bills due well into the next month while excluding earlier-in-month bills already shown as overdue. Mason can read it as the current calendar month's cash requirement even though it represents a different period.

**Suggested fix**

Choose one honest contract. Recommended: keep the label and calculate from the Chicago business date through the last day of that calendar month. If the business wants a rolling forecast, rename the card `Due in Next 30 Days` and keep the predicate.

**Prevention action**

Add a deterministic month-end test covering a bill due on the current month's last day and another due on the first day of the next month. Assert both the RPC result and the rendered label.

### HIGH 3 — AP and receiving receipts replay by operation, not actor plus exact intent

**Evidence**

- The shared helper in `supabase/migrations/20260714230000_gauntlet_core_guards.sql:5-50` keys replay only by idempotency key and operation; it stores no actor or payload fingerprint.
- Current AP RPCs check that operation-only receipt before validating their target or payload: `create_vendor_bill` and `update_vendor_bill` in `supabase/migrations/20260730114102_vendor_bill_period_close_lock.sql:70-73` and `:165-168`; `record_vendor_payment`, `void_vendor_payment`, and `void_vendor_bill` in `supabase/migrations/20260731001654_ap_period_close_boundary_hardening.sql:41-44`, `:107-110`, and `:193-196`.
- Receiving has the same shape: `receive_po_items` checks the operation receipt before parsing or locking any submitted item at `supabase/migrations/20260714230000_gauntlet_core_guards.sql:142-149`, then saves only the result at `:270-274`. The live `_section9_receive_po_items_serialized` definition matches.
- The browser retains one unresolved key without exact payload scope. `src/pages/VendorBillDetail.tsx:45-47` creates operation/user keys; `:143-173` sends editable amount/date/method/reference/notes with that key and resets only after confirmed success. `src/pages/PurchaseOrderDetail.tsx:60-67` does the same for receiving; `:234-299` builds editable per-line quantities/condition/lot/notes/location, sends one retained key, and resets only after confirmed success.
- The repo already contains the stronger actor-and-fingerprint helper at `supabase/migrations/20260811130000_bind_commission_payout_idempotency_to_intent.sql:76-160`, but no current Section 9 public or serialized function calls it. Fresh live function definitions confirm operation-only checks for the audited AP and receiving RPCs.

**Plain-English business risk**

After a request commits but its response is lost, a user can edit the amount, date, reason, quantities, lot, or location and retry with the same key. PostgreSQL returns the first result before comparing the new request. The screen can therefore report that the edited payment or receipt succeeded even though the database kept the earlier intent. This affects real money and inventory.

**Suggested fix**

Require an idempotency key for the high-impact Section 9 mutators and bind each receipt to `auth.uid()` plus a canonical fingerprint of every business-relevant argument. Use the existing intent-bound helper contract, reject mismatches, and keep thin Section 9 serialization wrappers delegating to one authoritative implementation.

**Frontend — corrected 2026-08-24 (CodeRabbit P1 on PR #457, accepted).** An earlier draft of this section said to "scope unresolved keys to the canonical intent." **That is not sufficient, and on its own it makes the problem worse.** If the key is derived from the payload, then editing payment/receipt A into payload B *after A's response was lost* selects a **new** key for B. The server sees no receipt mismatch, so it executes B as a genuine second money or inventory mutation — exactly the duplicate the binding was meant to stop. Server-side payload binding closes the replay-with-different-payload hole; it cannot close the edit-then-retry hole, because the edited request is no longer a retry.

The caller must therefore **freeze or reconcile the unresolved intent before any new key may be minted**: while an action slot has an unresolved response, the UI must block edit-and-resend and first ask the server for the original request's outcome. Only a definitive answer — committed (adopt A's result) or provably never committed (release the slot) — may release the slot for a new intent.

**Prevention action**

Add rollback-only lost-response smokes for vendor payment and PO receiving. Each must prove: exact replay returns one original result; same key with a changed amount/item/quantity/location fails closed; another actor with the same key fails closed; and no second money, inventory, receiving, or audit side effect occurs.

The smoke must additionally exercise the **edit-after-uncertain-response caller path** — not just server-side replay. Simulate a lost response, edit the payload in the UI, resend, and assert that no second mutation occurs. A suite that only replays the *same* payload will pass against a frontend that still mints a fresh key for an edited one, which is the actual defect.

## Verified safe in this refresh

- Remote `main` was confirmed at `780e88aae7fc2ca0b6ae66e402608be866b03bb3`; the finding-bearing files are identical in the active checkout and that remote-main object.
- Live RLS is enabled on `vendors`, `purchase_orders`, `purchase_order_items`, `receiving_records`, `vendor_bills`, `vendor_payments`, `inventory`, and `accounting_periods`.
- The 13 audited public RPCs are single-overload `SECURITY DEFINER` routines with `search_path=public, pg_temp`; their live ACLs grant execution to `authenticated` and `service_role`, not `anon` or `PUBLIC`.
- Direct authenticated `INSERT`/`UPDATE`/`DELETE` privileges are absent on purchase orders/items, receiving records, vendor bills/payments, vendors, and accounting periods. The expected read policies remain present.
- The former vendor-bill/accounting-period close race is resolved in current source and live definitions: AP mutations take the shared month lock before the open-period check and `close_accounting_period` takes the matching exclusive lock.
- PO and receiving serialization wrappers, PO status-transition/recompute triggers, vendor liveness checks, bill/PO/vendor row locks, positive vendor-bill trigger, and generated `vendor_bills.balance_cents` structure remain present.
- `get_ap_aging` correctly refuses unsupported historical dates. This does not cure the current-date bucket-definition defect above.

## Queue disposition

**Section 9 is NOT refreshed — it remains the current queue position.** This run produced two open HIGH findings and one open product decision, but its deterministic gate did not settle, so Section 9 must be re-run from a clean, current checkout before it counts as refreshed. Do not advance the queue past Section 9 on the strength of this report.

Once Section 9 settles, the next manual refresh is **Section 10 — blend tickets and repository-only Edge Function handoff contracts**. Sections 10–15 share the same 2026-07-28 last-reviewed date, so Section 10 is next in sequence rather than uniquely oldest.

