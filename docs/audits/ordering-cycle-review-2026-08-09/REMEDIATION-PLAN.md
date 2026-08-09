# Remediation Plan — Ordering Cycle Review

Companion to `FINDINGS.md`. This is the agreed scope and order of work, so the local session (and Codex) start from a settled plan rather than re-litigating 77 findings.

**Status: proposed. Nothing here is approved for implementation yet — the Codex triage in Step 2 comes first.**

## Scope decisions

**LOW findings are triaged, not fixed wholesale.** Of the 31, nine are cheap and genuinely worth doing; the rest are parked as known-and-accepted. Fixing all 31 would add churn and review surface for no real gain.

Keep (fold into the wave that already touches that area):

| Finding | Why keep |
|---|---|
| `create_direct_order` performs no cent rounding anywhere | Money correctness; fractional cents reach `order_items`/`orders` and the commission basis |
| Mint-time penny reconciliation can compute a negative commission | Aborts the whole order conversion — a crash, not a cosmetic issue |
| QuoteBuilder client totals use a different rounding formula than `save_quote` | Displayed money differs from stored money |
| `generate_order_number()` / `generate_quote_number()` EXECUTE-able by anon | Logged-out visitor can burn the sequences; one-line REVOKE |
| `invoices_select` / `invoice_items_select` granted to PUBLIC, no role or `is_active` predicate | Cheap policy tightening in the same wave as the other RLS work |
| Voided orders still offer Edit / Create Invoice / Schedule Delivery | UI gate tests `fulfilled`/`cancelled` but never `voided`; small, user-visible |
| Quotes list Duplicate reuses a stale page-scoped idempotency key | Same class as the MED idempotency-key findings; fix together |
| `duplicate_quote` silently drops `is_planned` / `needed_by_date` | Small, and it silently loses booking intent |
| `QUOTE_TO_DELIVERY.md` documents 7 of 9 statuses and names a nonexistent `prepay_credits` column | Docs drift that will mislead the next reviewer |

Park the remaining 22 LOW findings. They stay recorded in `FINDINGS.md`; revisit only if one surfaces in real use.

**Order of work: money first, direct-write lockdown second.** The money bugs are actively producing wrong numbers today, are self-contained, and are easy to verify — good ground to build confidence on. The direct-write lockdown is the largest blast radius in the set and benefits from being done deliberately rather than first.

## Sequence

Every wave: its own branch, its own PR, CodeRabbit, and a `codex-gauntlet` gate. All three waves touch money, RLS, or migrations, so the exact-SHA `gpt-5.6-sol` high-effort proof is mandatory on each — none of them qualify as "ordinary reversible code".

### Step 0 — Back up the database
No backup exists and the plan has no point-in-time recovery. Gates everything below.

### Step 1 — Close the evidence gap
Phases 1–2 read on-disk migrations only. Pull the **live** bodies of `_enforce_quote_status_transition`, `revert_quote_status`, `restore_quote_version`, `convert_quote_to_order`, `create_direct_order`, `complete_delivery`, `void_invoice`, plus live grants and policies on `quotes` / `orders` / `deliveries` / `order_items`. Diff against the repo. Any finding whose live body differs must be re-read before it becomes work.

### Step 2 — Codex triage and reconciliation
Independent `codex-review` (gpt-5.6-sol, high effort) over `FINDINGS.md` + cited files + the Step 1 live evidence. Per-finding verdict: real / not real / already mitigated, with its own severity. Then `agent-pair-review` to surface only the disagreements between Codex and this review. **The reconciled list is the approval artifact** — Mason signs off on that, not on the raw 77.

### Wave A — Money (3 HIGH + related)
- Quick-delivery invoice posted before completion never adjusted; follow-up delivery double-bills the shortfall
- Void-then-rebill permanently cancels an order's commissions with no re-mint path
- Caller-controlled cost/profit drives the commission basis on `convert_quote_to_order` and `create_direct_order`
- Plus the four money/commission LOW items kept above

Verification: real-path proof on each — run the flow, observe the invoice and commission rows, not just a passing test.

### Wave B — Close the direct-write lane (6 HIGH)
The six findings that share one root cause: safety logic lives in the RPCs while the tables stay directly writable by the same roles.
- Quote `accepted → sent` trigger edge (note: `QuoteBuilder.tsx:2686` is a residual consumer — the arm cannot simply be deleted; gate it on admin override or order-existence)
- Deliveries walkable to `completed` by direct update (found twice: migrations and live grants)
- Quote soft delete leaking planned/crop-program holds (two findings, one fix)
- Sales reps inserting orders and order lines directly
- Driver completing a delivery by direct update

Highest blast radius in the set. Needs a full test pass and a careful look at every legitimate caller before permissions tighten.

### Wave C — Gate the ungated read RPCs (1 HIGH + MED siblings)
`get_customer_year_end_summary`, `check_customer_credit_limit`, `get_customer_summary`, `global_search` — all `SECURITY DEFINER`, all granted to `authenticated`, none checking the caller. Add role checks. Small and low-risk. Include the two LOW grant fixes kept above.

### Wave D — MED maintenance (36, batched)
Missing `deleted_at` filters (the soft-deleted draft invoice that permanently hides Create Invoice), reused page-scoped idempotency keys on Quotes and Deliveries, the three inconsistent AR derivations, and the reporting/docs drift items. Group into 2–3 PRs by area rather than one large diff.

## Out of scope

- The 22 parked LOW findings.
- Anything not in `FINDINGS.md`. If a wave uncovers a new issue, record it rather than widening the diff.
