# CRX Live Foundation Gauntlet — Section 8 Refresh

- Date: 2026-08-12
- Section: Returns and credit memos, including issue, unapply, reversal, and statement impact
- Verdict at time of review: **REMEDIATION REQUIRED**
- Findings: **0 BLOCKER / 2 HIGH / 1 MED / 1 LOW**
- Status now: **ALL FOUR FINDINGS REMEDIATED** — the three runtime findings (1–3) were applied to the live database by migration `20260812130145_bind_return_receipts_to_intent_and_restore_overdue` (ledger version `20260812212323`, applied 2026-08-12) plus follow-up `20260813070000_pin_return_idempotency_helper_contract` (ledger version `20260813011751`, applied 2026-08-13); the schema-reference finding (4) was corrected in repository documentation, not by a live database change. All four fixes landed in [#388](https://github.com/masonwells1/CRX_Manager_V1.0/pull/388) (merged 2026-08-13). See the 2026-08-12 entry in `docs/CHANGELOG.md` for the post-apply live evidence. The body below is preserved as the dated record of what was found at audit time, not as open work.

## Executive Summary

At audit time, two evidence-backed production risks remained in the return/credit foundation (both since remediated — see the Status line above):

1. Every return action retains one idempotency key for the whole operation instead of the exact return or create payload. After a committed request loses its response, an action on Return B can replay Return A's cached success without changing Return B.
2. Invoice Detail deliberately creates a new credit-application key whenever the Apply Credit modal opens. If a partial application commits but its response is lost, closing, reopening, and retrying can apply the same partial credit a second time.

At audit time, a third lifecycle defect reopened a fully credited overdue invoice as `posted`, not `overdue`, after reversal or unapply. The generated balance remained correct, but the invoice could temporarily disappear from overdue-only workflows. The Returns schema reference was also stale relative to the live catalog. All of these are likewise remediated per the Status line above.

The server-side accounting foundation otherwise held: credit application locks and exact-key replay binding are present, unapply binds the receipt to the requested memo, application rows are append-only, return mutations are RPC-owned, invoice balance is generated, and detailed statements reconstruct credit activity from the immutable application ledger at the requested cutoff. No business rows were queried.

## Scope and Provenance

- Repo: `C:\CRX_Manager`
- Run-start checkout: `6bfe51d91906f716a07e8f662fcecc65bfa6316f`
- Run-start status: `main` was clean with no pre-existing uncommitted files and was 7 commits behind the local `origin/main` tracking object.
- Audited source object: local `origin/main` at `2837263d2a22eca71142bf77e449acbe2512e232`, read directly with `git show`/`git grep`; a final read-only `git ls-remote` confirmed the remote `main` tip is the same SHA. No ref was changed.
- Freshness limitation: the active checkout remained seven commits behind and the automation's write contract did not permit fetching, refreshing refs, or creating a clean worktree. The current remote source object was still audited directly, but the canonical deterministic section runner was not claimed as settled.
- Live Supabase project: `rhyzpcqhnizqbxphqdkr`.
- Fresh live migration high-water observed in the structure-only packet: `20260812034951`.
- Graph navigation: the available Graphify graph matched the checkout commit but was seven commits behind the audited source object. A focused query identified the return, credit, reversal, statement, smoke, and guard surfaces; graph refresh/result persistence were skipped because they write outside the permitted audit folder. Every cited connection was reverified against the pinned source object and/or live catalog.
- Independent read-only review: one reviewer traced return lifecycle/idempotency; a second traced credit application, reversal, and statement behavior. Their source findings were reconciled against live function definitions and catalog metadata.

Explicit exclusions honored: Sentry, Vercel, GitHub PRs, browser sessions, production runtime telemetry, application logs, and live business-row probes. No migration, live data, grant, policy, function, source file, ref, deployment, or customer-visible state was changed.

## Finding 1 — HIGH: Return action receipts can cross from one return intent to another

### Proven evidence

- `src/hooks/useIdempotencyKey.ts:15-18,30-47` says callers must pass `intentScope` when one mounted action can target different records or payloads; without it, the retained key is scoped only to operation and user.
- `src/pages/Returns.tsx:83-88` creates all six hooks without `intentScope`: approve, receive, issue credit, cancel, reject, and create.
- The handlers use that operation-wide retained key and reset it only after confirmed success: create at `src/pages/Returns.tsx:306-331`, approve at `:388-397`, reject at `:418-426`, cancel at `:450-459`, receive at `:486-495`, and issue credit at `:512-521`.
- The create dialog can close and reopen with a different customer/order/item payload (`src/pages/Returns.tsx:247-255,746-752,921`) without rotating the retained uncertain key.
- Current disk definitions return a cached receipt before validating the new target/payload: create at `supabase/migrations/20260723193312_product_families_return_policy_foundation.sql:487-497`; approve at `:632-643`; receive at `:713-723`; issue credit at `:857-866`; cancel at `:1024-1031`; reject at `supabase/migrations/20260701202000_returns_rpc_gating.sql:70-79`.
- Live `pg_proc.prosrc` for the six audited return RPCs matches the operation-only replay order. Authenticated actor/role checks occur before replay, but exact return/payload binding does not.

### Plain-English business risk

The server can commit action A, but the network can lose the response. The browser correctly keeps the key for a genuine retry. If the operator instead moves to Return B, the server can return Return A's cached success before checking B. The UI reports that B was approved, received, cancelled, rejected, or credited even though B was untouched. Create has the same false-success path for a changed customer/order/item request.

### Suggested fix

Pass a stable intent scope for each action: the return ID for lifecycle mutations and a canonical fingerprint of customer, order, items, quantities, conditions, and reason for create. Bind the stored receipt server-side to authenticated actor plus exact target/fingerprint, and fail closed when a reused key carries different intent.

### Prevention action

Add React tests for committed-but-client-failed Return A followed by Return B, and for a materially changed create draft. Add rollback-only SQL smokes proving identical intent replays once while the same key with a different return/payload is rejected before any cached receipt is returned.

## Finding 2 — HIGH: Reopening Apply Credit can duplicate a partial credit after an uncertain response

### Proven evidence

- `src/pages/InvoiceDetail.tsx:1054-1077` loads available credits and calls `applyCreditIdem.resetKey()` every time the Apply Credit modal opens.
- `src/pages/InvoiceDetail.tsx:1080-1107` uses the current key and resets after confirmed success, but the dialog remains closable during the request: `src/pages/InvoiceDetail.tsx:2049,2079` does not set `closeDisabled` and leaves Cancel active; `src/components/ui/Modal.tsx:39-45,106-108,127-128` permits Escape, backdrop, X, and Cancel closure when not disabled.
- Disk and live `apply_credit_memo_to_invoice` correctly bind a reused key to memo, target invoice, and amount (`supabase/migrations/20260711040000_apply_credit_memo_to_invoice.sql:55-65`) and lock/recheck under deterministic invoice locks (`:68-86`). A new key bypasses that receipt.
- The RPC permits a partial amount and bounds it against the remaining credit and target balance (`supabase/migrations/20260711040000_apply_credit_memo_to_invoice.sql:115-124`). It appends one application and saves the receipt at `:137-173`.

### Plain-English business risk

Example: an admin applies $50 of a $100 credit memo to a $100 invoice. The database commits, but the response is lost. The admin closes and reopens the modal; the UI mints a new key. Retrying $50 is a valid second partial application, so the invoice receives $100 total even though the operator intended one $50 action. Both ledger rows look legitimate.

### Suggested fix

Keep the unresolved key across close/reopen for the same `(credit memo, target invoice, amount)` intent, and disable every modal-close route while submission is in flight. Retire the key only after confirmed success or a server-proven intent mismatch. A server-side durable actor/intent fingerprint should remain the final guard.

### Prevention action

Add an Invoice Detail test that simulates database commit plus client error, closes/reopens, and proves the same partial intent sends the identical key. Add a rollback-only concurrency/retry smoke proving exactly one `credit_memo_applications` row for that intent.

## Finding 3 — MED: Credit reversal reopens an overdue invoice as posted

### Proven evidence

- `apply_credit_memo_to_invoice` accepts target invoices in either `posted` or `overdue` status (`supabase/migrations/20260711040000_apply_credit_memo_to_invoice.sql:103-108`) and marks a fully credited target `paid` at `:137-145`.
- The shared `_reverse_credit_memo_application` helper changes any restored paid target with a positive balance to `posted`, without checking its due date or prior status (`supabase/migrations/20260711050000_credit_apply_reversal_and_lifecycle.sql:62-71`). Live `pg_proc.prosrc` matches.
- The application ledger's live columns retain application/reversal facts but no prior invoice status.
- The current overdue sweep repairs only `posted` invoices asynchronously (`supabase/migrations/20260711060000_credit_apply_four_lever_consumers.sql:591-602`).

### Plain-English business risk

If an overdue invoice is fully cleared by a credit and that application is later reversed or unapplied, the invoice immediately has money due again but is labelled `posted`. It can disappear from overdue-only collection screens until the later sweep marks it overdue again. The generated balance and statement math remain correct, so this is operational classification risk rather than silent money corruption.

### Suggested fix

When reversal restores a positive balance, set `overdue` when `due_date < CURRENT_DATE`; otherwise set `posted`. Keep this logic in the shared reversal helper so direct reversal and whole-memo unapply cannot drift.

### Prevention action

Add rollback-only regressions covering overdue invoice → full credit → reverse and overdue invoice → full credit → unapply. Both must restore a positive balance and `overdue` immediately.

## Finding 4 — LOW: The Returns schema reference does not match the live table

### Proven evidence

- `docs/reference/database-schema.md:114-115` lists return statuses without `cancelled` and describes `return_type` and `reason_category` columns.
- The live `returns_status_check` permits `requested`, `approved`, `received`, `credited`, `rejected`, and `cancelled`.
- Live `information_schema.columns` contains `reason` and does not contain `return_type` or `reason_category` on `public.returns`.
- Current return source/types use the live status/reason shape; this is documentation drift, not an application schema defect.

### Plain-English business risk

An agent or maintainer following the reference can design against fields that do not exist or omit the valid cancellation lifecycle, increasing the chance of stale queries or unnecessary migrations.

### Suggested fix

Regenerate the Returns row from the live/catalog-backed schema registry and list the actual header fields and full status constraint.

### Prevention action

Extend `npm run check:docs` with a schema-driven assertion for named status sets and documented columns in high-risk lifecycle tables.

## Verified Controls That Survived Review

- Live `returns`, `return_items`, `invoices`, `credit_memo_applications`, and `inventory_transactions` have RLS enabled.
- Authenticated users have no direct INSERT on `returns`, no direct mutation grant on `return_items`, and SELECT-only access to `credit_memo_applications`; audited lifecycle writes are RPC-owned.
- Live return lifecycle, credit-application immutability, invoice status, and inventory-ledger triggers are enabled.
- Audited public `SECURITY DEFINER` return/credit/statement functions use `search_path=public, pg_temp`; no audited routine grants EXECUTE to `anon`.
- Return credit amount/source is server-derived from delivered order lines, and product return-policy guards are installed.
- The live invoice `balance_cents` generated formula correctly applies the credit lever; `credit_applied_cents` remains nonnegative.
- `credit_memo_applications.amount_cents` must be positive, source and target must differ, and reversal metadata is all-or-none. Application rows are immutable rather than deleted.
- `unapply_credit_memo` binds an exact-key replay to the requested memo and applies the accounting-period gate to active applications (`supabase/migrations/20260722112835_unapply_credit_memo_replay_binding.sql:31-43,66-81`).
- Detailed statements replace today's mutable credit lever with the immutable application ledger as of the requested cutoff, expose open credit separately from gross AR, and fail closed where historical cash/prepay/write-off state cannot be reconstructed (`supabase/migrations/20260803221244_fix_statement_balance_disclosure.sql:160-260,341-373,512-553`).
- The statement rollback smoke covers later application, reversal, unapply, and mixed later balance activity (`scripts/smoke/smoke-detailed-statement-balance-disclosure.sql:134-214,256-334`).

## Live Catalog Evidence Packet

The following structure-only queries were executed read-only against live Supabase and returned metadata/function definitions only:

- `information_schema.columns`: return, return-item, invoice, credit-application, inventory-transaction, and accounting-period columns/generation metadata.
- `pg_constraint`: return statuses/quantities, invoice credit/balance rules, credit-application amount/distinct-target/reversal rules, and related foreign keys.
- `pg_class`/`pg_policy`: RLS flags and table policy metadata.
- `information_schema.table_privileges` and `information_schema.routine_privileges`: table and routine grants.
- `information_schema.triggers`: enabled lifecycle, immutability, and invoice guard triggers.
- `pg_proc`: current signatures, `prosecdef`, `proconfig`, ACLs, and source bodies for audited return, credit, reversal, overdue, and statement functions.
- `supabase_migrations.schema_migrations`: applied migration names/versions only.

An initial combined catalog statement and a trigger-definition helper were blocked before execution by the live-data guard and replaced with narrower metadata queries. One table-grant query initially used the wrong information-schema column name, returned an error, and was corrected. No blocked or failed statement mutated anything.

## Cut Findings

- Statement application arithmetic was not scored: current source and live definitions prove that applications net to zero in gross AR and that remaining open credit is disclosed separately.
- Historical cutoff reconstruction was not scored: current statement logic uses immutable application/reversal timestamps and fails closed for unsupported historical balance components; the dedicated rollback smoke covers those contracts.
- Same-key concurrent apply was not scored: deterministic locks plus the after-lock replay recheck prevent duplicate application under the same key. Finding 2 requires the frontend to mint a new key.
- No claim was made about current return counts, credit balances, overdue rows, or customer statement contents because live business data was outside scope.

## Ranked Fix Queue From This Section

1. **RESOLVED (HIGH at audit time) — bind return receipts to actor and exact target/payload.** Fixed live by ledger `20260812212323` with contract follow-up `20260813011751` (PR #388).
2. **RESOLVED (HIGH at audit time) — preserve the partial-credit intent key across modal close/reopen.** Fixed live in the same rollout (PR #388).
3. **RESOLVED (MED at audit time) — restore overdue status synchronously on credit reversal/unapply.** Fixed live in the same rollout (PR #388).
4. **RESOLVED (LOW at audit time) — align the Returns schema reference with the live catalog.** Fixed in repository documentation (PR #388) — a docs change, not a live database change.

## Next Section

**Section 9 — Purchase orders, receiving, vendor bills, vendor payments, and AP safety.** It is next in section order after this Section 8 refresh.

## Closeout

- Audit report written under the permitted gauntlet folder.
- Index and ranked summary updated.
- No remediation was attempted during this audit run; the remediation recorded in the Status line landed afterward via PR #388.
- No tests were executed during this audit run because ordinary test/tool caches could write outside the automation's permitted folder. Source, migration, static guard, and live catalog evidence were inspected directly.
- No app/source code, migration, live database state, commit, push, deploy, deletion, ref, or forbidden external system was touched during this audit run.
