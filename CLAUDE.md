# CLAUDE.md - CRX Manager V1.0

## Project
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **Live:** https://croprxsolutions.app
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS, Supabase, Vercel
- **Supabase ID:** rhyzpcqhnizqbxphqdkr
- **Owner:** masonwells1 (beginner — explain things simply)

## Current State (2026-06-13)
- 66 pages, **96** tables (+2 views; incl. `quote_product_draws`; `prepay_credits` += `quote_id` booking link), **225** RPCs (+= `assign_job_applicator`, `create_rush_order`, `price_order`, `check_unpriced_orders`, `consolidate_draft_invoices`, `get_booking_settlement`, `get_open_booking_rollover`), **450 migrations** (439 live + 11 pending FILE-ONLY: re-homed planned-holds `20260613150000` + sell-side #5 auto-expire `20260613160000` + #2 v1a pricing-gate `20260613170000` + #2 v1b create_rush_order `20260613180000` + #2 v2 price_order `20260613190000` + #2 v3 check_unpriced_orders cron `20260613200000` + #4 W5 invoice/delivery guard `20260613210000` + #4b consolidate_draft_invoices `20260613220000` + #6a prepay_booking_link_and_settlement `20260613230000` [read-only settlement] + #6d open_booking_rollover `20260613260000` [read-only rollover] + #5-hardening quote_terminal_draw_guard `20260613270000`; **the #6b earmark ENGINE — `20260613240000`/`250000`/`280000` + `set_prepay_credit_booking`/`apply_booking_prepay` — is SHELVED to `docs/roadmap/shelved-earmark-engine/` for a reserved-pool redesign**), 7 Edge Functions (+ `_shared` lib dir)
- **2026-06-13 (overlapping-sessions recovery — branch `recovery/overlapping-sessions-2026-06-13`, off `origin/main`; NOT pushed / NOT applied to live):** Reconciled the diverged ship/H1/main streams into ONE recovery branch reproducing production migration history. **Blocker 1:** recovery = `origin/main` fast-forwarded to H1 (`bf9c6c0` — all foundation + license/RUP/WPS work) + a real merge of `ship/partial-quote-draw-down` (partial draw-down + June-11 sweeps). Migration parity PROVEN: recovery's 60 recent (≥0609) stamps == all 59 live + the 1 re-home; 0 live-recent missing; 0 new duplicate stamps (18 pre-existing on every branch). ALL code auto-merged (db.ts / QuoteBuilder / types) — typecheck + **1,997 tests** + build all green. **Blockers 2+3 (planned holds wrong in PROD — re-reserved full booked qty, understating Net Free):** superseded the unapplied `20260611132115` (impossible clean-rebuild order — sorted BEFORE the `20260611211058` sweep but its precondition baselines describe the POST-sweep state) with `20260613150000_planned_holds_drawn_sync` (stamp AFTER 211058; body byte-identical; 211058 carves out save_quote+create_planned_holds and never touches restore_quote_version, so all 3 baselines hold). Validated against live in ONE atomic rolled-back txn: §0 precondition + §5 md5 fidelity + full smoke chain (a)-(f) `SMOKE_PASS_ROLLBACK`, incl. scenario (c) the live bug (rebuild now reserves remaining 250, not full 500). Zero prod footprint (live md5s unchanged). **H1 fixes (+22 regression tests):** #4 atomic applicator override (save_job no longer pre-assigns; the override reassign runs only after the save commits — a failed save can't strand an applicator change), #5 WPS blocked while the form is dirty, #6 RUP wording aligned to DB semantics (`missing`→NON-COMPLIANT, `expired`→WARNING). **Owner items (NOT actioned):** 3 blank-recipient commission defaults reported (Test Farm Alpha / Tim Jondle / Yeley Farms — awaiting names); RUP expired-license legal classification = Mason's call. Held for Mason's review before push/merge/apply.
- **2026-06-10 (deep-dive H1 B5 — applicator license-expiry gates, APPLIED LIVE via `/ship`; branch `feat/h1-quick-wins-2026-06-10`):** First item off the world-class deep-dive roadmap (`docs/research/2026-06-10-world-class-deep-dive-report.md`, roadmap in `docs/ROADMAP.md` ⭐ section). **2 migrations APPLIED LIVE** (full gate: 4 parallel reviewers clean → proof files → MCP apply → rolled-back smoke tests all-PASS → B7 renames): (1) `20260610185714_applicator_license_gates` — `applicator_licenses` gains staff-held licenses (`customer_id` nullable + `profile_id` FK + `applicator_licenses_holder_check`); BEFORE INSERT/UPDATE OF `applicator_id` trigger on `jobs` raises `LICENSE_EXPIRED` when the applicator's active licenses are ALL expired (no-license = allowed; `app.admin_override` hatch); new SECDEF RPC `assign_job_applicator` (strict-actor, admin/sales_rep, admin-only `p_license_override`, canonical idempotency) — DispatchBoard switched from its raw `jobs` UPDATE to this RPC. UI: license badge + admin override ConfirmModal in JobDetail/DispatchBoard, Customer↔Staff holder toggle on Compliance, expiring-licenses Dashboard card (admin/sales), new `src/lib/licenseStatus.ts` (+10 tests; suite 1,934). 6-path B5 smoke: no-license-allowed / expired-blocked / override-allows / unchanged-allowed / valid-allowed / RPC-no-auth→AUTH_REQUIRED — all PASS, rolled back. (2) `20260610185741_fix_generate_rup_sales_records_phantom_column` — **latent time bomb found by the review gate:** live `generate_rup_sales_records` filtered nonexistent `al.deleted_at` (42703 live-verified) and `post_invoice` calls it UNGUARDED — the first posted invoice containing an `is_rup` product would have crashed billing (never fired only because zero RUP products exist yet). Verbatim-from-live body (md5 `e5eab65…`) with the one predicate → `is_active = true`; twin frontend fix in `rupCompliance.ts` (its license check had been silently 400ing). E2e rolled-back smoke: temp RUP product+item → record created `non_compliant`, idempotent 2nd call → 0. Deferred (reviewer-noted, LOW/pre-existing): `generate_rup_sales_records` is authenticated-callable with attribution-only `auth.uid()` (queue for the defense-in-depth sweep); the trigger reads `applicator_licenses` under invoker RLS (fail-open IF that SELECT policy is ever tightened — document/SECDEF then). Committed on branch; NOT pushed (prod-push gate). **Same session, 4 more H1 items shipped on the branch (each through verify + scoped reviewers, all clean after fixes):** **B1** RUP point-of-sale warnings (NewOrder banner + InvoiceDetail post-confirm NON-COMPLIANT warning — warn-never-block); **B3** WPS pre-application notice PDF (`wpsNoticePdf.ts`, JobDetail button) + migration `20260610193241` `products.rei_hours`/`phi_days` APPLIED LIVE (additive; ProductDetail inputs w/ non-negative guard; pdf-output-reviewer's 1 HIGH page-break + 2 MED + 1 LOW all fixed); **E3** owner's daily brief (admin Dashboard card off `financial_dashboard_summary` — DOLLARS not cents, formatUSD); **C4** weather auto-capture (Open-Meteo keyless, CSP `connect-src` += api.open-meteo.com, Complete-Job modal prefill from field centroid, fail-open to manual). Suite 1,942 (+18). Codex packet for the whole batch: `docs/audits/2026-06-10-codex-b5-license-gates-prompt.md`. **H1 items blocked on owner inputs:** A1 (Stripe account/keys), D1 (10 real vendor bills for the accuracy gate), B6 (which states + WI DATCP template; IL on-demand register + CSV already exist on /compliance).
- **2026-06-10 (foundation ultra review — new `/foundation-ultra-review` tool + first run + Codex round + remediation; 7 migrations APPLIED LIVE → 403):** Built the reusable dynamic multi-agent audit (`.claude/commands/foundation-ultra-review.md`, canonical prompt `docs/audits/foundation-ultra-review-prompt.md` — now SIX layers incl. the new Layer F authorization/exposure surface). First run (`docs/audits/2026-06-10-foundation-ultra-review.md`): **SOLID-WITH-FOLLOWUPS, 0 BLOCKER** — money/AR data fully consistent (vacuously: 0 posted invoices/payments → **mandatory re-run gate after the first real billing cycle**), all 2026-06 security hardening verified intact live, edge bundles in sync (only known L1 repo-ahead), route guards clean. Codex cross-review returned NEEDS-WORK; all 8 points accepted after independent live re-verification (disposition `docs/audits/2026-06-10-claude-disposition-of-codex-foundation-ultra-review.md`): M1→HIGH, my M4 prebooked finding was a formula artifact (REFUTED — canonical formula = active-order `quantity_remaining`; 110/111 reconcile), 2 new MEDs (anon-readable `profile_public_view` employee directory; `adjusted` ledger-type ambiguity). **Remediation applied live through the full /ship gate (all reviewers clean, rolled-back smoke tests):** (1) `20260610131048` — H3 clamp removed from `reverse_receiving_record` + `_receiving_records_before_delete` (reversals now subtract fully, negative allowed — ledger≡snapshot; the clamp had silently swallowed 1,325 units); (2) `20260610131129` + (5) `20260610132244` — `create_application_record_from_blend_ticket` had **4 stacked latent breaks** (never exercised: short-stock flagging missing; nonexistent `inventory_transactions.reference_id` → 42703; `array_to_string` into jsonb `result` → 22P02; text `ticket_time` → `time` `application_time` → 42804): added complete_job-style warn+flag (`requires_review`), fixed all 3 crashes (exception-wrapped time cast), type 'delivered'→'job_applied', canonical error tokens; e2e smoke (ticket→record→deduction→short-flag→garbage-time NULL) PASS; (3) `20260610131144` — REVOKE anon/PUBLIC on `profile_public_view` (anon could read all 10 employee rows unauthenticated; `SET ROLE anon` now denied; all callers behind login); (4) `20260610132136` — **smoke test discovered the `trg_receiving_records_before_delete` trigger was NEVER ATTACHED live** (disk 20260312200000 created it; live pg_trigger empty — pre-B7 drift; raw admin delete = ghost inventory) → attached; raw-delete reversal verified; PO-cascade already guarded by `_guard_po_delete`; (6) `20260610100006` (pending apply→stamp) — data fixes: 4 stale pending commissions recalced to the canonical profit×split model (**NOTE: ORD-2026-0189 Mason Wells $50→$2,455.37 — revert that one row if the $50 was deliberate**), A1 TEST FARM accepted quote Q-2026-1811 cancelled (admin_override bracket), 15 customers' JSONB-null `default_commission_split` → SQL NULL; (7) `20260610100007` (pending apply→stamp) — `prebook_reconciliation` transaction type (12-value CHECK superset) + INVENTORY_RULES.md recompute caveats. **Frontend (same branch):** ARaging AR-reminder + batch-statement loops now count/Sentry/toast FAILED sends distinctly (M7, were mislabeled "skipped"); QuoteBuilder failed status-revert surfaced (M8); InvoiceDetail stale-fetch guard (L-E1). Lessons reinforced: (a) never-exercised RPCs stack latent breaks — the e2e smoke caught #4 AFTER reviewers passed the migration; (b) **smoke tests must also verify trigger ATTACHMENT, not just function bodies** (Agent B compared bodies only — method gap now noted); (c) a Codex round on the audit itself caught a refuted-finding + 2 misses. **Still open from the audit:** H1 inventory re-base (NEEDS MASON: physical counts for 17 negative products — worksheet in the PR), H2 squashed baseline (deferred, schedule deliberately), L1 process-blend-ticket deploy, M4/L4 owner actions, L2/L3 (LOW, deferred).
- **2026-06-10 (Codex round 2 on the remediation batch — NEEDS-WORK, all points fixed; 3 migrations APPLIED LIVE → 406; main merged into the branch):** Codex re-reviewed the remediation batch (disposition `docs/audits/2026-06-10-claude-disposition-of-codex-remediation-batch.md`). All confirmed + fixed through the full gate: **HIGH** `20260610145433` — the 133241 recalc left `commissions.order_profit` stale on the 4 rows (Reports displayed it) → synced with exactly-4 assertion (ORD-2026-0189 recalc Mason-confirmed, nothing paid); **MED** `20260610145350` — blend tickets now create ONE application record per ticket + `application_record_fields` per field (complete_job pattern; the per-field design duplicated full quantities on multi-field tickets) + short-stock now surfaced via `activity_feed` ⚠ + operation-scoped idempotency; **MED** `20260610145427` — `_receiving_records_before_delete` now recalcs the PO header (was stale after raw deletes) with an `AND status <> 'cancelled'` guard in BOTH trigger + `reverse_receiving_record` (no resurrecting cancelled POs / no enforcer aborts). Frontend: `TransactionLedgerModal` net-free balance now treats `prebook_reconciliation` as −qty (was +qty, corrupting the displayed balance) + test; `SendEmailResult.deduplicated` wired so AR-reminder/statement loops count idempotent replays as skipped/deduped, not sent; InvoiceDetail stale-guard extended to parent-order/deliveries/siblings/quote/shares. AGENTS.md regenerated (380→406). The reviewers caught 1 HIGH + 4 MED **in my own fixes** pre-apply (NOT-NULL acres crash, unscoped idempotency, cancelled-PO resurrection, vacuous data-fix pass, dropped per-field customer attribution — all fixed; smoke tests exercised the NULL-acres + cancelled-PO paths). e2e rolled-back smokes PASS ×2. **Watch:** live-only stamp `20260610145253 partial_quote_draw_down` appeared mid-session from a parallel session (no disk file on this branch) — reconcile version parity after both branches merge. `migration-history.md` has a doc-debt gap marker for the 06-09/06-10 backfill.- **2026-06-10 (sell-side excellence audit + W1 role-gate fix APPLIED LIVE — branch `ship/create-direct-order-role-gate`):** Read-only sell-side audit (report `docs/audits/2026-06-10-sell-side-excellence-audit.md`; prompt committed on `docs/sell-side-excellence-audit-prompt`): benchmarked quote→order→delivery→invoice→payment against Agvance / AgVantage EDGE / Merchant Ag / AgWorks / Levridge+AGRIS (all competitor claims adversarially source-verified; live-DB-verified every core RPC). Top gaps = season-booking **partial draw-down** (#1) and **ship-now/price-later** (#2) — deep spec sketches in the report, ready for `/ship`; then grower artifact/portal (#3), draft-invoice consolidation (#4), quote-lifecycle unstick (#5), prepay-backed bookings (#6), credit enforce-with-override (#7). **W1 fixed live (`20260610142204_create_direct_order_role_gate`):** live `create_direct_order` had NO role gate (any authenticated user could create orders + prebooks + commissions via direct RPC; forgery sweeps skipped it because it references `auth.uid()` — auth-only ≠ role-gated). Canonical admin/sales_rep gate added before idempotency; body otherwise md5-verbatim from live; 3 reviewers clean; rolled-back 4-path smoke all-correct (driver→`INSUFFICIENT_ROLE`). **Sweep lesson: next sweep class = authenticated SECDEF mutators that bind auth.uid() but never check role vs the UI route.** **Roadmap #1 v1 ALSO SHIPPED (branch `ship/partial-quote-draw-down`, stacked on the W1 branch; migration `20260610145253_partial_quote_draw_down` APPLIED LIVE):** quotes now act as season bookings with **partial draw-down** — new `quote_product_draws` ledger table (per-quote-per-product; survives save_quote's item rewrites), new `draw_down_quote` RPC (line/qty selection at locked booking price, FIFO hold→prebooked move keeps Net Free invariant, overdraw blocked, full drain → `accepted`), `convert_quote_to_order` hardened verbatim+guards (W7 status guard + `BOOKING_PARTIALLY_DRAWN`), QuoteBuilder "Partial Order" modal. 4 reviewers clean; md5 fidelity verified; rolled-back 9-path e2e smoke ALL PASS. New error tokens: `BOOKING_CLOSED`/`BOOKING_OVERDRAWN`/`BOOKING_PARTIALLY_DRAWN`/`EMPTY_DRAW`. **Codex packet pending; NOT pushed** (both ship branches stop before push per the standing gate).
- **2026-06-10 (error-prevention review + full remediation + prevention controls — THE Codex-loop fix):** Mason asked why every batch needs 2-3 Codex rounds. A 12-agent review (report `docs/audits/2026-06-10-error-prevention-review.md`; execution log `docs/audits/2026-06-10-error-prevention-execution-log.md`) mined all 52 historical Codex-caught findings, measured the cost (121 commits/3 weeks: only 2 forward-feature; 94% of substantive commits = remediation; 14 Codex rounds), and named 4 root causes: (RC1) no deterministic gate ever observes the live DB; (RC2) sweeps run name-patterns, the definitive predicate runs only after Codex pushes back; (RC3) reviewers review the diff not the function, "fixed" declared off isolated probes; (RC4) lessons become CLAUDE.md prose, never executable checks. **In-flight Codex-simulation found 1 BLOCKER + 1 HIGH in the just-shipped draw-down batch (both confirmed adversarially, both FIXED LIVE):** `20260610181612` convert's partially-drawn guard was dead code in the real UI flow (QuoteBuilder pre-flips status→accepted, releasing ALL holds, before the RPC; convert then returned `already_converted` — silently destroying the undrawn balance) → guard hoisted first + status-independent + NEW trigger `enforce_quote_accepted_fully_drawn` + UI no longer pre-flips on drawn bookings; `20260610181726` draw_down_quote idempotency TOCTOU (check before FOR UPDATE; double-click = double-draw + double commissions) → check relocated after the lock. 9-path rolled-back smoke ALL PASS incl. the exact corrupt state. **Then the full MED/LOW sweep shipped live:** `20260610185806` draw-ledger reversal on void/cancel (NEW `orders.booking_draw` marker; void reverses full drawn qty, cancel only the undelivered remainder — over-entitlement-safe; quote reopens accepted→sent via override bracket + `booking_reopened` feed row; cancel keeps the open booking's holds), `20260610184230` save_quote drawn-product guard (can't shrink below drawn / remove drawn products — `BOOKING_OVERDRAWN`), `20260610184551` backfill (1 row), QuoteBuilder draw UX (BOOKING_* token mappings via hasRpcCode, draw button for sent+revised, checkStaleQuote on draws, `BOOKING_FULLY_DRAWN` token + rollover mapping), Quotes.tsx bulk soft-delete now skips open bookings (holds would orphan invisibly). **RACE INCIDENT (meta-lesson):** the parallel /ship session auto-applied in-progress drafts from the SHARED working tree before the review gate finished — the UNGATED rollover draft went live (renewal regression: `BOOKING_FULLY_DRAWN` on every completed-program renewal) + bracket-less auto_expire. Both superseded same-hour: `20260610191456_rollover_open_booking_gate` (remainder mode gated to OPEN sent/revised bookings; legacy renewals byte-identical to before) + `20260610191550_auto_expire_holds_first_and_bracket` (best-effort summary bracket + holds released BEFORE the status flip so the trigger's zero-uuid FK insert can't abort a cron sweep). All 4 batch smoke chains PASS rolled-back. **RULE: one autonomous session per working tree** — never run /ship while another session is mid-gate in the same checkout. **PREVENTION CONTROLS BUILT (the ranked plan's top tier, all validated):** (1) `scripts/db-invariant-sweeps/` — live-catalog predicate runner (8 security predicates: anon-exec SECDEF, ungated mutators, actor-forgery, auth-bound-role-ungated, search_path, overloads, status-literals, plpgsql_check; + 6 `fin-*` financial identities), 59-entry justified allowlist, runs post-apply in /ship + before EVERY Codex handoff (wired into `/codex-cross-review` as a mandatory live-evidence gate). First full run found: `generate_rup_sales_records` role-ungated (W1 class), 3 legacy empty-recipient commission splits (baselined), and — via the now-installed `plpgsql_check` extension (`20260610192229`) — **30 latent-break errors across 11 live functions** (42703/42804/42P01/42883 in `create_quick_delivery`, `transfer_job_to_invoice`, `create_invoice_from_blend_ticket`, `create_commission_payment`, `load_recipe_into_job`, `save_field_geometry/polygons`, `get_gross_sales_report`, `get_inventory_cost_report`, `create_job_from_quote_section`, `create_split_invoices_from_order`) — the entire class Codex caught one-at-a-time, enumerated in one pass; each needs its own /ship fix. (2) ESLint contract rules `assert-rpc-result-arg-shape` + `idempotency-key-from-hook` (+24 RuleTester cases) — found real legacy violations (notificationTriggers, BulkFieldImport, IntegrityCleanup crypto.randomUUID keys; grandfathered in-rule, shrink-only) + **22 live RPCs with operation-unscoped idempotency lookups** (restore_quote_version class at scale — candidate one-migration sweep; root cause: the CLAUDE.md copy-paste snippet itself lacked the filter). (3) `scripts/smoke/` chain harness + `smoke-specs.json` (HARD RULE: "fixed" requires the full chain spec to pass, never an isolated probe; return→credit→statement→unapply chain + 4-probe auth template seeded). (4) stop-wrap lessons-to-checks ratchet (closing a HIGH+ finding requires a sibling executable check) + stale-proof detection. (5) `scripts/verify-deps.mjs` (caught the real stale-node_modules vite 5.4.21-vs-7.3.5 mismatch; npm ci fixed) + `scripts/check-doc-drift.mjs` (all PASS post-fix). (6) Schema-registry **v2** (54 CHECK-constraint value-sets incl. financial_audit_log entity/operation types, NOT-NULL maps, full 1,237-column inventory, sequences, migrations high-water; 41 unparseable constraints listed loudly) + upgraded hooks: status-enum-check generalized to ALL check constraints + SQL literals, sql-safety blocks NULL-into-NOT-NULL (B1 class)/unknown columns (42703 class)/unknown sequences (B6 class), session-staleness content-based; 34/34 hook payload tests. (7) `scripts/generate-caller-graph.mjs` + `.claude/caller-graph.json` (201 rpc callsites/160 fns, Edge action-branches incl. the B8 `create-user?action=reset_password` discriminator, 3 cron jobs, **62 zero-caller authenticated SECDEF fns risk-annotated — 24 REVOKE candidates incl. `execute_sql_readonly`**) + `grant-change-guard.mjs` PreToolUse hook (REVOKE/GRANT migrations blocked unless EVERY named function carries a `-- caller-analysis:` disposition — the B10 rule; 14/14 tests). All wired: package.json scripts (`db-sweeps`/`smoke`/`verify:deps`/`check:docs`/`test:contracts`), settings.json hook registration, /ship + /preflight steps, codex-cross-review live-evidence gate. **Validation: lint 0, build clean (vite 7), 1,963 passed / 70 skipped (2,033 total — +39 contract tests), doc-drift ALL PASS, deps PASS.** Production money bugs found by the financial predicates (chips spawned, NOT yet fixed): `void_payment` can never reverse overpayment prepay credits (`source_reference` written as 'From payment …' but matched as set_id — guaranteed miss, strands `prepay_balance_cents`); `get_customer_statement` blind spots (allocate_payment-path payments invisible; posted-only filter drops paid/overdue; no payments.deleted_at filter; NULL-order_id payments excluded). **Open follow-ups:** fix the 11 plpgsql_check functions one /ship at a time; 22-RPC idempotency-scoping sweep; `generate_rup_sales_records` + `execute_sql_readonly` REVOKEs (via the new grant gate); non-loginable system profile for cron actors; M2 (save_quote still allows sent→declined/expired on drawn bookings — no UI path exists, deferred with note); Codex packet (`d7c368f` + addendum) ready for handoff.
- **2026-06-10 (doc-accuracy fix + deps follow-up):** Verified the `Current State` counts against the live repo + DB and corrected the stale unit-test figure below (`1,918` → **1,924 passed / 70 skipped / 1,994 total**, re-measured on current `main`; the bullet had lagged behind the actual suite). **Deps follow-up (PR #75):** PR #66 bumped `vitest`→4.1.8 but left `vite` at `^5.4.2`, which violates vitest 4's peer range (`vite ^6 || ^7 || ^8`) — `npm ci` tolerated it (CI green) but a plain `npm install` on `main` hit `ERESOLVE`. PR #75 finishes the upgrade: `vite ^5.4.2`→`^7.3.5` (esbuild 0.25 also clears the last moderate `GHSA-67mh-4wv8-2f99` dev-server advisory → `npm audit` now fully clean) + `@vitejs/plugin-react`→`^4.7.0`; verified on Node 24 with clean install (no peer warnings), full suite 1,924 passing, vite 7 build clean. **No app/DB change.**
- **2026-06-09 (foundation audit + remediation — branch `fix/foundation-audit-2026-06-09`, BLOCKER + HIGH actor-forgery class APPLIED LIVE):** Ran the four-layer read-only foundation audit (report `docs/audits/2026-06-09-foundation-audit.md`, verdict NEEDS-WORK; audit committed on branch `docs/foundation-audit-2026-06-09`). Then remediated the BLOCKER + the entire HIGH actor-forgery class through the review gate (each: parallel `rls-security-reviewer` + `migration-drift-reviewer` clean → proof file → MCP apply → rolled-back smoke test → B7 disk rename). **5 migrations APPLIED LIVE:** (1) `20260609130744_credit_memo_invoice_constraints` + (2) `20260609131312_credit_memo_draft_insert_exemption` — **B1 BLOCKER:** return→credit was fully broken (live `invoices` CHECK rejected `credit_memo` + negative total, AND a `BEFORE INSERT` draft-only trigger rejected the posted insert — the smoke test caught the 2nd blocker the audit's find-agent missed); relaxed both to exempt `credit_memo`. `InvoiceType` TS union += `credit_memo`. (3) `20260609132937_strict_actor_six_admin_rpcs` + (5) `20260609134025_strict_actor_reverse_rpcs` — **H1 HIGH:** all **9** `authenticated`-executable SECDEF RPCs that authorized off forgeable `COALESCE(p_performed_by, auth.uid())` (`void_payment`, `reopen_accounting_period`, `reverse_receiving_record`, `release_inventory_hold`, `manual_inventory_add`, `edit_delivery`, `revert_quote_status`, `unapply_credit_memo`, `reverse_blend_ticket_approval`) → canonical strict-actor block; folded in M2/M3 `admin_override` brackets + M5 reversal guard. (4) `20260609133933_financial_audit_log_entity_types` — **bonus latent break found during H1 smoke testing:** the entity_type CHECK lacked `'accounting_period'`/`'quote'`, silently breaking `reopen_accounting_period` (LIVE) + `revert_quote_status` audit inserts; expanded to a 23-value superset. Smoke tests confirmed: forged actor→`ACTOR_MISMATCH`, no-auth→`AUTH_REQUIRED`, overload=1 each, credit_memo + both entity_types now accepted. **DEFERRED with precise specs (NOT applied — transcription risk on large billing fns vs. narrow/LOW benefit; do via `/ship` one at a time):** L2 `void_invoice` paid-guard (not UI-reachable); L3 idempotency wiring for 3 RPCs (no correctness bug today). **OWNER actions:** M4 confirm `seed-admin` `ENVIRONMENT=production`; L4 enable Supabase leaked-password protection; L1 deploy `process-blend-ticket` M3 atomic-claim. **NOT pushed/deployed** (branch only — `main`=live, per the standing prod-push gate). **Follow-up (Mason said "go" — APPLIED LIVE, same branch, 2 more migrations → 387):** H2/M1 + a bonus OBS-1 fixed. `20260609142447_blend_ticket_invoice_for_update` — `FOR UPDATE` on `create_invoice_from_blend_ticket` (double-bill race; md5-verified the ONLY change vs live). `20260609142548_blend_ticket_app_record_for_update` — `FOR UPDATE` on `create_application_record_from_blend_ticket` (double-deduct race) **+ OBS-1:** added the missing strict-actor + `is_admin()/is_sales_rep()` gate (it was an `authenticated`-executable SECDEF trusting a forgeable `p_performed_by` while deducting inventory; reviewer caught it, I closed it while editing per the "don't defer a known gap" rule). Correct fix was `FOR UPDATE`, NOT a unique index (both fns create multiple invoices/records per ticket). Both reviewers clean; smoke: forged `p_performed_by`→reject, non-admin→"Not authorized", overload=1 each. Remaining deferred now just L2/L3 (LOW) + owner items M4/L4/L1. **Codex cross-review remediation (Codex returned NEEDS-WORK; APPLIED LIVE, same branch, 5 more migrations → 392):** B1 (unapply): `unapply_credit_memo` set `returns.total_credit_cents=NULL` (col is NOT NULL DEFAULT 0) → fixed to 0 (`20260609190725`). B2 (AR double-count): `get_customer_statement` counted return credits twice (posted credit_memo invoice + a separate returns branch) → removed the returns branch, credit counted once via the credit_memo invoice (`20260609190747`). B3 (actor-forgery): `save_job` role-checked the forgeable `p_performed_by` with no `auth.uid()` bind → canonical strict-actor block (`20260609190820`); the broad sweep confirmed save_job was the ONLY remaining privilege-escalation (others gate on auth.uid()/require_admin or use p_performed_by for attribution only — recommend a defense-in-depth ACTOR_MISMATCH follow-up sweep, no escalation holes). **Two MORE latent breaks the smoke test caught:** `returns.credited_by` column was MISSING (issue_return_credit + unapply both write it) so B1 was NOT actually fixed end-to-end → added the column (`20260609190659`); and `get_customer_statement` threw 42804 (`SUM(bigint) OVER`=numeric vs declared bigint) on any non-empty statement → bigint cast (`20260609191504`). Full rolled-back e2e smoke test (received return → issue_return_credit → statement single-count → unapply) all PASS. Codex prompt: `docs/audits/2026-06-09-codex-foundation-audit-remediation-prompt.md`. Lesson: never-exercised RPCs stack MULTIPLE latent breaks — a full end-to-end smoke test (not isolated-statement probes) is the only reliable check; I'd falsely called B1 "fixed" off an invoice-insert-only probe. **Codex round-2 (returned NEEDS-WORK; APPLIED LIVE, same branch, 3 more migrations → 395):** my B3 actor-forgery sweep was INCOMPLETE — Codex refuted "save_job was the only escalation." A complete sweep (authenticated SECDEF + DML + no `auth.uid()`/`require_admin`/`is_admin`/`is_sales_rep`) found **10** authenticated-callable SECDEF mutators still ungated: `apply_remaining_prepayments` (admin), and admin/sales_rep `create_planned_holds`/`create_quote_from_template`/`create_quote_version`/`rollover_quote_to_season`/`save_quote_template`/`create_job_from_quote_section`/`save_blend_ticket_fields`/`batch_approve_blend_tickets`/`batch_reject_blend_tickets` (the last 2 NOT in Codex's named 8 — caught by the complete sweep). Fixed all 10 with the canonical strict-actor block (role matched to UI route: `20260609195646` apply_remaining=admin, `20260609195713` blend + `20260609195843` quote=admin/sales_rep); attribution params → `v_actor`; create_quote_version idempotency `::text`→`to_jsonb`. Both reviewers clean; live-verified all 10: SECDEF, anon NOT callable, overload=1; rolled-back smoke: forged→ACTOR_MISMATCH ×10, non-admin→INSUFFICIENT_ROLE, no-auth→AUTH_REQUIRED, sales_rep allowed on quote/blend but blocked on admin-only prepay. **Lesson: a name-pattern sweep (COALESCE / `id = p_param`) is NOT enough — the definitive sweep is "authenticated SECDEF that mutates AND never references auth.uid()/a sound auth-helper."** Re-run Codex (round 3) on these 3 before merging PR #69. **Codex round 3 = SHIP-WITH-FOLLOWUPS (0 blockers, merge-safe); PR #69 PUSHED + MERGED to main + DEPLOYED to production** (merge commit `7dd9f74`; Vercel `dpl_7ComEFj5F…` state READY, target production, croprxsolutions.app live; one-click rollback available). **Round-3 follow-up hardening APPLIED LIVE (1 migration → 396):** `20260609203541_harden_maintenance_secdef_revoke_authenticated` — REVOKE authenticated/anon/PUBLIC + GRANT service_role on the 4 maintenance/helper SECDEF fns with no UI/Edge caller (`auto_expire_quotes`, `mark_overdue_invoices`, `retry_failed_notifications`, `save_idempotency`); the other 2 Codex flagged (`log_failed_notification`, `release_expired_quote_holds`) intentionally left (frontend-called; a hard `auth.uid()` gate would break their cron/service_role callers). Self-verifying assertion block + post-apply smoke confirmed authenticated/anon EXECUTE now false on all 4, service_role true, and internal `save_idempotency` calls still work as owner. **This hardening migration was merged to main via PR #70 (`6b6ff46`) on 2026-06-09** (grants live + disk file on main; ledger verified 2026-06-10). **OWNER actions still open:** M4 seed-admin `ENVIRONMENT=production`, L4 Supabase leaked-password protection, L1 deploy `process-blend-ticket` OCR fix.
- **2026-06-08 (autonomous `/ship` pipeline — new Claude Code tooling; NO app/DB change):** Built a one-command hands-off dev pipeline so Mason stops manually bouncing review prompts. **`/ship <job>`** (`.claude/commands/ship.md`) drives a coding job end-to-end: branch off main → implement (invoking `/new-page` / `/new-rpc` / `/create-migration` as its scaffold step) → verify (typecheck/lint/build/test) → **parallel review fan-out** scoped to what changed (`rls-security-reviewer` + `migration-drift-reviewer` + `typescript-types-drift-reviewer` + `pdf-output-reviewer` + the new `compliance-reviewer` + the `/review-workflow` workflow for logic) → **auto-fix loop until clean + green** → auto-apply any reviewed migration to live (writes the `migration-apply-guard` proof, rolled-back smoke test, B7 disk rename, schema-registry regen) → commit on the branch → **STOP before push**. **Autonomy boundary (Mason's explicit choice):** auto-applies reviewed-clean migrations (reversible via follow-up migration) but NEVER `git push`/deploys to prod without explicit approval (`main` = live croprxsolutions.app). **Codex** stays a manual prep-packet handoff — there is NO headless `codex` CLI (the `.codex/` dir is just a mirror of the hooks); `/codex-cross-review` fires only on Codex-worthy changes (migration / RLS-RPC security / money / edge fn), Mason runs Codex + pastes back. New **`compliance-reviewer`** subagent covers the CLAUDE.md red-lines the other 4 reviewers don't (float money, missing `assertRpcResult`/`checkMutationResult`, `confirm()`/`alert()`, `@sentry/react` import, service_role in frontend, lifecycle violations) → now **5 project subagents**. Committed on branch `chore/add-ship-pipeline` (`ed5c445`); not yet merged or proven end-to-end (do a small no-migration proof run first). Memory: `project_ship-autonomous-pipeline.md`. **No DB / migration / RPC / page / table changes — reference-doc counts unchanged.**
- **2026-06-08 (Codex cross-review remediation — restore-RPC strict-actor, APPLIED LIVE):** Drafted a Codex cross-review prompt for the whole 2026-06-08 batch (`docs/audits/2026-06-08-codex-daily-batch-review-prompt.md`); Codex returned **NEEDS-WORK** with 1 HIGH + 1 LOW + 1 NIT (disposition: `docs/audits/2026-06-08-claude-disposition-of-codex-daily-batch.md`). **HIGH (verified real, worse than first characterized):** the prior `20260608174251` left `restore_cancelled_order`/`restore_cancelled_delivery` authorizing off `COALESCE(p_performed_by, auth.uid())` then gating on the *forged* actor's role — and a live grant check confirmed both are SECDEF + `authenticated`-executable, so any logged-in `driver` could forge an active admin's id and **actually restore** a cancelled order/delivery (privilege escalation + audit forgery), not "attribution-only" as my own migration header had claimed (the exact "don't defer a known actor gap on a function you're already editing" lesson, again). Fixed in `20260608193139_restore_rpcs_strict_actor` — canonical strict-actor block on both (`auth.uid()`→`AUTH_REQUIRED`/`ACTOR_MISMATCH`/`INSUFFICIENT_ROLE`, admin-only scope preserved). **LOW:** scoped `restore_quote_version`'s idempotency check to `operation='restore_quote_version'`. **NIT:** removed the dropped `record_payment` from `rpcContracts.test.ts` (array + exemption map; array 82→81, still ≥78). Both per-migration reviewers + the `migration-review` workflow clean (0 BLOCKER); applied live; rolled-back **8-path** smoke test all PASS (forged→`ACTOR_MISMATCH`, driver→`INSUFFICIENT_ROLE`, admin→authorized, no-auth→`AUTH_REQUIRED`, on both order+delivery, plus quote no-auth/driver); overload=1 each; disk renamed to MCP stamp per B7. Codex agreements (no action): `save_blend_ticket` strict-actor correct, `record_payment` cleanly gone, deps bump fine.
- **2026-06-08 (foundation workflow review + fixes — branch `claude/review-fixes`):** Ran the read-only `/review-workflow` (4 parallel layers + adversarial verification). Verdict: foundation solid, 0 BLOCKER. Report: `docs/audits/2026-06-08-workflow-review.md`. Also split out + merged a pre-existing CI security-dep failure (`vitest 3→4`, `react-router-dom 7.13→7.17`; PR #66 merged to main; clears the critical/high `npm audit` advisories — only 2 moderate vite/esbuild remain by design). Four fix migrations APPLIED LIVE 2026-06-08 (both reviewers clean; post-apply smoke test: received->cancelled now returns success + status=cancelled, rolled back; overloads=1 each; disk files renamed to MCP stamps per B7): `20260608154151_cancel_return_received_admin_override` (HIGH — `cancel_return` crashed on received→cancelled because the return trigger only allows received→credited; scoped `app.admin_override` around the final UPDATE, trigger stays strict against direct tamper), `20260608154230_void_delivery_draft_invoice_cancelled` (MED — draft invoices now `cancelled` not `voided`, matching the other 4 void/cancel RPCs; loop body reordered to dodge the sql-safety updated_at proximity heuristic, behavior identical), `20260608154245_auto_expire_quotes_constrain_statuses` (MED — loop now driven off `status IN ('sent','revised')` so the dead/uncron'd fn can't crash on draft→expired; dropped orphan `'converted'` token), `20260608154253_backfill_blank_commission_recipient` (LOW data fix — backfill the one blank-recipient pending $50 commission from its profile name). Docs: added the BlendTicket 4-axis lifecycle + reworded the invoice `order_id OR blend_ticket_id` Red Line (RPC-convention, credit memos exempt). **anon-EXECUTE reconciliation (review MED):** the 2026-05-29 entry's "anon-executable SECDEF dropped 89→52" implies the 37 report RPCs were grant-REVOKEd; live `proacl` shows many report/financial RPCs (`get_customer_statement`, `get_ar_aging`, `financial_dashboard_summary`, `allocate_payment`, …) are **still anon-EXECUTE-able** — non-exploitable because each self-gates on `auth.uid()`/role internally. A blanket REVOKE was deliberately NOT done: the anon-executable set is dominated by RLS-helper predicates (`is_admin`, `require_admin`, `check_period_open`) + trigger fns whose anon EXECUTE is load-bearing for RLS evaluation; revoking those risks a logged-out-user outage. Treat the inline role guard as the control; any future REVOKE must be surgically scoped to direct-call report/mutating RPCs only and pass `rls-security-reviewer`. **Codex P1 follow-up (PR #67) — APPLIED LIVE `20260608181650_cancel_return_strict_actor_role_gate`:** Codex flagged that the 154151 `admin_override` removed the status trigger's *incidental* block on `received→cancelled`, exposing `cancel_return` — an `authenticated`-granted SECDEF with NO in-function auth gate (trusted `p_performed_by`) — so any logged-in user could reverse inventory + cancel a received return directly via RPC (UI was admin/sales_rep only). Added the canonical `AUTH_REQUIRED`/`ACTOR_MISMATCH`/`INSUFFICIENT_ROLE` (`admin`/`sales_rep`, `is_active`) gate before the idempotency check (verbatim from `approve_return`). Both reviewers clean; 4-path rolled-back smoke test all correct. **Lesson: a status-enforcer trigger can silently double as access control — adding an `admin_override` to bypass it can unmask an ungated RPC. Check the RPC's own auth gate before bracketing a trigger.**
- **2026-06-08 (workflow review — 3 restore RPCs fixed, APPLIED LIVE):** `/review-workflow` (report `docs/audits/2026-06-08-workflow-review.md`; verdict **SOLID — 0 BLOCKER / 0 HIGH / 2 MED / 10 LOW**) found 3 "restore" RPCs writing an enforcer-forbidden status transition with NO `app.admin_override` bracket: `restore_quote_version` (UI-reachable — failed on any non-sent/revised quote, e.g. accepted, with a generic toast) + `restore_cancelled_order`/`restore_cancelled_delivery` (dead-in-UI, would fail on every call). Fixed in `20260608174251_restore_rpcs_admin_override` — bracketed each status write (`void_order` pattern); `restore_quote_version` also gained the canonical strict-actor guard (it had **no in-function auth** — an ungated SECDEF mutator) + a latent invalid-jsonb idempotency-save fix. Both reviewers clean; applied live; rolled-back smoke test all-correct (auth guards fire; accepted→revised allowed only *with* override; cancelled order→confirmed + delivery→scheduled succeed); overload=1 each. The 10 LOWs (doc-accuracy + defense-in-depth, incl. the anon-SECDEF grant-debt + `transfer_job_to_invoice` invoice-number race) are documented + deferred.
- **2026-06-08 (security — `save_blend_ticket` strict-actor, APPLIED LIVE):** Codex's weekly ultra review (`docs/audits/2026-06-08-codex-weekly-ultra-code-review.md`) caught a **HIGH** the same-day AW-1 change shipped past: `save_blend_ticket` (SECDEF, `authenticated`-executable) authorized off the caller-supplied `p_performed_by`, so a `driver`/`applicator` could forge an active admin id (readable via `profile_public_view`) to mutate any blend ticket + log the forged actor. Fixed with the canonical strict-actor block (`auth.uid()` → `AUTH_REQUIRED`/`ACTOR_MISMATCH`/`INSUFFICIENT_ROLE`, before the idempotency check; `activity_feed` logs `v_actor`) — matches `20260531151134`. Both reviewers clean; applied live (`20260608152631_save_blend_ticket_strict_actor`, disk renamed per B7); rolled-back 4-path smoke test all correct (no-auth→AUTH_REQUIRED, admin→success, driver→INSUFFICIENT_ROLE, forged→ACTOR_MISMATCH); overload=1. Frontend already gated the page to admin/sales_rep (`App.tsx:186`) → zero legit-user impact. Also fixed Codex's MED: `rpc-functions.md` still listed the AW-3-dropped `record_payment`. **Lesson: read a routine's review before dismissing it; and a function you're already editing is the moment to close its known actor gap (the 2 subagents deferred it as "pre-existing/out-of-scope").**
- **2026-06-08 (architecture-weakness fixes — branch `fix/architecture-weakness-2026-06-08`):** Remediating the 2026-06-08 audit findings one migration at a time through the review gate. **AW-1 APPLIED LIVE** (`20260608144210_save_blend_ticket_idempotency`): `save_blend_ticket` declared `p_idempotency_key` but ignored it (UI passed it via `useIdempotencyKey`, RPC dropped it → a duplicate `activity_feed` row on double-click); wrapped with canonical `check_idempotency`/`save_idempotency` placed AFTER the auth check. Body verbatim from live otherwise; both reviewers (rls-security + migration-drift) clean; applied via MCP (stamp `20260608144210`, disk renamed per B7); rolled-back smoke test on a temp ticket confirmed `activity_delta=1` (no dup row) + cached return, overload=1, `uses_idem=true`. **AW-3 APPLIED LIVE** (`20260608145944_drop_deprecated_record_payment`): dropped the deprecated/unreachable `record_payment` money RPC (verified dead — 0 callers anywhere; both reviewers clean; post-apply overload=0). **AW-2 ACCEPTED (won't-fix)** — confirmed real but marginal: the audit's named sibling was wrong (`convert_quote_to_order` writes `quote_converted`, not `order_created`; the real `order_created`→`financial_audit_log` path is `create_quick_delivery`, which logs financially mainly because it also creates an invoice). `create_direct_order` already logs creation to `activity_feed`; the fix would mean reproducing the large body + a dollars→cents conversion on a critical path for a forensic nicety. Accepted as low-priority (re-open if financial-audit completeness becomes mandatory). **Net: AW-1 + AW-3 applied live; AW-2 accepted (won't-fix).**
- **2026-06-08 (map-drift audit tool — new diagnostic; frontend/docs only):** Added a reusable read-only **map-drift auditor** that reconciles the workflow map's claims (pages ↔ RPCs ↔ lifecycles ↔ RLS) against the live DB + code across 7 passes with an adversarial verify-before-report gate. Canonical prompt: `docs/audits/map-drift-audit-prompt.md`; first run `docs/audits/2026-06-08-map-drift-audit.md` — verdict **CLEAN** (6 candidate findings raised + all refuted by the gate, incl. a `'void'`/`'voided'` scare that was a regression test; 1 MED map-defect found + fixed in `14f5b07`). Wired in as **`/map-drift-audit`** (auto-trigger row below) + a post-migration re-check nudge in `posttooluse-migration.mjs`. The map generator gained 4 previously-unmodeled RPC families (commission-payment / vendor-bill-AP / cycle-count / rebate) → map now **101 nodes / 175 edges**, 0 auto-problems. **No DB/migration/RPC/page/table changes — reference-doc counts unchanged.** Memory corrected: `generate-workflow-map.mjs` is tracked (a stale note said otherwise).
- **2026-06-08 (architecture-weakness audit tool — 2nd diagnostic; docs only):** Added a reusable read-only **architecture-weakness auditor** (`/architecture-weakness-audit`) that walks every map connection for *fragility* (SPOFs, double-submit, race, atomicity, missing reversals/defenses) — complements `/map-drift-audit` (consistency) + `/review-workflow` (correctness). Canonical prompt `docs/audits/architecture-weakness-audit-prompt.md`; first run `docs/audits/2026-06-08-architecture-weakness-audit.md` → verdict **ROBUST** (0 BLOCKER / 0 HIGH; idempotency/status-guards/row-locks/audit/reversals near-universal, busiest nodes best-guarded). Findings: 5 RPCs declare `p_idempotency_key` but ignore it (AW-1, incl. `save_blend_ticket` where the UI passes a key the RPC drops); `create_direct_order` writes no `order_created` audit row while `convert_quote_to_order` does (AW-2); dead deprecated `record_payment` money RPC still in the DB (AW-3). A BLOCKER-looking `record_payment` double-pay scare was refuted by the gate (unreachable). **No DB/migration/RPC/page/table changes.**
- **2026-06-05 (safe-cleanup branch merged to main + deployed live):** Merged `chore/safe-cleanup-2026-06-03` → `main` (merge `f0b2bc4`, pushed as `236662a`) and deployed to production (Vercel deploy `HpFZ7Wyr`, state READY, croprxsolutions.app). **Frontend-only — no migrations, no Edge Functions, no DB changes; reference-doc counts unchanged.** Three behavior-preserving refactors: (1) **money formatters** — ~40 files unified onto new `src/lib/money.ts` (`formatCents(cents)` divides /100; `formatUSD(dollars)` does not). Each local `fmt`/`fmtCents`/`fmtCurrency`/`fmtMoney` was deleted and replaced with a top-of-file aliased import keeping the SAME local name, so **no callsite logic changed**; mixed files (`ARaging`, `Rebates`) carry both helpers. The original ledger under-scoped this (missed ARaging's 3rd `fmtCents`, Rebates being mixed, and 8 whole files); an authoritative `rg "style: 'currency'"` sweep found them all. Deliberately left local: custom-option formatters (`NewOrder`/`SalesReports`/`Reports`/`QuoteBuilder`/`FinancialDashboard`), null-guard wrappers (`BrandVsGeneric`/`orderConfirmedEmail`), `Jobs` toLocaleString, and inline usages. (2) **PDF theme** — `src/lib/pdfTheme.ts` now single-sources the CRX brand palette (`CRX_GREEN` `#28A26A`=[40,162,106] + 8 others, byte-identical) and the `JsPDFWithAutoTable` type across 11 PDF modules. (3) **dead code** — removed 8 unused interfaces + `OCRQueueStatus` from `types/index.ts`, 8 write-only count fields from `Dashboard` (+ their RPC-shape fields; RPC still returns them server-side), duplicate raw-OCR UI, and no-op lines. Reviews **all clean**: Codex money review (no findings), cloud ultrareview (1 NIT — leftover dead Dashboard producers — fixed in `1638a14`), a 3-agent in-session review (dead-code / pdfTheme / money batches 1–2), and `pdf-output-reviewer` on the 4 customer PDFs. Zero cents↔dollars misclassification confirmed by every reviewer; 1924 tests green throughout. Audit trail: `docs/audits/2026-06-03-cleanup-money-touch-log.md`, `2026-06-04-codex-money-formatter-consolidation-prompt.md`, `2026-06-04-claude-disposition-of-codex-money-review.md`.
- **2026-05-30 (branch consolidation — pre-push reconciliation):** Merged the two diverged 2026-05-30 audit branches (`chore/add-review-workflows` + `fix/review-2026-05-30-p2p3`, forked at `449b20e`) into one branch via a real merge commit (`29db449`). statementPdf remittance-overflow conflict resolved to p2p3's hardened in-callee page-break (chore's redundant caller-side `addPage` dropped; chore's safer `pageH-170` threshold kept). Recovered the live-only `20260530192441_batch_rpc_idempotency_entity_type_fix` into a disk file (verbatim from live) so the disk migration version-list matched live exactly *for that sprint's window* (the 2026-06-10 ultra review quantified that GLOBAL parity does NOT hold for the pre-2026-05-26 era: 479 live versions vs 396 disk files, 411 live-only / 308 disk-only — B7-era ≥2026-05-26 parity is perfect; see H2 in `docs/audits/2026-06-10-foundation-ultra-review.md`). All 5 sprint migrations (121737/183926/191823/192441/194520) were **already applied live** — this consolidation is git-only (no DB apply). Build + 1924 tests green. **NOT pushed** (held for Codex review per Mason). The `process-blend-ticket` M3 OCR atomic-claim change is committed but **NOT deployed** — deploy via `/deploy-edge-function` with an OCR smoke test after Codex sign-off. Full handoff: `docs/audits/2026-05-30-pre-push-consolidation-handoff.md`. A 4-reviewer verification workflow confirmed the merge/recovery CLEAN (PDF, migration-drift, types) but re-confirmed **2 pre-existing HIGH actor-forgery findings** — forgeable `p_performed_by` (no `ACTOR_MISMATCH`) on `batch_apply_all_prepayments` + `batch_void_invoices` (audit-attribution-only; same class as the same-day `reverse_write_off` fix). These are already-live + p2p3-deferred, NOT consolidation defects; ready-to-paste remediation (canonical strict-actor block) is in the handoff §11, to ship as a **post-Codex follow-up `CREATE OR REPLACE` migration** (NOT applied this session). **Codex independent review (2026-05-31): verdict SHIP-WITH-FOLLOWUPS** — consolidation clean, both batch-RPC HIGHs re-confirmed against live. NOTE: the earlier claim that `allocate_payment` shared this flaw was a **FALSE POSITIVE** — Codex + a live re-check confirm `allocate_payment` already derives the actor from `auth.uid()` and rejects a mismatched `p_performed_by` (non-canonical error string), so it is NOT vulnerable. Verification + exact follow-up migration plan: `docs/audits/2026-05-31-codex-review-verification-and-followup.md`. **The strict-actor fix was APPLIED LIVE 2026-05-31** as `20260531151134_batch_rpc_strict_actor` (both reviewers clean; rolled-back smoke test: forged `p_performed_by` → `ACTOR_MISMATCH`; overloads=1 each; disk file renamed to the MCP stamp per B7). The consolidation was also pushed to `origin/main` (`0d82deb`→`6d8f57e`).
- **2026-05-30 (review P2 sprint — branch `fix/review-2026-05-30-p2p3`):** P2-H — `20260530194520_save_blend_ticket_canonical_return` aligned `save_blend_ticket`'s return from `{status:'saved'}` to the canonical `{success:true, ticket_id, ticket_number}`. Migration-only (sole caller `BlendTicketDetail.tsx` uses `assertRpcResult` generically — no field read). Body verbatim from live (md5-confirmed); both reviewers clean; live-verified (overload=1).
- **2026-05-30 (review P2 sprint — branch `fix/review-2026-05-30-p2p3`):** P2-3 — `20260530191823_batch_rpc_idempotency` added canonical check-at-top/save-at-end idempotency (via `check_idempotency`/`save_idempotency`) to `batch_apply_all_prepayments` + `batch_void_invoices` (the last two `IDEMPOTENCY_BODY_EXEMPT` `'gap'`s — now removed from the test). **Bundled bugfix (Mason-approved):** `batch_apply_all_prepayments` was silently broken in prod — it inserted `entity_id = NULL` into `financial_audit_log` (NOT NULL) so the "Apply all prepayments" button failed on every click (0 audit rows ever). Fixed to `entity_type='batch'`, `entity_id=v_actor`. A post-apply smoke test caught that an initial `entity_type='system'` violated the `financial_audit_log_entity_type_check`; re-applied with `'batch'` (live-only correction stamp `20260530192441`). Both reviewers clean; live-verified (overloads=1, idempotency wired, rolled-back insert confirms the audit row now succeeds). Deferred follow-up: both batch RPCs still use the permissive `COALESCE(p_performed_by, auth.uid())` actor (attribution-only, gated by `require_admin_or_sales_rep`) — candidate for a strict-actor pass.
- **2026-05-30 (review P2 sprint — branch `fix/review-2026-05-30-p2p3`):** P2-E — `20260530183926_returns_rpc_role_actor_guard` added the canonical auth + strict-actor (`AUTH_REQUIRED`/`ACTOR_MISMATCH`) + `role IN ('admin','sales_rep')` `is_active` gate (copied from `issue_return_credit`) to `approve_return` and `receive_return`, placed BEFORE the idempotency check so cached results never leak to unauthorized callers. Both were SECDEF-but-ungated (relied only on RLS; forgeable `p_approved_by`/`p_received_by`). Bodies reproduced verbatim from live (md5-confirmed body-minus-guard == live). Both reviewers clean; live-verified (overloads=1 each, guard present, service-role call → `AUTH_REQUIRED`).
- **2026-05-30 (review P2 sprint, applied live):** P2-D — `20260530121534_delivery_items_parent_lock_trigger` added a BEFORE INS/UPD/DEL trigger (`enforce_delivery_items_parent_lock`) on `delivery_items` rejecting writes when the parent `deliveries.status IN ('in_progress','completed')`, honoring the canonical `app.admin_override` hatch (`_is_admin_override()`). Closes the direct-PostgREST tamper path on locked-delivery items (UI was already safe via `edit_delivery`). Guard uses `IN ('in_progress','completed')` not literal `<> 'scheduled'` so `update_order_items`' legit DELETE of cancelled/voided delivery_items keeps working; only `complete_delivery` needed the hatch (reproduced verbatim from live — md5-confirmed — with one added `SET LOCAL app.admin_override` line). Both reviewers clean; live-verified (overload=1, trigger attached, rolled-back smoke test: completed write blocked, scheduled write allowed).
- **2026-05-30 (review fix-branch P1 sprint, applied live):** 3 P1 fixes applied via MCP from branch `fix/review-2026-05-29` (cherry-picked to main). (1) `20260530020412_reverse_write_off_strict_actor` — replaced forgeable `COALESCE(p_performed_by, auth.uid())` with the canonical strict-actor block (`AUTH_REQUIRED`/`ACTOR_MISMATCH` + `is_active` admin check); the one mutating-financial RPC missed by the 2026-05-26 sweep (verified forgeable live pre-apply, strict post-apply). (2) `20260530020452_save_job_idempotency` — `save_job` declared `p_idempotency_key` but never used it, so a double-click created two jobs; added canonical check-at-top/save-at-end idempotency. (3) `20260530020514_release_holds_on_quote_cancel` — cancelling a planned quote left its `inventory_holds` active forever; added `'cancelled'` to the release trigger's status sets. Both reviewers clean; all live-verified post-apply (overload counts=1, forgeable→fixed, body uses `idempotency_keys`, trigger includes cancelled). Non-DB in same sprint: unified 10 PDF modules' company address to single-source `src/lib/companyInfo.ts` (**West York, IL**; remit-to address flagged for Mason and CONFIRMED by him 2026-05-30 (`src/lib/companyInfo.ts:33-47` — 9100 E 2000th Ave, Annapolis, IL; ledger verified 2026-06-10)), hardened `rpcContracts.test.ts` to verify idempotency *body* usage (not just the param), `npm audit fix` cleared 3 prod CVEs (dompurify/ws/protocol-buffers-schema). See `docs/audits/2026-05-29-fix-branch-handoff.md`.
- **2026-05-29 (workflow review + Codex remediation, applied live):** 3 BLOCKER fixes applied via MCP. (1) `20260529214355_revoke_anon_execute_on_report_dashboard_secdef` — REVOKE EXECUTE FROM anon,PUBLIC on **37** SECDEF report/dashboard/geo/financial RPCs that were leaking customer PII/financials to the unauthenticated `anon` key (proven exploitable); re-GRANT to authenticated/service_role. anon-executable SECDEF dropped **89→52** (remaining 52 verified safe). (2) `20260529214538_fix_void_order_void_invoice_status_transitions` — `void_order` was crashing on every call (fulfilled→voided blocked by trigger, no `admin_override`); fixed with the override bracket + draft invoices→cancelled; `void_invoice` draft/unposted→cancelled. (3) `20260529214423_fix_get_customer_transaction_review_running_balance_cast` — fixed SQLSTATE 42804 (numeric→bigint window-sum cast). Both reviewers clean. Codex's 4th "BLOCKER" (`batch_void_invoices` actor-spoof) was **refuted on live** (vulnerable body is disk-only; deployed fn gates on `auth.uid()`). Deferred (documented in `docs/audits/2026-05-29-codex-disposition.md`): defense-in-depth internal role guards on the 37, `batch_void_invoices` disk-drift hardening, restore-RPC fix-or-drop, migration rebuild-fidelity shadow-DB diff.
- Edge Function live versions (verified 2026-06-10 via MCP): `create-user` v20, `send-email` v13, `setup-blend-tickets-storage` v15, `process-blend-ticket` **v20** (M3 OCR atomic-claim deployed 2026-06-10 — closes owner item L1; bundle verified ACTIVE with the claim + `already_processing` bail in the deployed source; logs clean; smoke test = next real ticket upload, watch `get_logs`), `reset-user-password` v12, `process-document` v13, `seed-admin` v15.
- 1,924 unit tests passing + 70 skipped (1,994 total across 130 files) + 94 E2E spec files, all passing
- Supabase performance advisor: 0 WARN findings (was 97). 72 FK indexes added, 23 permissive-policy overlap groups consolidated, 55 RLS policies rewrote `auth.uid()` as `(SELECT auth.uid())` for once-per-query evaluation.
- 0 ESLint errors, 0 TypeScript errors, CI green
- Pre-commit hook: lint + build + vitest
- All RPC data usage wrapped with `assertRpcResult()` — enforced by ESLint + safety-net test
- All destructive actions use `ConfirmModal` (no bare `confirm()` calls)
- 15+ RPC calls wired with `useIdempotencyKey` for double-submit prevention
- Schema-aware PreToolUse hooks block status-enum mismatches, GENERATED-column writes, missing RLS on new tables, and idempotency-key declarations that never get used
- `inventory_transactions` is fully immutable (UPDATE+DELETE blocked); `prepay_applications` blocks UPDATE only (DELETE allowed for `void_invoice` reversal). Bypass: `SET LOCAL app.bypass_ledger_immutability = 'true'`.
- `payments.order_id` is `ON DELETE RESTRICT` — orders with payments cannot be deleted (payments must be voided first; orders are cancelled/voided via state transitions anyway, never DELETEd).
- `parseDollarsToCents` is positive-only by default (strips sign). Use `parseDollarsToCentsSigned` for vendor-bill adjustment fields that legitimately accept negatives (3 callsites only).
- Audit fix sprint 2026-05-09 complete on `fix/audit-2026-05-09`. All Phase 1/2/3 + Decision-B + audit items closed. See `docs/audits/2026-05-13-pr59-codex-review-summary.md` for full disposition.
- **2026-05-13 codex review of PR #59 — all P1s closed, 11/13 P2s closed.** 10 follow-up migrations + 1 frontend refactor + 1 strict-actor hotfix landed; all applied live via Supabase MCP. The 4 changed Edge Functions (`create-user`, `reset-user-password`, `seed-admin`, `setup-blend-tickets-storage`) deployed to live via MCP with the `_shared/sentry.ts` audit #28 hardening.
- **2026-05-16:** `send-email` Edge Function deployed to v11 (PR-03 `farm_name` fix + WAL-pattern durable idempotency from ultra-review P2 #5); `setup-blend-tickets-storage` deployed to v14 (CORS hardening, ultra-review P3 #7). 3 new migrations: #335 (transfer_job_to_invoice canonical idempotency), #336 (notification RPCs idempotency), #337 (email_log.status += 'pending'). Ultra-review (`docs/reports/2026-05-16-ultra-code-review-findings.md`) — all 8 findings disposed: 7 fixed live, 1 (P2 #6 process-blend-ticket error checks) code committed but deploy pending. P1 #2 verified false positive. All 20 PR #59 codex threads now resolved. PR #60 advisory comment + follow-up posted: live state confirmed safe (drops were no-op or affected only Storage API list/download, not public-URL rendering).
- **2026-05-16 (PM):** All Edge Functions now deployed live — `process-blend-ticket` v17 deployed via MCP (47KB inline worked fine after using node-via-bash to JSON-encode the file content + reading it back through Read). All 10 ultra-review P2 #6 error checks verified in deployed bundle.
- **2026-05-26:** Full-codebase ultra review execution migration added (`20260526090000`): revokes anon/public write-oriented SECURITY DEFINER RPC execution, hardens `apply_write_off`/`issue_return_credit`/`void_order` actor checks, restores server-side commission split validation + reconciled rounding, consolidates `next_invoice_number`, adds idempotency to duplicate quote/follow-up delivery/finance charge generation, allows voiding unposted commission payments, and adds a DB signature guard for completed deliveries. Frontend/Edge fixes cover CSV formula injection, CustomerDetail RPC assertions, commission-payment void UI, offline complete-delivery idempotency reset, `reset-user-password` fail-loud CORS, and `create-user` phone-update error capture. **Applied live and verified 2026-05-29** via live SQL (apply_write_off has strict-actor guard, anon EXECUTE revoked on financial RPCs).
- **2026-05-27 (dummy-proofing wave 2):** Added 3 more hooks + activated 3 existing-but-unused plugins. New hooks: `migration-apply-guard.mjs` PreToolUse refuses Supabase `apply_migration` calls without a `.claude/session-state/migration-review-<name>.json` proof file from a recent (<30 min) subagent review; `session-staleness.mjs` SessionStart warns on stale schema-registry / CLAUDE.md count drift / uncommitted files from prior session; `stop-wrap.mjs` Stop hook blocks session end with loose-ends list (uncommitted files, unapplied migrations, undeployed Edge Functions, learning-capture prompt). `bash-safety.mjs` extended with 7 more patterns (`supabase db reset`, `dropdb`/`createdb`, force-delete main/master, `git push --mirror`, `git filter-branch`, broad `rm -rf /`, suspicious `npm run reset`). `/preflight` now also dispatches `pr-review-toolkit:code-reviewer` + `silent-failure-hunter` on TS changes and `type-design-analyzer` on new types in `src/types/index.ts`. CLAUDE.md skill table now wires PostHog session replay to "customer reported X" phrasing, `engineering:debug`/`incident-response`/`deploy-checklist`/`tech-debt` to natural triggers, and `feature-dev:code-explorer`/`code-architect` to architecture questions. **Updated totals: 8 PreToolUse hooks targeting code edits, 1 PreToolUse hook on MCP tools, 1 PreToolUse hook on Bash, 2 PostToolUse hooks, 1 UserPromptSubmit hook, 2 SessionStart hooks, 2 Stop hooks, 11 project skills, 4 project subagents + ~10 plugin agents now wired into preflight.**
- **2026-05-27 (dummy-proofing wave 1):** Claude Code automation expansion — added 4 subagents (`rls-security-reviewer`, `migration-drift-reviewer`, `typescript-types-drift-reviewer`, `pdf-output-reviewer`), 5 skills (`/deploy-edge-function`, `/codex-cross-review`, `/explain-migration`, `/spot-check-prod`, `/regen-schema-registry`), and 3 hooks (`env-guard.mjs` PreToolUse blocks `.env` edits + service_role literals in `src/`; `eslint-autofix.mjs` PostToolUse runs `eslint --fix` on TS edits; `dangerous-phrase-warning.mjs` UserPromptSubmit injects safety context on risky phrasing). Vercel plugin enabled. `/preflight` rewritten to auto-dispatch the 4 reviewer subagents based on what changed; `posttooluse-migration.mjs` extended to force subagent dispatch before suggesting `apply_migration`. The four subagents + UserPromptSubmit hook directly target the B7/B8/B9 + March-2026-40-bug + service_role-leak + customer-facing-PDF failure classes.
- **2026-05-26 (post-Codex audit, applied live):** Codex performed a post-apply review of commits `fce0629` + `a824952` and surfaced three blockers (B7/B8/B9) the parallel session missed. **B7** — Supabase MCP `apply_migration` stamped the live version `20260526151856` rather than the disk filename `20260526090000`; disk file renamed to match live to prevent future re-apply attempts (and the new B9 migration similarly renamed from `20260526170000` to its MCP-assigned `20260526201319`). **B8** — frontend Set-Password UI (`SettingsPage.tsx:393`) routes through `create-user?action=reset_password`, not `reset-user-password`, so the EDGE-2 `entity_recipient` block was dead code. Added the same guard to `create-user`'s reset branch, redeployed as **v20 ACTIVE**. **B9** — 6 SECURITY DEFINER DML helpers (`check_idempotency`, `check_rate_limit`, `check_remainder_reminders`, `cleanup_rate_limits`, `log_failed_notification`, `notify_damaged_receiving`) were still anon-EXECUTE-able. New migration `20260526201319_revoke_anon_on_secdef_dml_helpers.sql` revokes from `anon`/`authenticated`/`PUBLIC` and keeps `service_role`; legitimate SECDEF wrappers + pg_cron still call them as `postgres` owner. See `docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §11`.
- **2026-05-26 (parallel audit additions to migration `20260526151856`):** Three new blockers folded into the same migration after parallel-session reconciliation (`docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §10`): **B4** explicit `REVOKE EXECUTE … FROM anon` on `execute_sql_readonly(text)` (SECURITY DEFINER + arbitrary SELECT was an anon RLS-bypass; regex prefix `execute_` missed); **B5** same on `unapply_credit_memo(uuid,text,uuid,text)` (RLS-1 actor-forgery anti-pattern; regex prefix `unapply_` missed); **B6** `CREATE SEQUENCE IF NOT EXISTS public.cm_invoice_number_seq` (the historical migration creating it on disk was never applied live; verified via MCP `list_migrations`). Without B6, `next_invoice_number('credit_memo')` would have crashed on first credit-memo issuance. **C1** also folded — REVOKE regex extended with `auto|retry|revert` prefixes to sweep `auto_expire_quotes`, `retry_failed_notifications`, `revert_quote_status`. Verification `DO $$` block gained 3 assertions (sequence exists, B4/B5 anon revoke). **Applied live and verified 2026-05-29** (89 anon-executable SECDEF functions remain, all read-only — zero anon-callable mutators; cm_invoice_number_seq exists).
- **Pending Mason:** Phase 4 backup verification (Supabase dashboard — not exposed via MCP); Phase 4 restore drill (half-day operational exercise). _(#38 abandoned-package swap closed 2026-05-16: shapefile@0.6.6 → shpjs@6.2.0 + @mapbox/togeojson → @tmcw/togeojson@7.1.2 — see `src/lib/fieldImportParser.ts:1-17`.)_
- **Codex cross-review — 2026-06-08 merge conflict resolution — RESOLVED 2026-06-08:** `git pull` on `main` produced 7 conflicted files (10 regions) from overlap between local audit-fix work and origin's `lib/money.ts` consolidation. Codex returned **YELLOW** with 2 required adjustments (delete stale `formatCents` imports in ARaging+InvoiceDetail; **CORRECT**: take HEAD on ReceivingLog — Codex caught that "take origin" would drop the `fetchData()` call) + 1 NIT (migrate QuoteBuilder off `formatCents.ts`, delete the file). All applied in merge commit `8c18a0b` + follow-up cleanup commit. Disposition: `docs/audits/2026-06-08-claude-disposition-of-codex-merge-conflict-resolution.md`. `src/lib/formatCents.ts` deleted; all 31 remaining `formatCents` callsites now route through `src/lib/money.ts`.
- **Codex cross-review — 2026-06-08 daily batch — RESOLVED 2026-06-08:** Codex reviewed the batch (prompt `docs/audits/2026-06-08-codex-daily-batch-review-prompt.md`) → **NEEDS-WORK** (1 HIGH + 1 LOW + 1 NIT). All remediated live in `20260608193139_restore_rpcs_strict_actor` (+ test cleanup); see the Current State entry above and the disposition `docs/audits/2026-06-08-claude-disposition-of-codex-daily-batch.md`. Both flagged open questions (`restore_quote_version` idempotency operation-filter; dangling `record_payment` test refs) closed.
- **Deferred (follow-up sprint):**
  - Customer RLS upper bound (P2 #3) — intentionally left as lower-bound-only; farm logistics require future visibility for route/job planning.
  - Entity commission recipients — **RESOLVED 2026-05-16** (Option 1, migration `20260516090000`): non-loginable service profile rows with role `entity_recipient` created for CMCTW LLC + Crop Rx Solutions. 18 CMCTW commissions ($72,174.90) now payable; verified live 2026-05-25 (2 entity profiles, 18 linked commissions, only 1 NULL recipient which is a cancelled $0 row).

---

## Architecture Rules
1. **Database changes = migrations only** — files in `supabase/migrations/`, never modify tables directly
2. **All tables MUST have RLS policies** — no exceptions
3. **Use `checkMutationResult()`** after every `.update()` or `.delete()`
4. **Lazy-load all pages** — `lazy()` + `Suspense` in `App.tsx`
5. **Lucide React icons only** — no other icon packages
6. **Tailwind CSS only** — brand color `crx-green` (#28A26A)
7. **Types in `src/types/index.ts`** — all shared interfaces
8. **Single Supabase client** — `src/lib/db.ts` only
9. **Activity logging** — `logActivity({ event, description, performedBy, ... })` from `src/lib/activityLogger.ts` (typed object param, NOT positional)
10. **Idempotency** — `useIdempotencyKey()` hook for critical writes
11. **Local ESLint rules** — `eslint-local-rules/` enforces `assertRpcResult` usage and blocks direct `@sentry/react` imports

---

## Auto-Triggered Skills & Commands (MANDATORY)

Claude MUST automatically invoke the matching skill/command when the task matches — do NOT wait for the user to type the slash command. These exist in `.claude/skills/` and `.claude/commands/` and travel with the repo.

### Skills (multi-step guided workflows)
| When the task involves... | Auto-invoke |
|---------------------------|-------------|
| **Any substantive coding job done to completion** — "add/build/implement/fix/create X", a new feature, page, RPC, fix, or migration. **Mason will NOT type the command — default to this** and tell him in one line that you're running it through `/ship` (it wraps the scaffold skills below as its implement step, then runs the review gate + auto-fix + auto-apply, stopping only for Codex when worthy and the prod-push approval). Skip for trivial one-line tweaks or questions. | `/ship` |
| Adding a new page/screen to the app | `/new-page` |
| Creating a new RPC / database function / stored procedure | `/new-rpc` |
| Creating a new migration / table / column / index / RLS policy | `/create-migration` |
| Running a full health check, audit, or "is everything okay?" | `/audit` |
| Deploying, or "is this ready to ship?" | `/deploy-check` |
| Checking docs for drift or staleness | `/update-docs` |
| Deploying a Supabase Edge Function (live deploy of `send-email`, `create-user`, etc.) | `/deploy-edge-function` |
| Setting up a Codex cross-review for a finding, fix, or proposed change | `/codex-cross-review` |
| Translating a SQL migration into plain English before approving `apply_migration` | `/explain-migration` |
| Quick live production health check (Sentry + Supabase + Vercel + Edge Functions) | `/spot-check-prod` |
| Regenerating `.claude/schema-registry.json` after a status enum / generated column / table change | `/regen-schema-registry` |
| Checking whether the app drifted from the workflow map — "is everything still wired right?", "did anything drift?", "find missing/broken page↔RPC↔lifecycle connections" | `/map-drift-audit` |
| Stress-testing the architecture for FRAGILITY — "where are the weak spots?", "single points of failure?", "is this double-submit/race safe?", "what connections are missing for resilience?" | `/architecture-weakness-audit` |
| "How does X work?", "what's the architecture of Y?", "trace this flow" — codebase exploration | `feature-dev:code-explorer` |
| "I want to add X feature" — needs architecture design before coding | `feature-dev:code-architect` |
| "A customer reported X", "a customer can't Y", "something looks weird for user Z" | `posthog:investigating-replay` (pulls their actual session replay) |
| "Why is this failing in prod?", "I see an error" — production debugging | `engineering:debug` |
| "We had an incident" / "production is down" / "rollback X" | `engineering:incident-response` |
| "Are we ready to deploy?", "deploy checklist" | `engineering:deploy-checklist` |
| "Where are we slowing down?", "tech debt review" | `engineering:tech-debt` |
| Any new feature with non-trivial complexity (before writing code) | `superpowers:brainstorming` (MUST — required by my system) |

### Commands (quick one-shot checks)
| When the user says... | Auto-invoke |
|-----------------------|-------------|
| "commit this", "ready to commit", or before any git commit | `/preflight` |
| "what's the status", "where are we", "show me the state" | `/status` |
| "something's broken", "check for errors", "what's wrong" | `/quick-fix` |

**Rule:** If the user's request matches ANY row above, invoke the skill/command FIRST, then follow its steps. Do not freelance the workflow — the skill exists to prevent mistakes. Skills only guide the process — they still require user approval before any destructive or irreversible action (deploys, migrations, commits).

---

## Hard Red Lines — NEVER Break

### Data Safety
- NEVER delete/modify existing migration files — only add new ones
- NEVER remove RLS policies — every table must have RLS
- NEVER expose `service_role` key in frontend — anon key only
- NEVER modify `financial_audit_log` records — append-only
- NEVER store money as floating point — use `bigint` cents, display ÷ 100

### Business Logic
- NEVER skip delivery confirm→complete flow (scheduled → in_progress → completed)
- NEVER allow editing delivery items once delivery is in_progress or beyond — items are only editable while status = 'scheduled'
- NEVER create invoices without an order OR blend ticket — must have order_id or blend_ticket_id. (Enforced by **RPC convention, NOT a DB CHECK** — `invoices` has zero CHECK constraints. **Credit memos are exempt:** `issue_return_credit` inserts a `credit_memo` whose `order_id` may be NULL with no `blend_ticket_id`. Don't add a literal `order_id OR blend_ticket_id` CHECK without excluding `invoice_type='credit_memo'`, or credit memos break.)
- NEVER bypass `check_period_open()` — closed periods block backdated transactions
- NEVER allow non-admin access to month-end, commissions, or settings
- `/payments` (PaymentAllocation) is **sales+admin** — both roles can record check entries and allocate to invoices. Confirmed at `App.tsx:198`: `allowedRoles={['admin', 'sales_rep']}`. Do NOT lock this page to admin-only without a deliberate policy change. (Audit Q6, 2026-05-06.)
- Season = October 1 to September 30

### Code Quality
- NEVER remove pre-commit hook or commit with `--no-verify`
- NEVER add `@ts-ignore` or `any` (one exception: `reportPdf.ts` columnStyles)
- NEVER install other CSS/icon frameworks
- NEVER commit `.env` files

---

## Migration Safety Rules (CRITICAL — Prevents Code Drift)

These rules exist because **migration drift caused 40+ bugs** in March 2026.

### Before Writing ANY Migration
1. **CHECK constraints** — `SELECT conname, consrc FROM pg_constraint WHERE conrelid = 'table'::regclass AND contype = 'c';` — read existing values BEFORE rewriting
2. **Function overloads** — `SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'func_name';` — ensure only ONE overload exists
3. **Trigger functions** — Read the LATEST version in migrations before rewriting
4. **Status columns** — Check existing CHECK constraint values; your new list MUST include ALL old values plus any new ones

### When Writing Migrations
- NEVER use `pg_get_functiondef()` + regex to clone functions dynamically
- NEVER rewrite a CHECK constraint without including ALL existing allowed values
- NEVER `CREATE OR REPLACE FUNCTION` without checking for overloads first
- NEVER `DROP FUNCTION` without verifying the replacement exists
- Every `SECURITY DEFINER` function MUST have `SET search_path = public, pg_temp`
- Every RPC that mutates data MUST accept `p_idempotency_key text DEFAULT NULL`
- NEVER reference `idempotency_keys` columns as `key`, `entity_type`, `entity_id`, or `result_id` — correct columns are `idempotency_key`, `operation`, `result`

### After Writing Migrations
- Verify: `SELECT proname, count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace GROUP BY proname HAVING count(*) > 1;` — should return ZERO rows
- Run `npm run build` + `npm run test` before committing

---

## Business Logic Lifecycles

### Quote: `draft → sent ⇄ revised`; from sent/revised → `accepted` / `declined` / `expired`; `cancelled` from draft/sent/revised
- **Branching, not linear** — the old single-arrow chain was misleading: `declined`/`expired`/`cancelled` are **terminal**, and `accepted` can revert to `sent`. See the quote SVG in `docs/app-workflow-map.html` for the exact enforcer-allowed transitions.
- `is_planned` reserves inventory via holds (linked via `source_id`)
- Accepted quotes convert via `convert_quote_to_order()` — holds released
- **Partial draw-down (since `20260610145253`):** a `sent`/`revised` quote is an open booking — `draw_down_quote()` pulls any per-product portion into a new confirmed order at the quote's locked price, repeatedly; balances live in `quote_product_draws`; active holds decrement FIFO per draw (hold → prebooked, Net Free invariant); the final draw sets `accepted`. Whole-conversion on a partially-drawn quote is blocked (`BOOKING_PARTIALLY_DRAWN`)
- Declined/expired auto-release holds AND restore `quantity_available`

### Order: `confirmed → partially_fulfilled → fulfilled → cancelled → voided`
- AR derived from linked invoices (use `invoices.balance_cents` — `orders.total_paid`/`balance_due` columns were dropped)
- Commission records created per order per recipient

### Delivery: `scheduled → in_progress → completed → cancelled → voided`
- Two-step: `confirm_delivery()` then `complete_delivery()`
- Items editable while scheduled (add/remove/adjust qty); locked once in_progress or beyond
- Quick Delivery: `create_quick_delivery()` = atomic order + delivery + draft invoice

### Invoice: `draft → unposted → posted → paid → overdue → voided → cancelled`
- `post_invoice()` calls `check_period_open()` — rejects if period closed
- `balance_cents` = single source of truth for AR (GENERATED ALWAYS column)
- All changes logged to `financial_audit_log`

### Job: `scheduled → in_progress → completed → cancelled → invoiced`
### PO: `draft → submitted → partially_received → fully_received → cancelled`
### Return: `requested → {approved, rejected, cancelled}`; `approved → {received, cancelled}`; `received → credited` (credited/rejected/cancelled are terminal — branches, not a chain)
### Commission Payment: `unposted → posted → voided`

### Blend Ticket: 4 orthogonal status axes (not a single lifecycle)
- `status` (OCR pipeline): `pending → processing → completed → failed | needs_review` — set by `process-blend-ticket` Edge Function + `save_blend_ticket`
- `review_status`: `unreviewed → approved | rejected` — `batch_approve_blend_tickets` / `batch_reject_blend_tickets` / `reverse_blend_ticket_approval` (require `status='completed'` first)
- `payment_status`: `unbilled → billed | prepaid | no_charge` — `create_invoice_from_blend_ticket` / `sync_blend_ticket_payment_status`; the `trg_sync_blend_ticket_payment` trigger auto-resets `billed → unbilled` when the linked invoice is voided/cancelled
- `order_link_status`: `unlinked → linked` — `link_blend_ticket_to_order` / `create_order_from_blend_ticket` / `unlink_blend_ticket_from_order`

### Tier Pricing
- Customers: tier 1, 2, or 3. Products: tier1/2/3_price. Quotes inherit tier.

### Inventory
- **Net Free** = available − planned holds − prebooked
- **On Order** = sum(ordered − received) from open POs
- **Transaction types (12):** received, booked, delivered, returned, adjusted, transferred, job_applied, cancelled_delivery_reversal, void_delivery_reversal, prebooked, released, prebook_reconciliation (2026-06-10 — prebooked-only corrections; historical prebooked corrections were `adjusted` rows flagged in notes — see INVENTORY_RULES.md caveats)

### Commissions
- `commission_split` JSONB: `{ splits: [{ recipient, percentage }] }`
- `save_customer()` validates splits sum to 100%
- Per-order commission record status: `pending → paid → cancelled`

### Commission Payment (batch): `unposted → posted → voided`
- `commission_payments` table — a payout batch grouping multiple commission records for one recipient
- Created with `status = 'unposted'`; finalized to `posted`; reversible via `void_commission_payment()` → `voided`
- CHECK constraint: `status IN ('unposted', 'posted', 'voided')` (see `20260331120000_void_commission_payment.sql`)
- Distinct from the per-order `commissions.status` above

---

## Common Patterns

### Adding a page
1. Component in `src/pages/` → lazy import in `App.tsx` → Route → nav link in `AppLayout.tsx`

### Database column change
1. Migration in `supabase/migrations/` → update `src/types/index.ts` → update components → `npm run typecheck && npm run build`

### Supabase queries
```typescript
import { supabase, checkMutationResult } from '../lib/db';
const result = await supabase.from('table').update({ col: val }).eq('id', id).select();
checkMutationResult(result, 'Update context');
```

---

## Edge Functions (7 in `supabase/functions/`, + `_shared/` lib dir)
- **create-user** — Admin-only user creation
- **process-blend-ticket** — OCR via Google Vision AI
- **process-document** — Document processing
- **reset-user-password** — Admin-only password reset
- **seed-admin** — One-time admin setup
- **send-email** — Resend API, JWT auth, idempotency, PDF attachments
- **setup-blend-tickets-storage** — Storage bucket config

All require `ALLOWED_ORIGIN` env var for CORS.

---

## Codebase Knowledge Graph (Graphify)

A knowledge graph of `src/pages/` lives at `graphify-out/` (gitignored — generated locally).
- **View:** open `graphify-out/graph.html` in any browser
- **Query:** ask Claude "trace the invoice flow" or "what connects to Deliveries?" — I'll read `graphify-out/graph.json`
- **Update after adding/changing pages:** run via Bash: `python -m graphify src/pages --update`
- **Full rebuild:** `python -m graphify src/pages`
- **Work machine setup:** `pip install graphifyy && python -m graphify install` then rebuild
- **Note:** must run via Bash tool (not PowerShell) — graphify is in user site-packages only visible to Bash Python

## Key Entry Points
- `src/App.tsx` — Routes, auth provider, navigation tracking
- `src/contexts/AuthContext.tsx` — Auth state, Sentry user context
- `src/lib/db.ts` — Supabase client + `checkMutationResult()`
- `src/types/index.ts` — All TypeScript interfaces
- `src/lib/emailService.ts` — Email service (Resend via Edge Function)
- `supabase/migrations/` — Database migrations
- `supabase/functions/` — Edge Functions

---

## Schema Gotchas
- `profile_public_view` uses `security_invoker = off` (SECURITY DEFINER semantics) **by design** — exposes only non-PII profile columns (id, full_name, role, is_active) so non-admin UIs can display user names without leaking email/phone. Supabase security advisor flags this as ERROR; it is an accepted finding. Do NOT switch to `security_invoker = on` without auditing every UI that reads through this view. (Migration: `20260510070000_tighten_customer_profile_rls.sql`)
- The **52 anon-executable SECURITY DEFINER functions** the Supabase advisor flags (`Public Can Execute SECURITY DEFINER Function`) are **accepted/inert grant-debt, NOT a hole**: each self-gates on `auth.uid()`/`require_admin()` as its first executable statement (runtime-proven 2026-06-08 the `anon` role is rejected — e.g. `admin_update_profile`→"requires admin role", `get_ar_aging`→"Admin access required"), and the trigger functions in the set error on a direct call. Migration `20260529214355` revoked anon EXECUTE on the **37 report/dashboard** RPCs that were leaking PII; the remaining 52 are a *different* set whose real gate is the in-body check, not the EXECUTE grant. Revoking them is optional defense-in-depth (migration gate + `get_advisors` re-check). (2026-06-08 workflow review LOW #6.)
- `commissions.commission_amount` is `numeric` dollars (NOT `_cents bigint`)
- `returns`: `requested_by` (not `created_by`), status `'requested'` (not `'pending'`)
- `return_items`: references `order_item_id` only (not `delivery_item_id`)
- `invoice_items.extended_cents` (not `line_total_cents`)
- `create_direct_order` returns `{ order_id }` not `{ id }`
- `complete_delivery` requires `p_signed_by text`
- `orders.total_paid` / `orders.balance_due` — DROPPED (use `invoices.balance_cents`)

### Tables WITHOUT `updated_at` (DO NOT SET updated_at on these!)
These tables have NO `updated_at` column. Setting it in an UPDATE will crash the RPC:
`payments`, `write_offs`, `delivery_items`, `finance_charges`, `prepay_applications`,
`cycle_counts`, `cycle_count_items`, `financial_audit_log`,
`idempotency_keys`, `receiving_records`, `commission_payment_items`

**Rule:** ALWAYS check `information_schema.columns` before referencing `updated_at` in any UPDATE statement.

---

## E2E Testing
- Mega-workflow: `tests/e2e/mega-workflow.spec.ts` (95 serial steps)
- Use `page.once('dialog')` in serial suites (not `page.on`)
- Use `waitForLoadState('networkidle')` over `waitForTimeout()`

### E2E Test Data Protocol (MANDATORY)
- **ALL test-created entities MUST use `[E2E]` prefix** in their name — no exceptions
- **Reuse shared fixtures** from `tests/e2e/fixtures/e2e-constants.ts`:
  - Customers: `[E2E] Farm Alpha` (tier 1), `[E2E] Farm Beta` (tier 3)
  - Products: `[E2E] Herbicide Alpha`, `[E2E] Adjuvant Beta`, `[E2E] Fertilizer Gamma`
  - Vendor: `[E2E] Test Vendor`
- **If a test needs unique entities** (e.g., concurrency), use `${E2E_PREFIX} Desc-${runId()}`
- **NEVER create test entities without the `[E2E]` prefix** — they won't get cleaned up
- `globalSetup` creates shared fixtures before the suite, `globalTeardown` deletes ALL `[E2E]` data after
- Import from `tests/e2e/fixtures/e2e-constants.ts` — never hardcode test entity names

---

## Reference Docs (read when needed)

| Doc | Contents |
|-----|----------|
| `docs/reference/database-schema.md` | 95 tables + RLS matrix |
| `docs/reference/rpc-functions.md` | 218 RPCs + triggers |
| `docs/reference/migration-history.md` | 379 migrations |
| `docs/reference/pages-routes.md` | 66 pages with routes |
| `docs/reference/code-patterns.md` | Number formats, UI patterns, build notes |
| `docs/reference/qa-testing.md` | Role matrix, workflow tests, edge cases |
| `docs/CHANGELOG.md` | Sprint-by-sprint history |
| `TODO.md` | Current TODO/Done/Deferred status |

## Workflow Docs
- `SAFE_DEVELOPMENT_RULES.md` — **READ EVERY SESSION** — mandatory safety rules
- `DATABASE_CHANGE_CHECKLIST.md` — Step-by-step for schema changes
- `QUOTE_TO_DELIVERY.md` — Full business pipeline reference
- `INVENTORY_RULES.md` — Inventory calculations and transaction rules
- `RLS_SECURITY_GUIDE.md` — Row Level Security patterns
- `UI_PATTERNS.md` — Frontend patterns and conventions

---

## Documentation Maintenance Rules (MANDATORY)

Docs drift caused confusion and wasted time repeatedly. These rules prevent it.

### After EVERY Code Change Session
1. **Update `CLAUDE.md` Current State counts** — page count, migration count, RPC count, test counts
2. **Update `docs/reference/migration-history.md`** — add row for every new migration file created
3. **Update `docs/reference/pages-routes.md`** — add entry for every new page/route added
4. **Update `docs/reference/rpc-functions.md`** — add entry for every new RPC created or dropped
5. **Update `docs/reference/database-schema.md`** — add entry for every new table or significant column change
6. **Update `docs/CHANGELOG.md`** — add entry summarizing the work done in this session
7. **Update `docs/reference/qa-testing.md`** — if new E2E tests were added or test patterns changed

### When Writing Migrations
- Add the new migration to `docs/reference/migration-history.md` immediately
- If the migration creates a table → update `database-schema.md`
- If the migration creates/drops a function → update `rpc-functions.md`
- If the migration changes status enums or lifecycles → update `CLAUDE.md` Business Logic section

### When Adding Pages
- Add lazy import to `App.tsx` → update `pages-routes.md` → update page count in `CLAUDE.md`

### When Adding/Changing Business Logic
- Update the relevant lifecycle in `CLAUDE.md` Business Logic Lifecycles section
- Update `docs/workflows/QUOTE_TO_DELIVERY.md` if the quote→order→delivery→invoice pipeline changes
- Update `docs/workflows/INVENTORY_RULES.md` if inventory calculations change

### Verification
Before claiming work is done, verify:
```bash
# Quick doc-drift check
grep -c "lazy(" src/App.tsx                    # should match CLAUDE.md page count
ls supabase/migrations/*.sql | wc -l          # should match CLAUDE.md migration count
```

---

## Code Drift Prevention Rules (MANDATORY)

These rules exist because code drift caused 40+ bugs. Follow them to keep the codebase consistent.

### ⚠️ COPY-PASTE CHECKLIST — Read Before Writing ANY Code ⚠️

**Before writing a SQL function that touches `idempotency_keys`:**
PREFER the canonical `check_idempotency`/`save_idempotency` helpers (see
"Canonical Patterns for New RPCs" below). If you must inline, copy this
exactly — the lookup MUST be scoped to the function's own operation name
(an unscoped key-only lookup returns ANY operation's cached row on a key
collision — the restore_quote_version bug class; 22 live RPCs had to be
swept because this snippet used to omit the filter — 20 via the staged
`idempotency_operation_scope_sweep` migration, 2 via the planned-holds
drawn-sync rebuild):
```sql
-- CORRECT inline pattern — copy this exactly (v_existing is jsonb):
IF p_idempotency_key IS NOT NULL THEN
  SELECT result INTO v_existing
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key   -- NOT "key"
      AND operation = 'my_rpc_name';            -- ALWAYS scope to THIS function's name
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
END IF;

-- At end of function (result column is jsonb — NEVER a bare ::text value):
INSERT INTO idempotency_keys (idempotency_key, operation, result)  -- NOT key/entity_type/entity_id
VALUES (p_idempotency_key, 'my_rpc_name', jsonb_build_object('id', v_id));
```

**Before writing a SECURITY DEFINER function:**
```sql
SECURITY DEFINER
SET search_path = public, pg_temp   -- ALWAYS include pg_temp
```

**Before writing a supabase `.update()` or `.delete()`:**
```typescript
const result = await supabase.from('table').update({ col: val }).eq('id', id).select();
checkMutationResult(result, 'Context description');  // ALWAYS — import from lib/db
```

**Before writing a confirmation dialog:**
```typescript
// NEVER: confirm(), window.confirm(), alert(), window.alert()
// ALWAYS: ConfirmModal component — see existing usage in any page
```

**Before writing `logActivity()`:**
```typescript
// Uses object parameter — NOT positional args
// performedBy is ALWAYS profile.id — never a string like 'delivery'
await logActivity({ event: 'event_type', description: 'Description', performedBy: profile.id, entityType: 'entity_type', entityId: entityId });
```

**Before importing Sentry:**
```typescript
// NEVER: import * as Sentry from '@sentry/react'
// ALWAYS: import { Sentry } from '../lib/sentry'
```

### Naming & Convention Rules
- **Status enums** — ALWAYS check existing CHECK constraints before adding/modifying statuses. Your new list MUST be a superset of the old values.
- **Column names** — ALWAYS read the actual table schema before referencing columns in RPCs. Never assume column names from memory.
- **RPC signatures** — ALWAYS check for existing overloads before CREATE OR REPLACE. Run: `SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'func_name';`
- **Type definitions** — When adding new DB columns, ALWAYS update `src/types/index.ts` to match
- **idempotency_keys columns** — The table uses `idempotency_key` (NOT `key`), `operation` (NOT `entity_type`), `result` (NOT `result_id` or `entity_id`). Pre-commit hook validates this.

### Pattern Consistency Rules
- **New pages** MUST follow the existing pattern: lazy import → Route → nav link → page component with standard layout
- **New RPCs** MUST accept `p_idempotency_key text DEFAULT NULL` if they mutate data
- **New tables** MUST have RLS policies — no exceptions
- **New mutations** MUST use `checkMutationResult()` after `.update()` or `.delete()`
- **Money values** MUST use `bigint` cents — NEVER floating point
- **Activity logging** — call `logActivity(performedBy=profile.id)` for user-visible actions
- **Error handling** — use toast notifications, never `window.alert()` or `window.confirm()` (use `ConfirmModal`)
- **Sentry** — import `{ Sentry }` from `lib/sentry`, never directly from `@sentry/react`

### Canonical Patterns for New RPCs (MANDATORY going forward)

These patterns avoid the drift the 2026-05-07 final-wave-review surfaced (3 coexisting error-shape conventions, 2 idempotency patterns, fragile substring-matching of error tokens).

**Error tokens (machine-readable):**
- SQL raises `'TOKEN'` or `'TOKEN: human readable suffix'` — short SCREAMING_SNAKE codes, never freeform English-only messages.
- Register every new token in the `RpcErrorCodes` const in [src/lib/db.ts](src/lib/db.ts). The `as const` + `RpcErrorCode` indexed-access type makes typos at callsites a compile error.
- TS callers detect with `hasRpcCode(err, RpcErrorCodes.X)` — NEVER `message.includes('TOKEN')` (substring matching false-positives if the token text appears in a user-supplied note).

**Idempotency (helper-function pattern preferred):**
```sql
-- At top of body, BEFORE any mutation:
IF p_idempotency_key IS NOT NULL THEN
  v_existing := check_idempotency(p_idempotency_key, 'my_rpc_name');
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
END IF;

-- ... do the mutation ...

-- At end:
IF p_idempotency_key IS NOT NULL THEN
  PERFORM save_idempotency(p_idempotency_key, 'my_rpc_name', v_result);
END IF;
```
The `check_idempotency` / `save_idempotency` helpers (defined in `20260210000000_tier3_idempotency_and_triggers.sql`, both have `search_path = public, pg_temp`) are the canonical pattern. Inline raw-SQL idempotency lookups still exist in some 2026-05-07 migrations (`create_inventory_hold`, `mark_inventory_row_verified`) — those are NOT precedent for new code. When using helpers, add the file-level marker comment `-- idempotency-body-check: exempt` at the top so the schema-aware hook doesn't trip on the indirection.

**Strict-actor pattern (until shared helper exists):**
```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
```
Use `IS DISTINCT FROM` (handles NULL safely) and the machine-readable codes above. Two spellings of this block currently coexist in the codebase; this one is the canonical going-forward shape.

**Return shape (mutating RPCs):**
- Mutating RPCs SHOULD return `jsonb_build_object('success', true, ...payload)`.
- Idempotent no-op RPCs (e.g. "already verified") return `'success', true, 'no_op', true, 'reason', 'why'` so the UI can differentiate "did the work" from "didn't need to."
- TS callers MUST wrap result data with `assertRpcResult<T>(data, 'rpc_name')` (enforced by `local-rules/require-assert-rpc-result` ESLint rule).

### Automated Enforcement (Pre-Commit Hook)
The pre-commit hook runs these checks automatically — code that violates them CANNOT be committed:

1. **`scripts/validate-sql.sh`** — Blocks SQL with wrong idempotency columns, pg_get_functiondef, updated_at on wrong tables
2. **`scripts/validate-frontend.sh`** — Blocks frontend code with direct @sentry/react imports, warns on missing checkMutationResult
3. **ESLint rules** — `no-restricted-globals` blocks `confirm()` and `alert()`, `no-restricted-properties` blocks `window.confirm()` and `window.alert()`, `no-restricted-imports` blocks `@sentry/react`
4. **Build + test** — TypeScript check, production build, all unit tests

### Schema-Aware PreToolUse Hooks (`.claude/hooks/`)
These run when Claude Code tries to Write or Edit a file — they refuse the write if it violates a known bug pattern. They read `.claude/schema-registry.json` (regenerate via `node scripts/regenerate-schema-registry.mjs`).

| Hook | What it blocks | Bug it prevents |
|------|----------------|-----------------|
| `sql-safety.mjs` | `pg_get_functiondef`, wrong idempotency columns, `updated_at` on tables that lack it | March 2026 40-bug incident |
| `money-safety.mjs` | `parseFloat()` on `*_cents` variables | Float rounding in money math |
| `idempotency-body-check.mjs` | RPC declares `p_idempotency_key` but body doesn't read/write `idempotency_keys` | `9b36cd2` — `issue_return_credit` regression |
| `rls-on-new-tables.mjs` | New table without `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` | Prevents future RLS regressions |
| `status-enum-check.mjs` | Writing a status string that isn't in the DB CHECK constraint | `4a25aea` — `'void'` vs `'voided'` |
| `generated-column-check.mjs` | UPDATE on a GENERATED column (e.g. `invoices.balance_cents`) | `a419da8` — `reverse_write_off` |
| `env-guard.mjs` | Any write/edit of `.env*` files; hard-coded JWT-shaped literals or `service_role` references in `src/` | Service-role-key leakage into frontend / transcripts |
| `migration-apply-guard.mjs` | Supabase MCP `apply_migration` calls — refused unless `.claude/session-state/migration-review-<name>.json` proof exists from a recent (<30 min) `rls-security-reviewer` + `migration-drift-reviewer` run | B7/B8/B9 class — applying migrations without parallel-session review |

### UserPromptSubmit Hooks (`.claude/hooks/`)
These run when Mason submits a prompt, BEFORE Claude reads it. They inject extra context via `additionalContext` — they don't block — so Mason's intent is preserved while Claude is forced to slow down on risky wording.

| Hook | What it warns on | Why |
|------|------------------|-----|
| `dangerous-phrase-warning.mjs` | "drop/delete migration", "drop/truncate table", "force push", "no-verify", "service_role in frontend", "disable RLS", "rebase published", "auto-commit/push/deploy", "bypass check_period_open", "edit financial_audit_log" | Forces Claude to explain consequences + offer safer alternative + get explicit confirmation before acting on phrasing that has caused incidents |

### SessionStart Hooks (`.claude/hooks/`)
Run when a new session begins. Inject `additionalContext` so Claude sees state-drift warnings up front.

| Hook | What it surfaces |
|------|------------------|
| `session-snapshot.mjs` | Git porcelain snapshot (so Stop hook can tell session-scoped changes from prior WIP) |
| `session-staleness.mjs` | Schema registry >7 days old, CLAUDE.md count drift vs reality, uncommitted files from a prior session |

### Stop Hooks (`.claude/hooks/`)
Run when a session ends. Block until Claude addresses loose ends.

| Hook | What it surfaces |
|------|------------------|
| `stop-verify.mjs` | Code files changed this session — forces `npm run build` + `npm run test` before declaring done |
| `stop-wrap.mjs` | Uncommitted files, written-but-unapplied migrations, edited-but-undeployed Edge Functions, learning-capture prompt on substantive sessions |

### PostToolUse Hooks (`.claude/hooks/`)
These run AFTER a successful Write/Edit. They can't block (file is already written) but they surface issues back to Claude immediately.

| Hook | What it does | Why |
|------|--------------|-----|
| `posttooluse-migration.mjs` | Reminds Claude to update migration-history.md + regenerate schema registry after a migration edit | Prevents doc drift |
| `eslint-autofix.mjs` | Runs `npx eslint --fix` on edited `.ts`/`.tsx` files in `src/` (skips tests, migrations, edge functions) | Catches import-order/local-rules/lint issues at edit time instead of at pre-commit |

### Subagents (`.claude/agents/`)
Specialized reviewers invoked via the `Agent` tool. They run in their own context window and return only a summary — perfect for parallel review without polluting the main session.

| Agent | When to invoke | Bug class it prevents |
|-------|----------------|-----------------------|
| `rls-security-reviewer` | After writing any migration, BEFORE `apply_migration` | B7/B8/B9 (2026-05-26) — anon-EXECUTE-able SECDEF DML, missing `search_path`, missing RLS on new tables, actor-forgery anti-pattern |
| `migration-drift-reviewer` | After writing any migration that touches an existing table/function | March 2026 (40-bug incident) — CHECK-constraint regression, function-overload collision, column-name drift |
| `typescript-types-drift-reviewer` | After applying any migration that adds/changes columns; or sprint-cadence health check | Silent type drift between `src/types/index.ts` and live DB schema (code "works" until a real query hits a missing field) |
| `pdf-output-reviewer` | After editing any file under `src/` that imports `jspdf` / `jspdf-autotable` | Off-brand colors, page overflow, missing image assets, undivided cents in customer-facing PDFs (tank labels, invoices, statements) |
| `compliance-reviewer` | After editing `src/` or a migration — auto-dispatched by `/ship` and available to `/preflight` | CLAUDE.md red-line drift the other 4 don't cover — float money, missing `assertRpcResult` / `checkMutationResult`, `confirm()`/`alert()`, `@sentry/react` import, service_role in frontend, lifecycle violations |

**Rule:** Dispatch both subagents in parallel via a single message with two `Agent` tool calls. They are independent — running them sequentially is wasted time.

To exempt a specific file from a PreToolUse hook, add the marker comment named in the hook's error message.

**Full audit (manual):** `scripts/validate-sql-migrations.sh` — scans ALL migration files. Run with `--idempotency-only` for focused check.

**Refresh schema registry after schema changes:** `node scripts/regenerate-schema-registry.mjs` (or ask Claude Code to do it via Supabase MCP).

**Refresh AGENTS.md after CLAUDE.md changes:** `node scripts/regenerate-agents-md.mjs`.

**Refresh architecture map:** `npm run generate-map` (or `node scripts/generate-workflow-map.mjs`). Auto-runs in pre-commit hook and stages `docs/app-workflow-map.html` automatically.

### Before Every Commit
1. `npm run lint` — 0 errors (ESLint now blocks confirm/alert/wrong-imports)
2. `npm run build` — clean build
3. `npm run test` — all tests pass
4. Doc counts match reality (see Documentation Maintenance above)
5. SQL + frontend validation passes (automatic via pre-commit hook)
