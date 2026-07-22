# CRX Live Foundation Gauntlet — Sections 5–8 T3 Close-out Refresh

Date: 2026-07-22
Mode: Read-only live evidence (Supabase MCP single-statement SELECTs, advisors, pg_proc/pg_indexes catalog) + adversarial code verification (gpt-5.6-sol, read-only sandbox) on origin/main `bf2a60ef`, clean worktree `claude/gauntlet-t3-sections-5-8`.
Orchestration: Fable orchestrates; Codex CLI executes builds (gpt-5.6-luna) and adversarial review (gpt-5.6-sol); migration gates = rls-security-reviewer + migration-drift-reviewer subagents + `scripts/write-apply-proofs.mjs` machine-verdict Codex proofs. Autopilot armed 4h by Mason for this run.

## Verdict

Sections 5 and 6: **closed with fresh evidence** — sol's adversarial pass returned VERDICT HOLDS, 0 findings each. Sections 7 and 8 live-data sweeps were fully clean, but sol's code-level pass surfaced 1 HIGH (section 7, parked for owner decision) and 1 MED (section 8, fixed this run). One section-5 hardening item (5 mutable-search_path functions) was fixed live this run.

| Section | BLOCKER | HIGH | MED | LOW | Status |
|---|---:|---:|---:|---:|---|
| 5 Database drift | 0 | 0 | 0 | 1 (noted) | Closed — search_path WARNs fixed live |
| 6 Idempotency | 0 | 0 | 0 | 1 (parked) | Closed — 07-08 HIGH+MED verified fixed |
| 7 Commissions | 0 | 1 (parked, owner decision) | 0 | 0 | Clean live; 1 latent code path parked |
| 8 Returns/credit memos | 0 | 0 | 1 (fixed this run) | 0 | Closed |

## Section 5 — Database drift

Fresh live evidence (all queries this session):

- Disk 805 migrations, max `20260722092928`; live `schema_migrations` 893 rows, max `20260722100456`.
- Live-only versions `20260722091359` (`supplier_pricing_workbook_v2_product_info`) and `20260722100456` (`revoke_inner_pricing_rpc_access`) belong to the **in-flight Codex supplier-pricing workstream** (its branch carries the disk files); not yet in `docs/reference/migration-history.md`. Reconciliation belongs to that branch's landing — recorded here, deliberately not touched.
- Historical 568/656 version-string mismatches = the known pre-existing naming drift (migrations match on `name`, not version).
- `.claude/schema-registry.json` regenerated from live introspection **today**; high-water `20260722080226` trails disk by one RPC-only migration (LOW, cosmetic — verified: 153 registry tables == 153 live base tables; the trailing migrations add no tables/enums/generated columns). The no-arg stamp script derives from the introspection snapshot, so only a full re-introspection moves the stamp; not worth churn.
- SECDEF functions missing search_path: **0**. App-function overloads in public: **0**.
- Advisors (362): the 7 `function_search_path_mutable` WARNs included 5 app functions — **FIXED LIVE this run** by migration `20260722111620_search_path_hardening_crm_guards_helpers` (ALTER-only, no body re-emission; rls-security 0 findings; drift 0 blockers; Codex machine verdicts CLEAN ×2; post-apply pg_proc shows `search_path=public, pg_temp` on all five). Remaining 2 are plpgsql_check extension functions.
- ERROR `security_definer_view` on `profile_public_view`: **intentional-by-design** — it is the app-wide safe profiles lookup surface (anon revoked 2026-06-10 by `20260610131144`; exposes only id/full_name/role/is_active; multiple src comments document "NEVER a profiles embed — that RLS nulls out"). Sol reviewed and did not flag. Not a finding.
- WARN `auth_leaked_password_protection` (Pro-gated) and `extension_in_public`: known accepted.

The 2026-07-05 HIGH (stale checkout) is resolved by construction: this run's base is current origin/main, equal to live minus the two Codex-workstream applies above.

## Section 6 — Idempotency / double-submit

- 2026-07-08 HIGH (`save_job_applied_record` duplicate parents): **verified fixed on live primary evidence** — live `pg_get_functiondef` shows `p_idempotency_key` + table-native `idempotency_key`/`idempotency_request_hash` insert-once with job-scoped unique_violation recovery, payload-conflict rejection (`APPLIED_RECORD_ALREADY_SAVED_DIFFERENT`), replay without child re-writes; live partial unique index `uq_job_applied_records_idempotency_key` present; frontend passes the key on create (`AppliedRecordsManager.tsx:121,301`). Sol: HOLDS.
- 2026-07-08 MED (stale static coverage list): **fixed** — `rpcContracts.test.ts` now asserts `MUTATING_RPCS_MISSING_IDEMPOTENCY` is empty (`toEqual([])`) with the WITH-list ≥78 including this RPC; sol judged the guard materially stronger than the old static list and found **no post-2026-07-08 mutator lacking idempotency** without a defensible natural/internal mechanism. Residual risk (dynamic-SQL mutators / dishonest exemptions) noted, accepted.
- 2026-07-08 LOW (3 read-only RPCs with unused `p_idempotency_key`: `generate_batch_statements`, `get_ap_dashboard_summary`, `get_expiring_planned_holds`): still true live. **Parked** — contract noise only; fold into the next RPC-hygiene migration rather than churning legacy signatures now.

## Section 7 — Commissions, splits, entity recipients, payout batches, voids

Live sweeps (all this session): commissions {pending 33, cancelled 2}; negative amounts 0; split_percentage out of range 0; pending-on-voided-invoice 0; soft-deleted 0; active-without-recipient_user_id 0; payments 8 / items 0 (unchanged since 06-17); pending-without-order 0.

Sol code-level pass — holds with citations: payment creation locks + rejects stale/mixed selections (`20260714180000`); posting validates totals + period + state drift (`20260714230000`); payout void restores only live-generation commissions (`20260707060000`); invoice void cancels order commissions only after last live invoice (`20260718221505`); partial-order cancel recomputes from delivered remainder with cent reconciliation (`20260721014858`).

**HIGH (parked — owner decision required):** the `CommissionSplitEditor` "Other" free-text recipient path inserts commissions with `recipient_user_id = NULL` (validator `20260719093500` only checks nonblank/unique/100%; both creation channels write NULL on no-profile-match), and `CommissionPayments.tsx` selection requires a truthy recipient id — so such a commission **can never enter a payout batch**. Zero live rows affected today (sweep above). Two directions: (a) reject unresolvable recipients at creation (removes the designed "Other"/external-entity feature), or (b) build name-based recipient support into payout batches. **Recommendation: (a)** — payout batching is profile-keyed everywhere, live usage of "Other" is zero, and (a) is a small fail-closed validator+UI change; (b) is a payout-engine redesign for a feature nobody has used. Mason decides; parked with this note.

## Section 8 — Returns and credit memos

Live sweeps: returns 1 (requested) / return_items 1 (unchanged since 06-17); credit memos = `invoices.invoice_type='credit_memo'` (1 live, `[E2E]` demo, posted, total −40000 / applied 40000 / balance 0); `credit_memo_applications` 1 active (40000¢), reversals-missing-reason 0; negative-balance invoices 0; balance-lever identity holds for all non-credit-memo invoices.

Sol code-level pass — holds: lever sign convention is **schema-enforced** (`20260711021000`: `credit_applied_cents` non-negative; generated balance adds it for credit memos, subtracts for invoices; memo totals/balances constrained non-positive); apply moves both levers in one transaction (`20260711040000`); reversal decrements both levers, reopens targets, stamps rather than deletes (`20260711050000`); generic void reverses active applications + restores prepay + releases linked returns (`20260718221505`); statements: the section-2 opening-balance HIGH is **fixed on this base** (`20260720173059` — opening row + deterministic running balances; credit memos appear once, voided excluded, applications net zero AR); return lifecycle transitions restricted and audit-field edits blocked outside vetted RPCs (`20260701202000`, `20260715115155`); return credit money derives from delivered order lines, not caller input (`20260714222000`).

**MED (fixed this run):** `unapply_credit_memo` idempotency replay matched on key+operation only, never comparing the cached `credit_memo_id` with `p_credit_memo_id` — sequential key reuse for a different memo returned false success leaving that memo untouched. Fixed by re-emitting the live-current body with a minimal replay-binding check (`IDEMPOTENCY_ARGUMENT_MISMATCH`), mirroring the sibling apply/reversal RPCs. See migration-history row for apply proof.

## Run log

- Fixes shipped this run: `20260722111620_search_path_hardening_crm_guards_helpers` (applied live, proven) and `20260722112835_unapply_credit_memo_replay_binding` (applied live; rolled-back admin-context smoke `SMOKE_PASS_ROLLBACK replay_binding mismatch_ok=t replay_ok=t`).
- Parked for Mason: section 7 HIGH (custom recipient payout dead-end — decision (a) vs (b) above); section 6 LOW (unused idempotency params); registry high-water stamp (cosmetic).
- For the supplier-pricing branch landing: add migration-history rows for live `20260722091359` + `20260722100456`.
