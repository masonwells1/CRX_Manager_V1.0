# CRX Manager — Current State

**Last verified: 2026-08-31 for the repository's written-but-unapplied migration inventory; the
live-ledger facts below remain from the 2026-08-27 11:43:53 UTC read.** The current gauntlet repair
candidate adds six ordered, unapplied migrations (`20260831160000`, `20260831161000`,
`20260831162000`, `20260831212415`, `20260831233000`, and `20260831235900`). They must not be described as live until
the governed apply and postflight complete. The durable 2026-08-27 read-only capture records
**978 ledger rows**. The matching live-introspection registry records
`migrations_high_water` **`20260827113443`**, with
`20260826220000_quote_version_restore_trust_boundary` as the latest applied authored name; the
current effective ordering name high-water is therefore **`20260826220000`**. The same registry
records `quote_versions.restore_trusted_at`, so the quote-version trust migration is **applied
live** and its schema marker exists. This evidence does not include a fresh post-apply read of the
six routine bodies or their grants; the 2026-08-26 pre-apply fingerprint paragraph is superseded,
not promoted into post-apply proof.

The prior header readings are retained as provenance: 977 rows / `20260826205935` / authored
high-water `20260826150000` after the COMMENT-only apply, and before that 976 rows /
`20260825142708` / authored high-water `20260820120000`. They are historical and must not be used
as the current ordering boundary.

The PR #361 return-credit function/schema surface was also re-read from a fresh live schema dump on
2026-08-27. That separate read supports its candidate preconditions; it does not replace the newer
978-row ledger/schema capture above.

All four migrations of the draw-down chain are applied live: the cutover barrier (ledger version
`20260824185408`) and, later on 2026-08-24 with Mason's explicit in-chat approval, the tier split
(`20260825025241`), the allocated-line-cents lifecycle carry (`20260825033106`), and the receipt
intent binding (`20260825034622`). The authoritative rollout record — per-migration SHA-256 pins,
proofs, and postflight — is the block at the top of `docs/reference/migration-history.md`; the
matching issue entries are in `docs/manual/KNOWN_ISSUES.md`.

**The 976th row is not part of the draw-down chain.** `20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals`
(history row 891) applied live on 2026-08-25 as ledger version `20260825142708`, after the
draw-down rollout closed. Its full apply record — approval, proofs, postflight — is carried by
history row 891 and the `KNOWN_ISSUES.md` entry, both landed by PR #475 from the session that ran
it. This document states only the ledger fact and defers to those.

**The tracked registry is current through the last applied authored migration, not through local
candidates.** `.claude/schema-registry.json` was generated 2026-08-31 from the live-introspection
snapshot, records ledger high-water `20260827113443`, and includes authored migration
`20260826220000_quote_version_restore_trust_boundary`. It deliberately excludes the six gauntlet
candidates above because they are not applied; regenerate it only after the governed rollout.

**Booking draws are RESUMED** — Mason released the pause in chat on 2026-08-25. The decision, the
evidence it rests on, and what was explicitly *not* proven are recorded in
`docs/manual/DECISION_LOG.md` (2026-08-25 entry).

What was observed before the release: zero unexpired and zero unbound `draw_down_quote` receipts on
a read-only live postflight (2026-08-25); production root returning HTTP 200 (2026-08-25); and Mason
opening the production Quote Builder initial screen (`Q-2026-2062`) on 2026-08-25, which rendered
normally with no visible error and with no customer, item, preview, save, or submission made. That
last item is **reachability and UI-render evidence only — it is not a booking-draw transaction and
not an end-to-end draw allocation proof.** No end-to-end production draw has been observed since the
rollout; Mason resumed knowing that, and manufacturing the proof by submitting a real quote or order
was ruled out. Do not re-impose the pause on the strength of that gap alone — only on new evidence
of an actual defect.

**This pass re-read the ledger and the registry stamp only.** It does not re-certify any other
figure in this document; every section below keeps its own older date. In particular, any statement
below that migration `20260820120000` (history row 891, the `save_job` chemical-unit invariant) is
parked, written-but-not-applied, or awaiting approval is **superseded by the ledger read above** —
it applied live on 2026-08-25. Those older lines are left in place as provenance and were not
individually rewritten in this pass.

**OWNER DECISION 2026-08-31 — DEFERRED, DO NOT APPLY NOW.** Keep the six-file return-credit chain
`20260827041000` through `20260827041500` unapplied until Mason explicitly reopens its production
rollout in a future conversation. The source files remain unchanged under `supabase/migrations/`;
their presence in the repository is not authorization to apply them. A future rollout must rerun
the then-current safety gates. If a newer migration has overtaken these timestamps, restamp all six
above the current high-water, update every pinned chain reference/hash, and re-review the restamped
artifacts before pushing/applying them in order. The rejected `20260827223000` ledger-order trigger
is not part of this deferred queue.

**PR #361 return-credit candidate — not applied.** The candidate migrations
`20260827041000_align_recognized_invoice_report_statuses` and
`20260827041100_rebuild_return_credit_cogs_reversal`, plus the follow-up
`20260827041200_exclude_return_credits_from_delivery_invoice_gate` and the delivery-surface alignment
`20260827041300_align_return_credit_delivery_surfaces`, plus the order-level alignment
`20260827041400_align_return_credit_order_invoice_gates`, and the generated-invoice lineage/cutover finish
`20260827041500_preserve_generated_invoice_lineage_and_finish_cutover`, are absent from the live ledger. Production has
zero credited returns, zero returns linked to credit invoices, and zero recognized return-credit
memos, so the defect is real but latent. Current live return-credit issuance still creates a
header-only credit, while the P&L and monthly reports use different recognized invoice-status sets.
The first candidate aligns invoice-basis P&L, monthly, and customer year-end reporting on
`posted`/`overdue`/`paid` and restricts year-end customer financial data to admins or the assigned
sales rep, including through the batch wrapper.

The second candidate writes immutable credit cost-lot lines, bounds reversal to COGS previously
recognized from the source sale, serializes source/credit lifecycle changes, and protects normal
void, batch-void, and unapply cleanup. Per Mason's 2026-08-26 decision, an issued return credit uses
the season for the current America/Chicago business date so prior customer year-end summaries never restate. A late return can therefore
show negative product usage in the current season when the original purchase belongs to an earlier
season; that is the accepted simplicity tradeoff. A 2026-08-27 read-only production check found one
open restock row, exactly the pinned legacy `15 ea` RMA that converts to `37.5 Gal`, and zero unhandled
warehouse-unit mismatches. A fresh read-only live-schema clone in disposable PostgreSQL passed the
paid/overdue/posted multi-cost chain, current-season boundary, fractional-cent allocation, concurrency
and lifecycle mutants. The third candidate prevents the order-linked credit
memo from suppressing either a later delivery's automatic draft invoice or the manual recovery path
for a completed unbilled delivery. The fourth keeps the dashboard action queue and the void/cancel
warning paths on that same active-sales-invoice definition and makes the complete-delivery gate ignore
soft-deleted invoices. The fifth aligns both order-level invoice creators with that same active,
non-deleted, non-credit definition. The sixth preserves immutable source-line IDs and historical cost
when a generated invoice is edited, then removes the temporary cutover barrier only after postflight.
The latest recorded disposable-schema run counted 56 load-bearing predicates and ended in
`SMOKE_PASS_ROLLBACK` with zero residue,
including an ordinary non-credit invoice hard-delete proof so the new trigger cannot silently cancel
unrelated deletes and a real completion proof that preserves return-credit tote provenance.
Apply all six files in order only through the repository's guarded migration runner or the Supabase
migration operation, never through the ad-hoc SQL channel.
The sixth file closes the former Invoice Detail lineage prerequisite in `KNOWN_ISSUES.md`; merge still
does not activate any candidate migration, and live apply remains a separate explicit-approval gate.
After an approved live apply, regenerate the schema registry and Supabase-derived type artifacts from
live, then verify they contain nullable `invoice_items.return_credit_cogs_cents bigint` and
`invoice_items.return_credit_source_item_id uuid` before closeout.

**Superseded 2026-08-22 header, kept for provenance — was last verified 2026-08-22 UTC for the ledger only** — a read-only re-read returning 971 rows, high-water `20260816174353`, 345 of 971 names timestamp-prefixed, every figure **unchanged** from the previous pass; that pass also read the four live `job_chemicals` rows while measuring the blast radius of parked migration `20260820120000` (history row 891), which is written and proven but **not applied**. The `quote_versions` write surface, the return-idempotency helper contract, and the section 2 counts were last read live **2026-08-19 UTC** and are carried forward on that reading, not re-verified since. **The live ledger has 971 rows.** Its highest `version` is `20260816174353`, carrying submitted migration name `20260813080000_lock_quote_versions_writes_to_rpc`, which is also the highest *timestamp-prefixed* `name` — so both orderings agree on the same row. (Only **345** of the 971 ledger names carry a 14-digit timestamp prefix — 346 if the single 8-digit `20260207_gap_analysis_fixes.sql` is counted (the `.sql` suffix is
part of the stored ledger name); `docs/reference/migration-history.md` uses the 14-digit definition and this file now matches it. A plain `max(name)` returns the slug `year_end_summary`, so the ordering claim is about the prefixed subset.) That migration (**CRX-SEC-1**, history row 886) is the security fix that closes the client-writable path into `public.quote_versions`. Its apply *time* — 2026-08-16 17:43:53 UTC — is **read off the version stamp, not observed**: `supabase_migrations.schema_migrations` has no timestamp column (`version, statements, name, created_by, idempotency_key, rollback`), so the clock time is inference from Supabase's version-assignment convention, while the *fact* of the apply is the ledger row itself. Five documents were stale about it, in three different ways, and only **two** of them called it unapplied outright: history row 886 (`LOCAL CANDIDATE — NOT APPLIED`) and the RLS matrix in `docs/reference/database-schema.md` (`LOCAL ONLY pending apply`). The matrix in `docs/workflows/RLS_SECURITY_GUIDE.md` was stale a third way — it described the pre-fix write model with no pending marker at all, so nothing in it said "unapplied" to notice. This document and `KNOWN_ISSUES.md` were stale by omission, carrying no entry for the fix at all behind a ledger high-water nine applies out of date. (Each of those five statements is checkable against `origin/main` at `699f5c61`.) They were **not** found together, which is the point. A doc pass on 2026-08-18 found three (this document, `KNOWN_ISSUES.md`, history row 886); adversarial review then found a fourth (**the RLS Policy Matrix in `docs/reference/database-schema.md`**); CodeRabbit then found a fifth (**the matrix in `docs/workflows/RLS_SECURITY_GUIDE.md`**). Each pass corrected what it was pointed at and missed the next one, which is why the whole of both matrices was eventually reconciled in one sweep rather than row by row. All five are corrected in PR #420; this paragraph corrects this document. Post-apply live proof: `quote_versions` carries exactly one policy, `qversions_select`, and `has_table_privilege` for `authenticated` returns INSERT/UPDATE/DELETE **false**, SELECT true. Stated precisely, because an earlier draft of this line said "`authenticated` holds SELECT only" and that is **wrong**: `pg_class.relacl` is `{postgres=arwdDxtm/postgres,anon=m/postgres,authenticated=rm/postgres,service_role=arwdDxtm/postgres,metabase_ro=r/postgres}`, so `authenticated` holds SELECT **plus MAINTAIN** and `anon` holds **MAINTAIN** (not nothing). MAINTAIN carries no read or write of rows — it permits VACUUM/ANALYZE/CLUSTER/REINDEX/LOCK — and the migration retains it deliberately, so the security conclusion is unchanged; the earlier wording was wrong because it was taken from `information_schema.role_table_grants`, which does not report MAINTAIN at all. `metabase_ro` also holds SELECT but has no policy and does not bypass RLS, so it reads zero rows. The migration immediately before it, `20260813070000_pin_return_idempotency_helper_contract` (ledger `20260813011751`), is assertion-only — it changes no table, function body or business row — and its contract still holds live: `check_idempotency_intent` has exactly one public overload, is `postgres`-owned `SECURITY DEFINER` on `search_path=public, pg_temp`, with no anon/authenticated/service_role EXECUTE. `.claude/schema-registry.json` was regenerated from live introspection on 2026-08-16 and records `migrations_high_water` `20260816174353`, so the registry matches this ledger high-water and was **not** re-derived in this pass. The section 2 operational counts below were re-read live in this same session and are restamped. The date on them moved from 2026-08-18 to 2026-08-19 **without a second read**: it is the same moment relabelled from local time to UTC, which is the convention every stamp in this file uses and which section 2 was already using.

**Superseded 2026-08-17 header, kept for provenance — ledger re-read only.** The live ledger has **971 rows** and ends at **`20260816174353`**, carrying submitted migration name `20260813080000_lock_quote_versions_writes_to_rpc`. Nine migrations landed between the previous stamp and this one, applied by concurrent sessions: `20260812010000_blend_ticket_order_header_runtime_assert`, `20260812011000_restore_quote_version_whole_cent_money`, `20260812115235_snapshot_cost_reporting`, `20260812115236_quote_items_cost_at_quote_snapshot`, `20260812115237_enforce_below_cost_admin_approval`, `20260812115238_repair_historical_order_line_cents`, `20260812130145_bind_return_receipts_to_intent_and_restore_overdue`, `20260813070000_pin_return_idempotency_helper_contract`, `20260813080000_lock_quote_versions_writes_to_rpc`.

**Scope of this pass.** It re-read the live ledger only, to correct a high-water this document was stating wrongly. It did **not** re-verify the narrative below, and it did **not** refresh the schema registry — the registry is still stamped to the 962-row high-water and is now nine migrations behind. Treat every substantive claim in this document as carrying its own older date, not this one. The paragraph that follows is the 2026-08-12 evidence, retained verbatim. **Corrected by the 2026-08-19 read above:** the registry was regenerated from live introspection on 2026-08-16 and records the same `20260816174353` high-water, so it was not nine migrations behind.


**Superseded 2026-08-12 header, kept for provenance:** the ledger then had 962 rows and ended at `20260812003315`, carrying submitted migration name `20260811230423_log_customer_sales_rep_assignment`. It re-emits the approved Customer 360 assignment RPC to advance `customers.updated_at` and write one customer-scoped activity row in the same atomic transaction. Live catalog proof found one overload, `SECURITY DEFINER`, `search_path=public, pg_temp`, `postgres` ownership, no PUBLIC/anon EXECUTE, and authenticated/service access; the active-admin, target-lock, exact-set, audit-count, and payload-bound replay guards are present in the stored body. The schema registry was genuinely refreshed from all six live introspection queries through this 962-row high-water. No table, column, enum, generated column, function signature, or public-function-name count changed, so generated Supabase types and the 566-name `pg_proc` fixture remain structurally current and only their verification stamp advances. Team Board deployment details below remain current. (That paragraph's closing claim that the operational counts were a 2026-07-18 snapshot is superseded — see the 2026-08-18 header above and the restamped table in section 2.)

**Wave A — six migrations are PARKED DRAFTS (STAGED), NOT APPLIED.** As of PR #393 (2026-08-13) the six Wave A files live at `scripts/.staging-migrations/20260813010000`–`20260813060000` — moved **out** of `supabase/migrations/` so nothing can replay them. Their `20260813` stamps are **no longer forward of live**: live now carries ledger name stamps `20260813070000` and `20260813080000` (re-read 2026-08-18), both ahead of the whole parked `20260813010000`–`20260813060000` range, so the Phase 2 governed apply must restamp all six against the then-current high-water before applying (content is what the sha256 pins bind; the stamps are expected to change). They are **not applied**; no statement in this document describes state they created. Each is pinned byte-for-byte by a SQL sha256 in `docs/reference/migration-history.md` rows 872–877. They apply only through the Phase 2 governed apply pipeline with fresh proofs; the older `20260811…` copies on branch `claude/wave-a-money` are superseded.

**2026-08-10 live re-read, second read — the source gap it reported is now CLOSED.** That read recorded live ledger high-water **`20260810235207`**, **958 ledger rows / 951 distinct names**; an earlier read the same day, taken right after this session's three applies, showed `20260810155629` / 957 rows, a fourth migration having landed live from a concurrent session in between. Of the earlier `20260810` rows, `20260810000427` is the version Supabase assigned to merged file `20260809230500_single_canonical_line_profit.sql` (history row 862). That read also flagged two live rows as having no file in `origin/main`: `20260810025159_backfill_stale_line_profit` and `20260810235207` / name `20260810183629_reconcile_pending_commission_snapshots`, the latter having existed nowhere in git at all despite already having mutated real commission money — it was recovered byte-for-byte from `supabase_migrations.schema_migrations.statements` on 2026-08-10 (live md5 `b14d3dd7f8c5aa8fecd0549886d8bbb3`). **Both files are now present on `origin/main`, verified by `git ls-tree` on 2026-08-11**, so `supabase/migrations/` is once again a complete reconstruction source for that date. Full per-column conformance figures and the recovery detail are in `docs/manual/KNOWN_ISSUES.md` under the same date.

**2026-08-10 — three whole-cent migrations APPLIED LIVE.** History rows 868–870 (`20260810150000`, `20260810150500`, `20260810151000`) fix the commission-basis defect, round `quotes.total_cost` and the `quote_items` line money, and add whole-cent CHECK constraints to the 7 already-clean money columns. All three first executed end-to-end against a throwaway PostgreSQL 17 with every post-condition passing and mutation-tested to fail closed, then applied to live on Mason's explicit in-chat approval, in order, each behind its own freshly minted migration-apply-guard proof with both required reviewers clean. Supabase assigned ledger versions `20260810152935`, `20260810154721`, `20260810155629`. Post-apply live reads confirm the new function fingerprints and exactly 7 validated `*_whole_cents_chk` constraints, with the 5 deferred columns still unconstrained. (**Superseded as live state:** a read-only re-check on 2026-08-19 UTC  finds **8** validated `*_whole_cents_chk` constraints and **4** deferred columns. `20260812115238_repair_historical_order_line_cents` repaired `order_items.total_price` and constrained it on 2026-08-12. The corrected lists are in `docs/manual/DECISION_LOG.md`.) **No live row was modified.** The schema registry was then rebuilt from live introspection. This is also the disposition of CodeRabbit's "use bigint cents" Major finding on PR #354: closed **won't-fix with a hard guard substituted**, rationale in `docs/audits/2026-08-10-order-profit-bigint-cents-evaluation.md`.

**Team Board delegation — both migrations APPLIED LIVE 2026-08-09.** The database half of the delegation fix is fully live across two migrations: `20260809130108` added `complete_team_note`, which authorizes the creator, current assignee, or an active admin through an actor-bound idempotent SECURITY DEFINER path, plus the assignment trigger that creates `task_assigned` notifications while suppressing self-assignment and inactive recipients; `20260810010308` then closed the inactive-actor path found by review, requiring an active profile in both the `tnotes_insert` policy and the trigger itself while leaving `tnotes_update` unchanged. Live catalog/grant checks, all 26 standing invariant predicates, and a genuine schema-registry refresh passed for the first migration, and the second was verified live after apply (policy shape, SECURITY DEFINER, pinned search_path, trigger attached and enabled, anon/authenticated EXECUTE denied on the trigger function). Behavior was proven by rollback-only probes against live: an active non-admin assignee completed a note they did not create, an unrelated employee was refused, a real deactivated profile was refused at the RLS layer, and with RLS bypassed the trigger's own guard raised `PROFILE_INACTIVE`. The compatible frontend shipped in PR #351, **merged 2026-08-10 (merge commit `8dcb82fb`)**, and its production deployment is live — delegated completion is reachable from the browser. The registered rollback-only chain smoke remains pending external execution because the Codex production guard refuses its intentional transaction-local writes.

**2026-08-09 live re-read.** An earlier read the same day recorded live ledger high-water at **`20260809130108`** with 946 ledger rows — exactly one row above the 2026-08-07 high-water — and noted that migration as applied from a concurrent session with no file in this repository. PR #351 lands that file and its follow-up, so the gap is closed; see `docs/reference/migration-history.md` rows 863 and 864.

**2026-08-09 later the same day — the five foundation-ultra-review migrations are now APPLIED LIVE.** History rows 857–861, re-issued forward as `20260809170500`–`20260809170900`, applied one at a time between 20:32 and 20:54 UTC. Each went through its own freshly minted migration-apply-guard proof with both required reviewers clean, followed by a live post-apply read. Supabase assigned ledger versions `20260809203222`, `20260809204044`, `20260809204435`, `20260809204855`, `20260809205423` in file order, and the schema registry was regenerated from live introspection to match. None of the five altered a table, column, constraint, or enum — every schema-shape section of the registry came back byte-identical. `20260809170900` applied against a review finding that `docs/manual/KNOWN_ISSUES.md` had recorded as blocking; that entry now carries the full account and the decision still owed to Mason. The commented-out fractional-cent repair inside `20260809170800` was **not** run — the 49 pre-existing fractional rows are untouched.

**2026-08-11 post-deploy closeout, carried in from `origin/main`.** At that closeout read, the live ledger high-water was `20260810235207` (`20260810183629_reconcile_pending_commission_snapshots`, B7-renamed on disk to the assigned version), 958 ledger rows — the pending-commission-snapshot reconciliation that closed out the stale line-profit backfill. The header above supersedes those figures; they are kept here as the state that closeout observed. The prior high-water `20260810025159` (`20260810022500_backfill_stale_line_profit`) was the unrelated money-workstream migration that landed after the Team Board migrations. The database half of Team Board delegation is fully live: `20260809130108` added the actor-bound `complete_team_note` RPC and assignment-notification trigger, and `20260810010308` added the active-profile insert and trigger guards while leaving `tnotes_update` unchanged. Live catalog/grant checks passed, the full registered business chain reached exact `SMOKE_PASS_ROLLBACK`, and the schema registry was genuinely regenerated from live through the current high-water. The compatible frontend was carried by PR #351, **merged 2026-08-10 (merge commit `8dcb82fb`)**. Closeout PR #372 merged as `261d10bd` on 2026-08-11; its Vercel production deployment completed successfully, and `/team-board` returned HTTP 200 with the app shell. Operational counts below were then the separately dated 2026-07-18 snapshot; that is **superseded** — section 2 was re-read live and restamped 2026-08-18 (see the header above).

**2026-08-08 addendum (carried forward):** the money-loop correction below and the `payments` row in the counts table were re-verified live on 2026-08-08 and are dated inline. No other line in this document was re-checked on 2026-08-08.

**2026-08-07 verification detail:** (post-apply). Live ledger high-water was then `20260807220323` (`log_customer_fact_rpc`). The two 2026-08-07 parked migrations are now APPLIED LIVE: `20260807215532_profile_role_lock_covers_insert` (profiles role-lock trigger now BEFORE INSERT OR UPDATE, non-admin logged-in inserts blocked with PROFILE_INSERT_LOCK) and `20260807220323_log_customer_fact_rpc` (`log_customer_fact` live: anon denied, authenticated granted, single overload). The Section 4 bulk-order-import lifecycle hardening is live through seven migrations: imports are confirmed-only, inventory-aware, activity-logged, actor/payload-bound for replay, and commission-safe; every imported line uses one locked bigint-cent Product cost snapshot, retains whole-cent profit, and commission profit is reread from the trigger-canonical order header. Canonical pre-reservation Net Position shortages are returned to the browser and recorded in activity. Post-apply catalog/grant checks, rollback proof, all 21 standing invariant predicates, and a genuine live schema-registry refresh passed. The earlier idempotency, statement disclosure, and historical AR report protections remain live as documented below. Operational counts below were then the separately dated 2026-07-18 snapshot; that is **superseded** — section 2 was re-read live and restamped 2026-08-18 (see the header above).

**2026-08-09 ledger/count re-read:** the live ledger high-water and the entire section 2 counts table were re-read from the live database on 2026-08-09 and are dated inline. The 2026-08-07 feature/postflight detail below and the deployment log were **not** re-checked in that historical pass.

**2026-08-09 live re-read.** At the time of that read, live ledger high-water was **`20260809130108`** (`team_note_completion_rpc_and_assignment_notify`), 946 ledger rows — exactly one row above the 2026-08-07 high-water. Its disk migration and history entry are now reconciled on PR #351.

**2026-08-09 later the same day — the five foundation-ultra-review migrations are now APPLIED LIVE.** History rows 857–861, re-issued forward as `20260809170500`–`20260809170900`, applied one at a time between 20:32 and 20:54 UTC. Each went through its own freshly minted migration-apply-guard proof with both required reviewers clean, followed by a live post-apply read. Supabase assigned ledger versions `20260809203222`, `20260809204044`, `20260809204435`, `20260809204855`, `20260809205423` in file order, so **live high-water is now `20260809205423`** and the schema registry was regenerated from live introspection to match. None of the five altered a table, column, constraint, or enum — every schema-shape section of the registry came back byte-identical. `20260809170900` applied against a review finding that `docs/manual/KNOWN_ISSUES.md` had recorded as blocking; that entry now carries the full account and the decision still owed to Mason. The commented-out fractional-cent repair inside `20260809170800` was **not** run — the 49 pre-existing fractional rows are untouched.

**2026-08-07 verification detail:** (post-apply). Live ledger high-water was `20260807220323` (`log_customer_fact_rpc`) as of that date. The two 2026-08-07 parked migrations are now APPLIED LIVE: `20260807215532_profile_role_lock_covers_insert` (profiles role-lock trigger now BEFORE INSERT OR UPDATE, non-admin logged-in inserts blocked with PROFILE_INSERT_LOCK) and `20260807220323_log_customer_fact_rpc` (`log_customer_fact` live: anon denied, authenticated granted, single overload). The Section 4 bulk-order-import lifecycle hardening is live through seven migrations: imports are confirmed-only, inventory-aware, activity-logged, actor/payload-bound for replay, and commission-safe; every imported line uses one locked bigint-cent Product cost snapshot, retains whole-cent profit, and commission profit is reread from the trigger-canonical order header. Canonical pre-reservation Net Position shortages are returned to the browser and recorded in activity. Post-apply catalog/grant checks, rollback proof, all 21 standing invariant predicates, and a genuine live schema-registry refresh passed. The earlier idempotency, statement disclosure, and historical AR report protections remain live as documented below. Operational counts below were then the separately dated 2026-07-18 snapshot; that is **superseded** — section 2 was re-read live and restamped 2026-08-18 (see the header above).
**Update triggers:** refresh when a major feature ships or quarterly, whichever first.

**Quote/customer row-version rollout is live:** PR #290 deployed the compatible frontend first, then `20260730201230_quote_customer_row_version_guard` applied under Supabase-assigned ledger/disk version `20260730235031`. Live catalog, trigger, overload, ownership, fixed-search-path, grant, and child-table ACL checks passed. Four rollback-only behavior chains reached exact `SMOKE_PASS_ROLLBACK`, zero fixture rows remained, all 21 standing invariant predicates had zero unallowlisted findings, and the schema registry was refreshed through the subsequent AP high-water. Cached pre-migration bundles fail closed until refreshed; no rollout toggle is required.

## Recent production deployments

- **2026-08-11 verification (Team Board delegation fully live and deployed):** Team Board delegation is live across two migrations. `20260809130108_team_note_completion_rpc_and_assignment_notify` added the governed completion RPC — which admits the creator, current assignee, or an active admin — plus the assignment trigger that notifies active assignees and avoids self-notifications. Review then found the trigger lacked an active-actor gate, closed by `20260810010308_active_team_note_assignment_actor` (authored as `20260809154649`), which requires an active profile in both the `tnotes_insert` policy and the trigger itself. The full rollback-only chain passed against live with exact `SMOKE_PASS_ROLLBACK`, covering assignee completion, outsider and inactive-actor denials, replay/mismatch behavior, assignment notifications, and grants. The schema registry is refreshed through live high-water `20260810235207`. The UI caller and notification deep-link changes were carried by PR #351 (merge commit `8dcb82fb`), and closeout PR #372 merged as `261d10bd`; Vercel reported the production deployment successful and `/team-board` returned HTTP 200 with the app shell.

- **2026-08-05:** Section 4 bulk-order-import lifecycle hardening is live through `20260806023048_surface_bulk_import_inventory_warnings`. The import RPC creates confirmed orders only, reserves inventory through the normal prebook/ledger model, returns canonical Net Position warnings, records order activity, binds retries to the original actor/payload, rejects non-finite values, locks Product cost into one bigint-cent immutable snapshot, keeps line profit whole-cent, and creates commissions from trigger-canonical stored profit. Live catalog and grants, an active-sales-rep rollback smoke with false caller cost, fractional lines, changed-intent replay, and forced shortage, zero fixture residue, all 21 invariant predicates, and a genuine schema-registry refresh passed.

- **2026-07-30:** AP period-close boundary hardening is live via `20260731001654_ap_period_close_boundary_hardening`. `record_vendor_payment`, `void_vendor_payment`, and `void_vendor_bill` now serialize with close using the established date semantics. Authenticated users have SELECT-only access to `accounting_periods`; close/reopen remain the governed mutation path. Sol-high review, six concurrency schedules, live catalog proof, rollback smoke, and zero-remnant checks passed. This is AP-only; 26 other live period-check callers remain outside the protocol.

- **2026-07-30:** Quote and Customer optimistic concurrency is live via `20260730235031_quote_customer_row_version_guard` (submitted as `20260730201230`). Whole-record saves, version snapshots, restores, and conversion reject stale tokens under the parent lock; browser roles cannot write Quote/Customer child collections directly. Postflight catalog/ACL checks, four rollback-only behavior chains, zero-residue checks, and all 21 live invariant predicates passed.

- **2026-07-30:** Accounting-period close write serialization is live via `20260730114102_vendor_bill_period_close_lock`. The post-apply catalog, ACL, and whole-month-constraint checks passed; the rollback-only business chain reached its expected `SMOKE_PASS_ROLLBACK` terminal. Residual hardening remains: direct authenticated-admin writes to `accounting_periods`, existing vendor-bill completeness at close, and the broader non-vendor-bill writer race.

- **2026-07-30:** Same-key accounting-period-close defense-in-depth follow-up is live via `20260730124308_close_accounting_period_idempotency_recheck`. The post-month-lock recheck is structurally asserted; the current helper's first key-only transaction advisory lock supplies behavioral same-key serialization. Sol mutation testing removed the later block and the current behavioral proof still passed. Live catalog proof and fixed-date delivery rollback smoke passed. Independent all-20 sweep: 7 raw/7 allowlisted/0 new rows across 5 predicates.

- **2026-07-30:** Accounting-period date math is explicitly time-zone-independent via `20260730140808_accounting_period_immutable_date_math`. It changed no business rows; live proof found one validated two-cast constraint, 9 valid period rows, and the close RPC's owner/security/search-path/ACL/lock/replay contract intact.

- **2026-07-30:** Validation-only postflight `20260730174628_vendor_bill_month_lock_helper_acl_postflight` is live exactly once at the 930-row ledger high-water (authored as `20260730170743`, then B7-renamed). It adds no schema or business data: it verifies the month-lock helper is uniquely `postgres`-owned, SECURITY INVOKER, on `search_path=public, pg_temp`, and executable by `postgres` alone; API roles are denied. The three governed callers must be unique `postgres`-owned SECURITY DEFINER routines. The network-isolated replay now covers 12 pre-candidate migrations plus 4 candidates (16 total) and rejects temporary untrusted-owner and custom-EXECUTE-grantee mutations before clean replay.

- **2026-07-28:** `process-document` Edge Function deployed v20 → v21 from merged PR #268
  (`7c096444`). Re-verified live 2026-07-29 by read-only `list_edge_functions`: version **21**,
  status `ACTIVE`, `verify_jwt=true`, and the deployed bundle read back with
  `VISION_OCR_TOTAL_TIMEOUT_MS = 120_000` and a shared `AbortSignal.timeout`. The production **boot**
  path returned HTTP 200 for `https://croprxsolutions.app` — that is a reachability check only and
  says nothing about CORS, since no preflight was issued and no
  `Access-Control-Allow-*` response headers were captured. **The signed-in document-upload/OCR path still needs one real-app
  smoke test** — that is the outstanding item, not the deploy itself.

## 1. Reality check

CRX Manager is the live production operations app for Crop RX Solutions at
`https://croprxsolutions.app`. It is feature-rich — core sales/ops, sell-side quote
lifecycle, field mapping and per-acre billing, inventory reservations, credit
memos, commissions, and a driver-facing Field Mode are all shipped and live.
The business is **actively using it**, but operational data is still ramping up:
the database was near-empty on 2026-06-13, and by 2026-07-12 it held roughly
153 customers and 604 products. As of the 2026-08-09 live re-read those two
numbers are still unchanged, but **deliveries are flowing through the app**
(108 recorded) while the dead legacy `payments` table remains at zero — see the table below. Treat this
as a business in early adoption: operational usage is real, and the money loop
(invoice → post → payment) **has** completed one real cycle — see the correction
below.

> **Correction (2026-08-08 foundation ultra review):** the `payments` row count
> below is not evidence the money loop is unexercised. `payments` is a **dead
> legacy table** with zero writers; the live ledger is `allocation_sets` +
> `prepay_credits`. On 2026-07-17 a $6,800 check was recorded against the owner's
> own customer record — $5,020.40 allocated to invoice CS-2026-0094 and $1,779.60
> booked as prepay credit — and both halves reconcile exactly. Do not read
> `payments = 0` as missing money or as an unrun money loop.

## 2. Live operational snapshot

Read-only counts against the live database (project `rhyzpcqhnizqbxphqdkr`),
**re-read 2026-08-19 UTC** by direct read-only query (the previous stamp was
2026-08-09). These age immediately — re-run before relying on them.

| Table | Count | Notes |
|---|---|---|
| customers | 153 | unchanged since 2026-07-12 |
| products | 604 | unchanged since 2026-07-12 |
| fields | 5 | field mapping/per-acre billing shipped, but growers not yet loaded in bulk |
| quotes | 4 | unchanged |
| orders | 65 | was 64 on 2026-07-18; unchanged since 2026-08-09 |
| invoices | 15 | 9 draft / 2 posted / 1 paid / 2 overdue / 1 unposted — was 13 on 2026-08-09. Re-read 2026-08-19 UTC: one `posted` invoice became `overdue` since the 2026-08-18 read. That is the `mark-overdue-invoices` cron doing its job, not a doc error — and it is the clearest illustration of the "these age immediately" caveat above, since this row went stale inside one day. |
| payments | 0 | **dead legacy table, zero writers** — real payments live in `allocation_sets` (1) / `prepay_credits` (1), both unchanged |
| order_items | 288 | unchanged in count. **Sub-cent rows are now 0** — see the whole-cent note below |
| commissions | 35 | unchanged in count. **Sub-cent rows are now 0** — see the whole-cent note below |
| jobs | 4 | unchanged |
| deliveries | 108 | deliveries are the most-used transactional surface; unchanged since 2026-08-09 |
| blend_tickets | 0 | none recorded yet |
| quote_versions | 3 | append-only snapshots; writable only through the reviewed RPCs since `20260813080000` applied live 2026-08-16 |
| negative inventory | 19 rows | `inventory.quantity_available < 0` — owner re-base pending (unchanged since 2026-07-18) |
| backup_snapshots | 878 rows | cumulative across the weekly in-DB snapshot runs; was 723 on 2026-08-09 |

> **Whole-cent money re-measure, read-only live 2026-08-18 — the historical
> sub-cent debt is nearly cleared.** Counting rows where the stored `numeric`
> value differs from itself rounded to two decimals (all five columns below are
> `numeric` with `numeric_precision` and `numeric_scale` both NULL — genuinely
> unconstrained, so this test is real and not vacuously satisfied by a column
> scale): `order_items.total_price` **0**, `order_items.profit` **0**,
> `commissions.commission_amount` **0**, `commissions.order_profit` **0**. Only
> `quotes.total_cost` still holds **2** sub-cent rows. This supersedes the
> 2026-08-10 figures still quoted in `docs/manual/KNOWN_ISSUES.md`
> (35 `order_items.total_price` + 2 `quotes.total_cost` + 3 + 3 `commissions`
> = 43 dirty **column-values**, summed across four columns rather than four
> disjoint row sets — the two `commissions` counts are 3/35 each and may be the
> same 3 rows, so distinct dirty rows were 40–43) and the older 46 + 3 = 49
> figure, which is a column-value sum in the same way. Note which term survived:
> the 2 `quotes.total_cost` rows are exactly the ones that did **not** clear.
>
> **Two of these zeros are enforced; two are only measured.** `order_items`
> carries validated whole-cent CHECK constraints on both columns
> (`order_items_total_price_whole_cents_chk`, `order_items_profit_whole_cents_chk`,
> both `convalidated = true`), so those zeros cannot regress. `commissions` has
> **no** whole-cent constraint on either `commission_amount` or `order_profit`
> — its only money CHECK is `chk_commission_amount (commission_amount >= 0)` —
> and `quotes` has whole-cent CHECKs on `total_price`/`total_profit` but **none
> on `total_cost`**. So the commission zeros are today's measurement, not an
> invariant, and nothing stops a future write from reintroducing sub-cent values
> there. **What cleared the commission rows is established:**
> `reconcile_pending_commission_snapshots` (ledger version `20260810235207`,
> applied live 2026-08-10 with Mason's approval) rounded `order_profit` to whole
> cents and recomputed `commission_amount` across exactly 11 pending rows. A first
> draft of this paragraph named `20260812115238_repair_historical_order_line_cents`
> as the only money-moving migration in the window and called the commission change
> unexplained; both were wrong, and the retraction with the full attribution is in
> `docs/manual/KNOWN_ISSUES.md`. `20260812115238` did move money — it rewrote order
> lines, and the canonical `trg_recalc_order_totals` trigger refreshed the order
> headers with them — but it never touches `commissions` directly.

> **Correction:** the 2026-07-13 snapshot reported jobs = 104 and deliveries = 0;
> the 2026-07-16 live read shows jobs = 4 and deliveries = 106. The two columns
> appear to have been transposed in the earlier snapshot (or usage shifted
> job→delivery in between) — trust the fresher numbers.

Note: `payments` and `blend_tickets` reading zero does not mean those features
are broken — it means the business hasn't routed real transactions through
those paths yet. Verify against code/tests, not against these counts, before
concluding a feature is unused or unbuilt.

## 3. Shipped feature map

Grouped, one-liner summary of what is LIVE in production today (see
`docs/CHANGELOG.md` for the dated entries these summarize):

- **Core ops:** customers, products, quotes, orders, invoices, payments, and
  accounts-payable (vendor bills/payments, purchase orders/receiving).
- **Supplier pricing:** quick Product-page edits and monthly XLSX batches both
  use preview, explicit approval, atomic governed apply, and one database
  history writer; supplier PDF price-list OCR is permanently retired.
- **CRM relationship intelligence (2026-07-17):** contacts + call logging,
  grower knowledge (facts w/ review queue) + call prep card, seasonal call
  lists (`/call-lists`), per-customer documents — built AI-receptionist-ready
  (Phase 5 seams recorded in the loop ledger).
- **Sell-side quote lifecycle:** quote builder, versions, templates, PDF
  quotes, convert-to-order.
- **Field invoices + as-applied billing:** field-level invoicing reconciled
  against unbilled deliveries, editable invoice editor.
- **Field mapping:** draw-your-own boundaries, shapefile import, USDA CSB
  (Crop Sequence Boundaries) click-to-adopt from the satellite map, two-acre
  model (full vs. edited acreage).
- **Per-acre billing + splits:** order/invoice-level field and acre
  allocations, multi-owner split invoicing, auto-split drafts on full
  delivery.
- **Inventory:** Layer 1 read-only shortfall warnings on scheduling; Layer 2
  job-level inventory reservations.
- **Credit-memo apply:** ledgered credit-memo application against invoice
  balances with reversal support.
- **Commissions:** job-level commission calculation and payment tracking.
- **Batch posting:** bulk invoice posting with posting-policy alignment
  across all posting surfaces.
- **Today dashboard + workflow waves:** Office Cockpit single morning screen
  (queues, KPIs, inventory), consolidated tabbed pages (field invoices,
  receiving, prepay, integrity).
- **Field Mode:** `/my-route` driver workspace for applicators/drivers.
- **EPA label lookup + data quality:** Wave 1 per-product "Look up EPA"
  lookup, admin `/label-data-quality` bulk EPA registration-number
  check-and-fix tool.
- **Lot capture/trace:** lot numbers captured and traceable through the
  chemical supply chain.
- **PDF outputs:** invoices, statements, quotes, and delivery slips.
- **Backups:** automated weekly in-database snapshot (pg_cron) plus a
  separate off-site weekly GitHub Action backup.
- **Morning cron reports** and **PWA/mobile overhaul** (bottom nav, phone
  card layouts, full-screen mobile modals).

## 4. What is NOT live

See `docs/manual/KNOWN_ISSUES.md` for the full parked/deferred/shelved list.
The three headline items:

- **Grower portal** — deferred (no customer-facing self-service portal yet).
- **Earmark engine** (prepay reserved-pool billing) — shelved, needs a
  reserved-pool redesign before it can be revisited.
- **OCR REI/PHI extraction** (re-entry interval / pre-harvest interval from
  label images) — deferred; flagged as a safety trap if done carelessly.

## 5. Environment facts

- **Production URL:** `https://croprxsolutions.app`
- **Supabase project:** `rhyzpcqhnizqbxphqdkr`
- **Deploy model:** a **merge to `main`** deploys production on Vercel
  automatically — there is no separate deploy step. Since the `protect-main`
  ruleset landed (2026-07-14) nobody can push to `main` directly, so landing
  work means: push a branch, open a PR, let the checks pass, read and resolve
  CodeRabbit's review, then merge. The merge is the deploy.
- **Supabase plan:** FREE — no point-in-time recovery (PITR). The weekly
  in-database backup plus the off-site weekly GitHub Action dump are the
  only recovery mechanisms.
- **Time zone:** the live database and its scheduled jobs (pg_cron) run in
  UTC. Business hours are America/Chicago — convert explicitly when
  reasoning about "today" or cron timing.
- **Error monitoring:** Sentry, wired only through `src/lib/sentry` (never
  import the Sentry SDK directly elsewhere).
