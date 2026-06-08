# Map-Drift Audit — 2026-06-08

**Map state:** 71 routes · 164 distinct RPC calls · **0** map-auto-issues · freshened this session (Jun 8; no `src/` changes since).
**Live snapshot:** 262 distinct `public` functions · **0 overloaded** · 95 base tables · **0 tables without RLS** · advisors: security = 1 ERROR (accepted) + 269 WARN (52 anon-SECDEF, all documented verified-safe), performance = 0 WARN / 146 INFO (`unused_index`).
**Verdict:** **CLEAN on the application** — **0 BLOCKER · 0 HIGH · 1 MED** (the MED is in the map *generator*, not the app). **6 candidate findings raised and all refuted** against live during the verify gate.

> First run of `docs/audits/map-drift-audit-prompt.md`. Read-only — no DB rows or files changed.

## Summary

| Pass | What was reconciled | Checked | Clean | Findings |
|------|---------------------|---------|-------|----------|
| 0 — Map auto-checks | orphans / broken links / dead RPCs / unguarded writes | 4 classes | ✅ all 0 | 0 |
| 1 — Asserted flows | every `DATA_FLOW_EDGES` arrow has a live implementer | 26 edges | ✅ implementers exist | 0 |
| 2 — RPC reality | 162 frontend RPC names vs live `pg_proc`; overloads; `search_path` | 162 + 262 | ✅ | 0 (1 refuted) |
| 3 — Lifecycle integrity | frontend status literals vs live CHECK constraints | 25 constraints / 51 literals | ✅ | 0 (5 refuted) |
| 4 — Role / RLS coherence | RLS coverage + anon-SECDEF posture | 95 tables | ✅ | 0 |
| 5 — Missing connections | entity reachability to revenue | 14 entities | ✅ none stranded | 0 |
| 6 — Map defects | generator assertions vs reality | grouping logic | ⚠️ | **1 MED** |

## Findings (ranked)

### [MED] MAP-1 — The map generator under-represents ~4 write subsystems (silent missing edges)
- **Pass:** 6 (map defect)  ·  **Where:** `scripts/generate-workflow-map.mjs:323-374` (`rpcToGroupId` + `RPC_GROUP_NODES`)
- **Evidence:** The generator buckets RPCs into **11** families (quote, order, delivery, invoice, payment, inventory, po, job, blend, report, return). Several **frontend-called write families match none of them**, so their page→RPC edges are silently dropped from the graph:
  - **Commission payments** — `create_commission_payment`, `post_commission_payment`, `void_commission_payment` (an entire `unposted→posted→voided` lifecycle). `e-commission` exists as an entity node but is fed only by the static `e-order → e-commission` data edge — no RPC layer.
  - **Vendor bills / AP** — `create_vendor_bill`, `update_vendor_bill`, `void_vendor_bill`, `record_vendor_payment`, `void_vendor_payment`. No Vendor/AP entity node exists at all.
  - **Cycle counts** — `complete_cycle_count`, `cancel_cycle_count`, `update_cycle_count_item`, `reverse_completed_cycle_count`.
  - **Rebates** — `create_rebate_claim`, `transition_rebate_claim`.
  - (Also partially: prepay-batch RPCs `batch_apply_*`, `create_prepay_check_splits`, `edit/delete_prepay_credit`.)
- **What the map claims vs reality:** the map presents itself as the app's RPC/flow graph, but these live, called subsystems are invisible on it. The omission is *consistent* (no node + no edge), so it reads as "this subsystem doesn't exist" rather than "not drawn."
- **Why it matters:** low blast radius — it misleads a *human* reading the map (and would let a future audit's Pass 1/Pass 5 under-cover those subsystems). It does **not** affect the running app.
- **Verification performed:** the 162 frontend RPC names (live-confirmed to exist) were matched against the 11 `rpcToGroupId` regexes; commission-payment / vendor-bill / cycle-count / rebate names match zero patterns, and there are no corresponding `RPC_GROUP_NODES`.
- **Suggested direction (NOT applied):** add `r-commission`, `r-vendor`, `r-cycle`, `r-rebate` group nodes + regex patterns (and consider `VendorBill` / `CycleCount` / `Rebate` entity nodes with their data edges). This is a generator-only change; it does not touch the app.

## Candidate findings raised & refuted (the verify gate working as designed)

| # | Candidate (looked real) | Verdict | Disproving evidence |
|---|--------------------------|---------|---------------------|
| C1 | Frontend calls missing RPC `log_event` → BLOCKER | **Refuted** | Sole occurrence is *test-fixture string data*: `src/lib/assertRpcCoverage.test.ts:189` (`code: "await supabase.rpc('log_event', payload);"`). No production callsite. |
| C2 | UI sends status `'void'` (CHECK wants `'voided'`) → BLOCKER | **Refuted** | Sole occurrence is a **regression test** proving the `'void'`→`'voided'` fix holds: `src/lib/reconciliation.test.ts:799-805`. |
| C3 | Status `'not_started'` not in any CHECK → drift | **Refuted** | UI-derived program status in `src/pages/ProgramTracker.tsx:26` (type union + filter + `<option>`); never written to a DB column. |
| C4 | Status `'expiring'` not in any CHECK → drift | **Refuted** | Client-computed license-expiry label from `getExpiryStatus()` in `src/pages/Compliance.tsx:203`; not a DB status. |
| C5 | Status `'created'` not in any CHECK → drift | **Refuted** | Activity-feed `action_type` (`ActivityFeed.tsx`) + test mock; not an entity status. |
| C6 | Status `'adjusted'` not in any CHECK → drift | **Refuted** | Inventory `transaction_type` (a valid type) + test mock; not an entity status. |

## Unconfirmed / needs human check
- None. Every candidate was conclusively confirmed or refuted read-only.

## Map defects (fix the generator)
- **MAP-1** above — `scripts/generate-workflow-map.mjs:323-374`. Add the 4 missing RPC families (and optional entity nodes) so the map stops hiding the commission-payment, vendor-bill/AP, cycle-count, and rebate subsystems.

## Coverage note (what a CLEAN verdict here does and doesn't prove)

**Verified true:**
- Every one of the 162 real frontend `.rpc()` names resolves to a live function (no runtime "function does not exist" crashes). The only "missing" hit was test-fixture text.
- Zero overloaded functions across all 262 `public` procs (the B7 drift class is empty).
- Every live status CHECK constraint matches the documented lifecycles in `CLAUDE.md`, and **no frontend code path writes a status the DB would reject** (all 5 out-of-constraint literals are UI-derived labels, event types, or guard tests).
- Every one of the 95 tables has RLS enabled (`tables_without_rls = 0`); security posture matches the documented accepted findings (`profile_public_view` ERROR; 52 verified-safe anon-SECDEF).
- All 26 hardcoded entity-flow arrows have a live implementing RPC.

**NOT covered by this pass (by design — these belong to `/review-workflow`):**
- Deep *invariant* verification inside each flow (e.g., does `convert_quote_to_order` truly release every hold; does a void cascade to all dependent ledger rows). Pass 1 confirmed implementers *exist*, not that each is internally correct.
- Genuinely novel *missing* business connections beyond entity-reachability (Pass 5 confirmed no entity is stranded from revenue, but did not exhaustively model every should-exist reversal).
- The `auth_leaked_password_protection` advisor WARN (an Auth dashboard config item, out of scope for map-vs-reality drift).

**Bottom line:** the map's claims about routes, RPC existence, status lifecycles, and RLS are **faithful to the live system**. The only drift is that the *map itself* has stopped modeling several subsystems the app has since grown — a generator fix, not an app bug.
