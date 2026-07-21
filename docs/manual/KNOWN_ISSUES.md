# Known Issues — Consolidated

**Last verified: 2026-07-20** (full document re-read; live high-water `20260720225716`; the 24 previously missing live migration sources landed through PR #180, and broad delivery-signature Storage policies were replaced with delivery-bound active-actor read, write, and delete access while preserving one inaccessible historical orphan; older open/deferred claims retain their dated evidence below; owner-facing combined list: root `TODO.md`)
**Update triggers:** when a finding is parked/resolved, a migration is parked/applied, or an owner decision lands. Agents must update THIS file, not create new issue lists. Do not re-discover or re-fix something listed here as already known — read the pointer first.

This file consolidates (does not replace) the source documents it points to. If this file and a source disagree, trust the source and fix this file.

---

## 1. Open HIGH findings (dormant on live data)

### Supplier Pricing Phase 1a rollout gap — frontend/Edge retirement not deployed

The additive pricing RPC/bootstrap, zero-cost guard, legacy Product repeat-save compatibility repair, cent-scale correction, strict direct-write cutover, integrity rescan, and supplier-price evidence foundation are live through `20260718230000_supplier_price_evidence_phase1b`. The zero-cost guard's repository source is `20260717112011_supplier_pricing_zero_cost_guard.sql` and its live ledger identity is `20260717120500_supplier_pricing_zero_cost_guard`; the governed calculator rejects margin-driven zero cost. The earlier statement that `20260718124517_harden_supplier_pricing_cent_scale_and_trigger.sql` and the cutover were pending is resolved by the 2026-07-20 live migration-catalog check.

The remaining rollout gap is the production Edge Function: its deployment state was not inspected in this repository/database-only pass. Do not describe supplier-price OCR as retired live until that separately gated deployment is verified.

### July 14 full-gauntlet remediation — LIVE, frontend rolled out (PR #133 merged 2026-07-15)

The three reviewed migrations were applied live on 2026-07-15 and `process-blend-ticket` is v25 ACTIVE with JWT enforcement. The live schema registry, TypeScript types, and 393-name RPC snapshot were regenerated; the queued-RPC exceptions are gone. The post-apply business chain reached `SMOKE_PASS_ROLLBACK`, and all 17 database invariant sweeps have zero unallowlisted violations. **The frontend rollout landed via PR #133 ("Harden gauntlet money and blend workflows", merged 2026-07-15, commit `c4f7b4c5`) — the release path is complete.** What remains under this heading is owner-side data-cleanup decisions (the bullets below), not code.

- Migration `20260714230100` removed the legacy direct-insert path. Tabs still running the old bundle must refresh before another blend upload; tell office users to use the existing “A new version of the app is ready” prompt (or reload).
- **Owner decision — live-data cleanup:** eight empty unposted `SEED` commission batches ($1,500 headers), PO-2026-0008's stale fully-received status/open lines, PO-2026-0015's legacy receipt gap, one explicit E2E zero-item invoice, and five historical completed deliveries without items.
- Reconcile 18 negative inventory rows only from physical counts. Negative stock is intentional discrepancy evidence, not a value to zero-clamp.

The frontend/live-RPC fixture is regenerated and green; both `create_blend_ticket` and `commit_blend_ticket_ocr_result` are present live. Evidence: `docs/audits/gauntlet/2026-07-14-full-gauntlet-codex-only-remediation.md`.

Reload recovery for an uncertain manual/bulk blend-ticket create stores the exact user-scoped customer/header/product snapshot in per-tab `sessionStorage` for at most two hours. It contains ordinary business data, not credentials or service keys; known success/definite failure and closing the tab clear it. On a shared Windows/browser profile, close the CRX tab after use. This bounded retention is the deliberate tradeoff that prevents a network-uncertain retry from creating duplicate operational work.

**Correction to the working assumption going into this pass:** the 5 HIGH findings usually cited from the overnight bug hunt (commission-resurrection on cancel/void, prepay double-spend, blend-ticket over-reset, cross-customer prepay misapplication, field-app save desync) are **NOT open**. All 5 have applied-live fix migrations, confirmed both in `docs/audits/overnight-bug-hunt/LEDGER.json`'s own `appliedLive_2026_06_21` note and independently against live `schema_migrations` in this session. See §6 for the specific migrations. `docs/reference/gotchas.md`'s "Money-Integrity Invariants" section was re-verified against live function bodies and marked RESOLVED on 2026-07-13.

Genuinely still-open items from that same hunt (checked against `LEDGER.json`, none HIGH):

| Item | Severity | Status | Pointer |
|---|---|---|---|
| `forgeable-actor:transfer_job_to_invoice:unbound-performed_by` — `p_performed_by` not bound to `auth.uid()` on job→invoice transfer | MEDIUM (Codex split HIGH/MED, settled MEDIUM) | parked, no migration built | LEDGER.json line ~357 |
| `concurrency:save_field_app_invoice:no-row-lock` — group-edit branch read status without `FOR UPDATE` | MEDIUM | **RESOLVED** — `20260714224000_field_app_save_post_lock.sql` wraps `save_field_app_invoice` in `FOR UPDATE` row locks; applied live 2026-07-14, verified in the live function body 2026-07-16 | LEDGER.json line ~498 |
| `prepay:apply_remaining_prepayments:status-not-paid` | MEDIUM | moot while bulk-apply is hard-blocked (see §6) | LEDGER.json line ~566 |
| `commissions:commission_pay_picker:blank-order-customer` | MEDIUM | parked for review (frontend, money-domain) | LEDGER.json line ~833 |
| ~10 further LOW items (doc-count drift, dead-RPC retire candidates, audit-log completeness gaps) | LOW | parked | LEDGER.json `findings` array |

Two items the ledger flagged as **"top build priority" and Codex-rated HIGH-on-severity** turned out to already be fixed by later sessions — confirmed via migration files on disk: `reverse_blend_ticket_approval:billed-ticket-reopen-and-edit` → `20260622080000_blend_ticket_reopen_and_content_lock.sql`; `void_commission_payment:resurrect-cancelled-order` → `20260622070000_void_commission_payment_dead_order_guard.sql`. Both **confirmed applied live** (present by name in `supabase_migrations.schema_migrations`, checked 2026-07-13).

---

## 2. Parked migrations (written, not applied)

| File | Purpose | Why parked | What unblocks it |
|---|---|---|---|
| `docs/audits/nightly-debug/parked-migrations/PARKED-03-cancel-delivery-scheduled-quick-prebook-leak.md` | Release prebooked inventory when a scheduled quick-delivery is cancelled | — | **RESOLVED, applied live 2026-06-16** (`20260616151122_cancel_delivery_release_prebook_on_quick_cancel`). File header already says so — stale-looking filename, not a stale fix. |
| `docs/audits/nightly-debug/parked-migrations/PARKED-07-seed-admin-security-OWNER-ACTION.md` | Flagged `seed-admin` edge function as an unauthenticated admin-mint endpoint | — | **RESOLVED** — `seed-admin` no longer exists in `supabase/functions/` (confirmed on disk this pass; `docs/reference/gotchas.md` line ~118 notes it was deleted 2026-06-16 as a security cleanup). |
| `scripts/.staging-migrations/SUPERSEDED-20260611080937_idempotency_lookup_operation_scope_sweep.sql` | Idempotency lookup operation-scoping sweep | Filename says SUPERSEDED | Nothing — already replaced, safe to ignore/delete |
| `scripts/.staging-migrations/workflow-fix-parked/u12/*`, `.../u13/*` | Draft patches for Applicator "My Day" (U12) and dispatch-assignment unification (U13) | **Verified superseded and removed locally in this ticket.** `docs/loops/business-workflow-fix-ledger.md` confirms both U12 and U13 **SHIPPED LIVE 2026-07-06/07** under different migration names (`20260707010000`/`20260707011000` for U12, `20260707020000` for U13) — not the deleted draft filenames (`20260706060000`, `20260706100000`). | Do not re-apply the removed drafts. |
| `scripts/.staging-migrations/workflow-waves-parked/PARKED-dispatch-backfill.sql` | One-time backfill of `job_location_dispatches` for legacy-assigned open jobs | Business-data write, needs Mason's OK; also a **no-op today** (0 jobs match, verified live 2026-07-10) | Mason's explicit go-ahead; re-run the embedded count query first since it's a live-data-dependent no-op |
| `scripts/.staging-migrations/20260717121000_supplier_pricing_phase1a_cutover.sql` | Close direct Product pricing and cost-history writes after the governed RPC frontend is deployed | Applying it before frontend deployment breaks current Product-page pricing and prevents a safe frontend rollback | Additive bootstrap and zero-cost guard live and verified; RPC frontend deployed; rollback window closed or forward DB rollback ready; fresh apply approval/proof |
| `docs/roadmap/shelved-earmark-engine/*.sql` (3 files: `20260613240000`, `20260613250000`, `20260613280000`) | Booking-prepay "earmark" engine (reserve prepay credits for a specific future booking) | **SHELVED for a full redesign** (Mason's call, 2026-06-14) — the earmark engine assumes a single ledger-based spend path, but the legacy aggregate-spend path (`apply_remaining_prepayments`) bypasses it, causing double-spend + fund-diversion defects (Codex rounds 5-6). See README.md in that folder for the reserved-pool redesign sketch. | **DO NOT APPLY without a fresh architectural pass** — reserved-vs-spendable balance model, not a patch. |
| Per `.claude/commands/parked.md`: also check `node scripts/fleet-status.mjs` output and any `*draft*.sql` under `docs/audits/` for parked drafts in other worktrees | — | — | Not re-run in this pass (read-only doc consolidation, single worktree) — a future agent asked "what's parked" should run it fresh |

---

## 3. Pending owner decisions

From `docs/loops/owner-decisions-2026-07.md` (6 packets, live counts pulled 2026-07-02). **2026-07-16 in-chat outcomes:** packet 3 (junk deletes) — Mason keeps test entities for E2E/Playwright use, un-commingled: the two untagged test customers were renamed with the `[E2E]` prefix (live UPDATE, verified); true-junk deletes (8 gibberish `RTJ Recipe…` blend recipes, zero-link customer rows, vendor `we`, bad emails) remain PENDING explicit line-item approval. Packet 4 (due dates) — **DECIDED: Net 30 default + Net 15 / due-on-receipt / custom-date override**; approved build spec: `docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`. Packet 5 / finding #40 wire-vs-retire — **SETTLED: KEEP** (planned features; do not retire the orphaned RPC, CropPrograms pages, or per-acre tier columns). Packet 6 ("wire" payment method) — **RESOLVED, was stale**: migration `20260702152000_payment_method_wire.sql` is applied live; all four payment_method CHECK constraints already allow `'wire'` (verified live 2026-07-16). Remaining genuinely-open packets: 1 (vendor-name merges) and 2 (category remap).

1. **Vendor/manufacturer name merges** (e.g. "Van Diest" vs "Van Deist") — re-buckets AP spend/rebate history; needs Mason's call on which spelling is canonical.
2. **Category remap** of the 19 live `products.category` values into functional-class + use-timing — re-buckets historical sales reports on rename.
3. **Junk-data deletes** (8 fake blend recipes, 3 "Test Mfg" products, 3 "Test Vendor" products, 1 junk PO vendor, ~5 invalid customer emails) — recommendation is delete-all; needs Mason's approval since it's real-row deletion.
4. **Due-date/aging policy** — chemical-sale invoices get no `due_date` today, so the whole late-AR machine (overdue cron, finance charges, cockpit tile) protects nothing. Unblocks parked migration "A8". Recommendation: Net 30 default, age from `due_date`.
5. **Wire vs. retire** calls on 5 dead/half-wired structures (`ingredient_map` page, CropPrograms/ProgramTracker, per-acre tier price columns, several dead tables incl. a booby-trap legacy `payments` table, and the orphaned `get_customer_delivery_remainders` RPC).
6. **Confirm "wire" as an allowed payment method** — two UIs offer it but no live table's CHECK constraint allows it.

Plus, from the 121-finding business-workflow review (`docs/audits/business-workflow-review-2026-07/`):
- **#40** — `get_customer_delivery_remainders` RPC is orphaned (defined, secured, zero callers). Decision: retire or wire into a per-customer remainders card; see Packet 5 in `docs/loops/owner-decisions-2026-07.md`. No retirement migration is authorized by this cleanup.
- **#107** — Auto-draft-invoice-on-job-completion silently does nothing when an *applicator* (the normal completer) finishes a job — only admin/sales-rep completions trigger it, and unlike a failed draft it logs nothing. Must be decided **before** the (currently off) auto-draft switch is ever flipped on.
- Related open item from the same review (not owner-decision-gated, just unbuilt): **#117** (`auto_draft_skipped` activity-feed row) — confirmed 2026-07-16 that no `auto_draft_skipped` string exists in any migration. **Correction 2026-07-16:** #106 and #109, previously listed here as open, actually SHIPPED LIVE 2026-07-06 via `20260707050000_application_record_integrity` (live v20260706175157) — see `docs/loops/business-workflow-fix-ledger.md` Night-2 entry (N2-7) and `docs/reference/migration-history.md` row #639; moved to §6.

~~Migration-apply approval policy is written two ways~~ — **SETTLED by Mason 2026-07-13** as option (b) with a destructive carve-out: armed autopilot + the apply-guard proof gate suffices in a pre-authorized hands-free run; interactive sessions still ask in chat; data-deleting/dropping migrations are never autonomous. Canonical text: `docs/manual/DECISION_LOG.md` (2026-07-13 entry).

Also open: **Sprint D leftovers** (`docs/loops/workflow-waves-ledger.md`) — D1/D2 shipped live 2026-07-10, but D3 is parked in two owner-decision halves: (a) blend-ticket-path commission minting, deliberately dormant until blend billing is actually used; (b) `jobs.commission_split` visibility to assigned applicators — Mason needs to decide between an admin-only side table or RPC-gating.

---

## 4. Deferred/parked feature work

- **Per-line-item custom split billing (field-app)** — DESIGN SPEC complete + review-hardened, **not
  built**; Mason builds it in Codex next week (baseline real-billing cycle first). Default splits from
  field ownership, override %/price per line, one invoice per customer, unpost stays reversible. Three
  advisor passes folded in (gpt-5.6-terra design + xhigh plan-review, claude-fable-5 money-math). Spec:
  `docs/plans/per-line-item-split-billing-spec-2026-07-17.md`; direction settled in `DECISION_LOG.md`
  (2026-07-17). Supersedes the "four parallel split mechanisms need a decision" flag — decided: field-app
  path is the surface, order-side engine retired later.
- **EPA label backfill** — ~105 of 204 distinct stored EPA registration numbers point at the wrong product (confirmed, `docs/CHANGELOG.md` 2026-07-10 entry). The in-app `/label-data-quality` tool to fix them shipped 2026-07-10; the actual backfill (doing the data-entry) is still pending — it's a data-entry job, not a code task.
- **OCR REI/PHI auto-fill** — deliberately deferred as a safety trap (label OCR for re-entry-interval/pre-harvest-interval data needs human verification before it can be trusted for compliance).
- **Grower portal §7-§10** — deferred, internal-only direction for now. `docs/ROADMAP.md` line ~57 (A2, "Grower portal v1") and line ~112 (G9, portal MVP) both still say TODO/VISION.
- **Sprint D** — see §3 above (largely resolved; only the 2 D3 owner-decision halves remain).
- **U12/U13 "drafts parked outside repo"** — per session memory this phrase referred to scratchpad copies; the actual repo-tracked drafts in `scripts/.staging-migrations/workflow-fix-parked/` were verified as stale leftovers from an already-shipped feature and removed locally in this ticket (see §2). No live U12/U13 work remains open.
- **Credit-memo "Feature B" / residual-ledger design blocker** — **correction:** this is not part of the credit-memo-apply project (that one shipped, see §6). The residual-ledger design blocker belongs to the **billing-day-money-loop's Feature B** (per-delivery split invoicing for partially-delivered field/acre-allocated orders) — parked at a Codex design-review BLOCKER because naive per-delivery mirroring loses money via independent rounding. Handoff doc: `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md`. Until redesigned, partial allocated deliveries keep today's flag-and-manual-split behavior.
- **Sprint E dispatch backfill** — see §2 (parked, currently a no-op).
- **Blend-ticket commission mint** and **`jobs.commission_split` RLS visibility** — see §3, Sprint D D3.

---

## 4b. Guard-system hardening backlog (from the 2026-07-13 retirement audit; recommendations, not built)

The 2026-07-13 audit implemented the cheap hard-guard fixes (see CHANGELOG). These remaining items were adjudicated PARK — each needs either allowlist design or accepted-residual sign-off, not just code:

- **Proof-file self-attestation** — the migration-apply and Codex-push proof JSONs can be written by the same agent that should be gated by them; nothing binds the proof to an actual reviewer run. Partial raise-the-bar option: have the reviewer subagents write the proof themselves. Full closure impractical (accepted residual for a malicious agent; the fix targets honest confusion). The 2026-07-13 hands-free additions (content-bound `codex-review-mig-<name>.json` Codex proof, exact `queryHash` binding on both proofs, required `reviewers` array naming both reviewer subagents, and timestamp freshness bounded to [0, 30 min] so future-dated stamps fail) raise the honest-mistake bar further but remain self-attestable by a deliberately dishonest agent — same accepted residual. Likewise the destructive-SQL classifier is a lexical scanner, not a SQL parser: it is quote-aware and default-keep (five adversarial Codex rounds closed the comment/literal/dollar-quote hiding tricks), but a genuinely novel obfuscation could still slip it — the classifier's job is stopping honest mistakes, and its false positives merely park a migration for the morning.
- **New live-sweep predicates worth writing** (scripts/db-invariant-sweeps/): a `concurrency-hotspot` predicate asserting the named race-prone functions (inventory reservations, prebook, number sequences, balances) contain `FOR UPDATE`/advisory locks; an `audit-log-completeness` predicate asserting each allowlisted money-mutator RPC writes `financial_audit_log`; more `fin-*` arithmetic identities per derived-value family (order/quote `total_profit`, `net_margin_pct`, per-line commissions).
- **Write-time forgeable-actor hook** — a regex hook flagging new SECDEF functions with `p_performed_by`-style params lacking `ACTOR_MISMATCH` binding (today caught only post-write by live sweeps/reviewers).
- **Edge Functions are exempt from the assert/check ESLint rules** (Deno) and the coverage ratchet's scope leaves ~130 legacy Supabase reads unchecked — known accepted gaps.
- **Invoice-type leaks and direct-URL edit-lock bypasses** (lifecycle class) have no static guard — stays reviewer-checklist territory (`compliance-reviewer`).
- **Shell string-reconstruction bypasses** of the Bash regex guards (quote-splitting, variable substitution) — accepted residual under the honest-mistake threat model; keep widening regexes as concrete shapes appear.
- **worktree-awareness is a session-start snapshot** — no mid-session warning when a sibling merges or applies; accepted perf tradeoff, re-run `git worktree list`/`/fleet` before done-claims.
- **stop-verify PROOF matching is text-based**, not tool-call provenance — a fabricated PROOF line passes; hardening would require binding to transcript tool_use records.
- **npm `--prefix`/`--workspace` forms escape the script-body guard** (Codex round-5 P2, 2026-07-13) — `npm --prefix client run x` yields no script name to the bash-safety-lib extractor, so the resolved-body check silently skips. Correct handling needs value-taking-option parsing AND resolving the *other* package.json the option points at. Accepted residual: CRX is a single-package repo (these forms never occur here), and the guard's threat model is honest mistakes; revisit if the repo ever becomes a workspace/monorepo.
- **Gauntlet V2 Phase 2 remains intentionally open** — Phase 1 makes missing evidence loud but does not manufacture unavailable evidence. The page-render gate still has 44 reasoned, count-ratcheted skips; five E2E files still contain direct production endpoint literals (Playwright now blocks before setup) and additional auth-token storage keys are production-project-specific; staging Supabase/secrets do not exist yet, so E2E stays `if: false`; `db-sweeps:strict` still needs an authenticated execution path in CI; the live-schema suite remains trusted-run-only via `npm run test:schema-live` because ordinary GitHub Actions has no least-privilege credential (the production service-role key must not be added merely to make CI green); Sentry's 30-day collector remains `BLOCKED` by Unauthorized. None of these may be reported as clean until executed evidence exists.

---

## 5. Known technical debt / accepted quirks

- **Offline work recovery database foundation and browser rollout are live; phone/device E2E remains pending** — all four receipt migrations, including the corrective target-row lock, were applied and verified on 2026-07-14, and PR #124's browser rollout landed on `main` before the 2026-07-15 offline verification pass. Browser retention until proven success, distinct cap/backlog handling, a safe device review panel, audited office `already_completed` / `abandoned` resolution, and cross-tab replay protection are now in code. A saved action that lacks an original queue-time target snapshot is intentionally sent to office review rather than deriving a new baseline after reconnect; therefore snapshot conflict coverage is complete only for actions that captured the snapshot when queued. Still deferred: signature/photo persistence, idempotent email/notification replay, operation-specific conflict preconditions, automatic device discovery of an office resolution, and a general duplicate-action policy. Browser storage remains device-local until the phone reconnects and stages its permanent server receipt, so destroying or clearing that storage before reconnection can still lose work. Source: `docs/audits/2026-07-15-offline-stage1b-rollout-verification.md`, `docs/audits/2026-07-14-offline-receipt-browser-office-resolution-proof.md`, and `docs/roadmap/offline-work-stage1b-receipt-design-2026-07-13.md`.
- **Live `schema_migrations` having more entries than files on disk is OLD, pre-existing drift** — do not treat it as a new problem. Only reconcile migrations newer than the point where the current branch diverged from `origin/main`. (Session memory: `project_migration-disk-vs-live-drift`.)
- **Page-render tests pass in isolation but flake in the full `vitest` suite** — fix with `waitFor`/`findAllBy`, not synchronous `getBy`. See `docs/reference/gotchas.md` and session memory `project_page-test-fullsuite-flake`.
- **PWA (installed app) needs two reloads after a production deploy** to pick up a new service-worker chunk — expected behavior, not a bug to chase.
- **Prepay bulk-apply (`apply_remaining_prepayments` / `batch_apply_all_prepayments`) is hard-disabled in production** (`RAISE 'PREPAY_BULK_APPLY_DISABLED'`, migration `20260620200000`) rather than properly fixed — the real fix needs the shelved reserved-pool redesign (§2/§4). Per-invoice `apply_prepay_to_invoice` is unaffected.
- **`commission_payments.total_amount` is a legacy numeric-dollar column** — current posting compares the header and item totals directly in the same numeric-dollar unit; only `financial_audit_log.total_impact_cents` converts the posted total to cents. Converting historical payment headers/items safely is a dedicated money-schema migration, not part of the gauntlet cutover; do not casually retype it while re-emitting posting guards.
- See `docs/reference/gotchas.md` for the full list of non-obvious schema/RPC quirks (idempotency column names, generated columns, tables without `updated_at`, etc.) — this file does not duplicate that content.

---

## 6. Recently resolved (last ~30 days)

- **2026-07-17** — Money/inventory gauntlet sections 8-15 database remediation is live through `replay_bulk_po_same_request_result` (ledger `20260717032437`). PO numbering is atomic with insertion; active sales reps retain PO create/import/edit authority; vendor bills compare the authoritative line-rounded PO header; an admin-deleted imported PO clears its claim plus cached save results so the unchanged document can be imported again; and a same-key lost-response retry now replays the original `saved` result before different-request document deduplication. Both trusted migration reviewers returned CLEAN; stacked pre/post-apply rollback chains reached `SMOKE_PASS_ROLLBACK`; permanent checks found zero claims, stale save replays, fractional source costs, and PO header mismatches, with public/internal grants correct.
- **2026-07-15** — The 2026-07-14 workflow-review HIGH (deactivated admins retained commission-payout policy access) is closed: all 3 fix migrations applied live — names `20260714185129_fix_commission_admin_policies` / `20260714185130_gate_batch_prepay_admin` / `20260714185631_harden_is_admin_search_path`, re-stamped live versions `20260715134551` / `20260715134618` / `20260715134629`. Verified in live `schema_migrations` 2026-07-16 (match on name, not version — the standard drift gotcha). `migration-history.md` rows 690–692 corrected the same day.
- **2026-07-15/17** — Schema registry and generated TypeScript database types were regenerated from live introspection through high-water `20260717045420` (`bind_bulk_po_claim_to_vendor`). Roadmap tickets T1/N2 remain done.
- **2026-07-06** — Business-workflow findings **#106 + #109** (application-record date/license snapshots; invoice-side season stamping) shipped live via `20260707050000_application_record_integrity` (live v20260706175157). Recorded here 2026-07-16 after this file wrongly carried them as open.
- **2026-07-13** — Automated weekly in-database backup live (`20260713050000_weekly_db_backup.sql`, pg_cron) — snapshots all tables to `backup_snapshots` + a run log.
- **2026-07-12** — Money+Inventory night-hunt batch A-D applied live: `void_invoice` is_active + period guards (`20260712160000`), unbilled-delivery guard now ignores soft-deleted invoices (`20260712170000` + dashboard companion `20260712180000`), `create_order_from_blend_ticket` row-lock race fix (`20260712190000`), `void_payment` overpayment-credit full unwind (`20260712220000`).
- **2026-07-12** — Edge Functions CORS outage (all 7 functions unreachable) fixed and deployed (`66b91855`, later centralized in `1170c2dc`).
- **2026-07-11/12** — Credit-memo apply shipped (5 migrations + frontend, `20260711020000`-`20260711060000`).
- **2026-07-10/11** — ChemMan-parity loop: 10+ build units incl. CSB click-to-adopt USDA field boundaries, print-options dialog, map-based location picker, loader worksheets, field obstacles — all shipped live.
- **2026-07-10** — Business-workflow review finding **#105** (spray-job credit-exposure blind spot) fixed and applied live (`20260712130000` + frontend).
- **2026-07-10** — Label Data Quality screen (`/label-data-quality`) shipped — in-app EPA registration-number check + inline fix.
- **2026-06-21/22** — Overnight bug-hunt Run 1 + Run 2: all 5 originally-HIGH money-correctness findings (commission resurrection, prepay double-spend, blend over-reset, cross-customer prepay misapplication, field-app type-flip) fixed and applied live — see §1 correction above for citations.

---

## Sources this file consolidates (read these for detail, don't recreate their content here)

- `docs/audits/overnight-bug-hunt/LEDGER.json` — full finding-by-finding history
- `docs/reference/gotchas.md` — quirks and invariants (Money-Integrity table marked RESOLVED 2026-07-13)
- `docs/loops/owner-decisions-2026-07.md`, `docs/loops/workflow-waves-ledger.md`, `docs/loops/business-workflow-fix-ledger.md`
- `docs/audits/business-workflow-review-2026-07/findings.json` + `report.md`
- `docs/roadmap/shelved-earmark-engine/README.md`
- `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md`
- `docs/CHANGELOG.md`
- `.claude/commands/parked.md`
