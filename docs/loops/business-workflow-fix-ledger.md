# Business-Workflow Fix Loop — Ledger (overnight 2026-07-05/06)

Mission: `docs/loops/business-workflow-fix-mission-2026-07.md` · Branch: `fix/business-workflow-2026-07` · Orchestrator: Fable.

## Pre-flight repairs (not units)

- **CLAUDE.md committed conflict markers** — origin/main's merge `b13e1207` left unresolved `<<<<<<<` markers in the Snapshot section. Resolved keeping both sides' facts (626-migration count + sentinel note AND the Security-follow-up paragraph). Commit `11b2ba28`.
- **schema-registry.json committed conflict markers** — same merge accident; broke strict JSON parsing for every hook that reads the registry (caught by migration-drift-reviewer H1). Resolved with the true live high-water `20260705224521` (queried live). Commit `3df94183`.

## U1 — Overdue payable + over-allocation guard — SHIPPED

- **Status:** SHIPPED (migration APPLIED LIVE; frontend committed, push pending in this commit)
- **Findings:** #41 (UNVERIFIED→CONFIRMED by hand: `PaymentAllocation.tsx:152` loaded only `posted`; `InvoiceDetail.tsx:1163` gated Record Payment/Write Off to posted+admin; live `allocate_payment` + `apply_write_off` both already accept `('posted','overdue')`) · #108 (UNVERIFIED→CONFIRMED-with-adjustment: the in-function total guard was indeed missing, BUT drift review found live trigger `trg_enforce_allocation_not_over_payment` (mig 20260616121105) already aborts over-allocation at the allocation_sets totals UPDATE — so #108's "no error" claim was stale; the new guard is defense-in-depth that fires earlier with named amounts. Migration header documents this honestly.)
- **Changes:** `PaymentAllocation.tsx` invoice query → `.in('status',['posted','overdue'])` · `InvoiceDetail.tsx` Record Payment/Write Off gate → posted|overdue (Void untouched) · migration `20260706000000_allocate_payment_over_allocation_guard.sql` re-emits live fn + OVER_ALLOCATED guard + single-overload assert.
- **Migration applied live:** version **20260706010233** (name `20260706000000_allocate_payment_over_allocation_guard`)
- **Reviews:** rls-security-reviewer CLEAN · migration-drift-reviewer CLEAN on the SQL (its 2 HIGH were environmental: the registry conflict → fixed `3df94183`; live version-stamp confirm → done, see PROOF) · Codex (gpt-5.5, `--uncommitted`) verdict: "no discrete introduced correctness issues".
- **PROOF — Ran:** live SQL post-apply: overloads=1, `position('OVER_ALLOCATED' in prosrc)>0` = true, `plpgsql_check_function_tb` errors=0, `schema_migrations` row `20260706010233` present, `proconfig` keeps `search_path=public, pg_temp`, anon/authenticated ACL unchanged from pre-apply (accepted self-gated grant-debt class); global dup-overload sweep returns only the 8 plpgsql_check extension internals (pre-existing, benign). **Saw:** all values as expected. **Not verified:** the UI list rendering with a real overdue invoice (0 overdue invoices exist in prod — operationally-empty DB; gate/query change proven by typecheck+build+lint green, Codex + reviewer reads).
- **Smoke caveat (process note for Mason):** the pre-apply `BEGIN;…;ROLLBACK;` smoke could not run — `live-testdata-guard` blocks ANY execute_sql containing `INSERT INTO financial_audit_log` text, even inside a CREATE FUNCTION body in a rolled-back batch (rule 1 has no rolled-back exemption). Not routed around; substituted with plpgsql_check + post-apply verification. This will recur on every money-RPC re-emit (U2/U7/U8) — worth a hook refinement decision in the morning.
