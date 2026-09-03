# Known Issues — Consolidated

**Last verified: 2026-09-01 for migration-ledger facts.** A read-only capture records **980 ledger rows**
and effective ordering high-water **`20260826222000`** (authored name
`20260826222000_correct_ap_aging_due_date_buckets`). The two Section 9 AP migrations
`20260826221000_bind_section9_ap_receiving_intent_and_month_dashboard` and
`20260826222000_correct_ap_aging_due_date_buckets` were applied live on 2026-09-01 under Mason's explicit
in-chat approval, through the full apply gate (ordering, destructive-content, reviewer proof and Codex
gate) — verified post-apply against the live catalog: exactly one `get_ap_aging` overload, `days_1_30`
present, buckets keyed on `due_date`, `SECURITY DEFINER` with `search_path=public, pg_temp` intact.
The earlier 976-, 977- and 978-row readings are superseded, and so is the `max(version)` that came with
them: the 978-row capture recorded `migrations_high_water` `20260827113443`, but after the two 2026-09-01
applies the live `max(version)` is **`20260901045346`**. `20260827113443` is history, not the current
maximum. The 978-row capture also recorded `quote_versions.restore_trusted_at`. Read ordering from the
authored NAME, never from `version` — the two diverge, which is why searching the ledger by version stamp
finds neither Section 9 migration even though both are applied. This pass does not re-certify every issue
narrative below or claim a fresh post-apply read of function bodies, grants, or operational counts.
The PR #361 function/schema surface was separately refreshed from a live schema dump on 2026-08-27;
that evidence supports the six pending return-credit candidates without superseding the newer ledger
capture above.
All four migrations
of the draw-down chain are applied live — the cutover barrier (2026-08-24 midday, version
`20260824185408`) and, later that day with Mason's explicit in-chat approval, the tier split
(`20260825025241`), the allocated-line-cents lifecycle carry (`20260825033106`), and the receipt
intent binding (`20260825034622`). See the rollout block at the top of
`docs/reference/migration-history.md`. This pass re-read the ledger and updated the draw-down
entries only; it does not re-certify unrelated issue narratives below.

**Section 9: RESOLVED — both migrations applied live 2026-09-01. Do not plan a rollout from this
entry.** The pre-apply narrative that stood here is superseded in full and is summarised below only so
the change of state is legible; nothing in it describes production any more.

Post-apply catalog read, 2026-09-01: `get_ap_aging` has exactly **one** overload taking `p_as_of_date`
and returns the five-bucket due-date contract (`current_amount`, `days_1_30`, `days_31_60`,
`days_61_90`, `over_90`, plus `total_outstanding`/`bill_count`), `SECURITY DEFINER` with
`search_path=public, pg_temp` intact; `get_ap_dashboard_summary` takes `p_idempotency_key` and its body
keys on `due_date` rather than a rolling 30-day window. The ledger shows **980 rows** with
`20260826221000_bind_section9_ap_receiving_intent_and_month_dashboard` and
`20260826222000_correct_ap_aging_due_date_buckets` as the two newest entries.

**Superseded (2026-08-26/08-31 state, retained for history only):** the three Section 9 HIGH findings
were then live production risks — `get_ap_aging(date)` used `bill_date` with no `1-30` column,
`get_ap_dashboard_summary()` used a rolling 30-day window, and the AP/receiving mutators were not yet
wrapped by the exact-intent contract. That read also found zero active unbound receipts across those six
operations, and recorded 978 ledger rows with ordering high-water `20260826220000`. **Those figures and
the "re-read the ledger before any apply" instruction no longer apply — the apply has happened.** No
unrelated issue entry was re-read; its own dated evidence remains authoritative.

**RESOLVED 2026-09-01 — return credits now reverse COGS; the PR 361 rebuild is applied live.**
`_issue_return_credit_impl` builds negative credit-memo lines carrying `invoice_items.cost_cents`
against the recognized source lots, and invoice-basis PNL and monthly reporting both recognize
`posted`, `overdue`, and `paid`. Production had zero credited returns throughout, so the defect was
latent and never produced a wrong report.

The pre-apply description is retained below for provenance and **no longer describes live
behavior**: _Live `_issue_return_credit_impl` still creates only the credit-memo header and writes no
`invoice_items.cost_cents`; live PNL still recognizes only `posted`, and monthly reporting still
omits `paid`. Production currently has zero credited returns, so the defect is real but latent rather
than an existing wrong report._ A 2026-08-27 read-only check found one open restock row: it is exactly
the pinned legacy `15 ea` RMA with the authoritative `2.5 Gal` conversion, leaving zero unhandled
warehouse-unit mismatches. **RESOLVED 2026-09-01 — all six migrations are applied live.**
`20260827041000`, `20260827041100`, `20260827041200`, `20260827041300`, `20260827041400`, and
`20260827041500` contain the durable repair and fail closed if the zero-credit/zero-legacy-restock
assumptions or either delivery-invoice implementation contract stop being true. Mason reopened the
2026-08-31 deferral in-chat on 2026-09-01; the chain was applied in order, each behind a full
migration-apply-guard proof, and each verified afterward by read-only live query. The cutover
barrier installed by the first migration was removed by the last (verified: trigger `0`, function
`0`). Do NOT restamp, re-review, or re-apply this chain — it is spent. Live ledger rows and
per-migration apply versions are recorded in `docs/reference/migration-history.md`. What follows
described the pre-apply state and is kept for provenance
through the repository's guarded migration runner or the Supabase migration operation, never through
the ad-hoc SQL channel.
The first migration blocks new return-credit issuance until the second migration's postflight succeeds,
closing the otherwise unsafe commit gap between the two files. They must be applied back-to-back. If the
second fails, leave the barrier active, repair the drift it reports, and rerun it; an emergency removal
needs its own reviewed forward migration and would knowingly reopen the zero-COGS defect.
Both files bound their table-lock wait at five seconds so a stuck reader causes a clean apply failure
instead of leaving Returns queued indefinitely. The new validated `invoice_items` constraints hold
that table lock for the validating scan itself; schedule the back-to-back apply in the maintenance
window even though waiting to acquire the lock is bounded. The second blocks a draft source invoice only when
recognizing it would expose an uncosted, restocked return quantity; a fully costed prior return does not
block a later delivery invoice. Posting uses the same ordered advisory-lock protocol as credit issuance
and fails fast on contention. The migration also excludes new credit-memo lines from delivery billing
allocation so a return cannot reopen customer billing headroom.
The third migration also excludes the order-linked credit memo from both delivery invoice coverage
checks, so it cannot suppress a later delivery's automatic invoice or block manual recovery of an
already-completed unbilled delivery.
The fourth applies that same rule to the main dashboard action queue and to void/cancel invoice-review
warnings, and makes the automatic completion path ignore soft-deleted invoices. It preserves the
ordinary hard-delete path for unrelated invoices; the disposable proof executes that branch with a
real draft header and cascaded line item.
The fifth aligns both order-level invoice creators with the same active, non-deleted, non-credit
predicate, so the server cannot refuse the billing-recovery action the UI correctly exposes.
Immediately before the maintenance-window apply, rerun the open-restock inventory-unit predicate and
all 29 read-only PR #361 invariant predicates. If any new unhandled mismatch exists, stop before row
894; do not intentionally raise the cutover barrier until the row is repaired and the predicates are
clean in that same window.
Because every recognized-status transition must coordinate with a return credit that could start at
the same instant, two people posting invoices for the same order line concurrently can make one post
fail cleanly with a wait-and-retry message even when no return credit exists yet. No data is at risk;
retry the refused post after the other finishes.

The source-line foreign key is intentionally retained after a credit is voided or unapplied. It is an
accounting audit link, so a source invoice that has ever funded a return credit cannot be hard-deleted
or re-saved: the general invoice writer rebuilds its line items, and the retained credit history refuses
that delete-and-reinsert cycle. Keep the source invoice unchanged. If an edit is genuinely required,
first void the return credit and then permanently delete that voided credit memo so its line-item link is
removed; only then re-save the source invoice. Clearing the link while keeping the credit memo would
make later reapply/reissue allocation ambiguous. The operator error sanitizer explains both the delete
and re-save refusal. This restriction also applies to a zero-COGS damaged/non-restocked return credit:
the source link is retained as customer-credit audit history even though no inventory value was reversed.

**CLOSED IN THE SIX-FILE CANDIDATE; LIVE REMAINS OLD UNTIL APPLY — general Invoice Detail can strip return-cost lineage.** The live
`_save_invoice_scoped_impl` rebuilds `invoice_items` without `order_item_id` and re-derives cost from
the product's current cost. Editing a delivery/order-generated draft through the general Invoice
Detail page can therefore erase the historical source line that the PR #361 allocator needs; a later
return would refund revenue but conservatively reverse zero COGS, understating profit with no runtime
error. Migration `20260827041500_preserve_generated_invoice_lineage_and_finish_cutover.sql` now
implements the approved durable fix: the client returns existing line ids, the server verifies every
order-linked line and forbids product/unit/order-line substitution or deletion, then restores the
server-held line id, `order_item_id`, historical `cost_cents`, `created_at`, tote, vendor, and warehouse
after the legacy rewrite. The rollback-only chain proves edit -> post -> overdue -> return -> credit
retains the exact 600-cent unit cost. Merging the candidate does not change live behavior; the fix
becomes active only when all six reviewed migrations are applied in one guarded maintenance window.

After the approved live apply, regenerate the live schema registry and Supabase-derived type artifacts,
and confirm both nullable ledger columns (`invoice_items.return_credit_cogs_cents bigint` and
`invoice_items.return_credit_source_item_id uuid`) are present before declaring the rollout closed.

**ACCEPTED POLICY — late return credits stay in the current crop season.** Mason chose this on
2026-08-26 to keep prior customer year-end summaries stable and the rule simple. Consequently, a
current-season summary can show negative product usage when the original purchase occurred in a
prior season. Do not "correct" that by moving the credit backward; changing the policy requires a
new owner decision.

**EXPECTED REPRINT CHANGE — paid/overdue invoice repair.** The PR 361 report repair also makes old
year-end reports include all recognized `posted`, `overdue`, and `paid` invoices. Regenerating a
prior-season report can therefore differ from an older printed copy that incorrectly omitted paid
or overdue invoices. That correction is separate from credit attribution: a 2026 return credit stays
in 2026 and does not move the credit into the original sale season. The same migration also changes
invoice-basis P&L and monthly COGS to round each invoice line to exact whole cents before summing; this
is required so a return can never reverse more COGS than those reports recognized, but it means a
reprinted P&L or monthly summary containing fractional-quantity lines can differ by a cent from an
older copy.
**RETIRED 2026-08-27 — Patrol is no longer an active CRX workflow.** Its command, generated
skill adapter, runtime, monitor, classifier, renderer, trusted-exec layer, and dedicated tests
were removed as part of the first harness-simplification tranche. The Patrol discussion below is
preserved only as historical evidence; its file paths and operating instructions no longer exist.
Use the smaller existing status/workspace tools for targeted read-only checks instead of rebuilding
an always-on owner queue monitor.


**RESOLVED 2026-08-25 — the two `/patrol` findings first deferred at the round-3 review cap
are both closed.** Kept as history because the reasoning is the evidence for the
interactive-only scoping decision, and because a future change that "simplifies" either
one would reopen a security property. Detail below.
(1) **Ambient-code path — CLOSED 2026-08-24** (Mason approved the extra review round).
`scripts/patrol/trusted-exec.mjs` now binds `git`, `gh`, and `powershell` to fixed absolute
executables under one minimal environment (system/global Git config disabled, replacement
objects off, system attributes off, no terminal prompt, `PATH` narrowed to the trusted Git
directory plus the system directory, inherited `GIT_*` overrides dropped by allowlist).
**Repository-local config — PARTIALLY closed, revised 2026-08-25. Read this before
believing the sentence above covers everything.** `git status` runs Git's conversion
pipeline, so repo-local command-bearing config executes. Measured against real repositories
on 2026-08-25 rather than assumed:

| vector | plain `git status` | with a command-line `-c` override |
|---|---|---|
| `core.fsmonitor` | **executes** | **blocked** (`-c core.fsmonitor=false`) |
| `filter.*.clean` | **executes** | **still executes** (`-c core.attributesFile=NUL` does not help; suppressing it requires naming the driver, which requires reading the config first) |

So patrol closes the fsmonitor half **by construction** — a fixed flag, no config read,
nothing that can fail open — and leaves the filter half open, declared rather than
half-guarded.

A scanner (`worktreeFilterRisk` / `dangerousConfigKeys`) did previously refuse to run status
in a worktree whose config defined a filter. **It was deleted on 2026-08-25** because it
failed **open** in three consecutive review rounds (an unguarded call site; error-text
matching that swallowed every failure; unrecognised Git boolean spellings), and because the
residual exposure is the repo's existing baseline rather than something patrol adds:
`scripts/fleet-status.mjs` runs `git status --porcelain -uall` across **every** worktree
through a bare `execFileSync("git", …)` — a PATH lookup inheriting the full ambient
environment, with no scan and none of patrol's hardening. Patrol after the deletion is
strictly better protected than a command already run whenever Mason asks "where are we at?".
**Open follow-up: apply the same one-line fsmonitor override to `fleet-status.mjs`.**
**Scheduling patrol later reopens this in full and needs its own design pass — do not
reinstate the scanner piecemeal.** Same fixed-executable pattern PR #455 established for the
review wrapper still applies and stays.
(2) **Forgeable parked state — CLOSED 2026-08-24.** `isParked()` now honours **labels
only**; a `PARKED` title is ignored. Applying a label requires write access, so it carries
authorization a self-authored title does not. **Consequence Mason should know:** PRs #361
and #441, which were parked via title markers, are actionable again in the report — add a
`hold`/`parked` label to either one to park it properly.

**RESOLVED BY SCOPING 2026-08-24 (Mason's decision) — `/patrol` is interactive only.**
The unattended-execution surface below did not converge, so the tool no longer claims that
capability: no OS scheduled task, no unattended `/loop`. Every finding in that surface
matters *only* because patrol would run hourly under Mason's account unwatched; run by hand
it is no riskier than any other script in this repo, and by hand is where its value already
is. The `trusted-exec.mjs` hardening stays as defence in depth. **Scheduling it later needs
its own design pass on the execution surface, not another patch.** The history below is
kept because it is the evidence for that decision.

**The unattended-execution surface did not converge.** Three consecutive
Codex rounds each found a *new* hole in the previous round's fix: round 3 (PATH lookups and
repo-local filters), round 4 (a missed `execFileSync("git")` in `patrol-report.mjs`, plus
producer validation failing open on an unbound app id), round 5 (`collectorBuild()` calling
status without the filter check, and the guard reading only `--local` while Git also
consumes per-worktree config when `extensions.worktreeConfig` is on). Each fix was correct
and each was incomplete. **Recommendation on the table for Mason: scope `/patrol` to
interactive use and drop the OS-scheduled task.** Every one of these findings matters
*because* the tool would run hourly unattended under his account; run by hand inside a
session it carries no more risk than any other script he runs. That removes the threat
model rather than patching it one hole at a time.

**Superseded 2026-08-22 header, kept for provenance — was last-verified 2026-08-22 UTC, read-only live re-read of the ledger and of every `job_chemicals` row.** The ledger figures below are unchanged from the 2026-08-19 pass; issue entries not named in the 2026-08-22 changes were not individually re-verified in this pass. **Live ledger high-water is `20260816174353` at 971 rows**, carrying submitted name `20260813080000_lock_quote_versions_writes_to_rpc` — which is also the highest *timestamp-prefixed* `name`, so both orderings agree on the same row. (Stated that way deliberately: only **345** of the 971 ledger names carry a 14-digit timestamp prefix — 346 if the single 8-digit `20260207_gap_analysis_fixes.sql` is counted (the `.sql` suffix is part

of the stored ledger name), and `docs/reference/migration-history.md` uses the 14-digit definition, so this file now matches it. A plain `max(name)` returns the slug `year_end_summary`. The ordering claim holds over the prefixed subset, not over the raw column.) Two things this pass corrected in this file: (1) the header below claimed `20260812003315` / 962 rows, **nine applies** and six days of ledger staleness out of date — the six 2026-08-12 recoveries listed below, then `20260812212323`, `20260813011751` and `20260816174353`, which is 962 + 9 = 971; (2) CRX-SEC-1 **applied live on 2026-08-16** — see the new CLOSED entry immediately below — while `docs/reference/migration-history.md` row 886 still called it an unapplied local candidate. `.claude/schema-registry.json` was regenerated from live introspection on 2026-08-16 and records `migrations_high_water` `20260816174353`, matching this ledger; it was **not** re-derived in this pass. **The 2026-08-10 money figures quoted further down this file are stale** — a read-only re-measure on 2026-08-18 finds `order_items.total_price`, `order_items.profit`, `commissions.commission_amount` and `commissions.order_profit` all at **0** sub-cent rows, with only `quotes.total_cost` still holding **2**; the "43 dirty rows" and "49 rows" figures below are superseded by that measurement (recorded in full in `docs/manual/CURRENT_STATE.md` section 2). Everything else below was left as separately dated historical evidence and was not re-verified in this pass.

**Superseded 2026-08-17 header, kept for provenance — ledger high-water only.** Live ledger high-water is **`20260816174353` at 971 rows**, carrying submitted name `20260813080000_lock_quote_versions_writes_to_rpc`. This pass re-read the live ledger and nothing else: it corrects a high-water this document was stating wrongly, and it does **not** re-certify the issue narrative below, which keeps its own older dates. **The schema registry is NOT refreshed to this high-water** — it is still stamped to the 962-row mark and is now nine migrations behind. Beyond the six migrations named in the next paragraph, three more have landed since: ledger versions `20260812212323`, `20260813011751`, `20260816174353`, carrying submitted names `20260812130145_bind_return_receipts_to_intent_and_restore_overdue`, `20260813070000_pin_return_idempotency_helper_contract`, `20260813080000_lock_quote_versions_writes_to_rpc`. Ledger versions are UTC and Supabase applies may assign a version different from the submitted filename, so match the recorded **name** when reconciling an apply.


**Superseded 2026-08-12 header, kept for provenance:** live ledger high-water was `20260812003315` at 962 rows, carrying submitted name `20260811230423_log_customer_sales_rep_assignment`. The Customer 360 assignment RPC is live with atomic customer timestamp/activity logging, one overload, the reviewed security/search-path/grant shape, and no table, column, enum, generated-column, signature, or public-function-name-count change. The schema registry was genuinely refreshed through the same high-water. Ledger versions are UTC and Supabase applies may assign a version different from the submitted filename, so match the recorded name when reconciling an apply. The historical Team Board, money, and commission-payout details below remain separately dated evidence rather than claims that their older high-waters are current.

**Repository/production gap reopened and re-closed on 2026-08-12 — six migrations, and the prevention gap is still OPEN.** The high-water quoted in the paragraph above (`20260812003315`, 962 rows) was overtaken the same day. Six further migrations applied live on 2026-08-12 — ledger versions `20260812034831`, `20260812034951`, `20260812145628`, `20260812151606`, `20260812154028`, `20260812154757`, carrying submitted names `20260812010000_blend_ticket_order_header_runtime_assert`, `20260812011000_restore_quote_version_whole_cent_money`, `20260812115235_snapshot_cost_reporting`, `20260812115236_quote_items_cost_at_quote_snapshot`, `20260812115237_enforce_below_cost_admin_approval`, `20260812115238_repair_historical_order_line_cents` — **applied by concurrent sessions that never landed their files.** For part of that day none of the six existed on `main`, on any pushed branch, or in any local worktree, so SQL touching order money, quote cost, report math and a new approval table was running against production with no one able to review it, and a clean rebuild from `main` would have produced a schema without it. The **files** side is now closed: all six were recovered verbatim from the applying sessions' transcripts (not reconstructed from live `prosrc`, which loses the header, preconditions and review history), md5-verified against live `pg_proc.prosrc`, and landed as history rows 880-885. **The prevention side is not closed.** Nothing yet stops the next session from applying a migration and not landing its file; this is the third occurrence of a migration applying live with **no file landed anywhere** (2026-08-09, 2026-08-11 via PR #371, 2026-08-12) and the only current defence is that someone notices. A durable fix — a hard guard that reconciles the live ledger against tracked files and fails a check when they disagree — is not written.

**`quote_items.cost_at_quote_cents` — declaration gap CLOSED.** Added by `20260812115236`; `src/types/index.ts` now declares it as an optional field because partial projections may omit it. The column is trigger-stamped and the browser never writes it. This branch is based on `origin/main`, whose schema registry already carries `cost_at_quote_cents`, so the type layer and registry now agree.

**Wave A — six parked migration drafts.** This branch carries `20260813010000` through `20260813060000` under `scripts/.staging-migrations/`. They are intentionally absent from `supabase/migrations/`, are not armed for apply, and create no live state. Nothing in this document describes state they created.

**Repository/production gap on the whole-cent migrations: CLOSED 2026-08-11.** History rows 868–870 (`20260810150000`, `20260810150500`, `20260810151000`; ledger versions `20260810152935`, `20260810154721`, `20260810155629`) were applied live before they existed on `main`. **PR #371 landed as merge `465458a0`**, bringing those three plus `20260811200000_blend_ticket_order_whole_cent_totals` (applied live as ledger `20260811220045`) onto `main`. Disk and production now agree on all four — independently re-verified against live `pg_proc` on 2026-08-11.
The remaining fractional historical rows described below are still tracked data debt and were not rewritten by that repository closeout.

**2026-08-10 money re-measure (read-only, live).** Whole-cent conformance by column, which is what history rows 868–870 are scoped against: `orders.total_price` 0 dirty, `orders.total_cost` 0, `orders.total_profit` 0, `order_items.profit` 0, `quotes.total_price` 0, `quotes.total_profit` 0, `quote_items.total_price` 0, `quote_items.profit` 0 — and still dirty: **`order_items.total_price` 35/288, `quotes.total_cost` 2/4, `commissions.commission_amount` 3/35, `commissions.order_profit` 3/35.** The `order_items` figure moved 46 → 35 because `20260810025159` (above) backfilled stale line profit through the canonical trigger; the 3 fractional `commissions` rows are unchanged and still deliberately unrepaired. **43 dirty *column-values* remain** (35 + 2 + 3 + 3, summed across four columns, not four disjoint row sets) — the two `commissions` counts are 3/35 each and may well be the same 3 rows, so the number of distinct dirty **rows** is somewhere in **40–43**. The overlap can no longer be re-derived: live has since moved to 2 dirty, so the 2026-08-10 row identities are gone. **Repairing them rewrites stored money — still Mason's separate decision, still not done.** Under the 2026-08-10 fail-closed money policy those columns are tracked debt, not an approved exception. **SUPERSEDED 2026-08-18:** the live re-measure now returns `order_items.total_price` 0, `order_items.profit` 0, `commissions.commission_amount` 0, `commissions.order_profit` 0, and only `quotes.total_cost` 2 — so **2 dirty column-values remain, against the 43 counted the same way**, and the "3 fractional `commissions` rows unchanged and deliberately unrepaired" claim is no longer true of live. Figures and the enforced-vs-measured distinction are in `CURRENT_STATE.md` section 2. What rewrote the `commissions` rows is **established, not open**: `reconcile_pending_commission_snapshots` (ledger `20260810235207`, applied live 2026-08-10 with Mason's approval) — see the RETRACTED entry below, which corrects a first draft that called this change unexplained.

**2026-08-10 commission-basis measurement, correctly characterized.** **12 of 35** order commissions have `order_profit ≠ orders.total_profit` (exact `IS DISTINCT FROM`; an earlier pass this session compared cent-rounded values and reported 10, hiding **two of the three** sub-cent rows — only a sub-cent gap can vanish under cent-rounding, and a gap of exactly $0.01 always survives it, so 12 exact → 10 rounded means two rows were masked and the third straddled a cent boundary and survived). Do not read that as a live emergency: **8 are `pending` with a gap of exactly $0.01 and 3 are `pending` with a sub-cent gap** (the disclosed backfill residual from `a0a69a62`, which deliberately did not rewrite commission rows), and the **1 materially larger gap is on a `cancelled` row** (dollar figure deliberately withheld — this repository is public; it is in the access-controlled session record). The underlying mint-time code defect is real and confirmed from live function source — `_convert_quote_to_order_owner_impl` and `create_direct_order` mint from a cached/local profit after the item triggers already rewrote the canonical header — and history row 868 is the fix, **applied live 2026-08-10**. It stops future drift; it does not repair the present rows, and the measurement above is the pre-fix state.

**SUPERSEDED — 2026-08-18 live re-measure of the same predicate (read-only).** The 12/35 figure and its 8-penny / 3-sub-cent split above are **no longer current**. Re-running `commissions c JOIN orders o ON o.id = c.order_id WHERE c.order_profit IS DISTINCT FROM o.total_profit` on 2026-08-18 returns **2 of 35** rows: **1 `pending` with a gap of exactly $0.01**, and the same **1 `cancelled` row with the materially larger gap** (figure still withheld — public repository). **Zero rows carry a sub-cent gap**, the arithmetic consequence of both sides of the predicate being whole-cent: `commissions.order_profit` measures 0 sub-cent rows in the `CURRENT_STATE.md` section 2 re-measure, and `orders.total_profit` measures **0 of 65** sub-cent rows on live (read-only, 2026-08-18 — that column is *not* one of the five in the section 2 re-measure, so it is measured here rather than inherited from it). The difference of two whole-cent numbers cannot be sub-cent. Do not read line 18's "3 pending with a sub-cent gap" as live state and do not draft a repair migration against those rows — they are already clean. **What changed and why is established:** two approved applied migrations — see the RETRACTED entry below.

**2026-08-09 historical baseline.** The live re-read then covered the ledger, `CURRENT_STATE.md` counts, and all 27 invariant predicates: 26 CLEAN and the documented `fin-money-whole-cents` historical-data violation. The five foundation-ultra-review migrations applied later that day as ledger versions `20260809203222` through `20260809205423`. The formerly missing Team Board migration file and history row are now reconciled on PR #351.

**2026-08-09 sweep and the five foundation-ultra-review migrations.** The 2026-08-09 re-read covered the live ledger, the section-2 counts in `CURRENT_STATE.md`, and all 27 standing invariant sweep predicates: 26 CLEAN and one violation, `fin-money-whole-cents` at exactly 49 rows (3 `commissions` + 46 `order_items`) — the documented, deliberately-unrepaired set described below. Under the 2026-08-10 fail-closed money policy, those dirty rows and any missing active finite whole-cent CHECK remain tracked findings; their numeric-dollar storage is not an approved or suppressible exception. The five foundation-ultra-review migrations (history rows 857–861, re-issued forward as `20260809170500`–`20260809170900`) **APPLIED LIVE 2026-08-09, 20:32–20:54 UTC**, each behind its own freshly minted migration-apply-guard proof with both required reviewers clean, and each followed by a live post-apply read; Supabase assigned ledger versions `20260809203222`, `20260809204044`, `20260809204435`, `20260809204855`, `20260809205423` in file order. A 21:15 UTC re-measure confirms no stored money was restated: fractional-cent rows remain exactly 46 + 3 = 49 and `order_items.profit` holds 0 fractional rows. **`20260809170900` applied against the blocking escalation recorded below** — see that entry for what happened and the decision now owed by Mason.

**2026-08-07 (evening) verification detail.** Live ledger high-water was `20260807220323` (`log_customer_fact_rpc`). Both formerly parked 2026-08-07 migrations are now APPLIED LIVE: the profile role-lock INSERT arm as `20260807215532` and the `log_customer_fact` CRM RPC as `20260807220323` (both reviewed CLEAN by both Codex charters, applied with Mason's in-chat approval; the paired predicate `profile-role-lock-insert-arm.sql` went 2 rows red → 0 green). The Section 4 bulk-order-import lifecycle gap is fixed live through seven migrations (`20260805211951`, `20260805220757`, `20260805224819`, `20260806000752`, `20260806004644`, `20260806012423`, `20260806023048` — history rows 681 and 849–854): imports are confirmed-only, inventory-aware, activity-logged, actor/payload-bound for replay, non-finite-safe, Product-cost-authoritative, whole-cent per line, and create commissions from trigger-canonical stored profit. Post-apply catalog/grant checks, fractional active-sales-rep rollback smoke, all 21 standing invariant predicates, schema-registry refresh, and zero-residue checks passed. The earlier idempotency, statement-disclosure, and historical AR report protections remain live as documented below.
**Update triggers:** when a finding is parked/resolved, a migration is parked/applied, or an owner decision lands. Agents must update THIS file, not create new issue lists. Do not re-discover or re-fix something listed here as already known — read the pointer first.

This file consolidates (does not replace) the source documents it points to. If this file and a source disagree, trust the source and fix this file.

---

## OPEN 2026-09-02 — four tracked follow-ups on the CodeRabbit label gate shipped in #516

The gate landed on `main` as `f2307fbf9` with these four items knowingly open. They were recorded
on the pull request and are lifted here so they do not live only in a PR comment. **None blocks
the gate; none is a production-behaviour risk.** The gate is label-triggered, so the worst outcome
in items 1 and 2 is a wasted paid CodeRabbit review, recoverable by removing the label.

**1. `coderabbit-final-review.cjs` — reset requested state before rejecting invalid ready events**
(Codex P2). When a `ready-for-coderabbit` event replaces a queued draft/base/auto-merge reset,
`blockCandidate()` removes only the ready label, so an invalid candidate's already-posted command
survives and can still consume a review. Fix shape: route through the full reset path whenever
requested state is present.

**2. `coderabbit-final-review.cjs` — require checks newer than same-head invalidations** (Codex
P2). After a base edit, reopen or draft transition invalidates a candidate **without changing its
head SHA**, prior successful runs stay discoverable under the same ref, so a reapplied label can
accept stale green. Fix shape: bind accepted workflow runs to the current base/invalidation
generation, not to `headSha` alone.

**3. The privileged workflow pins actions by mutable major-version tags.**
`actions/checkout@v7` and `actions/github-script@v8` rather than commit SHAs. Rated Low by two
separate Codex reviews; token scope is repository reads plus issue labels/comments. Deliberately
not done in #516: re-pinning a brand-new `pull_request_target` workflow's actions can break it on
its first real run, and #516 was the run that would have proven it.

**4. Both merge guards still accept a generic `APPROVED` verdict.**
`.claude/hooks/pr-merge-guard.mjs` and `.codex/hooks/production-action-guard.mjs` never read
`coderabbit-review-requested`, the hidden marker SHA, or the approving reviewer's identity, so the
gate's recorded authorization is documentation rather than enforcement. **This gap pre-dates #516
and exists on `main` independently of it** — #516 neither created nor closed it. Binding the guards
belongs with PR #556, which is already reworking both guard files; doing it inside #516 would have
re-broken the blob pin that PR had just cleared.

**Why these stopped rather than continued.** #516 took eight exact-head Codex reviews, and
essentially every commit produced a fresh P2 of the same class — reset/dedupe semantics in a new
state machine. The two worst instances *were* fixed there and mutation-tested (a superseded command
surviving a retry; a queued payload clearing a live dedupe marker). Continuing to fix-and-re-review
inside one PR is the known non-terminating pattern, and each round costs another review out of a
shared ~2/hour allowance. The hard gate defined in `AGENTS.md` — the exact-SHA `gpt-5.6-sol`
high-effort proof — returned CLEAN on the merged head with "Nothing required remains".

## OPEN 2026-09-02 (writer IDENTIFIED; opened 2026-08-31) — the Codex CLI `/import` writes 24 corrupted `source-command-*` adapters

**Identified 2026-09-01.** Twenty-four untracked directories named
`.agents/skills/source-command-<name>/SKILL.md` appeared in six worktrees under
`C:/CRX_Manager/.claude/worktrees/*` at 19:46:47 on 2026-08-31. Two sessions independently ruled
themselves out. The generator is now known from the artifacts' own front matter:

```yaml
name: "source-command-ship"
description: "Migrated source command `ship`"
```

A **command-to-skill migrator** — not `sync-agent-workflows.mjs`, which cannot emit that prefix
(all 37 tracked adapters are unprefixed) and which REJECTS all 24 via `--check` as "not generated
from .claude".

**The part that matters: the content is corrupted, not merely duplicated.** The migrator applied a
case-insensitive `claude` → `Codex` substitution to the instruction TEXT, not just to names. 13 of
the 24 files now instruct an agent to run paths that do not exist:

```
.Codex/hooks/autopilot-arm.mjs        (real: .claude/hooks/autopilot-arm.mjs)
.Codex/hooks/loop-guard.mjs
.Codex/hooks/migration-ordering-lib.mjs
.Codex/hooks/session-size-sentinel.mjs
```

So these are not harmless duplicates. `source-command-ship` carries the whole `/ship` autonomy
boundary — migration gates, edge-function gates, the landing policy — with its arming command
pointing at a path that cannot exist. An agent that loaded this skill and tried to follow it would
fail to arm autopilot, and would be reading a mangled copy of the safety contract.

**They also predate the 19:46:47 appearance.** `git log --all -S "source-command-"` finds them in
stash `bcaa4527` (`stash@{1}`, "crx-main-checkout-cleanup-20260831"), captured as untracked files on
`main` at **10:26:25 the same morning** — nine hours earlier. So the migrator has run at least
twice, and a cleanup session already swept one batch into a stash.

**Where it comes from (machine-wide sweep, 2026-09-01).** 94 artifact files were found and **not a
single generator** — no script anywhere on the machine contains the `source-command-` prefix or the
"Migrated source command" description. So the migrator is a **CLI/tool feature, not repo code**, and
`sync-agent-workflows.mjs` is exonerated twice over.

The distribution says which tool. Every hit sits in a Codex-run tree:

```
C:/Users/mason/.codex/worktrees/gauntlet-section9-takeover-20260830/…      (2026-08-30)
C:/Users/mason/.codex/worktrees/gauntlet-section9-opus-gate-20260830/…     (2026-08-30)
C:/Users/mason/.codex/rescue/cleanup-20260831-105800/…/dirty/…             (rescued 2026-08-31 10:58)
C:/CRX_Manager/.claude/worktrees/codex-claude-migrations-2-4-33493c/…      (a Claude↔Codex migration worktree)
```

So this is **not a one-off**: it has been running since at least 2026-08-30, the rescue snapshot
corresponds to the same morning as the stash, and it reproduces wherever the Codex CLI operates on
this repo. Expect it to recur until whatever invokes it is identified — deleting the copies without
finding the trigger will just defer it.

**IDENTIFIED 2026-09-02: it is the Codex CLI's "Import from other apps" feature (`/import`).** The
sweep's conclusion above was right — no generator script exists, because the generator is compiled
into `codex.exe`. Evidence:

- The artifacts' exact template literals are inside the binary
  (`…/@openai/codex/…/bin/codex.exe`): `Migrated source command \`` and `Use this skill when the
  user asks to run the migrated source command \``.
- Its module paths appear in the binary's own trace strings:
  `core-plugins\src\command_migration\render.rs`, `external-agent-migration\src\source_cla.rs`
  (cla = Claude), `source_cur.rs` (Cursor), `tui\src\external_agent_config_migration\flow.rs`,
  `app-server\src\external_agent_migration\processor.rs`. The source enum it selects from is the
  literal string `claude-codeClaude CodeCursor`.
- **A third run, timed to the second.** The 24 directories in `C:/CRX_Manager/.agents/skills/` carry
  `SKILL.md` timestamps of `2026-09-02 01:38:50` (~13ms apart — one process, one burst), and
  `C:/Users/mason/.codex/external_agent_session_imports.json` was last written at
  `2026-09-02 01:38`. That ledger's records reference `C:\Users\mason\.claude\projects\…\*.jsonl`,
  so the feature was reading the Claude Code configuration at that instant.
- Durable state confirms a first-class feature rather than a stray one-shot: the SQLite table
  `external_agent_config_imports`, the JSON session ledger above, and telemetry events
  `codex.external_agent_config.detect` / `.import` and
  `codex_onboarding_external_agent_import_complete`.

**No off-switch exists.** The binary was searched for a disabling configuration key
(`skip_external_agent*`, `disable_external_agent*`, `*import*enabled/disabled/skip`); there is none.
The trigger cannot be turned off from our side, so any durable fix must be ours.

**Severity has increased since this entry was first written: it now BLOCKS COMMITS.**
`sync-agent-workflows.mjs --check` rejects all 24 as "not generated from `.claude`", failing the
pre-commit workflow-parity gate. Verified live 2026-09-02 — the check fails in `C:/CRX_Manager`, so
every commit in the main checkout is blocked while the directories are present. **`.gitignore` does
not help:** the checker walks the filesystem via `readdirSync`, not the git index. The candidate fix
is therefore to make the parity checker treat `source-command-*` as foreign and ignore it, as its own
reviewed change.

**Status:** quarantined (NOT deleted) out of
`.claude/worktrees/permission-grants-claude-codex-9f7108` to the session scratchpad; still present
in the other five worktrees. **Do not run `sync-agent-workflows.mjs --write` as a cleanup** — it
would mutate tracked files repo-wide in an unreviewed change and destroy the evidence. Deleting the
24 untracked duplicates is the candidate fix, as its own reviewed change, once someone identifies
what invokes the migrator and stops it running again.

## OPEN 2026-08-31 — `git config core.hooksPath` disables EVERY husky gate in one allowlisted command

Found by exact-SHA `gpt-5.6-sol` review during PR #530 (round 4, HIGH). **This is independent of
that PR — it is a live weakness on `main` today, and PR #530 neither caused it nor closes it.**

`git config core.hooksPath NUL` (or any other path) turns off the pre-commit and pre-push hooks
wholesale — the ledger guard, private-artifact containment, SQL/frontend validation, ESLint,
typecheck, build, the hook unit tests, doc-drift, and `verify-deps` — **without modifying
`.husky/**` at all**, so every guard that watches those files sees nothing. Codex confirmed the
command passes `guarded-surface-lock`, `bash-safety`, and `production-action-guard`.

It is doubly reachable because `git config` is on the read-only allowlist in
`guarded-surface-lib.mjs` (it does not alter working-tree content, which is true and beside the
point) and because the same setting is what the 2026-08-31 `hooksPath` work manipulates
legitimately — see `scripts/install-git-hooks.mjs`, which sets it by design.

**Why it is not patched here.** Adding `git config core.hooksPath` to a denylist treats the symptom
and invites the next spelling. Four review rounds on PR #530 each surfaced a new channel — `stdin`,
Codex's `write_stdin.chars`, PowerShell backtick escapes, and now this — which is the signature of
a blocklist rather than a boundary (see `pin-the-region-dont-enumerate-the-cheats`). Enumerating
verbs is what reopened it each time.

**What actually holds:** GitHub branch protection plus required CI. A locally-disabled hook cannot
land anything on `main`, because the same checks run server-side on the PR. Local hooks are a fast
feedback loop, not the enforcement boundary — and should be described that way.

**If it is worth closing anyway**, the shape is a check that runs where the agent cannot reach it
(a CI assertion that `core.hooksPath` resolves to the tracked `.husky` on the runner), not another
command-text rule. Tracked as a finding, deliberately unfixed, needs an owner decision.

## RESOLVED 2026-09-01 (by removal) — `guarded-surface-lock` failed OPEN on a syntax error in its own rule book, and its header claimed the opposite

**Closed the same day it was found: the hook was deleted, not patched.** Mason's decision, recorded in
`DECISION_LOG.md` (2026-09-01, "the guarded-surface lock is DELETED"). `review-proof-guard.mjs`
absorbed the four enforcement paths the lock uniquely covered, plus the git/patch overwrite verbs it
caught, so this is not a loss of coverage. Nothing below is live any more — it is kept because the
failure *shape* generalizes to any future `matcher: "*"` hook: fail-open on module-load error,
fail-closed-everything on runtime error, and no way to tell the two apart from inside the session.
The original finding follows.


`.claude/hooks/guarded-surface-lock.mjs` opens with "FAIL-CLOSED POSTURE: if the rule book throws,
this hook denies rather than falling open." That is true for a **runtime** error and false for a
**load-time** one, and the difference is not academic — both were hit live on 2026-09-01 while
narrowing the rule book.

- **Runtime error** (a reference to an undefined identifier, i.e. a half-finished edit): the throw
  happens inside `evaluateGuardedSurface`, the `try`/`catch` on lines 51–61 catches it, and the hook
  denies. Observed twice. Because the hook is registered under `matcher: "*"`, this denies **every
  tool call in the session**, including the ones needed to repair the file. Total self-lockout;
  recovery required Mason to run a shell command outside the agent.
- **Load-time error** (a duplicate `export const`, an unbalanced brace — any `SyntaxError`): the
  static `import` on line 19 is evaluated *before* the `try`/`catch` on line 51 and before `deny()`
  on line 24 exists. Node aborts the process. **Nothing is written to stdout**, and a PreToolUse hook
  that emits no decision is not a denial — so the lock is silently inert.

Reproduced in isolation rather than asserted: a structural clone of the hook (static import at top,
sole `try`/`catch` around the evaluate call) importing a rule book whose only defect is
`export const X` declared twice exits **1 with empty stdout** — the `catch` never runs. The same
condition was live in this worktree for several minutes and tool calls flowed normally throughout.

**Why this matters more than an ordinary bug.** The failure is oriented the wrong way. The lock is
strictest exactly when it is healthy, and switches itself off exactly when its rule book is
malformed — which is the state tampering produces. A guard whose disabled state is indistinguishable
from its working state, from the agent's side, is not evidence of anything.

**Not patched here, deliberately.** Moving line 19 to a dynamic `import()` inside the `try` converts
the load-time case into the runtime case — which is the *lockout* case, and that one already bricked
the session twice in fifteen minutes. Fixing one failure mode by routing everything into the other
is not an improvement. This is an argument about whether the lock should exist, and that is an owner
decision: see the 2026-09-01 entry in `DECISION_LOG.md`. Reading a guarded file is now allowed
outright (`READ_ONLY_TOOL_NAMES`), so the lockout blast radius is smaller than it was, but not zero.

---

## OPEN 2026-09-02 — two known gaps in the guard-claim ratchet, left open deliberately

Both reported by the Codex connector on PR #530 and **not fixed there**, because the PR had already
absorbed eight rounds of findings and the cap on adversarial iteration (2026-09-01, `DECISION_LOG.md`)
exists precisely to stop this. Neither is a production-safety issue: the ratchet governs whether guard
COMMENTS overclaim, and its failure mode is a missed annotation, not a bypassed control.

1. **Multiline template literals are not tracked.** `scanFile()` continues a wrapped claim only
   through comment lines and lines starting with a quote. A raw multiline template —
   `permissionDecisionReason: \`This cannot` / `be bypassed.\`` — has a continuation line beginning
   with prose, so `isProseLine()` stops the window and the claim is never seen. A new **user-facing**
   absolute claim can evade the ratchet this way. Fix shape: track template-literal state across
   lines rather than testing each line's first character.

2. **`guardSourceFiles()` scans only two directories.** It enumerates the immediate `.mjs` children
   of `.claude/hooks` and `.codex/hooks`, plus a `guard-unlock` exception. Guard-adjacent runners
   elsewhere — `scripts/apply-migration-file.mjs` is the named example — already contain
   `fail-closed` and `guarantee` assertions that the audit never reads, so those claims can be added
   or reworded with no annotation while `test:correction-guards` stays green. Fix shape: an explicit
   manifest of guard/check runners, or a documented recursive scope. Expect a large one-time baseline
   growth when this lands; do that as its own reviewed change, not as a rider.

## OPEN 2026-09-02 — three executor bypasses of `review-proof-guard`, all PRE-EXISTING on `main`

Reported by the Codex connector on PR #530 and **not fixed there.** All three are the same shape as
the four that PR closes, and all three are **already open on `main` today** — no diff in #530 causes
them. They are recorded here as pre-existing known-open, not as a regression.

Measured 2026-09-02 by running each shape through both trees' hooks, with must-DENY regression
canaries and must-ALLOW false-positive canaries (0 crashes, 0 false positives, 5/5 canaries correct):

```
                                          main     PR530 head
node -r / --require / --import / --loader ALLOW    ALLOW     open on BOTH
node -pe  (bundled eval form)             ALLOW    ALLOW     open on BOTH
export GIT_EXTERNAL_DIFF=…; git diff --   ALLOW    ALLOW     open on BOTH
export GIT_PAGER=…; git log --            ALLOW    ALLOW     open on BOTH
gh release download --clobber -D <dir>    ALLOW    ALLOW     open on BOTH
rg --pre                                  ALLOW    DENY      #530 closes
doubled separator (.github//workflows/…)  ALLOW    DENY      #530 closes
git grep --open-files-in-pager            ALLOW    DENY      #530 closes
git -c diff.external … --ext-diff         ALLOW    DENY      #530 closes
```

1. **Node preload and bundled-eval flags.** `enforcementSegmentIsReadOnly()` rejects `node`'s eval
   forms (`-e`, `-p`, `--eval`, `--print`, `--input-type`) but not its **module-preload** forms.
   `node -r ./payload.cjs .husky/pre-push` runs the preloaded module before the entrypoint, so that
   module can rewrite or delete the named hook. `--require`, `--import` and `--loader` are the same
   channel. Separately, the eval regex applies `\b` after `-p`, so the bundled `-pe` spelling does
   not match it either.

2. **Git executor environment variables.** The guard rejects the `-c` / `--config-env` channel and
   `--ext-diff` / `--open-files-in-pager`, but git also takes its executor from the environment.
   `export GIT_EXTERNAL_DIFF=<cmd>; git diff -- <guarded>` passes because the `export` segment names
   no protected path and the following `git diff` is allowlisted. `GIT_PAGER` is the same shape. The
   **inline** (`GIT_EXTERNAL_DIFF=… git diff …`) and `env`-prefixed forms are correctly denied — it is
   specifically the separate-`export`-segment form that slips.

3. **`gh` is treated as wholly read-only.** `gh release download … --clobber -D .github/workflows`
   writes a downloaded asset over a protected path. No `gh` subcommand or output-flag validation
   exists.

**Why these are not being fixed.** With these three, that is **seven** distinct bypasses of one
shape — an allowlisted *reader* that accepts a flag naming a *command* to execute (`rg --pre`,
`git -c`, `git grep -O`, `git --ext-diff`, `node -r`, `GIT_EXTERNAL_DIFF`, `gh -D`). That is one
design being patched by spelling, and each round has found another. Mason capped adversarial
iteration on this file at six commissioned rounds (`DECISION_LOG.md`, 2026-09-01) for exactly this
reason, and the file's own comments already call enumerating them "the blocklist mistake this file
has already made twice." **Do not open round seven on this PR.** `DECISION_LOG.md` records the real
gate as the `ask` permission tier, with this hook a speed bump rather than a boundary; under that
framing these residuals are not load-bearing.

## OPEN 2026-09-02 — `review-proof-guard` fails OPEN, and SILENTLY, when it cannot parse its own input

`review-proof-guard.mjs` begins:

```js
let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); }
catch { process.exit(0); }   // exit 0 with no output == ALLOW
```

Verified 2026-09-02 against both trees with a well-formed must-DENY baseline as the canary: malformed
JSON, empty stdin, truncated JSON, a bare array and a `null` payload all return ALLOW on `main` and on
PR #530 alike. **Pre-existing and identical on both; #530 does not introduce it.** The baseline row is
what makes the result readable — without it, "correctly denies malformed input" and "broken in the
same way as main" both render as a column of ALLOWs.

**This is deliberately NOT being fixed, and the reason must survive.** The obvious change is
`catch { deny(...) }`. This hook is registered under `matcher: "*"`, so it sees every tool call in the
session — making it deny on unparseable input turns any single stdin hiccup (an EAGAIN on Windows, an
oversized payload, a pipe glitch) into a session-wide lockout. That is precisely what killed
`guarded-surface-lock` (see the RESOLVED 2026-09-01 entry): a universal-matcher guard became a single
point of failure where a runtime error denied every tool call. **Fail-closed on a universal-matcher
hook trades a low-reachability permit for a total-lockout risk.** Reachability here is low — an agent
cannot readily control whether the harness emits valid JSON.

**The cheap improvement someone can make later**, which carries none of that risk: make the fail-open
**loud** rather than silent. `catch { process.exit(0) }` permits *and says nothing*, so a guard that
has stopped functioning is indistinguishable from a guard finding nothing wrong. Writing a warning to
stderr before exiting 0 costs no availability and no lockout risk, and converts a silent fail-open
into a visible one.

**The in-repo precedent for the correct shape** is in `codex-push-lib.mjs`: `proofSearchDirs()` and
`resolveSessionWorktree()` both fall back to the *narrower* set when worktree enumeration fails, and
both say in a comment which direction they fell — losing the widening makes the gate stricter, never
laxer. The rule those two follow: **when you cannot determine, fall toward the more restrictive
answer, and record which way you fell.** The `matcher: "*"` case above is a deliberate exception to
that rule, not an inconsistency with it.

## OPEN 2026-09-01 — three migration-apply protections live only on a closed PR's branch, not on `main`

**Found by:** the disposition of PR #364, which was closed as superseded on 2026-09-01 with Mason's
in-session approval. Full scope: `docs/audits/2026-09-01-pr364-guard-extraction-scope.md`.

**The issue.** PR #364's headline deliverable had already shipped — its migration
`20260810025159_backfill_stale_line_profit.sql` is byte-identical on `main` (blob
`f4f97722be903f431d1f4f30cebfe14c8d2ab3ca`, applied live 2026-08-09) — and `main` independently
rebuilt the same guard file across #483, #514, #502, and #533. A `gpt-5.6-sol` high-effort review
confirmed `main` is now **strictly stronger** than the branch on every protection the branch's three
unmerged guard commits introduced, so `2e23711c9`, `1692978f2`, and `286a38d2a` are superseded and
must **not** be re-applied — doing so would be a regression.

**What is genuinely missing from `main`.** The same review corrected an earlier claim in that
session that event-trigger handling was the branch's only surviving value. Three protections have no
equivalent on `main`:

1. **Apply-time one-shot replay enforcement.** `main` consults `one-shot-migrations.json` only when
   `scripts/list-post-baseline-migrations.mjs` generates a replay plan. Nothing enforces it at the
   live apply door, and nothing detects a renamed or disguised repeat of a one-time data repair.
2. **Fresh, project-bound live evidence.** `main` accepts a per-checkout snapshot up to 24 hours old
   that does not record which project it was captured from.
3. **Event-trigger and transitive fanout protection.** `main` has no operational event-trigger
   coverage. Six enabled event triggers exist on production (verified read-only 2026-09-01:
   `pgrst_ddl_watch`, `pgrst_drop_watch`, `issue_pg_net_access`, `issue_pg_cron_access`,
   `issue_pg_graphql_access`, `issue_graphql_placeholder`).

**Where the code is.** Branch `claude/pr364-guard-commits-local-20260831`, tip
`57d27e79105b62ee9887d59bdd1f2f58ed3c0e2d`. **Do not delete that branch** — it is the only remaining
home for these three. Extraction onto current `main` is roughly 8 files and +9,250 lines, dominated
by `.claude/hooks/apply-time-dml-lib.mjs` (2,612 lines); it is scoped but **not approved to build**.
Do not bring the `patrol` system across — `main` removed it deliberately in #512.

## OPEN 2026-09-03 — three fixes exist only on stale, unmergeable branches (branch cleanup audit F1–F3)

**Found by:** `docs/audits/2026-09-02-github-branch-cleanup-audit.md` (Codex `gpt-5.6-sol` reviewed),
re-confirming findings F1–F3 of `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md`. None of
the three was tracked here before; each lived only on a branch 150–690 commits behind `main`. The
branches are references, not merge candidates — every fix must be re-derived on current `main`.

**F1 — idempotency key discarded before the RPC result is checked (money paths).** On `main`,
`src/pages/OrderDetail.tsx` calls `resetKey()` at lines 596, 698, 891 and 906 **before**
`assertRpcResult(...)`; the 2026-08-02 branch `codex/idempotency-reset-order-hardening-20260802`
found the same shape across ~22 files (cancel/void order, split invoicing, invoice creation,
deliveries, prepayments, returns, month-end close, vendor bills). Transport errors are caught earlier
and a SQL error rolls back, so the exposure is an **ambiguous reply** — a null or malformed success
payload after the server may have committed — where the user's retry travels under a fresh key and
can double-apply. Codex (2026-09-01) added that the reorder is necessary but not sufficient:
`onCreateInvoiceClick` (`OrderDetail.tsx:938`) resets per attempt by design and needs a click-level
repair too. Open PR #535's `fingerprintIntentPayload` solves a different problem and does not touch
these call sites. **Fix shape:** reorder every post-RPC reset after `assertRpcResult`, repair the
click-level reset, tests for transport failure / failure envelope / lost-response replay / success /
changed intent. Money path → exact-SHA `gpt-5.6-sol` proof, then CodeRabbit.

**F2 — `next_*_number` generators callable by any authenticated session with no active-profile or
role gate.** Eight `SECURITY DEFINER` generators (`next_application_record_number`,
`next_commission_payment_number`, `next_cycle_count_number`, `next_delivery_number`,
`next_invoice_number`, `next_job_number`, `next_po_number`, `next_return_number`) grant `EXECUTE` to
`authenticated` and check nothing (live, read-only, 2026-09-01). `anon` has no grant; they insert
nothing; exposure is sequence-number disclosure and advisory-lock contention by any logged-in
principal including a deactivated one. Severity MEDIUM (Codex). The branch
`codex/section1-security-hardening-20260725` carries migration
`20260725234503_harden_section1_number_and_field_actor.sql`, **not applied and not on `main`**, and
covers only six of the eight; its other half (`bind_save_field_actor`) is live via PR #285. A plain
`REVOKE` is wrong — `CycleCounts.tsx:155` and `JobDetail.tsx:1838` call two of them directly.
**Fix shape:** new migration, all eight, in-body active-profile + role gates, grants preserved,
through `migration-review`.

**F3 — nine enforcement-file patterns missing from the `.claude/settings.json` `ask` list.**
`scripts/agent-manifest-parity.mjs`, `scripts/sync-agent-workflows.mjs`, `scripts/normalize-eol.mjs`,
`scripts/post-agent-review-to-pr.mjs`, `scripts/agent-health-check.mjs`, `.claude/commands/**`,
`.claude/skills/**`, `.claude/agents/**`, `.agents/skills/**` — 18 `Edit()`/`Write()` entries in
commit `b985e919b` on `claude/control-file-coverage-a41c`, a single additive hunk. PR #530 covers 2
of the 9 at a different layer (Bash guard). **Fix shape:** land the 18 entries as a one-file change;
the branch stays until then.

**Branch retention:** the three branches above stay until each fix lands on `main`.

## OPEN 2026-09-01 — agents share Mason's admin identity, so the manual merge override can only be fenced off by command matching, never truly withheld

**Found by:** the exact-SHA Codex proof on PR #541, which refused the candidate until the raw
REST/GraphQL merge transports were denied on both guards.

**The issue.** On 2026-09-01 Mason gained a manual review override on `main` (classic branch
protection no longer enforces its rules for administrators — see the decision log). The bypass is
granted by **admin rights on his account**, and every Claude and Codex session authenticates as that
same account. There is therefore no mechanism that offers the override to Mason and withholds it
from an agent; the guards can only refuse the *commands* that would use it.

**What is in place.** Both merge gates deny `gh pr merge --admin` outright, verify
`reviewDecision === "APPROVED"` directly rather than inferring it, and deny the
`/pulls/<n>/merge` REST endpoint and the `mergePullRequest` GraphQL mutation by destination
regardless of transport. That closes every route found so far, and it is an honest-mistake net —
**not a security boundary.** A command shape nobody has thought of, or an indirection that never
spells the destination in the command text, is outside what a command-text guard can catch. The
same honest residual is already documented for the interpreter-argument rule in
`.codex/hooks/production-action-guard.mjs`.

**The durable fix, DECLINED by Mason on 2026-09-01.** Giving agents a separate, non-admin GitHub
credential (a machine account or a fine-grained token without admin bypass) would let GitHub
withhold the override from agents instead of a guard trying to. It was put to Mason twice — once
when the override was designed, and again after the exact-SHA proof demonstrated a working bypass —
and he declined both times, explicitly choosing to keep the setup simple and accept the residual
risk. **This is a settled owner decision: do not re-open it or implement the separate credential
unless Mason asks.** Record it here rather than re-litigating.

**What that means in practice.** The merge guards are the only thing standing between an agent and
an unreviewed merge to `main`, and they are a command-text net: they catch every route found so far
(and six were found in one day), but a command that constructs the merge URL from separate strings
is invisible to them — Codex demonstrated exactly that. The accepted mitigations are the guards
themselves, the required Vercel/CI/SQL checks (which the ruleset still enforces on everyone), and
Vercel's one-click rollback if something unreviewed does land.

## OPEN (CAPPED — WONTFIX by decision) 2026-09-01 — the write-time actor-binding guard is bypassable by design limits, not by defect

**Plain English.** CRX records **who did what** — who received inventory, who recorded a vendor payment —
and some of those entries land in the immutable financial audit log. A database routine running with
elevated privileges that accepts a caller-supplied "who did this" value and writes it down unchecked lets
any signed-in user attribute an action to somebody else. That is not hypothetical: it happened on
2026-06-17, when `link_blend_ticket_to_order` / `unlink_blend_ticket_from_order` stamped `p_performed_by`
straight into `financial_audit_log` with no binding check (Gauntlet Section 1 HIGH, fixed in migration
`20260617171500`).

`.claude/hooks/actor-binding-check.mjs` is the **write-time** half of that defence — it inspects a migration
before it is written, so a forgery is refused rather than detected after it ships. **Scope that claim
precisely: it inspects `Write` and `Edit` tool calls only.** Both manifests register it under the matcher
`"Write|Edit"` (`.claude/settings.json`, `.codex/hooks.json`), so a migration authored any other way is
never presented to it (row 6). The sweep predicates (`predicates/actor-forgery.sql`, `-fin-audit.sql`) are
the **post-apply** half, run against the live catalog, and are indifferent to how the file was written.

**Status: capped as best-effort on 2026-09-01** — see the DECISION_LOG entry of the same date. The
**active** hook is the unchanged 213-line guard: it catches ordinary spellings *of a whole-function write*
and nothing more. The **parked PR #449 rewrite** is materially stronger — 19 laundering channels closed over
two rounds, each reproduced by running the hook and each fix mutation-tested — but **none of that is in the
running hook**, and this PR does not change it. Do not credit the active guard with #449's fixes. It is
**not** a boundary, and no document should describe it as preventing actor forgery. Note in particular that
the ordinary *incremental* edit path is not covered at all (row 3 below), so "catches every ordinary
spelling" would overstate even the active guard.

**What it does NOT catch, stated so nobody re-derives it:**

| Gap | Why it is open |
|---|---|
| Actor-shaped parameters outside the name pattern `^p_\w*by$\|^p_actor\|^p_user` (e.g. `p_target_id`, `p_acting_user_id`) | Deliberate scope limit — and **the live sweep predicates use the SAME name pattern, so this gap is shared, not compensated.** The post-apply sweep does NOT catch this one. Closing it needs real dataflow over write targets, and would have to change the hook and both predicates together. |
| Re-binding after a passing check (`p_performed_by := p_target_id;`), `EXECUTE … USING`, `INSERT … RETURNING … INTO`, temp-table round trips | **Not covered at write time, and not covered by the sweeps either.** The incidental `hasMutation` trigger that would catch `EXECUTE`/`INSERT` lives in **parked PR #449, not in the running hook** (213 lines, no such logic) — do not credit the active guard with it. The sweeps miss them for their own reasons: both predicates select only where `prosrc !~* 'ACTOR_MISMATCH'`, so a routine that passes a binding check and *then* re-assigns the parameter is excluded outright; and a temp-table round trip matches neither the `coalesce`/`auth.uid`/role proximity test in `actor-forgery.sql` nor the same-statement `financial_audit_log … <param>` test in `-fin-audit.sql`. |
| An ordinary incremental `Edit` that inserts an unsafe write **inside** an existing function | The hook analyses `tool_input.content \|\| tool_input.new_string` — the fragment alone. It does **not** reconstruct the full post-edit file the way `sql-safety.mjs`, `idempotency-body-check.mjs` and `status-enum-check.mjs` do via `edit-splice-lib.mjs`. With no function header, parameter list or `SECURITY DEFINER` attribute in the analysed text, the guard finds no candidate and allows. This is the *normal* editing path; the hook's own Edit-coverage test passes a whole function as `new_string`, so it does not exercise it. The sweeps do still see the applied routine. |
| Cross-routine / cross-migration helpers | **Not covered — and there is no "fail-closed callable rule" in the running hook.** The analysis is intra-routine and single-file, and the active guard only considers a routine whose own body contains a literal `INSERT INTO` / `UPDATE` (matched with a trailing space) / `DELETE FROM`. A `SECURITY DEFINER` wrapper that accepts `p_performed_by` and delegates the write to a helper therefore has no literal DML in its body and is allowed — confirmed by running the real hook, which returned `allow`. Neither sweep predicate follows the helper call either. Any fail-closed callable handling belongs to **parked PR #449**; do not rely on it. |
| Novel lexical spellings | The known-unknown. Three rounds each found a *new category*; the tool pattern-matches text, and PostgreSQL's grammar has more spellings than anyone will enumerate. |
| **A migration written by any tool other than `Write`/`Edit`** — `cat`/`tee`/redirect from Bash or PowerShell, or a generator script | **The guard never runs at all.** Both manifests register it under the matcher `"Write\|Edit"` only, and `bash-safety.mjs` blocks *modifying* an existing file under `supabase/migrations/` while permitting **creation** of a new one. Perfectly ordinary SQL with a forgeable actor therefore bypasses the guard on tool choice alone — no lexical trick required. This is the widest gap in this table and it is orthogonal to every other row: they describe SQL the guard mis-reads, this one describes SQL it never sees. The post-apply sweeps do still see the applied routine. |

**The finding that settled the cap.** PostgreSQL needs no whitespace before a quoted identifier, so
`CREATE OR REPLACE FUNCTION"public"."f"(` is valid SQL that the guard **never matched** — the security check
did not run on that routine at all. That one lexical fact defeated eight independent regexes written across
three careful passes.

**What actually protects this path** (do not treat the hook as load-bearing) — and it differs by residual:

- **For the incremental-Edit, novel-lexical and non-`Write`/`Edit` tool-path gaps** (rows 3, 5 and 6
  above): the exact-SHA `gpt-5.6-sol` proof on migration diffs and the CodeRabbit final review are the
  controls that always apply. The post-apply sweep predicates are a **partial, conditional** control here,
  not a third guaranteed one, and the condition must be stated rather than implied. They consider such a
  routine at all only because it carries no `ACTOR_MISMATCH` token — but they then fire only on their own
  sinks: the actor parameter near COALESCE/`auth.uid()`/role text, or a `financial_audit_log` write in the
  same statement. **A bypass that writes the forgeable actor to any other target, with none of those cues,
  clears both predicates without trying.** Do not describe any row here as requiring an attacker to clear
  all three controls.

  Two of these three rows need no cleverness at all, which is the point of the cap: an ordinary incremental
  `Edit` (row 3) and an ordinary shell-written migration (row 6) each bypass the *hook* with completely
  unremarkable SQL. "Deliberately obfuscated SQL" describes the novel-lexical row only, and even there it
  describes what defeats the hook, not what defeats the sweeps.
- **For cross-routine / cross-migration helpers** (row 4): **only the Codex proof and the CodeRabbit
  review.** Neither predicate can see this path. `actor-forgery.sql` needs actor/`auth.uid`/role proximity
  inside the *wrapper's own* `prosrc`, and `-fin-audit.sql` needs both the parameter and the
  `financial_audit_log` sink in that same source — but the wrapper only hands the parameter to a helper, and
  a private helper is not even a candidate, since both predicates require
  `has_function_privilege('authenticated', ...)`. Do not count the sweep here.
- **For the re-binding and laundering gaps** (row 2): **only the Codex proof and the CodeRabbit review.**
  Both predicates are gated on `prosrc !~* 'ACTOR_MISMATCH'`, so a re-binding that follows a passing check is
  excluded from the sweep by the presence of the check it defeated; and a temp-table round trip matches
  neither predicate's sink test. Do not count the sweep here.
- **For the naming-scope gap** (row 1): **only the Codex proof and the CodeRabbit review.** The sweep
  predicates key on the same `^p_\w*by$|^p_actor|^p_user` pattern, so they share the blind spot rather than
  covering it. Do not cite the sweep as the compensating control for a `p_target_id`-shaped parameter.

**Do not.** Do not open another pattern-hardening round (cite the DECISION_LOG entry and close the request).
Do not remove or weaken the hook — it is cheap and it catches the ordinary cases. If it is ever rebuilt, use
PostgreSQL's own parser (`libpg_query`) rather than more regexes; that removes the lexical category entirely
but still does not solve the naming-scope limit.

**Related open work.** PR #449 is parked with the 19 closed bypasses and 23 open review findings; it is worth
landing after one clean review round, as an improvement to a capped control rather than a resumed programme.
A third, unpushed regex attempt exists locally at `codex/actor-binding-guard-recut-20260831` (no PR) and
duplicates one of #449's fixes — delete it rather than continuing it.


## OPEN 2026-09-01 — F06: a reloaded chemical line loses which field the operator typed, so an acreage change blocks the save

**Plain English.** Open a saved job, change the acres, and a chemical line keeps both numbers it was
saved with. A line saved as **1.5 pt/ac, quantity 150, over 100 acres** still reads 1.5 and 150 at
**200 acres** — and 1.5 × 200 is 300, so the two numbers no longer agree. Saving is then refused and
the whole job save rolls back.

**The defect is the lost provenance, not the stale number.** Which figure is wrong depends on what
the operator originally typed, and the saved row does not record that:

| Typed | Correct line at 200 acres |
|---|---|
| the **rate** (1.5 pt/ac) | rate 1.5, quantity **300** |
| the **total** (150 pt) | quantity 150, rate **0.75** |

`applyChemEdit` back-solves the other field either way, so both histories produce an identical saved
row. **Do not "fix" this by re-deriving the quantity** — that silently rewrites an operator's typed
chemical amount. A heuristic testing `quantity == rate × acres` was tried and reverted as unsound
for exactly this reason; see `src/lib/chemCalculator.ts:91-96`. The clean fix is to persist the
`driver` field on `job_chemicals` so a reloaded line knows which side is authoritative, or to
surface the refusal on screen before the operator reaches it.

**Money impact.** Priced lines cannot misbill through `save_job`: it raises
`CHEM_QUANTITY_NOT_DERIVED` before any write. Unpriced cost-bearing lines have accepted paths where
a stale quantity saves and misstates margin. **The exact accept/refuse set is the control flow of
`supabase/migrations/20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql`** —
read the function, not its header comments and not this entry. Repeated review rounds on PR #538
went into paraphrasing that partition and got it wrong each time; the paraphrase is deliberately
omitted here.

**Where.** `src/pages/JobDetail.tsx:1765-1777` (an explicit "F06 IS STILL OPEN, DELIBERATELY"
block); `src/lib/chemCalculator.ts:75, 88` (the driverless branch returns the row unchanged).
`src/lib/chemCalculator.test.ts:723-727` **asserts the current behaviour**, so any fix must update
that test.

**Was tracked nowhere** before this entry — only in
`docs/audits/2026-08-20-codex-verdict-dryoz-guard.md` under a "Still open" heading and in source
comments. Surfaced by the 2026-08-31 documentation sweep (#529). Verified against `main` at
`85266c9a`.

---

## RESOLVED 2026-09-02 — H5: a dead-end "Create invoice" button on split-billing orders, and one surface swallows the reason

**Fixed 2026-09-02.** Both parts landed as a frontend-only change; no migration was needed. Part 1:
all four `IntegrityCleanupPanel` catch blocks now use `sanitizeError()`, so the server's sentence
reaches the operator instead of the literal `Backfill failed`. Part 2: the new shared predicate in
`src/lib/deliverySplitBilling.ts` mirrors the server guard's OR (flag OR allocation rows) and both
surfaces consume it, rendering the button disabled with the reason. `src/lib/deliverySplitBilling.test.ts`
fails if either surface re-derives the rule locally. Details and the observed browser proof are in
`docs/changelog.d/2026-09-02-h5-split-billing-invoice-button.md`. The diagnosis below is retained
because it documents the postgrest-js error-shape trap, which applies to any non-throwing Supabase
call.

**Plain English.** An admin is offered a "Create invoice" button on a delivery whose order needs
**split billing**, where it can never succeed. Nothing wrong is written — the database refuses
correctly — but on one of the two surfaces the operator is not told why.

**Two surfaces, and they behave differently.** The original handoff names both at
`docs/handoffs/2026-07-18-gauntlet-2-6-leftover.md:78`.

| Surface | Button gate | What the operator sees on refusal |
|---|---|---|
| `src/components/integrity/IntegrityCleanupPanel.tsx:684-689` | unconditional for every unbilled row | **"Backfill failed" — the reason is lost** |
| `src/pages/DeliveryDetail.tsx:1628-1636` | `isAdmin && status === 'completed' && !hasActiveRelatedInvoice` (never consults split allocations) | the full server explanation |

Both call `create_invoice_for_unbilled_delivery`, whose `ORDER_NEEDS_SPLIT_BILLING` guard is in
`20260718202607_backfill_invoice_guard_durable_split_allocations.sql`, re-emitted in
`20260719024641_lock_backfill_split_allocation_rows.sql`. It raises a full sentence with the remedy:
*"…a single backfilled invoice would mono-bill it and mis-attribute AR. Create the split invoices
through the split-billing flow instead."*

**Why one surface loses that sentence.** With `@supabase/postgrest-js` 2.112.4, a `PostgrestError`
(which *is* an `Error` subclass) is constructed **only** when `.throwOnError()` is used. An ordinary
`supabase.rpc(...)` returns the parsed error as a **plain object**. `IntegrityCleanupPanel:410` does
`if (error) throw error`, so its catch at line 416 evaluates `err instanceof Error` as **false** and
falls through to the literal `'Backfill failed'`. `DeliveryDetail` instead calls
`sanitizeError(err)`, which explicitly handles object-shaped Postgrest errors
(`src/lib/errorSanitizer.ts:72-82`) and preserves the message.

**The fix — two parts, both small:**

1. **Use `sanitizeError(err)` in `IntegrityCleanupPanel`'s catch**, matching `DeliveryDetail`. The
   helper already exists and already handles this exact case; do **not** build a code→message
   lookup table, and do not assume `err instanceof Error` after a non-throwing Supabase call
   anywhere else either.
2. **Hide or disable the button** for orders the guard will refuse, on both surfaces — ideally via
   one shared "can this delivery be single-invoiced?" predicate mirroring the server check, rather
   than two conditions that can drift.

**Severity: minor workflow defect, not cosmetic.** Nothing is miswritten and no money is wrong, but
the admin is offered an action that cannot succeed and, on the integrity panel, is not told why —
part 1 is a real information loss, which is more than a presentation problem.

**Was tracked nowhere** before this entry — only in
`docs/handoffs/2026-07-18-gauntlet-2-6-leftover.md`, a file headed "completed/superseded". Surfaced
by the 2026-08-31 documentation sweep (#529). Verified against `main` at `85266c9a`.

---

## OPEN 2026-08-26 — the quote-version trust chain is whole-body hash-pinned in THREE files; any re-emission must update every pin site in the same change

**Apply-order dependency with the PR #361 successor — SATISFIED, nothing wedged.**
`20260826220000_quote_version_restore_trust_boundary` was already applied (ledger `version`
`20260827113443`) before any of the `20260827041000`–`20260827041500` return-credit migrations went
in on 2026-09-01, confirmed by read-only live query that day. The required order was preserved, the
pending-set guard permitted each apply correctly, and no renumbering was needed. The original warning
below described the state as of 2026-08-25 and no longer applies:

> the merged-but-unapplied `20260826220000_quote_version_restore_trust_boundary.sql` must apply
> before the six pending `20260827041000`–`20260827041500` return-credit migrations. Reversing that
> order would move the high-water past the quote security migration and wedge it again. If the quote
> migration cannot apply first, it must be renumbered above the new high-water before either chain is
> released.

**Non-restocked return policy:** damaged or otherwise non-restocked returns still refund the customer,
but intentionally reverse zero COGS because no saleable inventory value returned to Crop RX. This is
the conservative direction: revenue falls while profit is not inflated by an inventory-value reversal.
The disposable PR #361 proof executes this branch and pins the credit to `-1000` revenue and `0` cost.

PR #401 rounds 8-10 pinned the ENTIRE normalized bodies (length + md5, normalization
`md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g')))`) of all five chain routines —
`create_quote_version`, `_restore_quote_version_below_cost_impl_20260810`,
`_create_quote_version_owner_impl`, `_restore_quote_version_owner_impl`, and the public
`restore_quote_version` wrapper. This is deliberate: a prefix/region pin left the tail open to
an appended `EXCEPTION` handler that could catch `QUOTE_VERSION_LEGACY_UNTRUSTED` and restore
legacy snapshots, and the wrappers trusted deeper links nothing pinned (all proven live
2026-08-26, both ways). **Consequence:** any future legitimate re-emission of ANY of the five
makes the standing sweep report a violation until its pin constants are recomputed against live
and updated in **all three pin locations in the SAME change**:
1. `scripts/db-invariant-sweeps/predicates/quote-versions-rpc-owned.sql` (the standing sweep —
   its violation reasons print expected vs measured values, so an operator can tell an expected
   pin update from a real bypass);
2. the immutable applied migration
   `supabase/migrations/20260826220000_quote_version_restore_trust_boundary.sql` as the historical
   pin source; future re-emissions must place the new precondition/postcondition pins in a new
   migration because applied migration files are never edited;
3. `src/lib/quoteVersionWriteBoundary.test.ts` (the mirror test, which binds each pin to its
   own predicate branch).
That forced review is the guard working, not a false positive.

## OPEN 2026-08-23 — `codex review <scope>` self-recurses, kills its own process, and exits 0

**Severity: HIGH. Not a crash — a silent false "gate passed".** `codex review --base origin/main`
run from the repo root loads `AGENTS.md`, `CLAUDE.md`, and `.claude/commands/codex-gauntlet.md`
as project context. Those files instruct an agent to "run a Codex review", so the reviewer follows
them literally: it spawns a **nested** `codex review`, enumerates `codex.exe` processes, sees
duplicates, and `Stop-Process`/`taskkill`s the tree — **including its own PID**. Reproduced twice
on 2026-08-23 during PR #447 (PIDs 39564 and 36244), identical both times.

**Why it is dangerous rather than merely annoying:** the pipeline still **exits 0**. `tee`
succeeds, the harness reports success, and the ~1 MB capture is almost entirely echoed context
files with no findings anywhere in it. Any check that reads exit status — a script, a hook, or an
agent in a hurry — records a clean Codex review when Codex reviewed nothing. That is precisely the
false-clean the gauntlet's `UNVERIFIED`/`BLOCKED` rule exists to prevent.

**Workaround (in place, documented in `.claude/skills/codex-review/SKILL.md`):** use
`node scripts/write-codex-push-proof.mjs`. It runs `codex exec` inside a sanitized
`%TEMP%\crx-codex-review-*` workspace holding only `BASE_SNAPSHOT`/`CANDIDATE_SNAPSHOT`, so there
are no agent-instruction files present to recurse on. It returned a real CLEAN verdict with cited
`file:line` evidence on the first try for the same diff that killed `codex review` twice.

The wrapper covers the `--base origin/main` scope only — its base is pinned to `origin/main...HEAD`
by design and it fails closed on a dirty worktree, so `--uncommitted` and `--commit <sha>` need a
committed branch or `/codex-cross-review` instead.

**The gate is the proof file, not the exit code and not the bare token** — the token also spells
`BLOCKERS`. The wrapper mints the proof only on a terminal `CODEX_PROOF_VERDICT: CLEAN`; no proof
for the current HEAD means not passed. Secondary check on the capture, matching `CLEAN` itself:

```bash
grep -cE '^CODEX_PROOF_VERDICT:[[:space:]]*CLEAN[[:space:]]*$' .claude/session-state/codex-review-latest.txt
```

`0` means no clean verdict. **Two drafting errors were made here on 2026-08-23 and both are worth
keeping visible**, because each is the same false-clean shape this entry is about:

1. The first draft grepped `CODEX_PROOF_VERDICT|^VERDICT:` — presence only, so it reported a pass
   on a `BLOCKERS` verdict. Caught by CodeRabbit on PR #448.
2. The correction then demanded *exactly* `1` match, reasoning from the parser's one-token rule.
   That rule governs Codex's stdout, not this capture file, which holds a structured section
   **and** the raw transcript — so a genuinely clean run reports `2` (verified at lines 18 and
   33671 of a real clean capture) and the "fix" would have raised a false alarm on every pass.
   Caught by running the command instead of reasoning about it.

**Prevention gap — still OPEN.** The fix shipped is documentation, which is soft scaffolding: it
advises, it does not block. The hard boundary would be a hook denying (a) a Codex session spawning
another `codex review`/`codex exec` and (b) `taskkill`/`Stop-Process` aimed at a `codex.exe`. No
such guard exists — `.claude/hooks/` has nothing matching either pattern today, and one of the two
kill attempts was stopped only incidentally, by the maintenance-producer guard reacting to the
command's shape rather than its target. Wiring that guard touches both hook manifests and needs
Mason's approval.

## RESOLVED 2026-08-26 — Phase 3C no longer walks top-level ignored tool bulk

**Severity: MEDIUM. Not a containment hole — a false refusal.** The pre-push hook
(`.husky/pre-push:7`) runs `scripts/check-supplier-pricing-phase3-private-artifacts.mjs`, which
enumerates ignored files at
`scripts/check-supplier-pricing-phase3-private-artifacts.mjs:1751-1752` and then stats and opens
every candidate through `scanWorktreeCandidate` (line 1797). The repository's own top-level
`dist/` build output is **not** excluded from that enumeration:

- `worktreeContainerToolOwnedExcludePathspecs` (line 1683) excludes `dist/` **only** where it sits
  nested under a registered worktree *container* directory — deliberately narrow, and it does not
  cover the checkout's own `dist/`.
- Line 1795 fully skips only `isOperatorOwnedIgnoredPath`. For `isToolOwnedIgnoredPath` (which is
  what `dist/` is, line 72) line 1796 only sets `checkArchives = false` — the file is still
  enumerated and still opened.

`scanWorktreeCandidate` runs a whole pre-open sequence — `lstatSync`, `statSync`, `realpathSync`,
`openSync`, then `fstatSync` (lines 605-686) — and **none** of it tolerates `ENOENT`. So if anything
rewrites `dist/` between enumeration and the stat — a dev server, a `npm run build`, a parallel
session in the same checkout — the scanner throws and the push is refused with a **misleading
"containment failed"**, which reads as "a private packet leaked" when nothing leaked. Phase 3C's
containment scan is ~98 seconds on its own, so the window is wide.

**Historical verification from source 2026-08-20** (the call chain and the missing exclusion,
cited above); the crash itself was **observed directly in an earlier session** and was not
reproduced here. At that time `dist/` files still received the structural-signature scan. The
resolution below deliberately changes that boundary for ordinary ignored descendants while
retaining the full scan once a file becomes Git-visible.

**Resolution and chosen boundary:** ignored-file enumeration now excludes descendants of the
guard's existing explicit top-level dependency/build/test-output roots. This deliberately gives up
structural scanning of ordinary ignored descendants under those roots. It does **not** exclude a
root endpoint, a nested lookalike, or anything Git can see: tracked, staged, force-added, index,
outgoing-commit, and history content remains scanned. The existing candidate double-read and
vanish/recreation checks are unchanged. The owning suite mutation-fails when this pathspec boundary
is removed and proves that a force-added private packet under every excluded root is still denied.

Measured on the same installed worktree, the real containment path fell from 434,901 ms to 37,468
ms overall (a 91.4% reduction in elapsed time), while worktree scanning fell from 405,535 ms to 220 ms.
These timings cover the real scanner path, not the separate exhaustive cross-platform regression suite.
Reopen this issue only if a Git-visible artifact under an excluded root escapes scanning, or if an
excluded root is widened without equivalent tracked/index/history and boundary regression proof.
## OPEN (WONTFIX for now) 2026-08-20 — `review-proof-guard` denies destructive shell commands that NAME a worktree path

**Severity: LOW — cosmetic, with a zero-cost workaround. Mason chose "document, don't fix"
(2026-08-20) after five review rounds found the fix more dangerous than the bug.**

**Scope: Claude-managed worktrees only.** Claude creates them at `<repo>/.claude/worktrees/<name>/`;
Codex worktrees live outside the repo (`~/.codex/worktrees/…`) and have no such collision — see the
Claude-only list in `scripts/agent-manifest-parity.mjs`. The guard is wired for both agents, but only
a Claude worktree path trips it this way, and the `permissions.deny` layer referenced below is
Claude-side (Codex is governed by `.codex/hooks.json`).

Every file inside a Claude worktree carries a `.claude` path component. `review-proof-guard.mjs`
protects any `.claude` component and cannot distinguish the repo's review state from an ordinary
scratch file under a worktree.
Introduced by `f3e06c52` (PR #423 round-3/5 hardening) — bisected, not guessed; the later ack-valve
commits `c64ea3d4` and `4b302050` are not implicated.

**Actual impact is much smaller than first reported.** *For this collision*, the guard fires only
when the command *spells out* the worktree path — the agent's shell already starts inside the
worktree, so relative commands avoid it: `rm -f scratch.tmp`, `rm probe-dir/x.txt`,
`mv a.txt b.txt` and `Write` (relative or absolute) all **ran live in a worktree**, while
`rm -f <full-worktree-path>\file` and `cd <full-worktree-path> && rm file` are denied. That is a
statement about the worktree collision, **not** the guard's complete matching rule — the guard
independently blocks commands naming `.claude` or `.claude/session-state` anywhere, and treats
`rm`/`mv`/`git clean`/`rsync --delete`, and `find` paired with `-delete`/`-exec`, as destructive
verbs *when the command also names the state directory*; the full rule is the
`review-proof-guard.mjs` row in `docs/reference/agent-guardrails.md`.

Four lookalikes are **different layers**, so relative paths do not help: `rm -rf`/`rm -fr` never run
at all (`permissions.deny` in `.claude/settings.json`); `git clean -f/-fd/-fdx` is blocked twice
over, by `permissions.deny` and by `bash-safety-lib.mjs`; a bare `find … -delete` is blocked by a
separate safety layer independent of the state-dir rule above (not `bash-safety-lib.mjs` — that
library allows it); and the blocked `Write` to `stop-wrap-ack.json` in the original report came from
a different hook (this guard deliberately allows that write — it is the designed acknowledgment
valve).

**Correction, PR #434 review (twice).** Successive drafts of this entry and of `gotchas.md` listed
`git clean -fd src`, then `rm -rf node_modules/.cache`, as allowed workarounds. Both were wrong, and
both were wrong the same way: verified against `review-proof-guard` alone rather than the whole
stack — `permissions.deny`, then the PreToolUse hooks, then the harness's own safety layer, any of
which can refuse a command. Every example is now something that was actually executed in a worktree.
**Run the command; do not reason about it.**

**Workaround (use this):** never name the worktree path in a destructive shell command. Recorded in
`docs/reference/gotchas.md`.

**Do not attempt a text-stripping carve-out.** Five successive versions were built on 2026-08-19/20
and each was reviewed by an independent `gpt-5.6-sol` high-effort pass. **Every round found at least
one real hole — eight in total**, each a different spelling of the same path: a trailing separator
consuming the whole target; `../..` traversal after the reference was blanked; a `$var` descendant;
a `/.` dot alias; `."."` quote-joined traversal; an *operand* named `cd`; cmd.exe `%VAR:~0%` and
`!VAR!`; and cmd.exe caret escapes `.^.`. All eight reached the repo's own review state, the
applied-source ledger, or a whole worktree's state directory. Each round's test suite was green over
the next round's hole, and mutation testing reached 14/15 without surfacing round 5. The root lesson:
**rewriting command text inside a security guard is the wrong mechanism** — the guard reasons over
shell text, and shell text has unbounded ways to spell one path. All eight spellings are now pinned
as denials in `review-proof-guard.test.mjs`, so a future attempt trips on them immediately.

**If this is ever worth fixing properly, ranked by risk:**
1. **Move worktrees out from under `.claude`** (e.g. `<repo>/../crx-worktrees/`). The collision
   disappears and no carve-out is needed — a configuration change, not security logic. *Unverified
   prerequisite:* the worktree location may be set by the Claude Code harness rather than repo
   config; check that first. Also touches `worktree-awareness.mjs`, `worktree-cleanup`, `fleet`, and
   needs the live worktrees drained.
2. **Strict allowlist** — apply a carve-out only when the whole command matches a deliberately
   boring grammar (one verb, literal paths, no quotes/globs/`$`/`%`/`!`/backtick/caret/dot-segments).
   Fail-closed by construction; a survivor is a false positive, not a hole.
3. **Resolve real paths** — tokenize, `path.resolve()` against cwd, compare against the protected
   directories actually on disk. The correct answer and the largest rewrite of a live security guard.

---

## OPEN 2026-08-19 — the per-product rate check in `blendMathValidator.ts` is still unit-blind

**Severity: LOW, warning text only, currently unreachable (0 rows in `blend_tickets` and
`blend_ticket_products` on live, verified read-only 2026-08-19).** The sibling total-volume defect
in the same file was fixed on 2026-08-19 via
[PR #426](https://github.com/masonwells1/CRX_Manager_V1.0/pull/426); this one was left
deliberately out of scope and is recorded here so it is not re-discovered as new.

`validateBlendMath` compares each product's `quantity` against `rate_per_acre × total_acres`
without ever comparing `unit` to `rate_per_acre_unit`. Both fields exist on `ProductData`, but the
rate arm reads neither. A product entered as 25 **Gal** at a rate of 32 **oz**/acre over 100 acres
is arithmetically correct — 32 × 100 = 3200 fl oz = 25 gal — yet the check compares the bare
numbers 25 vs 3200 and flags it. The mirror case hides a real error: quantities that happen to be
numerically close across different units pass silently.

Three things a fix must handle that the total-volume arm did not:

- `rate_per_acre_unit` is a **per-acre** string — the form's placeholder is literally `oz/ac` — so
  it will never match `unit_conversions.unit` directly. `chemCalculator.ts` already has
  `baseUnitFromRateUnit` to strip the `/ac` suffix; reuse it rather than writing a second parser.
- `rate_per_acre_unit` is **not always populated**: the recipe-load path in
  `ManualTicketCreate.tsx` hardcodes `rate_per_acre_unit: ''`, so recipe-derived rows carry none.
  A missing unit must skip the check, never be assumed to match.
- `unit_conversions` **can** legitimately serve this arm, unlike the total-volume arm: a rate and a
  quantity for the *same product* are usually in the same family, so `factor_oz` converts exactly
  within liquid or within dry. But the fix must still refuse the liquid↔dry crossing (no density
  column), must not treat `Ea`/`Unit` (`factor_oz = 1`, `unit_type = 'both'`) as convertible — they
  are a dimensionless count, and converting a jug count to fluid ounces 1:1 is nonsense — and must
  not join `LOWER(unit)` naively, because the case-alias rows (`Lb`/`LB`, `oz`/`Oz`, `qt`/`Qt`)
  duplicate on that join.

**Not started.** No migration, no live state, no money path. Fix alongside the next blend-ticket
change rather than on its own.

---

## OPEN 2026-08-20 — a zero-width character in a rate unit makes a ticket un-invoiceable, and only the SQL can fix it

**Severity: LOW-MED, currently unreachable (0 rows in `blend_tickets` and `blend_ticket_products` on
live, verified read-only 2026-08-19).** Raised as `CRX-MONEY-PARITY-001` by gpt-5.6-sol on
[PR #439](https://github.com/masonwells1/CRX_Manager_V1.0/pull/439) and then confirmed directly
against live `pg_proc.prosrc`.

**The finding, and the wrong turn that produced it.** [PR #426](https://github.com/masonwells1/CRX_Manager_V1.0/pull/426)
taught `normalizeUnit` to **delete** zero-width characters, so `g<ZWSP>al` reads as `gal`. That is
correct and stays: `normalizeUnit` only ever compares two client-side strings.

A first pass at PR #439 extended the same strip to `rateBaseUnit` on the theory that the money path
had been left unprotected. **That was backwards**, and the review caught it. `rateBaseUnit` is not a
client-side comparator — it is a *prediction of the server*, and the server does not close these up:

```
normalize_rate_unit := lower(btrim(COALESCE(p_unit,''))) + a CASE over known spellings
```

`btrim` strips **outer spaces only**. Live therefore returns `m<ZWSP>g` intact, matches no size
table, and `create_invoice_from_blend_ticket` raises `BLEND_TICKET_UNIT_UNCONVERTIBLE`. Stripping
zero-width client-side made the preflight **more permissive than the database it predicts**, turning
an accurate early warning into a silent ticket that fails weeks later at invoicing. The strip was
reverted before merge; the parity contract is now pinned by tests in
`describe('zero-width characters must not out-run the database')`, which go red if anyone re-adds it.

**So the remaining real defect is server-side.** An operator who pastes a rate unit out of a PDF gets
a correct-looking ticket that the database will refuse, and the warning naming the offending unit
shows two strings that look identical on screen. Nothing misbills — the RPC fails closed — but the
ticket cannot be invoiced until the unit is retyped.

**The fix is a migration, not a client change:** harden `normalize_rate_unit` to delete
U+200B/200C/200D (and decide the BOM and interior-whitespace cases at the same time), then relax
`rateBaseUnit` **in the same change** so the two never drift. Doing either side alone re-creates this
bug in one direction or the other.

Three adjacent parity gaps to settle in that same migration rather than piecemeal:

- JS `.trim()` strips the BOM (U+FEFF) and tabs; PostgreSQL `btrim` does not. Pre-existing, predates
  PR #439. (gpt-5.6-sol MED #2.)
- The live CASE lists `'fl oz'` with a single space; neither side collapses interior whitespace, so
  `'fl  oz'` matches nothing on either side. Consistent today, but by accident rather than design.
- **The invoice pre-flight stays silent when the rate unit or the sold unit is blank**, although the
  SQL calls its converter regardless and `normalize_rate_unit` returns NULL for an empty string, so
  live refuses that line too (gpt-5.6-sol MED #1). Warning on blank was **tried and deliberately
  reverted** on PR #439: client-side, an empty string does not reliably mean "the catalog has no
  unit" — it equally means *this caller never resolved the catalog row*, since the pages filter
  `allProducts` to `is_active` and an inactive product is simply absent. A live read on 2026-08-20
  says the innocent reading dominates: **0 of 595** active products lack a sold unit (25 lack a rate
  unit). Warning on blank would therefore mostly emit false "not recorded" notes from load gaps —
  the wallpaper effect the two-tier design exists to prevent. The real fix is to tell
  `validateBlendMath` whether the catalog row RESOLVED, instead of inferring it from an empty
  string; until then the server's fail-closed refusal is the backstop.

**Fixed on PR #439, not deferred:** gpt-5.6-sol MED #3 — the unit-family sets listed only US
spellings, so a total in `kg`, `g`, `l`, `ml` or their long forms matched neither family, ran no
total check at all, and said nothing about it. That was a silent hole and a regression against the
older same-unit sum comparison. The sets now track the live `normalize_rate_unit` CASE, and a total
unit that still belongs to no family earns an explicit `unchecked` note naming the unit.

**Narrowed, not closed (2026-08-23).** The two remaining free-text unit boxes — the Field App
Split Invoice Editor's rate unit and the Blend Recipes item unit — became `UnitSelect` dropdowns,
so on those two screens a unit can no longer be pasted or typed at all and a zero-width character
cannot enter that way. This changes the *reachability* of the defect, not the defect: the server
is still the only place that can fix it, and every other way a rate unit reaches the database
(the OCR path in `process-blend-ticket`, direct SQL, an import) is untouched. Do not read the
narrower entry surface as a reason to close this.

**Not started.** No migration written, no live state, and a live apply would need Mason's explicit
approval plus a migration review.

---

## OPEN 2026-08-19 — `baseUnitOfRate` reads `oz/cwt` as `oz`; the database refuses it

**Severity: MED, money path, not yet reproduced on live data.** `baseUnitOfRate`
(`src/lib/chemCalculator.ts`) strips a per-acre suffix by splitting on the first `/`
unconditionally, so any non-acre denominator collapses to its numerator: `oz/cwt` → `oz`.

The live `normalize_rate_unit` does the opposite. When a denominator other than acres is present it
returns the **whole string**, precisely so it cannot match a bare unit and the conversion refuses.

So for a rate unit like `oz/cwt` the client says "convertible, priced fine" while
`create_invoice_from_blend_ticket` raises `BLEND_TICKET_UNIT_UNCONVERTIBLE`. That is the dangerous
direction: nothing on screen, a hard failure at billing.

`baseUnitOfRate` is **not** confined to blend tickets — it is used by the job chemical grid, in code
whose own comments describe it as a P1 money fix. Whether any live rate unit actually carries a
non-acre denominator has **not** been checked, so the real-world exposure is unknown.

`blendMathValidator.ts` deliberately does its own suffix stripping rather than reuse this helper, and
documents why at `rateBaseUnit`. That sidesteps the problem for blend tickets only.

**Live `rate_unit` values checked 2026-08-22 (read-only).** All four `job_chemicals` rows carry
`pt/ac`, `oz`, `oz`, and the junk string `32`. **None has a non-acre denominator**, so the
real-world exposure on the job path is currently zero — but that is a fact about today's four rows,
not a guarantee, and free-text entry can produce one at any time.

**CLOSED — APPLIED LIVE 2026-08-25.** Migration `20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql`
(history row 891, merged as PR #446, applied to production 2026-08-25 as ledger version
`20260825142708` on Mason's explicit in-chat approval) makes `save_job` refuse a chemical line whose rate unit has a non-acre denominator, with
`CHEM_RATE_DENOMINATOR_NOT_ACRES`. That turns the dangerous direction — nothing on screen, hard
failure at billing — into a refusal at save time, naming the product and the offending unit. Proven
in a throwaway container: an `oz/cwt` line is refused and leaves no `jobs` or `job_chemicals` row.

**All three spellings are covered, and the word and hyphen forms are new findings.** The migration
refuses `oz/cwt`, `oz per cwt` *and* `oz-per-cwt`. A slash-only test was the first draft and Codex
blocked it (P1, 2026-08-23): a spelled-out denominator whose `unit` carries the same text
normalizes EQUAL, so the row was accepted with its quantity already derived against a non-acre
denominator. The hyphen form was the same escape one separator away and was found in the following
review round. The per-acre exclusion is plural-tolerant on both sides, so `gal per acres` still
saves. **The same gap exists in the client half on PR #436** — `rateDenominatorIsUnrecognized` ends
in `return raw.includes('/')`, so it flags neither the word nor the hyphen form. That is unfixed and
belongs to PR #436.

**A BLANK `unit` is now REFUSED when the line bills — settled by Mason, 2026-08-23.** The invariant
can only disprove what it can measure, so a blank unit on either side used to be *skipped* — while
`transfer_job_to_invoice` billed the line at `price_per_unit_cents x quantity` regardless. An
unprovable line that still bills is the same hazard class as a provably wrong one, so migration
`20260820120000` now raises `CHEM_UNIT_UNSPECIFIED` for it.

Three exemptions, all deliberate and all the same rule — a line that cannot bill cannot bill
*wrongly*, so refusing it would be pure friction: a `customer_supplied` line (contributes 0 to both
totals), a line carrying neither a cost nor a price, and a line whose quantity is 0. The test covers
the **cost** side as well as the price, because `total_cost_cents` feeds margin and not just the
customer bill.

The zero-quantity exemption is third for a reason worth recording. When the refusal was first
written, the zero-quantity skip sat *below* it, so a line with a blank unit, a filled-in price and
quantity 0 was refused — and because `performSave` re-sends the whole chemical grid, one such line
makes the **entire job** unsaveable, not just that line. It is reachable from the ordinary UI:
`reconcileChemAutofillUnits` leaves `unit` blank on its fallback path while the tier price is
already populated, so a product picked before any acreage is entered lands exactly there. Three
independent reviewers found it on the same round; the skip moved above the refusal, test `T20` pins
it, and a mutant that moves it back turns `T20` red by name.

**PRE-APPLY DATA OBLIGATION — SATISFIED 2026-08-24, and still re-run it before any apply.** Of the
four live `job_chemicals` rows, exactly one (JOB-2026-0002) carried a `pt/ac` rate, a **blank** unit
and both a cost and a price, so the new rule refused it. Mason chose to fix the data first and then
close the hole. **That correction was made on 2026-08-24 with his explicit OK** — one row, `unit` set
to `'Pt'` — and re-verified read-only: the count below now returns **zero**, and the job totals did
not move (`219930` / `278578` before and after), because the per-unit amounts were already quoted
per pint; only the label was missing. Behaviour test `T28` replays the corrected row and asserts
those same two totals, so the claim is proved by execution rather than asserted.

Do **not** treat that as retiring the check. "Zero rows today" is a property of the data on one day,
not of the migration: a legacy import, a hand-built RPC call, or any save made before this migration
applies can recreate the shape. Re-run this immediately before the apply and require **zero** rows:

**The query is deliberately NOT reproduced here. Copy it from the header of
`supabase/migrations/20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql`,
which is the only authoritative copy.** This page used to carry a second copy claiming to match it
"character for character", and on 2026-08-24 the exact-SHA gate found the copy had gone stale: it
was missing the fourth term, the one for a rate that is ONLY a denominator (`per acre`, naming no
unit at all). A stale pre-apply count fails in the worst direction — it reports a false zero, and
the apply then makes live jobs unsaveable. One rule written in two places is exactly how that
happens, so the second place is now a pointer instead of a copy.

What the query looks for, so whoever pastes it can sanity-check what they pasted: a **blank stock
unit**; a stock unit that is nothing but a per-acre denominator; a **rate unit** that strips to
nothing once its per-acre suffix is removed; or a rate unit that is only a denominator with no
leading separator — all counted only on lines that actually bill (non-zero quantity, not
customer-supplied, carrying a cost or a price). **Four terms. If the block you pasted has three, it
is the stale version.**

It took **four** versions to get right. The first three tested only a blank stock `unit`, so they missed the rate
side entirely: `normalize_rate_unit` returns NULL whenever its base strips to empty, which a rate
unit of `/ac` or `per acre` does — those rows are refused too, and a `unit`-only count reports zero
while a live row is still refused. Every wrong version failed in the same direction, which is the
dangerous one: it reads as "no operational impact on apply day" when in fact a job would become
unsaveable. All four versions happened to return the same **one** live row, so Mason's actual data
obligation never changed — but that was luck, not correctness.

Context that keeps the risk in proportion: the affected row belongs to a **test product** on a job
already in `invoiced` status, not to live customer work. Had it not been corrected, the cost would
have been one operator seeing a message naming the product and asking for the Unit — but one bad
line blocks the *whole* job, because the page re-sends the entire chemical grid on every save.

**A "narrower" option was floated and does not work — recorded so it is not re-proposed.** The
obvious softening is to refuse a blank unit only when the line carries a non-zero price. That buys
**nothing** here: the one live blank-unit row carries both a cost *and* a price, so the narrow gate
refuses exactly the same row as the broad one.

Test `T1` in `scripts/smoke/fixtures/save-job-chem-unit-tests.sql` replays that row's
**pre-correction** shape and asserts the refusal, so the obligation is pinned by an executable test
rather than by this paragraph; `T28` replays the corrected row and asserts it saves at the real
totals. `T1` is deliberately kept now that production is clean — deleting it because no row happens
to be in that shape today would retire the only executable statement of the policy. Note this does
**not** close the class on its own, because of the scope limit below.

**A SECOND, UNRELATED LIVE DEFECT IS OPEN IN THE SAME FUNCTION, and the same parked migration
closes it — `save_job` can create a DUPLICATE JOB, and can silently discard an edit.** Found by the
exact-SHA `gpt-5.6-sol` proof gate on 2026-08-24; live today, since nothing has been applied. This
is a defect in the idempotency handling, not in the unit invariant, and it is recorded here so it is
not re-discovered as new.

An *idempotency key* is the receipt number the app sends with a save so that a double-click, or a
retry after a dropped connection, records the work once instead of twice. The live `save_job` body
looks that key up with an unlocked `SELECT` filtered to `operation = 'save_job'`, then records the
receipt with `ON CONFLICT (idempotency_key) DO NOTHING` — but the live uniqueness constraint is
`idempotency_keys_idempotency_key_key`, on the **key alone**, not on the pair (verified read-only
2026-08-24). Those two facts together are the bug. A key already spent by a *different* operation is
invisible to the filtered lookup, so the job is created, the receipt INSERT is swallowed by the
conflict, and the **next** retry with that key finds nothing again and creates a **second job** — a
duplicate job is a duplicate bill. Two callers racing on one key could also both pass the unlocked
lookup.

The quieter half: even scoped correctly, a key+operation lookup matches on the key, so a key spent
by an earlier `save_job` and then reused for a **different job or an edited payload** returns the
earlier success. Nothing is duplicated, but the current request is never saved and the operator is
told it was — an edited quantity, cent amount or job header silently discarded. Any caller could
likewise replay another user's receipt. This is the identical defect shape already fixed for
commission payouts (finding 3.5 below, PR #378, applied live 2026-08-11).

Migration `20260820120000` closes both halves by routing the lookup through
`check_idempotency_intent(text, text, uuid, text)` — installed live and already called by nine money
RPCs (the whole return family plus create/post/void commission payment) — which advisory-locks the
key and binds it to the calling actor and to a sha256 fingerprint of the request. Cross-operation
reuse raises `IDEMPOTENCY_CROSS_OP_KEY_REUSE`, another actor's receipt `IDEMPOTENCY_ACTOR_MISMATCH`,
a changed payload `IDEMPOTENCY_INTENT_MISMATCH`; an unchanged retry still replays to the same job.
Tests `T26`, `T27`, `T29` and `T30` pin all four behaviours. **Parked with the rest of the
migration — the hole is open on production until it applies.**

**A THIRD hole in the same function, found 2026-08-24 and closed by the same parked migration: fluid ounces could be billed as dry ounces.** `normalize_rate_unit` collapses `fl oz` to `oz` without knowing the product's form. That is correct for a **liquid** product (`unit_conversions` records `oz` as "alias for fl oz", both liquid, both factor 1) and wrong for a **dry** one, where `oz` is a dry ounce — a weight — and `fl oz` is a volume. `field_app_priced_quantity`, the authoritative converter, refuses the pair outright: its dry branch sizes `fl oz` as NULL. The guard compared the normalised units **before** loading `product_form`, so a dry line with `rate_unit = 'fl oz/ac'` and `unit = 'oz'` compared equal, took the fast path, and billed with nothing proven — the guard being more lenient than the SQL that bills. Note an earlier round of this work examined this exact alias and cleared it; that clearance was right for liquids and never covered dry, which is why it is recorded here rather than treated as new. **The first fix was a HALF-fix and the gate returned the other half as a fresh HIGH.** Moving the form lookup above the equality shortcut closed only the shortcut. The path it missed is worse: `field_app_priced_quantity` is called with the **normalised** units, so `fl oz` is already `oz` before the converter sees it — handed the raw spelling its dry branch sizes it NULL and refuses, handed `oz` it sizes it 1 and converts **16:1 into pounds**. A dry line with `rate_unit = 'fl oz/ac'` against a stock `unit` of `'lb'` therefore does **not** normalise equal, skipped the new check entirely, went down the conversion path, and turned a VOLUME into a WEIGHT that the authoritative totals were derived from. The rule is now **unconditional**: on a dry product, a fluid-ounce spelling on either side is refused whatever the other side says. `T31`/`T32` pin the aliased pair both ways, `T37`/`T38` the conversion path, and `T33` pins that the LIQUID `fl oz`/`oz` pair still saves — the one line that must not move, because widening further ("the converter must agree") would refuse a liquid product priced in pounds and block whole jobs. **A test had to be INVERTED, and that is the durable lesson:** the half-fix round had written a test *requiring* the both-sides-`fl oz` dry shape to SAVE, on the reasoning that identical spellings are self-consistent. That froze the half-fix in place and would have defended it against the next reviewer. Self-consistent arithmetic in a unit the invoice cannot convert is not a saving grace. **No live product is in the refused shape** (read read-only 2026-08-24: the 85 dry products use `dry oz`, `lb`, `mg` and `oz`), but the compared units arrive in the RPC payload rather than from the catalog, so catalog cleanliness does not bound it. **A THIRD round was needed on this same rule, and it is the reason the rule is no longer a list.** The round-12 fix matched three literal spellings (`fl oz`, `floz`, `fluid ounce`). The gate returned `fl. oz` as a fresh P1: `normalize_rate_unit` has no arm for the period form, so it hands the string back unchanged, both sides of a dry line match each other, the equality shortcut fires, and the line bills with nothing proven. The app's own `src/lib/blendMathValidator.ts` states that periods are insignificant, so the client and server disagreed about what the operator typed. The rule now folds whitespace **and periods** on both sides and matches the fluid-ounce CONCEPT rather than an enumerated list; `T39` pins it. **A FOURTH round followed within hours, and it is the one worth remembering.** CodeRabbit found that the round-13 fold handled periods but not ZERO-WIDTH characters, so `fl<U+200B>oz` escaped exactly as `fl. oz` had — the same mistake twice running, because round 13 fixed the single spelling a reviewer named instead of adopting the complete rule the app already had. `src/lib/blendMathValidator.ts` defines the full lossless set (case; zero-width U+200B/200C/200D/FEFF deleted outright; any run of real whitespace including the non-breaking space; periods) and the guard now mirrors it exactly. Measured on live PostgreSQL 17.6, the round-13 expression missed five real forms. Zero-width characters are DELETED because they separate nothing (`fl<ZWSP>oz` must close up to `floz`); the non-breaking space is MAPPED TO A SPACE because it does separate, so the legitimate `dry<NBSP>oz` unit still saves — `T40` pins the refusal and `T41` pins that non-refusal, because widening a guard is never free. **Parked with the rest of the migration.**

**Scope limit: `save_job` is not the only writer.** The invariant binds `save_job` alone, but
`_close_quote_as_applied` (migration 20260703200000) and the recipe-pricing path (migration
20260618230000) both `INSERT INTO job_chemicals` with `cost_per_unit_cents` / `price_per_unit_cents`
and never run this check. A mismatched-unit priced line can still be created through those paths and
billed by `transfer_job_to_invoice`. "The database is now the boundary" is therefore true of the
job-save path and not yet true of the table.

**Still open after that migration applied:** (a) is now **closed** — `rateDenominatorIsUnrecognized`
in `chemRowDefects` landed with PR #436 (merged to `main` as `c302d296`), so the client half no
longer shows "convertible, priced fine" for an `oz/cwt` row; the server refusal is the backstop,
not the only signal. (`baseUnitOfRate` still collapses `oz/cwt` to `oz`, which is why the
server-side denominator test is deliberately wider — see the residuals in the handoff.) And (b)
the blend-ticket path is untouched — `create_invoice_from_blend_ticket` still raises
`BLEND_TICKET_UNIT_UNCONVERTIBLE` at billing time, and `blendMathValidator.ts` still does its own
suffix stripping.

---

## OPEN 2026-08-19 — blend-ticket unit fields are free text, so spellings drift

**Severity: LOW, data-quality.** The `unit` and `rate_per_acre_unit` inputs on
`ManualTicketCreate.tsx` and `BlendTicketDetail.tsx` are plain `<Input type="text">` boxes with a
placeholder, and a new product row starts with `unit: ''`. Nothing constrains an operator to the
vocabulary in `unit_conversions`, so `gallons`, `lbs`, `gal`, and a blank are all equally storable.

The Field App already solves this: `FieldAppChemicalEntry.tsx` renders a picker from
`unitOptionsForForm(unitConversions, product_form)` and uses `isKnownUnit` to grandfather existing
odd values. Making the blend-ticket fields use the same helpers is the real fix and would turn a
prose rule into a hard guard.

Until then the total-volume check fails safe: an unrecognised spelling or a missing unit produces a
"verify the total by hand" message instead of a comparison. That is deliberate — see the alias-map
comment in `src/lib/blendMathValidator.ts` — but it means an operator who types `gallons` on one
row and `Gal` on another loses the check on that ticket.

**Not started.** No migration, no live state, no money path.
## RESOLVED 2026-08-24 (opened 2026-08-19) — PR #404 stamps quote-line provenance, defers the FK, and settles superseded prices

**Status: RESOLVED — the reworked tier-split migration merged to `main` as the authoritative
artifact (PR #461) and was applied live on 2026-08-24 with Mason's explicit in-chat approval as
ledger version `20260825025241`, followed by its two successors (`20260825033106`,
`20260825034622`). See the rollout block at the top of `docs/reference/migration-history.md`.
The branch named below is a superseded draft; the description below is kept as history.**

**FIXED in the same migration — `restore_quote_version` REFUSES a drawn booking.** Found by
`rls-security-reviewer` and confirmed against live `prosrc`: `save_quote` was not the only path that
deletes and reinserts a quote's lines. `_restore_quote_version_owner_impl` does the same, and its
reinsert **omits the `id` column entirely** — every restored line takes a fresh
`gen_random_uuid()`, so no id is ever reused. Under the deferred FK that would leave every stamp
dangling at COMMIT and abort the restore with a raw foreign-key error, on a UI-reachable path that
works today.

**Mason chose option (A) — release the stamps — on 2026-08-19, and it was then REFUTED by the
`gpt-5.6-sol` gate the same day.** Releasing discards the telescoping rounding basis. Reproduced on
PostgreSQL 17.6: two 0.5-unit lines at `$1.01`, draw 0.5, restore to a single 1-unit version, draw
the rest → the customer is billed **`$1.02` against a booking whose own arithmetic says `$1.01`**.
`DRAW_MIXED_TIER_UNMATCHED_LINE` cannot catch it, because that guard fires only when the product
carries **more than one** distinct `(price, cost)` — and after the restore it carries exactly one.
The release also fired `after_order_items_change` → `trg_recalc_order_totals`, locking the order row
while restore holds the quote row, crossing the order→quote order that cancel/void takes.

**Mason then chose option (B), which is what ships:** restore raises
`QUOTE_RESTORE_BLOCKED_BY_DRAW` — a plain-English refusal — when the booking already has drawn
lines, **before** any destructive work. 

**Its real scope, stated accurately (Codex round 3 — an earlier version of this entry called it
"narrow", and that was wrong):** the check joins `order_items` **unfiltered by order status**, so
once a booking has **ever** been drawn it can never restore a version again — even if every draw
order was afterwards cancelled or voided, the quantity returned to `quote_product_draws` and the
booking reopened. Those reversed rows are retained for audit and still carry their stamp, so the
check stays true forever.

**Mason accepted that over-breadth on 2026-08-20 rather than narrow it.** Narrowing means letting a
reversed line past the guard, whose stamp would then dangle at COMMIT exactly as before — so
restore would have to **release** the stamps on those dead lines. Releasing is money-neutral for
them (a voided line is filtered out of `billed_stamped` and `v_unmatched` entirely; a cancelled
line contributes only its delivered quantity, zero here), but it puts back an `order_items` UPDATE,
which fires `after_order_items_change` → `trg_recalc_order_totals` and locks the order row under
the quote lock — the deadlock this rework just removed. Trading a rare capability for a
reintroduced lock cycle is the wrong trade. A regression case in
`scripts/smoke/smoke-restore-version-drawn-guard.sql` pins the accepted behaviour, so a later
narrowing must change this decision consciously rather than by accident.

What is unaffected: a booking never drawn restores freely, and editing the quote directly still
works on **any** booking, because `save_quote` reuses the same line ids and the deferred FK keeps
the stamps. Doing (A) properly means carrying the
line-level billing basis across a restore, which needs a real snapshot→live identity mapping — the
same missing capability `QUOTE_ITEM_AMBIGUOUS_COST` is about, and it gets its own PR.

**A second `gpt-5.6-sol` finding was a guaranteed-rollback blocker.** The postflight denied
`service_role` EXECUTE on the restore impl, copied from the draw impl. That is wrong for this
function: live carries `{postgres=X/postgres,service_role=X/postgres}`, a grant `20260813080000`
deliberately retained, and `CREATE OR REPLACE` preserves ACLs — so the assertion fired and rolled
the **entire migration** back on every attempt. It went unnoticed because the first rehearsal
created the function fresh, with no inherited ACL, so the check passed **vacuously**. The deny list
is now the browser roles only, and `service_role` is asserted **present** so an accidental REVOKE is
caught too.

**Proven on PostgreSQL 17.6 (2026-08-19; live never written to), with a fixture that reproduces
live's ACL exactly:** the old assertion trips on `service_role` (so the blocker was real and the
test is not vacuous) while the corrected one passes; the shipped body installs over that preimage,
the ACL survives `CREATE OR REPLACE`, and all four restore postflight predicates hold; the restore
writes `order_items` nowhere, so `after_order_items_change` cannot fire; a drawn booking is refused,
an undrawn one is not, the guard is scoped per quote, and the `$1.02` overbill is unreachable. All
15 money assertions still pass, re-lifted verbatim from the edited file.

**Also fixed in the same pass (both gate reviewers, 2026-08-19):** the migration locked
`quote_product_draws` before `order_items` while the draw path writes `order_items` first — a real
deadlock cycle against any in-flight pre-barrier draw, which neither the advisory key nor the
quiet-gate prevents (the quiet gate runs *below* those locks). The order is now
`quote_items` → `order_items` → `quote_product_draws`, matching the draw path, and the header's
false "no deadlock is possible" claim is corrected along with its lock count (six acquisitions,
~90s worst case, not three and ~45s). The FK postflight now also asserts `convalidated` and the
full key shape — proven by mutation: a `NOT VALID` constraint passed the old predicate and is
rejected by the new one. The price-partition tripwire now matches the `IS NOT DISTINCT FROM
ti.price` predicate rather than two identifiers that also appear in the file's own comments.

**Live facts confirmed read-only on 2026-08-19**, because the price partition depends on them:
`quote_items_price_per_unit_cent_scale_chk` and `order_items_price_per_unit_cent_scale_chk` are
both `convalidated` (so the price comparison is exact whole cents); `order_items.price_per_unit` is
NOT NULL with zero NULL rows; and there are zero cancelled orders carrying delivered units, so the
cancelled-branch money case stays dormant.

PR #404's tier split originally identified a price tier by the `(price_per_unit,
cost_at_quote_cents)` pair. That key is neither unique (two booked lines at the same price collapse
into one tier) nor immutable (three separate paths rewrite the cost snapshot), so attributing
already-billed units to tiers was a guess. The rework makes a tier **one booked quote line** and
stamps `order_items.quote_item_id` on every line the partial-draw path writes, so the next draw
resolves attribution by identity.

**The blocker that discovery surfaced, verified link by link against live on 2026-08-19.**
`_save_quote_below_cost_impl_20260810` begins every quote edit with `DELETE FROM quote_sections
WHERE quote_id = v_quote_id`, and `quote_items_section_id_fkey` is `ON DELETE CASCADE`, so that one
statement removes every `quote_items` row for the quote. `order_items_quote_item_id_fkey` was plain
`NO ACTION` and not deferrable (`confdeltype 'a'`, `condeferrable false`), so it is checked at the
end of that DELETE — before any reinsert. **Any stamped order line therefore made its quote
un-editable, with a raw foreign-key violation surfacing to the user.** `save_quote` carries no
guard that would catch this first: its body contains no reference to `orders`, `booking_draw`, or a
`QUOTE_LOCKED` refusal. Live blast radius before this migration was 1 stamped line of 288 (written
by the full-conversion path); after it, every partially drawn booking would be affected.

**Resolution: `ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`** — the check moves to COMMIT, by
which time `save_quote` has reinserted the same `quote_items` ids, so an ordinary revision leaves
every stamp intact. **This replaces the `ON DELETE SET NULL` rule an earlier draft of this entry
described, which was reviewed and found wrong.** SET NULL fires on *every* save of an existing
quote, including a save that changes nothing, so it wiped every stamp every time: that resets the
telescoping rounding basis (re-opening the fractional overbill the migration exists to close) and
strands a partly-drawn two-price booking behind `DRAW_MIXED_TIER_UNMATCHED_LINE`, whose message
tells the operator to undo a revision SET NULL has already made impossible to undo. The old draft
rejected DEFERRABLE on the belief that id reuse required the client to echo ids; live `prosrc` read
on 2026-08-19 shows that is wrong in both halves — no current page echoes ids, and `save_quote`'s
id-less fallback reuses prior ids without them. The constraint is matched **structurally on catalog
columns**, not on `pg_get_constraintdef` text, because that rendering depends on the applying
session's `search_path` and a text match could raise a false drift abort. A postflight asserts both
halves of the rule (still NO ACTION, now deferred), and the block refuses to adopt a SET NULL rule
if it finds one.

**Pricing rule (Mason, 2026-08-19): a price change never rebills delivered product.** Each tier's
billed history is partitioned by whether the order line was billed at the price the quote line
carries *today*. Units billed at the current price stay in the telescoping rounding basis. Units
billed at any other price are **settled**: they still consume the tier's capacity, so the product
cannot be re-sold, but they are never re-based and their money never enters the basis. New units
bill at the new price from a fresh basis. Genuine early-price errors are corrected with a credit
memo. A postflight name tripwire (`units_current` / `units_settled`) refuses the apply if that
split is ever dropped, because the failure is silent — the allocation still sums, so
`DRAW_ALLOCATION_MISMATCH` would not catch it.

**Residual, deliberately NOT fixed here.** `save_quote`'s id-less fallback reuses the *lowest*
unconsumed prior id for a product, not the operator's line. On a quote carrying two lines of one
product this is normally unreachable — re-saving such a quote already fails closed on
`QUOTE_ITEM_AMBIGUOUS_COST`. The one crack is deleting one of the two lines (which sends a single
id-less row, so the ambiguity test passes) while the two lines share a cost: one prior id never
returns, and if an order line was stamped with it the save aborts at COMMIT on a raw foreign-key
error. That is **fail-closed** — the whole save rolls back, no money moves, no stamp is silently
lost. Closing it properly means giving `save_quote` real line identity, which is the same defect
`QUOTE_ITEM_AMBIGUOUS_COST` already is, with its own blast radius and its own PR.

**Proof standing behind the rework (2026-08-19; live was never written to).** Ran on a throwaway
PostgreSQL 17.6 in Docker, the same version live runs:

- The reworked tier query — lifted **verbatim** out of the migration, not retyped — parses and runs.
- Seven money scenarios all pass against expected values: a price raised mid-booking bills
  `40 × $1.00 + 60 × $1.50 = $130.00`; four 0.25-unit draws on a `$1.01` unit still telescope to
  exactly `$1.01`; a price changed and changed back bills `80 × $1.00 + 20 × $1.50`; a two-tier
  booking with a price change between draws bills `100 × $1 + 50 × $2 + 50 × $3 = $350.00`; and a
  fully drawn line whose price is then changed is **refused** (`DRAW_ALLOCATION_MISMATCH`) rather
  than re-sold.
- **Mutation-tested:** restoring the pre-rework projection makes that first scenario bill
  `$150.00` instead of `$130.00` — a silent $20 rebill of 40 already-delivered units — so the
  scenario genuinely detects the regression rather than passing vacuously.
- The migration's **real FK `DO` block** was executed: it installs `confdeltype 'a'`,
  `condeferrable true`, `condeferred true`; it is idempotent on a second run; and it refuses a
  drifted `ON DELETE SET NULL` rule instead of adopting it.
- A `save_quote`-shaped delete-and-reinsert **preserves the stamp** under the new rule; the same
  shape **aborts** under the old non-deferrable rule and **silently wipes the stamp** under the
  retired SET NULL rule; and the residual case above **fails closed** with no orphan committed.

**(Historical pre-rollout note, superseded 2026-08-24.)** At review time the file had never been
applied end-to-end by a server — the preflight requires the cutover barrier (`20260816110000`)
committed in a prior transaction. That gap closed on 2026-08-24: the file applied live with Mason's
explicit approval as ledger version `20260825025241` and its preflight/postflight passed in that
committed transaction.

---

## OPEN 2026-08-19 — blend-ticket linkage picks ONE order line per product, which multi-tier orders break

Confirmed against live `pg_proc` on 2026-08-19. Not caused by PR #404 and not fixed by it; PR #404
makes the first one reachable more often by emitting several order lines per product.

1. **`link_blend_ticket_to_order`** attaches a blend ticket product to a single order line via
   `ORDER BY oi.sort_order NULLS LAST, oi.id LIMIT 1` and records the ticket's whole quantity as
   `quantity_applied` against it. On a tier-split order the product now has several lines, so the
   link lands entirely on the first tier. **Money impact is currently nil**: `quantity_applied` is
   written by this function and by `create_order_from_blend_ticket` and is read by nothing —
   no other function, and no frontend code outside type declarations and a test fixture. It is an
   audit/linkage record, so this is a correctness and traceability defect, not a billing one.
2. **`create_invoice_from_blend_ticket`** prices a ticket product from the quote with `SELECT
   qi.price_per_unit ... WHERE qi.section_id = ... AND qi.product_id = ... ORDER BY qi.id LIMIT 1`.
   `qi.id` is a random uuid, so on a booking with two lines for one product at different prices the
   invoice picks an **arbitrary** tier's price for the whole ticket quantity. This is a live money
   defect today, independent of PR #404 — multi-line bookings already exist as quote data whether or
   not the draw splits order lines. Deliberately not fixed in PR #404: it needs its own design
   decision about how a ticket quantity is split across tiers.

## CLOSED 2026-08-16 — CRX-SEC-1: a sales rep could forge a quote-version cost basis and inflate their own commission

**Severity: was HIGH (money + privilege). Closed live by `20260813080000_lock_quote_versions_writes_to_rpc`, ledger version `20260816174353`.** The apply is observed in the ledger; the commonly quoted clock time of 2026-08-16 17:43:53 UTC is **inferred** from that version stamp, because `supabase_migrations.schema_migrations` has no timestamp column. Recorded here on 2026-08-18 because it was never entered in this file while it was open, and because `docs/reference/migration-history.md` row 886 had gone on describing the migration as an unapplied local candidate for **two days** after it went live (2026-08-16 inferred apply → 2026-08-18 correction). That drift is fixed: row 886 has read **APPLIED LIVE** since the 2026-08-18 correction, and this sentence records what it used to say, not what it says now. The file was authored under the stamp `20260813080000`, five days before that correction; neither of *those two* intervals is six days. (The six-day figure in this file's header measures how stale the recorded ledger high-water was, which is a different quantity.)

**What the hole was.** `public.quote_versions` is an append-only snapshot table. Its RLS INSERT policy `qversions_insert` checked only *who owned the quote* — never what the row contained — and the browser roles still held raw table write grants, so a sales rep could PostgREST-INSERT a version row of their own construction onto their own quote. That became a money problem once `20260812115236` made `snapshot_data` an authoritative cost source: the restore path writes the snapshot's cost straight into the immutable `quote_items.cost_at_quote_cents`, `convert_quote_to_order` copies it onto the order line, and canonical profit and commission derive from there. The below-cost approval trigger added by `20260812115237` does **not** catch it, because that trigger compares the sale price against the *live product* cost — understating the historical cost basis raises apparent margin, so it never fires.

**What the fix does.** Drops the ownership-only INSERT policy, revokes the write-capable table grants from the browser roles, and leaves `qversions_select` and the authenticated SELECT grant untouched — reading versions is unchanged, writing them is reachable only through the reviewed SECURITY DEFINER RPCs.

**Post-apply live proof, read read-only 2026-08-18:** `public.quote_versions` carries exactly one policy, `qversions_select`; `qversions_insert` is gone; and `has_table_privilege('authenticated', 'public.quote_versions', …)` returns INSERT **false**, UPDATE **false**, DELETE **false**, SELECT true, with `anon` SELECT **false**. On grants, state the ACL and not a summary: `pg_class.relacl` is `{postgres=arwdDxtm/postgres,anon=m/postgres,authenticated=rm/postgres,service_role=arwdDxtm/postgres,metabase_ro=r/postgres}`. So `authenticated` holds SELECT **and MAINTAIN**, and `anon` holds **MAINTAIN** — an earlier draft of this line said "SELECT only" and "`anon` holds nothing", and both were wrong, contradicting the migration's own retained-MAINTAIN comment and the `anon=m` reading already recorded further down this file. MAINTAIN permits VACUUM/ANALYZE/CLUSTER/REINDEX/LOCK and can neither read nor write a row, so the write-lock conclusion stands unchanged; the error was one of evidence, not of security — `information_schema.role_table_grants` silently omits MAINTAIN, so reading grants there and calling it a complete proof overstates it. `metabase_ro` holds SELECT, has no policy, and does not bypass RLS, so it reads zero rows. **Write-path probe, independent of the grant read:** the only function in the database that inserts into `quote_versions` is `_create_quote_version_owner_impl(uuid,uuid,text,text)` — SECURITY DEFINER, postgres-owned, `search_path=public, pg_temp`, EXECUTE false for both `anon` and `authenticated`. Its only caller is `create_quote_version(uuid,uuid,text,text,bigint)`, whose parameters carry **no client cost snapshot** — the basis is built server-side — and whose body enforces `auth.uid()`, active-profile role, quote ownership and row version. No triggers on the table, no view over it, no UPDATE or DELETE writer, and `anon`/`authenticated` are members of no other role. No non-admin write path remains. The live ledger row stores this migration as a single statement that is **byte-for-byte identical** to the tracked file — `md5(array_to_string(statements, E'\n'))` on live returns `dd6554fa6f819f9e5b96b8244f73f8ee`, which equals `md5sum` of both the working-tree file and the committed blob, at 88,098 bytes on every side (the file is LF-terminated on disk, so no end-of-line normalization was applied). Matching lengths alone would not have proved this; the hash does. The file is on `origin/main`. A live exploitation check over existing rows came back clean when the fix was written — the migration's own header dates that re-confirmation **2026-08-14 UTC** and notes UTC runs one calendar day ahead of the local evening, so do not read it as 08-13; there are 3 `quote_versions` rows live.

**Not closed by this.** The migration file's own first line still reads `-- STATUS: NOT APPLIED`. That comment is stale. It is deliberately **not** corrected, because CRX Manager never edits an applied migration — trust history row 886 and the live ledger instead. Separately, this is the fourth time a migration's real live status was discoverable only by querying the ledger — a wider count than the "third occurrence" above, which counts only the cases where the file itself never landed; the durable "reconcile live ledger against tracked files" guard named in the prevention-gap entry above is still **not built**, and it is what would have caught this **two days** earlier (2026-08-16 inferred apply → 2026-08-18 correction), the same interval retracted above.

---

## CLOSED 2026-08-19 — the RLS matrices' *named roles*, verified cell by cell against live

**Severity: LOW-MED (documentation accuracy in a security reference; no live access defect
implied).** Two documents carry an RLS permission matrix: `docs/reference/database-schema.md` (79
rows) and `docs/workflows/RLS_SECURITY_GUIDE.md` (37 rows). PR #420 machine-compared both against
live `pg_policies` and fixed every **presence** disagreement — which commands have a policy at all
— so each cell's "grants something" vs "grants nothing" shape is verified as of 2026-08-19 UTC.

**The role wording inside each cell was a weaker claim; it has since been closed.** A second
mechanical pass re-derived each cell's role set from the live `USING`/`WITH CHECK` expressions and
corrected the unambiguous class — every cell claiming **"All authenticated"** where live is in fact
role-gated (`profiles`, `blend_tickets`, `blend_recipes`, `blend_ticket_to_order_items`,
`blend_ticket_fields`, `vendors`, `financial_audit_log`, `team_note_tags`, `field_app_locations`,
`field_app_location_shares`, plus `field_crop_history` and `notifications`, which the earlier
presence pass had already corrected), and `rate_limit_log`, whose three write cells had been
"corrected" *into* existence by a presence-diff that mistook a RESTRICTIVE policy for a granting
one.

**Flag counts, and why the number is a proxy rather than a defect count.** The classifier scans
**113 rows / 452 cells**. (113 = the 79 rows of the `database-schema.md` matrix plus the 37 of the
`RLS_SECURITY_GUIDE.md` matrix, minus the 3 whose table-name cell carries an inline annotation —
`product_cost_basis`, `product_cost_basis_change_rows` and `product_cost_basis_rollout` — which the
classifier's bare identifier match skips. 113 rows x 4 commands = 452 cells.) Measured at each
revision of PR #420:

| Revision | Flags | What changed |
|---|---|---|
| `origin/main` | 162 | pre-PR baseline |
| `7d5d5d80` | 89 | after the presence pass (`a4b4e9ce`), which incidentally closed 73 |
| `21f29c4a` | 61 | role-wording pass — the "All authenticated" class, 28 cells |
| this commit | 33 | hand-triage of every remaining flag against live |

Earlier drafts of this entry quoted **89** and **61** with no baseline attached, which is why the 89
could not be reproduced against `origin/main`. Quote the revision with the count. And the count
tracks accuracy only loosely: correcting `rup_sales_records` SELECT from `Admin` to
`Admin / Sales Rep` — live is `role = ANY (ARRAY['admin','sales_rep'])`, so the fix is real —
*raised* the count by one, because the classifier detects roles by matching helper-function names
(`is_admin()`, `is_sales_rep()`, `is_applicator()`, `is_driver()`) and that policy inlines its
role test as a scalar subquery.

**All 33 remaining flags were read individually against live `pg_policies` on 2026-08-19 UTC and
are false positives**, in three families:

1. **Inlined role test.** A policy that spells out a `profiles.role` test as a subquery instead
   of calling `is_admin()` or `is_sales_rep()` reads as "no role named", so a cell saying `Admin`
   is right while the classifier flags it. Worked example: `email_log` INSERT is governed by the
   single policy `email_log_admin_insert`, whose `WITH CHECK` is `EXISTS (SELECT 1 FROM profiles
   WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = 'admin' AND profiles.is_active =
   true)` — quoted verbatim, because `docs/workflows/RLS_SECURITY_GUIDE.md` makes wrapping
   `auth.uid()` in a subselect a rule and an earlier draft of this line transcribed it away. The
   matrix
   cell reads `Admin` and is correct. Same family, inlined as `= 'admin'`:
   `ar_reminder_tracking` SELECT, `failed_notifications` (one `FOR ALL` policy covering all
   four commands), `team_note_attachments` DELETE, `vendor_bills` SELECT/INSERT/UPDATE,
   `vendor_payments` SELECT/INSERT, and the
   soft-deleted-rows policy on `vendors`. Inlined as `= ANY (ARRAY['admin','sales_rep'])`:
   `rup_sales_records`, `offline_action_receipts` SELECT, and the main `vendors` SELECT policy
   (`vendors` carries two policies — live rows for admin and sales_rep, soft-deleted rows for
   admin only). An earlier draft of this entry defined the family as `= 'admin'` only, which did
   not describe three of its own members, and listed the tables without commands. The commands
   matter: `ar_reminder_tracking` INSERT, `vendor_bills` DELETE and `vendor_payments` DELETE
   are governed by a bare `is_admin()`, so those cells name a role the classifier *can* see and
   are not members of this family.
2. **Role named by how the row is reached.** The `Driver` cells on `deliveries`, `delivery_items`,
   `delivery_photos` and `delivery_remainders`, where live is `assigned_driver = auth.uid()` — for
   `delivery_remainders`, the *original* delivery's assigned driver. Correct English, unmatched
   role name. (An earlier draft of this entry gave the column as `driver_id`; live is
   `assigned_driver`.)
3. **Deferred to another table's RLS.** One member: `invoice_items` SELECT, an `EXISTS` over the
   parent invoice carrying exactly the `invoices_select` predicate and no auth test of its own.
   An earlier draft also filed `offline_action_receipts` here. That was wrong — its `EXISTS` is
   over `profiles`, with `role = ANY (ARRAY['admin','sales_rep'])` inlined and an
   `actor_id = p.id` owner branch. It defers to nothing, and belongs in family 1. (The matrix
   cell itself, `Owner / Admin / Sales via sanitized RPC only`, is correct: `authenticated` holds
   no SELECT grant on the table, so the permissive policy is unreachable from the browser.)

**What the hand-triage corrected**, each verified against live `pg_policies` before the cell was
rewritten:

- `customers`, `delivery_items`, `delivery_photos`, `cycle_counts`, `rebate_programs`,
  `rebate_claims`, `prepay_applications`, `fields`, `email_log`, `note_tags`, `team_note_tags`,
  `note_activity_log` — cells naming a role live does not grant, or omitting one it does.
- `invoices` / `invoice_items` SELECT: live is `is_admin() OR created_by = auth.uid() OR
  salesman_id = auth.uid()`. There is no `is_sales_rep()` branch, so a sales rep who is neither
  the creator nor the assigned salesman cannot read the invoice; `Admin / Sales Rep` overstated it.
- `blend_recipe_items` writes: `is_admin() OR parent recipe.created_by = auth.uid()` — the same
  shape as the `blend_recipes` parent row this PR had already corrected. The child row was missed
  in that sweep.
- `applicator_licenses`: SELECT is `is_active_profile()` with no role test, and INSERT/UPDATE are
  `is_admin() OR is_sales_rep()`. The row was wrong in both directions at once.
- `field_billing_defaults` SELECT, `cycle_count_items` SELECT, `rup_sales_records` SELECT — live
  grants a role the doc omitted.
- `deliveries` UPDATE, `delivery_remainders` SELECT, `job_loader_worksheets` INSERT,
  `cycle_count_items` writes — the cell named the right roles but dropped a condition live
  enforces (delivery status `in_progress`/`completed`, the original delivery's driver,
  `created_by = auth.uid()`, parent count `in_progress`).
- That last shape is the one the classifier structurally cannot flag — the role names match, so
  nothing is raised — so a final sweep read every matrix cell that is a bare role list against its
  live expression, looking only for conditions the cell omitted. Six more turned up:
  `field_obstacles` INSERT (`created_by = auth.uid()`, so an admin cannot insert a row
  attributed to someone else), `vendors` and `vendor_bills` SELECT (`deleted_at IS NULL`),
  `invoice_shares` and `order_shares` SELECT (the parent invoice or order must also be
  un-deleted), and `team_notes` INSERT (an active profile as well as ownership).

**"All authenticated"** in both matrices means live `is_active_profile()`: signed in *and*
`profiles.is_active`. A deactivated profile is authenticated but denied. **One** cell newly reads
it: `inventory_holds` SELECT, which read `Admin / Sales Rep` on `origin/main`.
`team_note_attachments` and `team_note_comments` SELECT already read `All authenticated` there.
(An earlier draft named all three and said they had "rendered that same live expression as *Any
active profile*". Both halves are withdrawn: `git log -S` finds that phrase nowhere in
`origin/main`'s history — it existed only in branch-internal prose — and the other two cells did
not change.) That makes **17**
distinct table/command pairs carrying the phrase — 17 cells in the `database-schema.md` matrix and
8 of them repeated in `RLS_SECURITY_GUIDE.md`, 25 cell instances in all. An earlier draft of this
entry said "all 14 cells ... in both matrices", which was the count for one matrix described as
covering two. Every one was re-read on 2026-08-19 UTC and is governed by exactly one policy whose
`USING` is `( SELECT is_active_profile() )`. Both matrix banners now say so, and the claim can be
re-checked without the classifier:

```sql
select tablename, policyname, cmd, qual from pg_policies
 where schemaname = 'public' and cmd = 'SELECT' and qual like '%is_active_profile%';
```

That returns **27** rows live (2026-08-19 UTC), not 17 — every SELECT policy in `public` built on
`is_active_profile()`. The 17 are the subset whose tables the matrices carry; all 17 are in the
result.

**If this is ever re-run, do not bulk-apply the classifier's output** — that is exactly the mistake
that produced the `rate_limit_log` row. The classifier locates candidates; live `pg_policies` is
the proof.

**The classifier is not checked in.** It was an ad-hoc script run against a live `pg_policies`
snapshot, so the flag counts above cannot be reproduced from this repository alone — treat them as
a narrative of the sweep, not as evidence. Everything that actually rests on them is enumerated by
name instead: each false-positive family lists its members above, each corrected cell is named, and
every one can be re-checked with a direct read of `pg_policies` for that table.

---

## OPEN 2026-08-18 — the session-staleness hook measures disk filename stamps against a server-assigned ledger version

**Severity: LOW (latent silent skip; no incident observed).** `.claude/schema-registry.json` stores
`"migrations_high_water": "20260816174353"`. That value is a Supabase-assigned ledger **version**, not
a migration **filename** stamp — the same version/name split described in the CRX-SEC-1 entry above,
where a file authored `20260813080000` was recorded live as version `20260816174353`.
`.claude/hooks/session-staleness.mjs` then uses that value as the floor for disk *filename* stamps:
it walks `supabase/migrations/`, matches `^(\d{14})_`, and does `if (!m || m[1] <= String(highWater))
continue;`. The two sides are not the same clock.

That `continue` is only the candidate-window filter; files that survive it are then checked for name
membership against `_meta.applied_migration_names`, with a comment explaining that a pure name check
over all history was tried and rejected (~100+ historical ledger rows carry prefix-less names). The
skip still happens **before** the name check ever runs, which is what makes the finding real — but
quoting the numeric compare on its own makes the hook look simpler than it is.

**Why that can skip a real finding.** Because Supabase assigns the version at apply time, the recorded
high-water runs ahead of the authored stamp whenever a migration sits on disk before it is applied — by
three days in the CRX-SEC-1 case. Every migration file stamped at or below `20260816174353` is
therefore skipped without being checked, including a genuinely unapplied file that would change the
schema registry. The hook stays silent rather than reporting, which is the failure mode hardest to
notice.

**Not fixed here.** This was found during a documentation-only pass; changing hook logic belongs in its
own change with a guard test that fails before the fix and passes after. The fix is to compare against
the high-water **name** stamp, which `docs/reference/migration-history.md` records alongside the
version for exactly this reason, or to resolve the version to its name before comparing.

**Correction, 2026-08-19 — the fix is smaller than this entry first claimed.** An earlier revision
said the fix was "not a one-line hook edit" because `.claude/schema-registry.json` stores
`"migrations_high_water"` as a version "and nothing else, so the hook has no name to compare
against", leaving a choice between a registry format change and a live ledger read on an offline
path. **That premise is false, and it was the entire stated reason this was filed rather than
fixed.** The registry already stores `_meta.applied_migration_names` — 964 ledger names, 344 of
them carrying a 14-digit prefix — and it already contains
`20260813080000_lock_quote_versions_writes_to_rpc`. `session-staleness.mjs` already loads that
array (line 115) and already uses it for the membership check (lines 139-148). The name high-water is
therefore derivable in-process as the largest `^\d{14}_` entry of the array, which evaluates to
exactly the CRX-SEC-1 name the entry says is unavailable. No format change and no live read are
needed.

So the remaining work is local: compare disk stamps against that derived name high-water instead of
against the server-assigned version. It is still filed rather than patched here for the reason given
above — this is a documentation-only pass, and a hook-logic change belongs in its own commit with a
guard test that fails before the fix and passes after — but it is a bounded hook change, not a
registry redesign.

---

## CLOSED 2026-08-18 — RETRACTED: the "unexplained commission money change" was two approved, applied migrations

**This entry was first published in PR #420 as an OPEN production-money incident — "stored commission money changed on live and no statement has been identified as the cause". That framing was wrong and is retracted.** The writer was already recorded in this same file (the 2026-08-10 team-board closeout entry below, which names `reconcile_pending_commission_snapshots` and Mason's approval of it) and in `docs/CHANGELOG.md`. The entry asserted an absence without searching for the writer, which is the same overstated-evidence error as the `role_table_grants` grant claim retracted earlier on that PR. It is kept here, corrected, because the wrong version was published and because the attribution is worth having written down.

**What moved, and what moved it** (all verified read-only against live):

- `20260810183629_reconcile_pending_commission_snapshots`, **ledger version `20260810235207`**, applied live 2026-08-10 with Mason's approval. The ordering the rest of this entry depends on — that the reconcile post-dates the 2026-08-10 measurements — rests on that version stamp reading 23:52 UTC, which is an **inferred** clock time (the ledger has no timestamp column), not an observed one. It is an apply-time `DO` block running `UPDATE public.commissions SET order_profit = ROUND(COALESCE(o.total_profit, 0), 2), commission_amount = public.compute_commission_amount(o.total_profit, c.split_percentage)`, and it hard-asserts it wrote **exactly 11 rows** — precisely the two columns and roughly the row count in question. That statement takes both columns from **3 sub-cent rows to 0**, and closes **11 of the 12** basis gaps — but by two different mechanisms, and the quoted `ROUND(…, 2)` is only half of it. It rounds `order_profit`; `commission_amount` is computed from the **un-rounded** `o.total_profit`, and reaches whole cents because `compute_commission_amount` rounds internally — live `pg_proc.prosrc` reads `SELECT GREATEST(ROUND(COALESCE(p_profit, 0) * COALESCE(p_percentage, 0) / 100, 2), 0)` (`supabase/migrations/20260526151856_execute_full_codebase_ultra_review.sql:177`, originally `20260513020000_canonical_commission_math.sql`). Crediting the visible `ROUND` for both columns would be the same overstated-evidence error this entry exists to retract. Its declared scope treats paid, **cancelled**, deleted and payment-batched rows as immutable history, which is why the 12th gap — on a `cancelled` row — was left untouched by design.
- The single **`pending`** row that still carries a gap of exactly $0.01 re-opened *after* that reconcile. Its order header was last written **2026-08-12 15:47:57 UTC**, which is exactly the ledger version of `20260812115238_repair_historical_order_line_cents` (**`20260812154757`**, applied live 2026-08-12 with Mason's in-chat approval). That migration rewrites `order_items`; the canonical `trg_recalc_order_totals` trigger refreshed `orders.total_profit` in the same statement, and the commission snapshot was not re-derived alongside it.

So: 12 gaps → 11 closed by the reconcile → 1 `cancelled` left by design → 1 re-opened by the 2026-08-12 line repair = the **2 of 35** measured on 2026-08-18. Both writers are tracked, approved, applied migrations. Nothing moved outside a recorded decision.

**Correcting the "two independent measurements" claim.** The retracted entry offered the basis-gap movement (12/35 → 2/35) as independent confirmation that *commission* money was rewritten. It is not independent: that predicate compares `commissions.order_profit` against `orders.total_profit`, and the order side is rewritten by the `trg_recalc_order_totals` trigger, so the count can move with **zero** writes to `commissions`. Only the sub-cent measurement requires a commission write.

**What is genuinely still open, and it is small.** One `pending` commission carries a $0.01 stale basis inherited from the 2026-08-12 line repair, and one `cancelled` commission carries the materially larger historical gap (figure withheld — this repository is public). Neither is a new incident. Both are the already-tracked data debt: repairing them rewrites stored money, which remains Mason's separate decision.

**Note the durability gap.** `order_items` carries validated whole-cent CHECK constraints on `total_price` and `profit`, so those zeros cannot regress. `commissions` carries **no** whole-cent constraint on either money column (only `chk_commission_amount (commission_amount >= 0)`), and `quotes.total_cost` has none either. The commission zeros are a measurement, not an invariant.

**Decision owed by Mason.** Whether to add whole-cent CHECK constraints to `commissions.commission_amount` and `commissions.order_profit` now that both columns measure clean — which would make the current state enforced instead of merely observed — and whether to re-derive the one $0.01 `pending` snapshot. Both stay read-only until Mason approves a migration.


---

## RESOLVED 2026-08-24 (opened 2026-08-14) — `draw_down_quote` never rounds the weighted average PRICE, and the whole-cent guard rejects it

**Status: RESOLVED — the weighted average itself was eliminated by
`20260816120000_draw_down_split_order_lines_by_price_tier`, applied live 2026-08-24 as ledger
version `20260825025241` (one order line per booked price tier; the migration's postflight refuses
any body that reintroduces the averaging identifier). The description below is the pre-rollout
record of the defect.**

**Severity at time of finding: HIGH, live in production, currently latent (0 reachable rows).** Found by the
independent Codex review of PR #392 and re-verified directly against live `pg_proc` and live data
on 2026-08-14. **This is a defect in already-applied SQL — it is not caused by the recovery PR, and
it cannot be fixed by editing the recovered files, which must stay byte-identical to what ran.**

Live `_draw_down_quote_below_cost_impl_20260810` aggregates the quote lines of one product into a
quantity-weighted average price and a quantity-weighted average cost:

```sql
118    CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
119      THEN SUM(qi.price_per_unit * COALESCE(qi.total_units_needed, 0)) / SUM(COALESCE(qi.total_units_needed, 0))
...
126  INTO v_booked, v_wavg_price, v_wavg_cost, v_total_acres, v_unit_size
137  v_wavg_cost := ROUND(v_wavg_cost, 2);      -- cost settled to whole cents
176    v_wavg_price, v_wavg_cost, v_acres,      -- price inserted UNROUNDED
```

Line 137 settles the weighted **cost** to whole cents, behind a seven-line comment explaining
precisely why an average of several differently-priced lines lands on fractional cents. There is no
matching `v_wavg_price := ROUND(v_wavg_price, 2);`. The unrounded price goes straight into
`order_items.price_per_unit` at line 176.

Live `_enforce_below_cost_line` then rejects exactly that value — twice, at lines 40–41 and 148–149:

```sql
       OR NEW.price_per_unit <> round(NEW.price_per_unit, 2) THEN
      RAISE EXCEPTION 'INVALID_UNIT_PRICE_CENTS';
```

**Effect:** a quote with two lines of the same product at prices whose quantity-weighted average is
not a whole number of cents — one unit at $1.00 and two at $1.01 average to $1.00666… — cannot be
converted to an order at all. The booking-to-order transaction raises `INVALID_UNIT_PRICE_CENTS`
and rolls back. Not a money-corruption bug: the guard does its job and nothing wrong is stored.
It is an availability bug — a legitimate booking is refused with an opaque error.

**Reachability measured live 2026-08-14: 0.** No quote/product group in the database currently has
a fractional weighted average, so nothing is broken today. It is a trap waiting for the first quote
with mixed pricing on one product, which is ordinary business behavior.

**The obvious fix is wrong. Do not round the weighted average unit price.** Adding
`v_wavg_price := ROUND(v_wavg_price, 2);` alongside line 137 — mirroring what the code already does
on the cost side — makes the guard pass and silently mis-prices the line. The unit price is a
*derived average* that is then multiplied by the quantity, so rounding it moves the line total by up
to half a cent **times the quantity**, not by one cent. The direction follows the rounding: an
average that rounds **up** overcharges the customer, one that rounds **down** undercharges and eats
the margin. Both are wrong and both are silent. Measured in PostgreSQL 17 on 2026-08-14 with
the body's own expressions: a quote holding 1,000 units at $1.00 and 2,000 units at $1.01 has an
exact value of $3,020.00; rounding the average unit price to $1.01 and extending it produces
$3,030.00, a **$10.00 overcharge** that flows into order revenue, profit, commissions and audit. The
cost-side rounding at line 137 is not a precedent for this — a cost snapshot is not re-multiplied
the same way. **Round after extension, never a per-unit figure.**

Two attempts at this rounding fix were written and both are withdrawn, not applied:

| Migration | Branch | Status |
|---|---|---|
| `20260814194500_round_draw_down_weighted_unit_price.sql` | `claude/draw-down-price-rounding` | **BLOCKED** by its own adversarial push-proof gate for this defect; unpushed, no PR |
| `20260814210000_reconcile_draw_down_owner_and_price_rounding.sql` | `fix/draw-down-weighted-price-rounding` | **WITHDRAWN AND DELETED** 2026-08-14 — it merged the defect with the ownership fix and would have carried the mispricing forward |

**The collision is dissolved, but a second blocker applies to everything here.** These two files
previously collided with the ownership migration because all three `CREATE OR REPLACE` this function
and each preflight pins the *current* live `md5(prosrc)`, so the second to apply fails closed. With
both rounding attempts withdrawn, only one pending migration touches this function —
`20260813161614_restrict_draw_down_quote_owner.sql` on `claude/restrict-draw-down-owner` — and it no
longer needs reconciling with anything. It is a separate, sound security fix (quote ownership plus
soft-delete exclusion), unaffected by the rounding defect.

**CORRECTED 2026-08-16 — the source-control blocker is dissolved.** This section originally said no
tracked migration defined `_draw_down_quote_below_cost_impl_20260810` or the five-argument
`draw_down_quote` wrapper, so every candidate's `md5(prosrc)` preflight pinned a body that existed
only in the live database and could never survive a clean rebuild. That was true when written and is
false now: PR #392 merged on 2026-08-15 — the recovery tracked in the CLOSED section immediately
below — and both definitions are on `origin/main`, re-verified there on 2026-08-16:

| Definition | Tracked at |
|---|---|
| four-argument body (the one later renamed) | `20260812115236_quote_items_cost_at_quote_snapshot.sql:1516` |
| `RENAME TO _draw_down_quote_below_cost_impl_20260810` | `20260812115237_enforce_below_cost_admin_approval.sql:779` |
| five-argument `draw_down_quote` wrapper | `20260812115237_enforce_below_cost_admin_approval.sql:815` |

A clean rebuild now reproduces both bodies, so the `md5` pins are satisfiable from source rather than
only from live state. `20260813161614_restrict_draw_down_quote_owner.sql` is therefore unblocked on
this ground. Confirm the pinned hash still matches live at apply time — recovery restores the source,
it does not by itself prove the live body has not since drifted.

**SUPERSEDED 2026-08-20 — do not apply or rebuild `20260813161614`.** The pending
`20260819232000_bind_draw_down_receipts_to_intent.sql` successor preserves the owner-approved
authorization boundary (active admins and sales reps may cover any live booking), keeps the
soft-delete exclusion, and replaces the public five-argument wrapper while moving the reviewed money
implementation behind an owner-only private function. The old ownership draft's owner gate was
rejected, its remaining soft-delete change is already delivered by both the tier-split migration and
the successor wrapper, and its live-body `md5(prosrc)` pin cannot match after that wrapper cutover.
It is fully superseded: never "repair" it into a later `CREATE OR REPLACE public.draw_down_quote`,
because that would overwrite the actor binding, required-key guard and receipt binding. All four
migrations in the chain — the barrier and its three successors — are now applied live (the barrier
on 2026-08-24 midday, the remaining three later that day with Mason's explicit approval — see
`docs/reference/migration-history.md`); the do-not-rebuild instruction above still stands.

**THE FIX IS THE TIER SPLIT, NOT THE ROUNDING — Mason changed his answer on 2026-08-16, and the
later answer governs.** Two options were put to him. The first, at 09:51 Central, was mine: keep the
exact line total and round only the stored unit price. He answered "Option a". Later the same
morning a concurrent session re-explained both options and he chose the other one — **write one
order line per booked price tier and stop averaging them at all**. That session's work is
`supabase/migrations/20260816120000_draw_down_split_order_lines_by_price_tier.sql` on branch
`claude/draw-down-price-tier-lines` (PR #404, commits 11:59–13:16 Central). The canonical record is
the 2026-08-16 entry "Draw-down writes one order line per booked price tier" in
`docs/manual/DECISION_LOG.md`.

**The rounding fix is therefore withdrawn and must not be built.** Both branches that attempted it
are already dead (table above). A third attempt would `CREATE OR REPLACE` the same function as the
tier-split migration, and each preflight pins the *current* live `md5(prosrc)`, so whichever applied
second would fail closed — the collision this file has been tracking all along.

Why the split is the better answer, in one line: rounding a *unit* price and then multiplying it by
the quantity moves the line total by up to half a cent **per unit**, so on a large mixed-price
booking it is a real mispricing in whichever direction the average happens to round — an overcharge
when it rounds up, a silent margin loss when it rounds down. Splitting the lines removes the average
entirely, so every unit is billed at a price the customer actually booked and there is no per-unit
figure left to round; the existing post-extension rounding of the line total stays exactly as it is.

Three facts verified against live `pg_proc` and live catalogs on 2026-08-16 stay recorded, because
the tier-split migration depends on the second one and a future change to any of them is a
regression risk on this path:

1. `draw_down_quote` computes `v_line_total := ROUND(v_wavg_price * v_qty, 2)` — the total is rounded
   **after** extension, never before. That ordering is preserved by the tier-split
   (`ROUND(v_tier.price * v_take, 2)`) and must not be inverted.
2. `_enforce_below_cost_line` re-derives `NEW.total_price := round(NEW.price_per_unit *
   NEW.total_units_needed, 2)` **only** when the operation is one of `create_direct_order`,
   `bulk_import_order`, `update_order_items`, `price_order`. The five-argument `draw_down_quote`
   wrapper declares the operation `draw_down_quote`, outside that list, so the per-tier price and
   cost written by the draw survive the trigger. **If `draw_down_quote` is ever added to that list,
   the tier split's snapshot costs get overwritten with today's catalog cost.**
3. `trg_order_items_round_money` → `_round_money_to_whole_cents` rounds `total_price` and derives
   `profit`, but never touches `price_per_unit`. No CHECK constraint ties `price_per_unit * qty` to
   `total_price`.

Mason's decision 2026-08-14 was to log this bug and fix it separately rather than entangle it with
the recovery PR. **(Historical: the "no migration here is approved for apply" caveat that stood
with this entry is superseded — see below.)** Do not re-diagnose this from scratch; the live
evidence is above.

**Status of the tier-split candidate: APPLIED LIVE 2026-08-24** (superseding the LOCAL CANDIDATE
status this paragraph carried before the rollout). Both required gate reviewers returned zero
blockers and a further adversarial pass found one HIGH, since fixed in-file (a draw against a
soft-deleted booking — see the CRX-RLS-001 note on row 887); every scenario was re-proven
end-to-end on throwaway PostgreSQL 17 databases before the apply. On 2026-08-24, with Mason's
explicit in-chat approval and fresh apply-guard + Codex proofs, it applied live as ledger version
`20260825025241`. Row 887 of `docs/reference/migration-history.md` carries the file's pinned SQL
hash and the apply record.

The first rounding attempt's branch, `claude/draw-down-price-rounding`, was deleted on 2026-08-16;
its tip is preserved as tag `abandoned/draw-down-price-rounding` so the abandoned work stays
recoverable without a live branch inviting a third attempt.

**Ignore the contrary record on `claude/known-issues-drawdown-defect`.** That local-only, unpushed
branch records the opposite choice ("keep the exact line total, round only the stored unit price")
and attributes it to Mason, who did not make it. It has no pull request and cannot reach `main`. One
finding on it is genuine and worth keeping: the live ledger's ordering high-water must be read from
the `name` stamp, not `max(version)` — on 2026-08-16 those read `20260813070000` and
`20260813011751` respectively, a three-day understatement.

---

## CLOSED 2026-08-13 — six migrations applied live on 2026-08-12 have no file on `main`

**Severity: was MATERIAL — resolved by PR #392 (files landed on `main`).** Six migrations
were applied live on 2026-08-12 from another session and their files are absent from
`origin/main` (verified by `git ls-tree` against the live ledger on 2026-08-13):

| Submitted name | Ledger version |
|---|---|
| `20260812010000_blend_ticket_order_header_runtime_assert` | `20260812034831` |
| `20260812011000_restore_quote_version_whole_cent_money` | `20260812034951` |
| `20260812115235_snapshot_cost_reporting` | `20260812145628` |
| `20260812115236_quote_items_cost_at_quote_snapshot` | `20260812151606` |
| `20260812115237_enforce_below_cost_admin_approval` | `20260812154028` |
| `20260812115238_repair_historical_order_line_cents` | `20260812154757` |

CLOSED by PR #392 (2026-08-13): the recovery branch `recovery/live-no-file-six` merged into
`main`, landing all six files under `supabase/migrations/` (history rows 880-885, recovered
verbatim from the applying sessions' transcripts and md5-verified against live `pg_proc.prosrc`).
`20260812130145_bind_return_receipts_to_intent_and_restore_overdue` and
`20260813070000_pin_return_idempotency_helper_contract` from the same window were already on
`main` and were never part of this gap. **The prevention gap remains OPEN** — see the header
paragraph above: nothing yet reconciles the live ledger against tracked files automatically, and
this was the third occurrence.

---

## OPEN 2026-08-12 — `20260813060000`'s guarded-function set has a fragile membership rule

**Severity: LOW, but it is a live tripwire on an unapplied file.** The delivery-before-billing
migration `20260813060000` asserts over a set of four function names. `_save_invoice_scoped_impl`
qualifies for that set only because the string `'posted'` appears in its body — and in the current
body it appears inside a **code comment**, not in executable SQL. `20260813040000`, which rewrites
that function, deliberately preserves the comment.

The migration is therefore one comment edit away from silently dropping a function out of its own
assertion set. Nothing is wrong today and the two files are consistent as written; this is recorded
so that whoever next edits `_save_invoice_scoped_impl` knows that deleting an innocuous-looking
comment changes what `20260813060000` checks. The durable fix is to select that set by a structural
property rather than a substring match, which is a rewrite of an unapplied file and not worth doing
mid-wave.

---

## FIXED LIVE 2026-08-11 — blend-ticket order creation could be rejected by the whole-cent CHECKs

**Severity: latent, not currently firing.** `create_order_from_blend_ticket` accumulates `v_total_price` and `v_total_cost` as raw `price * converted_quantity` products and writes them, plus `total_price - total_cost`, straight to `orders` with **no rounding** (live body confirmed 2026-08-10; `orders` has no BEFORE-UPDATE rounding trigger — only status/lineage/commission-stamp triggers). History row 870 added `orders_total_cost_whole_cents_chk` and `orders_total_profit_whole_cents_chk`, both live and `convalidated`. A blend ticket whose unit conversion yields a fractional quantity therefore produces a sub-cent total and the final write is **rejected**, rolling back the whole RPC and failing order creation from `BlendTicketDetail` with a raw constraint error.

**Why it is not firing:** production holds **0 `blend_tickets` and 0 `blend_ticket_products`** (read-only count, 2026-08-10), so the path has never been exercised. All existing `orders` rows are whole-cent, which is why the constraints validated cleanly.

**Found by:** Codex P1 on PR #371, verified independently against live `pg_proc`, `pg_trigger` and `pg_constraint` rather than taken on trust.

**Fixed by** `20260811200000_blend_ticket_order_whole_cent_totals` (PR #371, merge `465458a0`), **applied live
2026-08-11 as ledger version `20260811220045`**. The fix deletes the raw header write rather than rounding it:
`after_order_items_change` → `trg_recalc_order_totals` has already written all four header columns from the
per-line values, rounding each on the way in, so the RPC now reads that canonical header back and returns it.
Rounding the accumulators instead would have kept two independent computations of the same number in the
codebase. The migration carries an apply-time `$verify$` block asserting exactly one overload and that
`after_order_items_change` is present, enabled, bound to `trg_recalc_order_totals()` and fires on INSERT.

**Proved by execution, not review alone.** `scripts/smoke/prove-blend-ticket-fractional-cents.mjs` runs the
whole thing in a network-isolated disposable PostgreSQL 17 container: it reproduces the CHECK violation
against the pre-fix body from `20260714230200`, applies `20260811200000` verbatim, and re-runs the chain to
`SMOKE_PASS_ROLLBACK` with whole-cent totals equal to the canonical sum-of-rounded-lines. It refuses to run
unless the post-fix body on disk still md5-matches the **pinned 2026-08-11 production snapshot** of that
function — a historical reading, not a live one: the prover's container runs with `--network none` and never
contacts production, so the match proves the repo has not drifted off what was applied, not that production
is unchanged since. Both mutation stages apply the migration as a single transaction and confirm it fails
closed **and rolls back** when the trigger is missing **and** when it is `REPLICA`-only — the latter is the
case a `tgenabled <> 'D'` check would wave through, because a replica-only trigger never fires in an origin
session.

### OPEN — residual run-time gap (CRX-MONEY-001-R): the trigger guarantee is APPLY-time only

**Severity: HIGH if it ever fires — silent wrong money, no error.** There is no run-time equivalent of the
apply-time check. The fixed body reads the header back with `SELECT … INTO v_total_price` followed by
`IF NOT FOUND`, but the `orders` row always exists by that point, so `FOUND` is true even when the trigger
never ran. Stage F of the prover characterizes this: with the fixed body in place and
`after_order_items_change` dropped, the RPC **reports success and books a zero-value header** — nothing
raises, and only the smoke chain catches it.

- **Owner:** Mason to schedule; unassigned until then. Not scheduled into a current branch.
- **Trigger condition:** requires the recalculation trigger to be dropped or disabled. It cannot occur on
  its own, and `20260811200000`'s `$verify$` block blocks the migration path into that state.
- **Mitigation (the fix, when scheduled):** assert inside `create_order_from_blend_ticket` that the header
  it read back is non-zero and equals the sum of rounded line values, and raise instead of returning.
  Same shape applies to every RPC that reads a trigger-maintained header back.
- **Monitoring until then:** `scripts/smoke/prove-blend-ticket-fractional-cents.mjs` stage F is the standing
  detector and fails the prover if the behavior changes. A live-side check —
  `orders` rows where `total_price = 0` but priced `order_items` exist — is the query to run if a
  blend-ticket order ever looks wrong; production currently holds **0** blend tickets, so there is nothing
  to watch yet.
- **Do not** treat the apply-time guard as run-time protection.

---

## OPEN — `parseCents.ts` truncates excess fractional precision

`parseDollarsToCents` and `parseDollarsToCentsSigned` currently accept inputs with
more than two fractional digits and truncate them (`1.999` becomes 199 cents); the
focused test explicitly preserves that legacy behavior. This predates the
2026-08-10 exact-whole-cent policy. New or changed authoritative money paths must
parse decimal operands exactly and must not copy this truncation. Changing the
shared form-input helper needs a separate caller audit and UI decision: reject
excess precision or apply one explicit approved rounding rule. The documentation
prerequisite records the debt but deliberately does not change production input
semantics.

---

## CLOSED 2026-08-14 — Codex Supabase read-only guard withdrawn: write access is now the deliberate policy

**Found 2026-08-10; closed by owner decision 2026-08-14.** Mason explicitly approved
write-enabled Supabase access for Codex (see `docs/manual/DECISION_LOG.md`, 2026-08-14).
`.codex/config.toml` now declares `read_only=false`, and both guard assertions were
updated to pin the new declared state. The original finding below is preserved because
its core observation — the tracked entry's OAuth grant is dead and real traffic flows
through the separate `codex_apps/supabase` App — is still true and still matters:
enabling write for the App is a toggle in the Codex app's own connector settings that
only Mason can perform, and no guard in this repository verifies that channel's scope.

`check-agent-workflows.mjs:92` and `check-agent-guidance.mjs:121` both assert
that `.codex/config.toml` contains `read_only=true`, and that assertion is the
stated guarantee that Codex cannot write to the live database. The guard checks
that a **string is present in a file**. It does not check that the connection
that string configures is the one serving Codex's Supabase traffic.

On 2026-08-10 those two were observed to be different things:

- The `[mcp_servers.supabase]` entry in `.codex/config.toml` **fails to
  authenticate on every run** — `failed to refresh OAuth tokens for server
  supabase` / `invalid_grant: Grant not found`. Its OAuth grant is dead, exactly
  like the Sentry entry removed the same day.
- Meanwhile the Supabase calls that actually succeed are served by
  **`codex_apps/supabase`** — a separate built-in Codex App with its own
  independent authentication. Observed tool line:
  `mcp: codex_apps/supabase.list_migrations (completed)`, returning correct live
  data — migration name `20260810022500_backfill_stale_line_profit`, live ledger
  version `20260810025159` — verified against the live ledger from the Claude
  side. The two stamps differ because a migration's filename prefix records when
  it was written and its ledger version records when it was applied; they are
  different numbers for the same migration.

So the read-only assurance is asserted against a config entry that appears never
to have authenticated, while real traffic flows through a channel whose
permissions are **not verified by any guard in this repository**. Removing the
dead entry was attempted and reverted precisely because the guard failed — the
declared intent is worth keeping, but it should not be read as proof.

**What is NOT known, and was deliberately not tested:** whether
`codex_apps/supabase` is itself read-only. Establishing that empirically means
attempting a write against the production database, which is not an acceptable
test. A capability probe (asking Codex to list its Supabase tool names without
calling them) was attempted twice and produced no usable output.

**Closure (2026-08-14).** Mason decided Codex should have write access, which
dissolves the false-assurance problem: the repository no longer claims Codex is
read-only. Remaining owner action: if the `codex_apps/supabase` App is scoped
read-only in the Codex app's connector settings, Mason flips it there — no file
in this repository controls that channel. Operative safety note: the migration
apply-guard proof system gates Claude's applies only; Codex writes to production
are gated by Codex-side discipline (AGENTS.md hard rules and the standing
"Codex builds files, gated operator applies" workflow), not by a repo hook.

---

## RESOLVED LIVE 2026-08-10 — Team Board delegated completion and assignment notifications

Both migrations are applied live. `20260809130108_team_note_completion_rpc_and_assignment_notify` added the governed `complete_team_note` RPC and the assignment-notification trigger without widening the existing `tnotes_update` policy; live structure, grants, and the 26 standing invariant predicates passed. The HIGH that review then raised — an inactive profile with a still-valid JWT could satisfy the legacy `tnotes_insert` creator check and make the owner-run trigger notify an active teammate — is closed by `20260810010308_active_team_note_assignment_actor` (authored as `20260809154649`), which requires an active profile in the INSERT policy *and* independently in the trigger, leaving `tnotes_update` unchanged.

Proven live by rollback-only probes rather than by tests alone: an active non-admin **assignee completed a note they did not create** with `completed_by` stamped from `auth.uid()`; an unrelated active employee was refused with `NOT_AUTHORIZED_TO_COMPLETE`; a real deactivated profile with a valid token was refused at the RLS layer (42501); with RLS deliberately bypassed and the token subject set to that deactivated profile, the trigger's own guard raised `PROFILE_INACTIVE` (42501); and the normal path still filed exactly one `task_assigned` notification.

Delivery: the browser changes that call the RPC and open assignment notifications were contained in PR #351, which merged on 2026-08-10 (merge commit `8dcb82fb`). Closeout PR #372 merged as `261d10bd` on 2026-08-11; its Vercel production deployment completed successfully, and `/team-board` returned HTTP 200 with the app shell. The registered chain `scripts/smoke/smoke-complete-team-note-chain.sql` passed live with exact terminal `SMOKE_PASS_ROLLBACK` and rolled every synthetic fixture back.

---

## CLOSED 2026-08-11 — three migrations are live but their source files are not yet on `main`

> **Closed by PR #371 (merge `465458a0`).** All three files are on `main`, alongside
> `20260811200000`. Kept for history; the authoritative status is the header line at the top
> of this file. The "Closes when PR #371 lands" paragraph below was written before it merged.

Raised by Codex (P1) on PR #372 and verified at the time: the schema registry recorded
`20260810150000_commission_basis_from_canonical_order_header`,
`20260810150500_save_quote_whole_cent_total_cost`, and
`20260810151000_whole_cent_money_check_constraints` as applied — they genuinely were, live
since 2026-08-10 — but `git ls-tree` found none of the three `.sql` files on `main`. A clean
baseline replay or disaster-recovery rebuild driven from `supabase/migrations/` would have
silently omitted the canonical commission basis, the save-quote whole-cent total cost, and
all seven whole-cent money CHECK constraints, while the registry asserted they were present.
Nothing was ever wrong on live; the gap was between live and the repository's ability to
reconstruct it.

**Closed by PR #371** (merge commit `465458a0`), the home of all three files (history rows
868–870). `git ls-tree -r origin/main supabase/migrations/` on 2026-08-11 returns all three,
along with `20260810025159_backfill_stale_line_profit` and
`20260810235207_reconcile_pending_commission_snapshots`, which the header of this document
had separately reported as missing. `supabase/migrations/` on `main` is a complete
reconstruction source again for everything dated 2026-08-10.

**Standing lesson, hit three times before it closed:** a session that applies a migration
live and does not land its file leaves production ahead of the repository, and no existing
check warns about it.

---

## OPEN — agent tooling breaks in remote (Claude Code on the web) sessions

**Found 2026-08-04**, extended 2026-08-05. Three problems, two sharing one root
cause. None affect production; all affect an agent's ability to finish a session
from a remote container.

> **Update 2026-08-07 (reconciled when this entry merged with `main`):** since
> this was written, PR #313 (2026-08-05) relaxed both guards for sessions
> carrying only the two SSH-spelling rewrites, and removed the memory-backup
> script's blanket rewrite ban — see the two entries immediately below. Neither
> fix covers a container that *also* installs the credential proxy, which is the
> shape described here, so this entry stays OPEN. The entries below are the
> current, narrower statement of what still refuses and why.

**Root cause for (1) and (2): URL rewrites.** A Claude Code on the web container
reaches GitHub through a local proxy, configured in `/root/.gitconfig` as
`url."http://local_proxy@127.0.0.1:<port>/git/".insteadOf = https://github.com/`,
plus two more `insteadOf` rules injected as `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`
environment variables. Both of the repo's guards correctly treat URL rewrites as
dangerous — the container legitimately requires them.

1. **Branch delivery by git is impossible from a remote session.**
   `.claude/hooks/codex-push-guard.mjs` denies a push while `GIT_CONFIG*`
   variables are set ("Unset them before pushing"), and *also* denies a push
   command that names that namespace — so `env -u GIT_CONFIG_… git push …` is
   refused too. The guard is a PreToolUse hook reading the harness shell's own
   environment, so nothing done inside the command can change what it observes.
   There is no in-session workaround for the push that does not disable the guard.

   **Scope correction (2026-08-07, from the PR review that landed this entry):**
   these restrictions apply to **pushes only**. `codex-push-guard.mjs:81` passes
   every non-push command straight through *before* reaching the `GIT_CONFIG`,
   `HOME`, and repo-selector checks, and the tracked suite asserts the point
   directly — `codex-push-lib.test.mjs:857`: `GIT_CONFIG_COUNT=1 git commit -m x`
   is "not a push". An earlier draft of this entry said the guard refused
   `env -u GIT_CONFIG_… git …` in general and therefore blocked arranging a clean
   commit environment. That was wrong, and it would have told a remote agent to
   give up on a commit that is not actually gated.
2. **Committing is blocked too — two separate pre-commit tests fail.** Both run in
   the `test:correction-guards` gate:
   - `scripts/backup-claude-memory.test.mjs` — `stage()` refuses with "refusing to
     stage — Git URL rewrite settings are active (3 settings)".
   - `.codex/hooks/production-action-guard.test.mjs:318` — asserts "Claude guard
     still allows an ordinary feature-branch push", which fails because the guard
     correctly denies while `GIT_CONFIG*` is set. Confirmed 2026-08-05: this
     aborts `git commit` outright in a remote container.

   Both guards behave exactly as designed; the sandbox's proxy rewrite trips them.
   **Committing from a remote session therefore requires `HOME` pointed at a
   gitconfig that keeps `[user]`/`[gpg]`/`[commit]` but drops the `[url …]` block,
   plus the `GIT_CONFIG_*` vars unset for that one command.** Per the scope
   correction in item (1), the push guard does **not** forbid arranging that for a
   commit — both failing guards read the environment and gitconfig the command
   inherits, so a command-scoped sanitized environment should satisfy them. That
   is reasoning from source, not an observed run: nobody has yet proved it inside
   a live remote container, and the *push* stays blocked either way. Until someone
   demonstrates it, commit and push from a local machine.
3. **`scripts/log-session.mjs` misattributed a session's work.** — **FIXED
   2026-08-04/06** across PRs #310 and #317. It used to fall back to the last 15
   commits when no commit matched its `--author=Mason` heuristic, labelling the
   result "Commits this session" and "Migrations touched"; on 2026-08-04 it
   attributed 14 unrelated commits and 7 statement migrations to a docs-only
   session. It also folded the entire `--summary` string into the `##` heading,
   and a `--help` invocation wrote a `{SUMMARY}` template stub into
   `docs/CHANGELOG.md`. Commits are now scoped to `origin/main..HEAD`, migrations
   are never backfilled, `--help` exits without writing, and the heading is a
   short derived title. A git *failure* is no longer treated as an empty result —
   the script refuses to write rather than guessing. There is no time-window
   fallback of any kind: #317 removed the last one (a 12-hour window that #310 had
   merely guarded behind `HEAD === origin/main`, which left the common
   level-with-main case still claiming other people's merges).
   `scripts/log-session.test.mjs` guards all of it, and skips cleanly (with a
   stated reason) in checkouts that have no local `origin/main`.

**Net effect:** an agent in a remote session can analyse and edit, cannot deliver
a branch by git, and cannot commit either without the sanitized-environment
arrangement described above (untested in a live container). Work must go through the GitHub MCP tools
(`push_files` + `create_pull_request`), which address the repository by explicit
`owner`/`repo`/`branch` and so carry none of the destination ambiguity the push
guard exists to prevent. That route has its own ceiling: file content passes
through the tool call, so files in the hundreds of KB (`docs/CHANGELOG.md` is
977 KB, `docs/manual/KNOWN_ISSUES.md` is 108 KB) cannot be delivered this way at
all — which is why doc updates to those two files must be applied by hand from a
local machine.

**Fix options (not yet decided):** teach `codex-push-guard`, the memory-backup
guard, and `production-action-guard.test.mjs` to accept a known-safe proxy-rewrite
shape the way `GIT_SSH_COMMAND` already has a sanctioned keepalive shape; or gate
them on a detected remote-container marker; or leave as-is and treat the GitHub
MCP path as the supported remote delivery route. Mason chose **leave as-is** on
2026-08-04; the 2026-08-05 finding that commits are blocked as well (not just
pushes) may be worth revisiting, since it means a remote session cannot record its
own work in the two largest docs. See
`docs/audits/2026-08-04-test-coverage-analysis.md` for the session that surfaced
these.

## OPEN — the push guard AND the memory backup still refuse web/mobile sessions that install a credential-proxy rewrite

**Found 2026-08-05 by Codex on PR #313 (P2), reproduced and confirmed the same day. Needs an owner decision; see "the decision this needs" below. Codex found the second instance (`backup-claude-memory`) on the same PR after the first was parked — see "Second instance" below.**

PR #313 fixed the push guard denying *every* web/mobile session. It does not cover the variant where the session also installs a **credential-proxy rewrite** — the "third" rewrite noted in the RESOLVED entry below. Sessions carrying only the two SSH-spelling normalizations (`git@github.com:` / `ssh://git@github.com/` → `https://github.com/`) push fine; that is the shape the PR was developed and verified in, which is why it went unnoticed.

With a proxy rewrite of the form `url.http://<proxy>/git/.insteadOf https://github.com/`, `git remote -v` reports the proxy URL, so the guard's two reads disagree:

```
scrubbed decision: guarded-app github github.com/masonwells1/crx_manager_v1.0
ambient  decision: guarded-app raw http://proxy.invalid/git/masonwells1/CRX_Manager_V1.0.git
divergent keys   : ["dest"]
```

`pushDestinationKey()` only canonicalizes direct GitHub spellings and falls back to `raw <url>` for anything else, so `divergentPushLookups()` reports a divergence and the guard denies — including an ordinary `HEAD:feature` push. That blocks the branch→PR landing path in exactly the environment the guard was meant to unblock.

Reproduce: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='url.http://proxy.invalid/git/.insteadOf' GIT_CONFIG_VALUE_0='https://github.com/' git remote -v` in an HTTPS-origin checkout, then compare `pushDestinationDecision()` on the scrubbed and ambient URLs.

**Note both sides already classify the destination `guarded-app`** — `urlIsGuardedApp()` recognizes the proxy URL by path. The divergence is only in the identity half of the key.

**The decision this needs.** A fix means teaching the guard which rewrite targets count as "the same repository," and every obvious shortcut re-opens the fail-open this helper has already sprung five times:

- Comparing only the `guarded-app` boolean is the first draft that was rejected as too weak.
- Matching on the `owner/repo` path suffix would make any host with a matching path compare equal — a redirect to an attacker-controlled host would pass.
- Applying the unioned rewrite table to *both* reads makes them agree by construction, which defeats the divergence check entirely.

So it wants an explicit notion of an approved rewrite target rather than another patch to the key function. Deliberately not attempted on PR #313: it is a security-relevant change to a push guard, and **this session cannot verify a fix end-to-end** — it carries the two SSH normalizations and no proxy rewrite, so only unit-level proof is available here. Recommend fixing it from a session that actually has the proxy installed, so the real push path is the proof.

### Second instance — `backup-claude-memory` refuses the same way, for the same reason

**Found 2026-08-05 by Codex on PR #313 (P2), reproduced and confirmed the same day.** The RESOLVED entry below says the memory backup now runs from a web or mobile session. **That claim is narrower than it reads, and the entry has been corrected**: what was verified there is a session carrying the two SSH-spelling normalizations. A session that also installs a credential proxy still refuses.

`git remote -v` reports the proxy URL for the backup remote too, so the resolved push URL is `http://<proxy>/git/masonwells1/CRX_Backups.git`. `destinationIsPublishable()` gates the private-backup branch on `pushUrls.every((url) => canonicalRepoId(url) === BACKUP_REPO_ID)`, and the proxy URL does not canonicalize to that id, so the run falls through to the "not the off-site backup repo" refusal and stages nothing. Confirmed directly against the shipped helper:

```
ENTERS backup branch  "github.com/masonwells1/crx_backups"        <- https://github.com/masonwells1/CRX_Backups.git
ENTERS backup branch  "github.com/masonwells1/crx_backups"        <- git@github.com:masonwells1/CRX_Backups.git
REFUSES               "proxy.invalid/git/masonwells1/crx_backups" <- http://proxy.invalid/git/masonwells1/CRX_Backups.git
```

Same root cause as the push-guard instance above — no notion of an approved rewrite target — and the same safe failure direction: it refuses rather than writing private notes to an unverified address. Parked for the same reason, with one addition specific to this script: verifying a fix needs both a proxy-carrying session **and** a real private `CRX_Backups` clone to stage into, so the end-to-end proof is not available from an ordinary session at all. Fix both instances together; one approved-rewrite-target notion should serve both call sites.

### Third instance — the executable-config classifier misses `core.hooksPath` — (b) FIXED 2026-08-05, (a) still parked

**Found 2026-08-05 by Codex on PR #313 (P1), reproduced the same day. Two separate defects; Codex's report names one and reproduces the other.**

> **Update, same day:** **(b) is fixed.** The classifier and the mirror-remote
> check were hoisted above the `mainPushSource()` early exit, so both now run on
> every push form rather than only a main-bound one. The fix landed while fixing
> the mirror-remote parse on this PR — the two defects share one call site, and
> the mirror check was dead for the exact hazard its deny text describes. The
> hoist is safe for this repo precisely because **(a)** is still open: with
> `core.hooksPath` absent from `EXECUTABLE_TRANSPORT_KEYS`, the husky collision
> below does not fire. Verified: a real push from this checkout still passes
> through. **(a) remains parked on the approved-value work described below** —
> and adding those keys is now strictly gated on that work, since with the hoist
> in place a naive addition would deny every push from here immediately rather
> than only main-bound ones.

`EXECUTABLE_TRANSPORT_KEYS` in `.claude/hooks/codex-push-lib.mjs` names the settings that select a program to carry a push (`core.sshCommand`, `core.gitProxy`, `remote.*.receivePack`, …). Two omissions matter, because `git push` runs `pre-push` from `core.hooksPath`:

- **(a) The list is incomplete.** `core.hooksPath` and shell-form `credential.helper` are absent. On a **main-bound** push, `core.sshCommand` denies and both of these allow.
- **(b) The classifier is unreachable for any push that is not main-bound.** ~~The loop exits at the `mainPushSource()` check (`codex-push-guard.mjs:395`) before reaching the classifier at line 481.~~ On a feature-bound push, even `core.sshCommand` — which *is* in the list — allows. **Fixed 2026-08-05:** the classifier now runs before that early exit, so the reproduction below no longer holds for the feature-bound rows.

Reproduced against the shipped guard, plus a planted hook to prove execution is real:

```
--- MAIN-BOUND push (reaches the classifier) ---
  core.sshCommand:    deny
  core.hooksPath:     allow
  credential.helper:  allow
--- FEATURE-BOUND push (exits at guard line 395) ---
  core.sshCommand:    allow
  core.hooksPath:     allow

planted pre-push hook executed by git?  YES
```

Codex reproduced (b) and proposed a fix for (a) — "deny executable configuration keys". Applied literally, **that fix denies every push from this repository**, because husky legitimately sets `core.hooksPath=.husky/_` here:

```
Keys in THIS repo the proposed list would flag:
  core.hookspath=.husky/_
=> every push from this repo would DENY
```

That collision is why this is parked rather than patched. The setting cannot be refused by name the way `core.sshCommand` can: the repo's own tooling sets it, so the guard needs to tell the repository's own hook path from an inherited or absolute attacker path — which is the **same approved-value notion** the two rewrite instances above need, in a third place. Fix all three together.

**Value changed 2026-08-31 — still parked, but the approved value is now cleaner.** The repository-wide setting is `core.hooksPath=.husky` (the *tracked* directory), not `.husky/_`. The quoted reproduction above predates that change; the classifier gap it describes is unaffected, because `core.hooksPath` is still absent from `EXECUTABLE_TRANSPORT_KEYS` and still allows. What improves is the fix's shape: the legitimate value is now a single committed path that is present in every checkout, rather than a generated, gitignored one that is absent from any worktree that never ran `npm install`. See `DECISION_LOG.md` (2026-08-31, `core.hooksPath` entry) for why the old value was silently disabling the guards it was supposed to install.

Failure direction differs from the other two and is worth stating plainly: these **allow** rather than refuse, so this instance is a genuine hole rather than an over-refusal. It is bounded by the fact that setting the config at all requires the ability to run commands in the session already.

## RESOLVED — `backup-claude-memory` could not run from a web/mobile session

**Found and fixed 2026-08-04 (Mason approved the fix the same day). Same "presence treated as intent" shape as the push-guard regression fixed alongside it, in a different script.**

`scripts/backup-claude-memory.mjs` refused to stage the agent-memory snapshot whenever ANY `url.*.insteadOf` / `url.*.pushInsteadOf` rewrite was configured, on the grounds that a rewrite could silently replace the verified private-backup address before the push. Claude Code on the web ships such rewrites as a matter of course — two SSH-spelling normalizations (`git@github.com:` and `ssh://git@github.com/` → `https://github.com/`) plus, when a credential proxy is installed, a third. So the refusal fired on the ordinary case and the off-site memory backup could not be run at all from a web or mobile session. It passed on a laptop, which is why it went unnoticed.

**The finding that decided the fix: the ban was redundant.** `git remote -v` prints its `(push)` line with `insteadOf` AND `pushInsteadOf` already applied — byte-identical to `git remote get-url --push`, verified against git 2.43 for both forms. The script derives `pushUrls` from exactly those lines, so a rewrite that redirects the push *changes `pushUrls` itself*, and the existing repository-identity, credential, and transport checks were already judging the real destination and already refusing it. The blanket ban was not the control catching redirects; it was a second, cruder layer on top of the one that was already working.

So the ban was removed rather than reworked. What replaced it is a check that the redundancy is real: the script now asks git directly for each remote's push URL and requires that set to match the URLs it just validated, failing closed on any divergence, unenumerable remotes, or an unresolvable URL. If a future git version or configuration ever made `remote -v` show something other than the address git will contact, the run refuses instead of silently validating a URL that is never used.

Coverage: the three round-26 redirect cases still refuse (the local `pushInsteadOf` case now via the credential check, one step later and for a more specific reason, still without echoing the secret), and a new case proves the actual relaxation — an identity-preserving rewrite no longer blocks the run. 234 assertions pass. Verified in the real web session: `stage()` into a private `CRX_Backups` clone with the ambient rewrites active now returns 0 and reports `Destination verified`.

**Scope correction (2026-08-05, Codex on PR #313).** "The ambient rewrites" above means the two SSH-spelling normalizations this session carries — that is what was verified, and the resolution is real for that shape. It does **not** extend to a session that also installs a credential proxy: the proxy re-spelling makes the resolved push URL fail the `BACKUP_REPO_ID` identity check, and the run still refuses. Tracked as the second instance under the OPEN entry above. This entry stays RESOLVED for the rewrite shape it actually fixed rather than being reopened, since the blanket-ban removal it describes is sound and unaffected.

Also fixed alongside it: the suite itself read the host's global git config instead of pinning its own, so the ambient rewrites failed it — and since the pre-commit hook runs that suite, it blocked every commit from a web session. It now pins `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` to an empty file and strips inherited `GIT_CONFIG_*` at startup, so it tests the script rather than the machine.

## OPEN — the migration ordering guard cannot see applies from another checkout

**Found 2026-08-08 (Codex P1, PR #354).** The guard decides whether a migration
is out of order by reading a snapshot file of the applied ledger,
`.claude/session-state/applied-migrations.json`. PR #354 made an *apply*
invalidate that snapshot instead of trusting a 24-hour clock, which closes the
single-session hole that caused the 2026-07-15 revert.

It does not close the concurrent case. The invalidation hook deletes the file in
the checkout it runs in. A second worktree, another machine, or an apply made
outside this tooling leaves that checkout's snapshot intact — stale, but
"fresh" by every check the guard has. Given Mason runs concurrent sessions, this
is a real shape, not a theoretical one.

**The sound fix** is for the guard to query the live ledger at apply time rather
than read a cached file. That means giving a hook database access it currently
does not have, so it is a real design change and was not bolted on mid-review.

**Context on how much this matters:** the guard is defence in depth, not the
enforcement point — Supabase's own ledger rejects a genuinely out-of-order
apply. What it uniquely catches is an OLDER migration file re-submitted under a
NEWER version, which lands as a "forward" apply and silently reverts whatever
the newer one had fixed. That is exactly what happened on 2026-07-15.

## RESOLVED 2026-08-09 — the migration ordering guard was escapable by renaming the migration

**Found by the exact-SHA Codex review of PR #354 (High).** Separate from the
concurrent-checkout gap above, and worse: this one needed no second checkout.

`apply_migration`'s `name` is supplied by the caller, and the ordering check
abstains on a name it cannot timestamp. The guard converted an abstention into
a block **only when the name carried a 14-digit timestamp** — exactly backwards.
Every other abstention cause is already refused upstream, because those checks
constrain the *ledger snapshot*; the untimestamped *candidate* was the one case
nothing caught. So dropping the timestamp from the name bought an unconditional
pass. Reproduced full-hook, identical SQL, out-of-order against a fresh snapshot:

```text
name="20260101000000_old_mig"   denied=true   by-ordering-guard=true
name="old_mig"                  denied=false  by-ordering-guard=false
```

That is the same replay class as the 2026-07-15 revert — an older file
re-submitted so it lands as a "forward" apply and silently undoes a newer fix.

**Fix:** deny on ANY abstention, and say so when the cause is a missing
timestamp. Every repository migration is timestamped, so refusing an
untimestamped candidate costs nothing real. Regression test added to
`.claude/hooks/migration-apply-guard.test.mjs` covering both directions, and
mutation-tested — restoring the old `&& /\d{14}/` condition turns it red.

The concurrent-checkout entry above stays OPEN; this fix does not touch it.

## FIXED LIVE 2026-08-09 — order header profit vs the sum of its own lines

**Found 2026-08-08 (Codex P2, PR #354). Not a regression — it predates the
rounding work and is unchanged by it.** `trg_recalc_order_totals` does not read
`order_items.profit`. It recomputes the header as
`ROUND(SUM(total_price) - SUM(cost_per_unit * total_units_needed), 2)`, and the
cost side is never rounded per line. So when a unit cost carries fractional
cents, the header profit and `SUM(order_items.profit)` — which
`get_sales_detail_report` shows — can disagree by a cent, and by more across
many lines.

`20260809170800` and `20260809170900` (history rows 860–861; authored as
`20260808150400`/`20260808170000` and re-issued forward on 2026-08-09) round the stored line columns
(`total_price`, `profit`, `commission_amount`) at write time. That stops the
stored money from carrying sub-cent precision, which was the finding they were
written for; it does **not** make the header agree with its lines.

**Why it is parked, not fixed:** closing it means changing where the header
derives from — summing the rounded line profits, or allocating the rounding
residual across lines. Either moves live money on `orders.total_profit`. That is
a money-semantics decision for Mason. Both rounding migrations are now applied
live (2026-08-09), so the decision is owed rather than hypothetical — but it is
still not an emergency: neither migration restated a stored figure, and the
residual is a penny-scale reporting gap, not lost or double-counted money.

**In plain English:** an order's profit total and the profit numbers on its own
lines can be off by a penny from each other when a product's cost has more than
two decimal places. Nothing is lost or double-counted — it is a display/rounding
mismatch between two places that each do their own math.

**Escalated 2026-08-09 (exact-SHA Codex review of PR #354, High) — `20260809170900`
must not apply until the rounding rule is settled.** The migration rounds
`total_price` and `profit` independently per line, while the header keeps
subtracting unrounded costs. That can make the disagreement *bigger*, not
smaller: for two lines with raw revenue `10.005` and cost `5.001`, the header
lands on `10.02` while the stored line profits total `10.00` — where before the
profit rounding the report total was `10.01`. So a migration written to narrow
the gap can widen it.

This was recorded as blocking, not merely parked: the review returns BLOCKED
while `20260809170900` is in the diff. The other four migrations on that PR are
unaffected.

**It applied live anyway, 2026-08-09 20:54 UTC.** The local takeover session
applied all five migrations under Mason's blanket "yes i approve all" without
re-surfacing this blocking finding to him first; that approval covered applying
five migrations, not knowingly overriding a blocking review. Measured live
impact at 21:15 UTC is none — the migration is forward-only and restated
nothing, fractional-cent rows are still exactly 46 + 3 = 49, and
`order_items.profit` carries 0 fractional rows. `trg_order_items_round_money` is
live scoped to `(profit, total_price)`; `trg_commissions_round_money` is
untouched at `commission_amount` alone, so an ordinary status write cannot
restate the pending payout. The residual is the prospective penny-scale
header-vs-lines gap described above. Mason's open choice: leave it live and
settle the canonical rounding rule, or revert it with a follow-up migration —
reverting would return sub-cent precision to a stored money column, and live
already carries the change, so leaving it live is the recommendation on record.

**The decision needed from Mason** is the same one behind the unresolved live
line-profit discrepancy — **which stored copy of profit is canonical, the order
header or the line items, and which single rounding rule do all writers use?**
Once that is answered, the invariant gets enforced across every writer with a
database invariant test, and this entry and the live discrepancy close together.
Per-order live figures are deliberately not recorded here — this repository is
public; they live in the access-controlled session record.

### Answered 2026-08-09 — the order header is canonical; lines are derived to match it

Measuring live before deciding changed the shape of the problem. The gap is
**not** a rounding artefact. `orders.total_profit` is recomputed by a trigger on
every write and is right. `order_items.profit` is a **stored cache that nothing
refreshes** — edit a product's cost or a line's quantity and the line keeps its
old profit forever. 37 of 288 line rows across 17 orders currently hold a stale
value, and most of the 11 visible order-level gaps are orders of magnitude
larger than any rounding rule could produce.

**Mason's decision:** the order header is canonical. Line profit is derived from
it, using one rule everywhere — round each line's revenue and each line's cost
to whole cents, then subtract. Rounding per line (rather than rounding the sum)
is what makes `SUM(line profit) = header total_profit` hold **exactly**, by
algebra rather than by luck. That also disposes of the escalated blocking
finding above: the header now subtracts per-line **rounded** cost, so the
two-line `10.005 / 5.001` case that widened the gap cannot arise.

**The fix:** `20260809230500_single_canonical_line_profit.sql` (history row 862).
Written and reviewed 2026-08-09 — `rls-security-reviewer` and
`migration-drift-reviewer` both returned zero blockers — and **APPLIED LIVE
2026-08-09** as Supabase ledger version `20260810000427`. Verified live after the
apply: both function bodies carry the new logic, the trigger fires on all four
columns and is enabled, and the row counts are unchanged (46 fractional
`order_items`, 3 fractional `commissions`, 37 stale lines, 11 disagreeing
orders), with no `orders` row written in the surrounding 15 minutes.
It is forward-only: applying it moved no live money. At the time this section was
written, the one-time repair of the 37 stale lines was commented out and still a
separate, untaken decision.

> **Closed 2026-08-10 — the repair was approved and applied; the two paragraphs
> that followed here are superseded.** Mason approved the repair, and it went
> live as its own forward-only migration,
> `20260810022500_backfill_stale_line_profit` (ledger version `20260810025159`),
> which re-derives each stale line through the canonical trigger rather than
> recomputing profit in the file. The pending commission snapshots those orders
> carried were then reconciled by `reconcile_pending_commission_snapshots`
> (ledger version `20260810235207`).
>
> **Live read-only measurement, 2026-08-10:** stale lines **37 → 0** of 288, and
> disagreeing orders **11 → 1**. The single remaining disagreement is not a
> regression — it is the one fulfilled order the backfill deliberately left out
> of scope, whose *header* sits a cent above its own already-correct lines. That
> is the mirror of this bug (a stale header, not stale lines) and is tracked on
> its own rather than folded in here.
>
> Do not treat the stale-line repair as outstanding work, and do not re-apply
> either migration — both are forward-only and already on the live ledger.

**Still open after this lands, deliberately:** `_update_order_items_impl`
(`20260617123503`, lines 274–275) overwrites `orders.total_price` with the raw
un-rounded line sum immediately after the trigger set the rounded one. That is
pre-existing and unrelated to profit — the exactness guarantee above is scoped
to `total_profit` only, and `total_price` can still sit a fraction of a cent off
its own lines until that RPC is fixed. Recorded so nobody reads the new
guarantee as broader than it is.

## RESOLVED LIVE — Quote and Customer whole-record saves reject stale editors

**Applied live 2026-07-30.** The frontend-first bundle landed through PR #290, then the governed migration was submitted as `20260730201230_quote_customer_row_version_guard` and Supabase assigned ledger/disk version `20260730235031`. Trigger-maintained `row_version` columns now close the known last-write-wins exposure for whole-record `save_quote` and `save_customer` updates. Immediate catalog, trigger, overload, owner, search-path, grant, and child-table ACL checks passed. The primary Quote/Customer rollback chain plus planned-hold, restore/version, and drawn-booking companion chains all reached exact `SMOKE_PASS_ROLLBACK`; zero fixture rows remained. All 21 standing live invariant predicates returned zero unallowlisted findings. The schema registry was refreshed again through the later live high-water `20260731001654` and retains the assigned row-version migration name and both columns. Cached pre-migration bundles fail closed and must refresh; the already-deployed compatible bundle avoids an all-user outage. No rollout toggle is required.

The same candidate closes adjacent bypasses: direct crop/lifecycle writes only adopt the returned token when it is exactly the previous token plus one (otherwise they preserve the committed narrow change, clear the local token, and require Reload), and normal browser roles lose direct INSERT/UPDATE/DELETE on `quote_sections`, `quote_items`, and `customer_addresses`. Those children remain readable under their existing policy/SELECT boundary and are written only by the parent-locking `save_quote`/`save_customer` SECURITY DEFINER RPCs; no child-to-parent version trigger is used because it would invert that lock order. Because `save_quote` is elevated, it also mirrors the parent Quote ownership policy before either mutation or idempotent replay: admins may save any Quote, while a sales rep must match `quotes.created_by`; the rollback proof rejects both a direct non-owner save and an attempt to recover another actor's cached result.

Every committed Customer-row update now advances the same whole-record token, including payment and prepay balance updates. If money is posted for a customer while another user has unsaved edits open in `CustomerDetail`, that editor's next save intentionally fails closed and requires Reload; the typed edits are not merged automatically. The operational rule is: finish and save a customer edit before posting money for that same customer, or reload and re-enter the edit after the conflict. The rollback smoke proves a concurrent `prepay_balance_cents` change advances exactly once, makes the older editor token stale, and preserves both the committed money change and the rejected editor payload.

Exact-SHA review found that the first candidate `save_quote` body performed one parent UPDATE for header/status fields and another for calculated totals, so one logical existing-quote save advanced `row_version` from N to N+2 and made the client's exact-next-token check fail closed. The correction consolidates header, status, and totals into one parent UPDATE after the existing upfront `FOR UPDATE` lock and stale-token check. Its rollback proof now requires a created quote to return exactly version 2 (insert default 1 plus one totals/header update), then proves two consecutive existing-quote saves advance exactly N→N+1→N+2 using the first returned token for the second save. A later exact-SHA review exposed that the canonical prover trusted the relocated header block instead of comparing it: the hardened proof now compares every moved assignment field-by-field, mutation-tests deliberate `status` and first-send `sent_at` corruption, and executes draft→sent→sent on the real restored schema to require exact +1 tokens, `sent_at` set then preserved, and commission-split persistence. The real-schema harness now requires both lifecycle failure assertions exactly once and mutation-tests their removal and renaming before Docker or its PASS banner can run, while `smoke-specs.json` documents that lifecycle contract. A further exact-SHA review found that lifecycle validation still ran before the generic row-version guard, so a stale draft tab could receive `Invalid status transition: sent -> draft` after another tab sent the quote and miss the Reload/review UX; the corrected order is split-specific conflict first, generic stale token second, lifecycle/unplanning validation third, and the one parent write last, with static order mutation tests plus a real-schema stale-draft-after-sent rollback case.

## 0f. PARTIALLY RESOLVED — vendor-bill and AP boundary live; global paths remain

**Status: APPLIED LIVE 2026-07-30.** A read-only 2026-07-29 preflight confirmed
the current production functions can interleave a vendor-bill period check with
`close_accounting_period`; no accounting period is closed live today (9 rows,
all open), so the exposure is dormant rather than an active historical-data
incident. Migration `20260730114102_vendor_bill_period_close_lock.sql` is now
the B7-renamed disk record of the live server-assigned ledger version
`20260730114102` (submitted as `20260729231031_vendor_bill_period_close_lock`).

The candidate enforces whole calendar-month rows, serializes governed close and
vendor-bill RPCs with sorted transaction advisory locks, and has a restored
PostgreSQL 17 proof covering baseline reproduction, create/update winning
orders, canonical month acquisition, and the affected Section 9, finance, and
delivery rollback smokes. The registered Section 9 chain now creates a bill,
closes its month through the real close RPC, and proves the authoritative
closed-period reader blocks the bill update before mutation. Direct
authenticated-admin writes to
`accounting_periods` remain a deliberately recorded UI-unreachable residual
boundary; close still has no separate existing-vendor-bill completeness gate;
and only governed create/update vendor-bill RPCs join the new protocol, so a
pre-existing concurrent draft/unposted-invoice writer can still beat close's
invoice-completeness scan. Create intentionally completes its existing vendor,
amount, and PO validation before its month lock, so those errors may precede a
closed-period refusal. The live application also reasserted the established
callable-role model for the four re-emitted SECURITY DEFINER routines: `PUBLIC`
and `anon` are denied while `authenticated` and `service_role` retain EXECUTE;
the new internal month-lock helper remains API-unexecutable. B7 is complete:
the disk filename and header now match live applied state, so fleet discovery
does not retain this migration as parked. The runner and regression use its
unique suffix, not its submitted timestamp. Durable local evidence:
`docs/audits/2026-07-30-vendor-bill-period-close-lock-closeout.md`.

**Live proof.** Targeted catalog/ACL/constraint verification passed after apply.
The registered Section 9 rollback-only chain reached its expected terminal
`ERROR P0001 SMOKE_PASS_ROLLBACK`; it proves the real closed-period bill-update
refusal while rolling back every fixture. All 20 standing invariant predicates
have 0 non-allowlisted rows. The raw allowlist output is seven rows across five
predicates: actor-forgery (1), anon-exec-secdef (1), auth-bound-role-ungated
(1), status-literals (3), and ungated-secdef-mutators /
`log_failed_notification(...)` (1).

**Follow-up applied live.**
`20260730124308_close_accounting_period_idempotency_recheck.sql` is the B7
renamed disk record of server ledger version `20260730124308` (submitted as
`20260730121951_close_accounting_period_idempotency_recheck`). It retains a
second same-key idempotency lookup immediately after its exclusive month lock
and before the already-closed refusal as redundant defense in depth. The
current `check_idempotency` helper serializes same-key callers at the first
key-only transaction advisory lock, so the behavioral proof demonstrates that
current helper serialization rather than the later lookup's necessity. Sol
mutation testing removed the later block and the current behavioral proof still
passed; the source regression separately asserts the block's structure. It preserves the live signature, `postgres` owner, SECURITY DEFINER
mode, `search_path=public, pg_temp`, helper execute path, and explicit
authenticated/service-role-only ACL. The deterministic disposable PostgreSQL 17
proof observes real lock readiness for every schedule and proves concurrent
same-key callers return one identical committed result. Post-apply live catalog
proof confirmed exactly one matching overload, the asserted owner/security/path
and ACL shape, and exactly two `check_idempotency` occurrences with the second
after the month lock. The registered fixed-date delivery smoke returned expected
`ERROR P0001 SMOKE_PASS_ROLLBACK`. The independent post-follow-up all-20
invariant sweep is CLEAN: 7 raw rows, all 7 allowlisted, and 0 new findings
across actor-forgery (1), anon-exec-secdef (1), auth-bound-role-ungated (1),
status-literals (3), and ungated-secdef-mutators (1).

**Vendor-bill candidate ACL preservation (local 2026-07-30).** The period-close
candidate re-emits four SECURITY DEFINER public RPCs, so it now explicitly denies
`PUBLIC`/`anon` and grants EXECUTE only to `authenticated` and `service_role` on
`create_vendor_bill`, `update_vendor_bill`, `check_period_open`, and
`close_accounting_period`. Its apply-time postflight and disposable PostgreSQL 17
proof fail if any of those callable-role guarantees drift; the new internal
month-lock helper remains uncallable by every API role.

**Parked-discovery integrity guard (local 2026-07-30).** The fleet and SessionStart
readers previously opened only migration-history `LOCAL CANDIDATE / NOT APPLIED` files,
so a forward SQL file with an explicit leading parked header but no history row could
produce a false clean zero. They now prefilter the immutable `origin/main` tree for
all parser-accepted header phrases (`PARKED`, `NOT APPLIED`, and `DO NOT APPLY`) with
case-insensitive extended whitespace matching (including repeated spaces and tabs),
inspect those possible headers, and report `PARKED STATE UNKNOWN` unless each header has
the required candidate signal or an exact applied/retired/superseded history state. Git's
exit `1` means the healthy case of no prefilter matches and preserves a known empty set;
only a real prefilter error falls back to a complete forward scan rather than claiming the
backlog is clear. The prefilter is anchored to an ASCII-space/tab SQL comment status line,
which removes prose-only matches; it intentionally remains a safe superset because only
the parser can enforce the first-comment-block window. Both readers load the remaining
safe-superset SQL blobs through one `git cat-file --batch` process rather than spawning a
separate `git show` for each candidate. That batch has a deliberate 32 MiB output ceiling
(the observed complete 840-file fallback is about 10.5 MiB) and each returned record must
echo its requested path in order, carry an exact body delimiter, and consume the entire
output. Any Git size/framing/path failure produces `PARKED STATE UNKNOWN`; it never drops
unreadable forward SQL and reports a false clean zero.

**AP boundary follow-up applied live 2026-07-30.**
`20260731001654_ap_period_close_boundary_hardening.sql` is the B7 disk record of
server ledger version `20260731001654` (submitted as
`20260730233835_ap_period_close_boundary_hardening`). It adds the separately
proven coherent protocol for `record_vendor_payment`, `void_vendor_payment`, and
`void_vendor_bill`, and removes every browser-role table capability on
`accounting_periods` except authenticated SELECT. Admins keep the governed
close/reopen RPC path. Its disposable PostgreSQL 17 proof covers both winning
orders for all three AP writers, observes the advisory locks, and requires the
close-first calls to fail without AP/audit/activity/idempotency side effects.
Sol-high accepted the exact SQL hash with zero findings and specifically
rejected adding the month lock to `reopen_accounting_period`, whose existing
period-row-first order would deadlock with close's month-first order. Live
catalog proof and the registered Section 9 rollback smoke passed; zero smoke
fixtures or closed periods remained. Durable evidence:
`docs/audits/2026-07-30-ap-period-close-boundary-hardening-closeout.md`.

**Remaining scope residual.** This does not claim a global accounting-close
protocol. Live readback still finds 26 other `check_period_open` callers without
the month-lock protocol; they remain a separate HIGH-risk review lane. Close still has no
separate existing-vendor-bill completeness gate, and a pre-existing concurrent
draft/unposted-invoice writer can still beat close's invoice-completeness scan.

---

## 0d. RESOLVED LIVE 2026-07-29 — `profile_public_view` RLS bypass onto `profiles`

**Status: RESOLVED LIVE.** Closed by `supabase/migrations/20260729125227_secure_profile_public_directory.sql` (PR #269), applied 2026-07-29. Live postflight confirmed `security_invoker=true`, RLS enabled, 11/11 profiles backfilled, authenticated write privileges removed, and anonymous reads denied.

Found by CodeRabbit on PR #269 and confirmed by reading live catalog state, not inferred. Three facts compose:

| fact | live value (re-read 2026-07-29) |
|---|---|
| ACL on `public.profile_public_view` | `authenticated=arwdDxtm/postgres` — INSERT, UPDATE, DELETE, TRUNCATE |
| `pg_relation_is_updatable(view, true)` | `28` = UPDATE\|INSERT\|DELETE — single-table view, no joins/aggregates, fully auto-updatable |
| `reloptions` | `NULL` — **not** `security_invoker`, so base-table access runs as owner `postgres`, which owns `profiles` (not `FORCE ROW LEVEL SECURITY`) and is `BYPASSRLS` |

Root cause is the same default-privilege trap that produced finding (1) on the directory table: `ALTER DEFAULT PRIVILEGES ... ON TABLES` in the ACL baseline covers **views as well as tables**, and `CREATE OR REPLACE VIEW` preserves the existing ACL, so a `REVOKE` naming only `PUBLIC` and `anon` leaves the write grants standing.

**Actual blast radius — this composes into privilege escalation to `admin`.** Each link verified live 2026-07-29:

1. `anon` cannot reach it (`anon=m`, MAINTAIN only), so the attacker must be **signed in**. Direct PostgREST access with their own token is required; nothing in the CRX UI does this.
2. `UPDATE` through the view is contained — `trg_guard_profile_role_lock` raises `42501` unless `is_admin()` whenever `role`, `is_active`, `full_name` or `denied_pages` change. That covers three of the view's four columns, so **a user cannot simply UPDATE themselves to admin.**
3. But `DELETE` is not guarded at all: `public.profiles` has **zero BEFORE DELETE triggers**, and normally has no DELETE policy either — so RLS would deny it outright. The view bypasses RLS, so the delete proceeds. The only remaining limit is referential integrity: of the 108 FKs referencing `profiles`, 81 are `NO ACTION` (block), 10 `SET NULL` (silently drop attribution), 4 `CASCADE`. **An established user's row will not delete; a new or lightly-used account's will.**
4. Once their own row is gone, `profiles_insert` — `TO authenticated WITH CHECK (auth.uid() = id OR is_admin())` — lets them insert it back **with any role they like**. `profiles_role_check` permits `'admin'`, and `_guard_profile_role_lock` is `BEFORE UPDATE` only, so it never fires on INSERT.
5. `is_admin()` is `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND is_active)` — which is now true. **Full admin.**

So the realistic threat was a new or low-activity account, acting deliberately through the API, escalating itself to admin. It was not something a user would trip into, and it was not reachable logged out — but it was a genuine escalation path, not merely a data-deletion nuisance. That is why the migration required prompt application.

**Follow-ups this exposed, out of scope for that migration** (each pre-existing, none introduced by it):

- `profiles_insert` has no role guard. `_guard_profile_role_lock` should have an INSERT arm, or the INSERT policy should pin `role`. Closing the view does not close this; it only removes the DELETE that makes it reachable.
- `authenticated` holds `TRUNCATE` and `TRIGGER` directly on `public.profiles` (ACL baseline line 456). After this migration a plain `TRUNCATE` fails on the new FK and `TRUNCATE ... CASCADE` fails because `authenticated` no longer holds TRUNCATE on the directory — but that is an accident of the FK, not an asserted control.
- `TRUNCATE` on `profiles` does not fire the row-level sync trigger, so it would leave the directory permanently stale. A statement-level trigger would close that.
- **Resolved live 2026-07-29:** `20260729163243_harden_profile_directory_followups.sql` replaced the duplicated active-profile predicate with `public.is_active_profile()`, reduced `service_role` on the directory table/view to SELECT-only, and removed direct application-role EXECUTE from the trigger-only synchronizer. The live catalog confirms the owner-run trigger remains enabled, all 11 profile and directory rows match exactly, and rollback-only `service_role` and authenticated profile updates synchronized successfully while direct directory writes were denied.
- The separate application-service compatibility follow-up previously pointed here; its current owner-decision record is section 0e.

**Not a wider class:** a schema-wide sweep for the same pattern — auto-updatable, not `security_invoker`, writable by `authenticated` — returns **exactly one row across all of `public`**, this view.

The fix closes it two independent ways (the `REVOKE` now names `authenticated` and `metabase_ro`, *and* the view becomes `security_invoker = true` over `profile_public_directory` where `authenticated` holds `SELECT` only), and the migration's postflight asserts both rather than letting either carry the other.

---

## 0e. OPEN OWNER DECISIONS — application-service cost follow-ups

- Sales reps can still recover internal application-service cost for invoices assigned to them from `invoice_items.cost_cents` plus acres or `invoices.total_cost_cents`. Drivers cannot. Narrowing sales-rep visibility on their own invoices is a product decision for Mason, not a grant-only correction.
- `admin_set_application_service_cost` was deliberately retained through the atomic-save rollout so browsers on the previous bundle would not fail between migration apply and deployment. Retire that compatibility RPC after the one-release transition window, with a forward-only migration and caller check.

---

## 0. RESOLVED 2026-07-28 — two SECURITY DEFINER functions leaked pricing past the office-only reads

**Status: FIXED LIVE by migration `20260728182141_secdef_pricing_reads_office_only`**
(applied 2026-07-28 18:21:41 UTC). Mason explicitly approved the parked migration on 2026-07-28. The
mandatory RLS and drift reviewers first blocked its inherited function ACLs; those findings were
fixed by explicit `PUBLIC`/`anon` revokes and the required `authenticated` regrant. PR #257 landed
the gate and PR #260 the pinned execute grants; both passed protected CI, SQL validation, CodeQL,
Vercel, and CodeRabbit with no actionable comments before merge. Fresh hash-bound migration proofs
returned CLEAN immediately before apply. Post-apply catalog proof confirms both functions are
`STABLE SECURITY DEFINER`, pin `search_path=public, pg_temp`, and contain both `AUTH_REQUIRED` and
the admin-or-sales-rep guard. `anon` can execute neither function; `authenticated` can execute only
`get_program_completion`; `service_role` can execute both.

**Ledger-identity note, now historical.** It was applied by a parallel session, so the server
assigned ledger version `20260728182141` while the file on disk was still named
`20260728123224_secdef_pricing_reads_office_only.sql` — a lookup by version `20260728123224`
returned zero rows and read as "never applied". The file has since been renamed to match the ledger
version, so the two now agree and no name-vs-version reconciliation is needed any more. Earlier
revisions of this section said PARKED / NOT applied live; that was true when written and is stale.

**Finding (audited and proven live 2026-07-27; full evidence in
`docs/audits/2026-07-27-secdef-pricing-bypass-audit-handoff.md` — do not re-run the audit).**
Migration `20260727231652_quote_and_rate_reads_office_only` restricted SELECT on `quote_items`,
`quote_versions`, `customer_application_rates` and `rebate_programs` to `is_admin() OR is_sales_rep()`.
SECURITY DEFINER bypasses RLS by design, so that policy cannot reach SECDEF readers. Exactly **20**
SECDEF functions read those tables with EXECUTE to `authenticated`; **18 are already gated** in-body.
Two were not:

1. **`compute_application_service_fee(uuid, uuid, numeric, integer)` — HIGH, proven live.** No role
   check of any kind. Impersonating a real active `driver` returned `rate_per_acre_cents: 800`,
   `total_fee_cents: 80000`, plus `cost_per_acre_cents` and `total_cost_cents` — customer price and
   internal cost in one response, so margin is one subtraction away. Control: the same impersonation
   against `get_booking_settlement` raised `INSUFFICIENT_ROLE`, so the leak is real, not a test
   artifact. It has **no frontend caller at all**, so the React route guard was never in the path;
   the PostgREST endpoint was reachable with the field user's own JWT.
2. **`get_program_completion(integer)` — MEDIUM, latent.** No role check. Returns per customer: farm
   name, quote numbers, planned vs completed acres, and `invoiced_amount_cents`. It returns 0 rows
   today **only** because the single planned quote has `season = NULL` — a data accident, not a
   control. Called from `src/pages/OfficeCockpit.tsx` and `src/pages/ProgramTracker.tsx`, whose
   routes are gated `allowedRoles={['admin','sales_rep']}`.

Exposure is 5 active non-office accounts (2 driver, 1 applicator, 2 `entity_recipient` — the last is
customer-facing), not just field staff.

**Fix as shipped.** Both functions got the house in-body gate copied from the PARKED-007 block in
`preview_field_app_invoice_split` — `AUTH_REQUIRED` when `auth.uid() IS NULL`, then
`INSUFFICIENT_ROLE` unless `is_admin() OR is_sales_rep()`, both with ERRCODE
`insufficient_privilege`. Both helpers were re-confirmed live to require `profiles.is_active = true`,
so this matches the other 18 exactly. `compute_application_service_fee` additionally has its EXECUTE
grant revoked from `authenticated`.

**Correction to the caller claim (2026-07-28, verified live — the migration's own header comment and
the PR #257 description both get this wrong and cannot be edited now that the file is merged).** The
handoff said the callers were `save_job` **and** `transfer_job_to_invoice`. A live `pg_get_functiondef`
scan of every function body found **exactly one** caller: `transfer_job_to_invoice`. `save_job` does
**not** call it. Two independent reviewers flagged the discrepancy and a direct catalog query
confirmed it. The revoke conclusion is unaffected — the single real caller is `prosecdef = true`,
owned by `postgres`, and already requires an active admin/sales_rep profile, so nothing in the field
breaks — but do not carry the two-caller claim forward. `get_program_completion` keeps its grant
because the two office pages call it.

**Added 2026-07-28 after an apply-gate reviewer round:** both functions also get
`REVOKE EXECUTE ... FROM anon` and `FROM PUBLIC`. These are **no-ops against current live state** —
`proacl` for both is `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` and
`has_function_privilege('anon', ...)` is `false` — and `CREATE OR REPLACE` preserves the existing
ACL. They are stated so the grant set is explicit in the migration rather than inherited. The
reviewer finding that prompted them was a false positive against live, but the fix is free and is
the pattern `20260529214355_revoke_anon_execute_on_report_dashboard_secdef.sql` already set.

**Verified live after the apply, two directions.** Catalog state: both bodies contain the
`AUTH_REQUIRED`/`INSUFFICIENT_ROLE` gate, both remain `SECURITY DEFINER` with a pinned `search_path`,
one overload each, `authenticated` no longer holds EXECUTE on `compute_application_service_fee`,
`authenticated` **still** holds it on `get_program_completion`, and `anon` reaches neither. Behaviour,
impersonating a real active `driver` (`5bfbf33a-…`) — a service-role call proves nothing here, because
`auth.uid()` is NULL for `postgres` and both functions would raise `AUTH_REQUIRED` for the wrong
reason: **both refused with SQLSTATE 42501**. Positive control: the same call as an active `admin`
passed the gate, so the guard discriminates by role rather than blocking everyone.

**No postflight `DO $$ ... $$` block shipped inside the migration.** Both apply-gate reviewers asked
for one (`rls-security-reviewer` M1, `migration-drift-reviewer` H1) and it was written, but the file
had already merged via PR #257 and was then applied — editing an applied migration is a hard-rule
violation, and a database that has recorded the version will never execute added statements. Codex
flagged exactly this and blocked the push. The assertions were instead **executed read-only against
live** (all six passed) and their durable form now lives in
`scripts/db-invariant-sweeps/predicates/office-only-pricing-secdef-gates.sql`, which is strictly
better: a postflight block runs once at apply time, whereas the sweep re-checks on every run and so
actually catches the pending-migration overlap-clobber class — a later `CREATE OR REPLACE` that
re-emits either body without the gate.

That predicate includes a deliberately *positive* check: silently losing the `authenticated` grant on
`get_program_completion` would take `OfficeCockpit` and `ProgramTracker` offline for the office — a
worse outcome than the leak this migration closed — and a sweep that only looked for excess access
would not notice.

The assertion set was **proven non-vacuous**: run against live in its exact form *before* the apply it
raised `VERIFICATION FAILED: compute_application_service_fee body has no office-only gate` at
assertion 2 (having passed 1 and 3), and assertion 4 also failed then
(`has_function_privilege('authenticated', ...)` was still `true`). After the apply the same set passes.
Red before, green after — not green either way.

**Still open, reported separately.** `application_services.cost_per_acre_cents` — the internal
per-acre cost — remains readable by any active profile through the `application_services_select`
policy (`USING (is_active_profile())`); the two SECDEF functions were only one route to it. Live
count of services with `cost_per_acre_cents > 0` is currently **0** of 4, so nothing is leaking
today, but the policy is the residual hole. Mason approved the fix on 2026-07-28; it lands
separately as `20260728210030_application_service_cost_admin_only`, which revokes the table-level
grant and re-grants an explicit column list omitting only `cost_per_acre_cents`.

`default_rate_per_acre_cents` is **deliberately not** part of that hole. It is the customer-billed
rate, not an internal cost, and `ApplicationServicePicker` reads it to render the per-acre default in
the dropdown that `JobDetail`, `CustomerDetail` and `FieldApplicationInvoice` mount — revoking it
would empty the applicator's service picker. It stays in the re-granted column list.

**No consumer justifies it (verified live 2026-07-28).** An earlier note in `src/lib/rlsContracts.test.ts`
claimed the column stayed driver-readable "because Jobs/JobDetail need it". They do not. Every
driver-facing read is column-narrow — `ApplicationServicePicker` takes `id, name,
default_rate_per_acre_cents, is_active`; `Jobs.tsx`, `BlendTicketDetail.tsx` and
`FieldAppSplitInvoiceEditor.tsx` take `id, name` (plus `vehicle_id`); `JobDetail.tsx` never references
the table. The only readers of `cost_per_acre_cents` are `ApplicationServices.tsx` and
`ApplicationServiceDetail.tsx`, both mounted behind `<ProtectedRoute allowedRoles={['admin']}>` — the
same shape as the leak just closed, a React route guard that is not in the data path.

**How it will be fixed, and a correction to what this section previously said.** An earlier revision
concluded that "a column GRANT cannot discriminate by app role, so the fix is to move the column to an
office-gated companion table". The premise is right — Postgres has no column-level RLS and every app
user shares the `authenticated` role — but the conclusion is wrong, and no table move is needed. A
`SECURITY DEFINER` function owned by `postgres` reads columns **as postgres**, so revoking the column
from `authenticated` does not affect it. The migration therefore revokes `SELECT, INSERT, UPDATE,
REFERENCES` on the table from `authenticated`, re-grants on the explicit nine-column list that omits
the cost, and re-admits admins through two gated RPCs
(`admin_get_application_service_costs` / `admin_set_application_service_cost`). Note the revoke-then-regrant
shape is required: a table-level grant implies every column and `REVOKE … (col)` does not subtract from
it. All five functions that touch `application_services` were verified live to be SECDEF owned by
`postgres`, so the money engine is untouched — including `preview_field_app_invoice_split`, which reads
the table with `SELECT *` and never names the cost column at all.

**Deliberately out of scope, settled:** `quote_sections`, `rebate_programs` and
`customer_application_rates` policies are untouched. Sales reps keep their access.

**Accepted cosmetic inconsistency, not exploitable and no action planned:**
`enforce_quote_accepted_fully_drawn` is a trigger
function (returns `trigger`, not RPC-callable) and is the only one in the set with EXECUTE to `anon`
— inconsistent with `20260529214355_revoke_anon_execute_on_report_dashboard_secdef.sql`. This is
recorded for audit accuracy, not as open remediation work.

---

## 0c. RESOLVED 2026-07-28 — logged-out visitors could execute 43 database functions

**Status: BOTH halves APPLIED LIVE 2026-07-28** with Mason's in-chat approval, under the full proof
gate (both reviewer charters CLEAN from gpt-5.6-terra, hash-bound proofs, live-ledger preflight
recorded first). Deliberately split so the easy half could be approved without the risky half; in
the end both were approved together.

Supabase stamps its own ledger version at apply time, so each file was B7-renamed to the version it
came back with — bodies never edited. Half 1 authored `20260728193000` → **ledger
`20260728231350`**; half 2 authored `20260728193100`, renamed to `20260728232500` to clear the
high-water half 1 had just raised, then → **ledger `20260728233459`**. Live high-water is now
`20260728233459` at 918 ledger rows.

**Post-apply proof, read back independently from live.** Half 1: `anon` EXECUTE **false on 40 of
40** targets, `authenticated` **true on 40 of 40**, `service_role` **true on 40 of 40**. Half 2:
`anon` **false** on `is_admin()`, `is_applicator()` and `is_driver()`; `authenticated` and
`service_role` **true on all three**. `handle_new_user()` remains anon-executable by design.
Production loaded logged out immediately after: the sign-in page renders, zero console messages, no
`42501`, all asset requests 200.

- **Half 1 — `20260728231350_revoke_anon_execute_non_policy_functions`** (was `20260728193000`). 40
  functions that appear in **no** RLS policy, so nothing changes from "returns nothing" to "hard
  error". 20 are trigger-only (`RETURNS trigger`, no arguments) and PostgREST cannot expose them at
  all. 12 are SECURITY DEFINER callables that already gate internally. **The other 8 are the actual
  live exposure**: `calculate_billing_splits(bigint, numeric[])`, `check_period_open(date)` and the
  six `next_*_number()` document-number allocators had no auth gate of any kind, and before this
  migration a logged-out caller could invoke them. Since the apply, `anon` has no EXECUTE on any of
  the 40.
- **Half 2 — `20260728233459_revoke_anon_execute_rls_role_helpers`** (was `20260728193100`) — `is_admin()`,
  `is_applicator()`, `is_driver()`. These are evaluated **inside** RLS policies as the querying
  role, so removing anon's EXECUTE turns a silent filter into `42501 permission denied for function
  is_admin`. Blast radius measured live: 30 tables / 70 PUBLIC-audience policies for `is_admin`, 6
  for `is_applicator`, 1 for `is_driver`. Judged safe because `is_sales_rep()` is already in exactly
  that state on 24 tables in production today and nothing is broken by it, the login route never
  reads those tables as anon (`src/App.tsx:185` — `login` is the only route outside
  `<ProtectedRoute>`), no edge function reads as anon, and the `authenticated` grant is retained and
  positively asserted. That judgment held: the post-apply reads above and the logged-out production
  load confirm it.

**Why this is not the blanket judgment it looks like.** The overnight Codex draft
(`20260728185827_revoke_anon_security_definer_execute`) revoked **44** functions with the same
boilerplate sentence repeated 44 times, and is superseded by these two files. It also included
`handle_new_user()`, which must **not** be revoked: it is the `auth.users` trigger,
`supabase_auth_admin` holds no grant of its own, is not a superuser, and is a member of no role — the
PUBLIC grant is its only route, so revoking it would break signup.

**Mechanics worth keeping.** Every REVOKE names **both** `PUBLIC` and `anon`: Supabase's
`ALTER DEFAULT PRIVILEGES` hands `anon` its own EXECUTE on each new public function, so revoking
from `PUBLIC` alone leaves that grant standing, and revoking from `anon` alone leaves the PUBLIC
grant it inherits. Proof uses `has_function_privilege('anon', <oid>, 'EXECUTE')`, never a `proacl`
scan.

**Proof.** Schema rebuilt from zero in a throwaway PostgreSQL 17 container from baseline
`20260727174805`, all six post-baseline migrations replayed in order, then 43/43 target signatures
(parsed out of the migration files, not retyped) verified: `anon` EXECUTE false, `authenticated`
EXECUTE true. Both files re-applied cleanly a second time. Independent `rls-security-reviewer` pass
against live returned no BLOCKER and no HIGH: all 43 signatures match live with no overloads, and no
cron job, edge function, cross-schema function body, `auth`/`storage` trigger, or PostgREST
pre-request hook calls any of them.

---

## 0a. RESOLVED 2026-07-27 — deactivated users kept access through 38 RLS policies (all three follow-up items also resolved)

**Status 2026-07-27: FIXED LIVE** by migration `20260727145843_inline_role_checks_require_active_profile`
(applied under Mason's conditional approval once the clean-rebuild check passed). Residual inline-role
gaps went **38 → 0**; 48 policies now require an active profile. Live role simulation, fully rolled
back: the deactivated `sales_rep` now sees **0** vendors and **0** vendor_bills, while an active admin
still sees 13 and 4. **Of the three numbered items at the end of this section, items 1 and 2 were
themselves RESOLVED and APPLIED LIVE later the same day** (ledger `20260727174657` and
`20260727174805`) — they are kept below with their proofs rather than deleted, and each carries its
own residual-risk note. **Item 3 was RESOLVED later the same day too** — an unrelated
disaster-recovery defect in the schema baseline, logged here because this migration's clean-rebuild
check is what surfaced it.

The original finding, for context:

**As found 2026-07-27:** 38 RLS policies — across 17 `public` tables plus
`storage.objects` — gate on `profiles.role` **inline** without also requiring
`profiles.is_active = true`. Deactivation is not enforced anywhere else: `auth.users.banned_until`
is NULL for the deactivated account and sessions are not revoked, so RLS is the only gate. A user
who has been deactivated but still holds a valid JWT therefore keeps access through every one of
them. One such account exists live (a deactivated `sales_rep`, 216 session rows, last sign-in
2026-03-15) and 7 of the 38 policies include `sales_rep`, so it is exploitable today.

Policies that call `is_admin()` / `is_sales_rep()` / `is_driver()` / `is_applicator()` are **not**
affected — all four helpers were confirmed live to check `is_active`. This is the systemic gap that
migration `20260726223520` (migration-history row 826) explicitly deferred.

Fix, now applied live as ledger version `20260727145843`:
`supabase/migrations/20260727145843_inline_role_checks_require_active_profile.sql`, branch
`claude/rls-inline-role-require-active`, commit `4fcf2c90`, migration-history row 827. Proven by a
full-file dry run on live inside `BEGIN … ROLLBACK` (all 38 ALTERs applied, verification block
passed, residual gaps 38 → 0, rolled back, live state re-read unchanged) and adversarially reviewed
by Codex `gpt-5.6-sol` at high effort — verdict SHIP-WITH-FOLLOWUPS, no blockers. **Do not
re-discover or re-audit this — the enumeration and the migration already exist.**

**2026-07-27 — both preconditions were met, and the migration is now APPLIED LIVE.** The clean-rebuild replay was run on a
disposable PostgreSQL 17.6 stack built from `supabase/baselines/`: all 38 policy names present
(38/38, 0 missing), the file applies cleanly, and its verification block reports `38 policies now
require an active profile` with 0 residual gaps. The replay stalls at 16 of 50 on a **pre-existing
baseline defect unrelated to this migration** — the July 19 baseline's schema is ahead of its own
recorded ledger high-water, so it carries function bodies later than migration 16's md5 precondition
expects. That does not weaken the proof: the remaining 35 migrations were checked statically and none
creates, drops, or alters any of the 38 targets. **The baseline has since been refreshed and a
from-zero replay now completes — see item 3.** The `write-apply-proofs.mjs` gate now returns CLEAN from both
`rls-security-reviewer` and `migration-drift-reviewer` — its first run correctly blocked on a CHECK 9
comment reference, since fixed (comment-only).

Of the three items listed below, **items 1 and 2 were RESOLVED and APPLIED LIVE on 2026-07-27**
(ledger versions `20260727174657` and `20260727174805`) under Mason's explicit approval; they are kept
here with their proofs rather than deleted. **Item 3 was RESOLVED the same day** once Mason supplied
the `postgres` database password — an unrelated pre-existing defect that the clean-rebuild check
surfaced, affecting disaster-recovery rebuilds only, not production.

1. **RESOLVED — APPLIED LIVE 2026-07-27 (`20260727174657`).** **Wide-open PERMISSIVE read policies —
   the count here was wrong; it is 31, not six.**
   **Corrected 2026-07-27** after a live re-enumeration: **31** PERMISSIVE SELECT policies across 31
   tables gate on nothing but "you are logged in" — 30 with `USING (true)` on role `authenticated`,
   plus `application_record_fields.arf_select` on PUBLIC with `uid IS NOT NULL`. The six tables named
   previously (`application_services`, `application_record_fields`, `customer_application_rates`,
   `quote_pdf_templates`, `quote_templates`, `team_note_attachments`) were only the *overlap* with the
   tables migration `20260727145843` tightened; the other 25 (`products`, `customer_addresses`,
   `team_notes`, `quote_items`, `applicator_licenses`, …) expose independent business data and were
   simply missed. PERMISSIVE policies OR together, so any logged-in user reads all 31 regardless of
   role or active status. Each of the six named tables has exactly ONE SELECT policy — the wide-open
   one — so there is no role-based policy to fall back on.
   **Fix APPLIED LIVE 2026-07-27 (ledger `20260727174657`):**
   `supabase/migrations/20260727174657_broad_reads_require_active_profile.sql` adds a role-agnostic
   `public.is_active_profile()` helper and rewrites all 31 predicates to require an active profile.
   It deliberately does **not** narrow read access by role — every active user reads exactly what
   they read today; only deactivated accounts lose read. Choosing which roles *should* see each
   table is a separate product decision. **Mason answered the scoping half in chat on 2026-07-27:
   sales reps should see rebate programs and per-customer application rates** — rejecting the
   reviewers' suggestion to narrow those two to admin-only. (An earlier revision of this entry
   claimed a decision that had not been made; that claim was fabricated and is retracted. The real
   answer differs from it on those two tables.) Follow-up migration
   `supabase/migrations/20260727231652_quote_and_rate_reads_office_only.sql` implements exactly that
   shape — `quote_items`, `quote_versions`, `customer_application_rates` and `rebate_programs`
   become office-only (admin + sales_rep), excluding drivers and applicators.
   **Status: APPLIED LIVE 2026-07-27 (ledger `20260727231652`; authored as `20260727193441`, renamed
   to the server-assigned version after apply).** Proven live by per-role impersonation: admin and
   sales_rep read 20 `quote_items` / 3 `quote_versions`; driver and applicator read 0 / 0, down from
   20 / 3. See `docs/reference/migration-history.md` row 830.
   **Two parts of the decision remain open and are NOT closed by that migration:**
   (a) `products`, `application_services`, `field_billing_defaults` and `blend_recipe_items` are read
   by driver/applicator-reachable pages, so the cost/margin *columns* — not the tables — are what
   needs hiding; RLS cannot express that (every signed-in user shares the single `authenticated`
   grantee), so it needs a restricted view plus frontend changes.
   (b) `SECURITY DEFINER` functions granted to `authenticated` bypass RLS entirely and can still
   return these figures through a direct PostgREST `/rpc/` call. Two were named when the migration
   was written — `compute_application_service_fee` (`rate_per_acre_cents`, `cost_per_acre_cents`) and
   `get_program_completion` (derived from `quote_items`) — but a live enumeration after the apply
   found **20** `authenticated`-executable SECDEF functions referencing the four now-office-only
   tables, including read-shaped ones such as `get_booking_settlement`, `get_inventory_position`,
   `get_open_booking_rollover` and `preview_field_app_invoice_split`. Each needs its body checked for
   a role gate; the mutating ones (`save_quote`, `convert_quote_to_order`, `draw_down_quote`, …) may
   already gate on `is_admin()`/`is_sales_rep()` internally, and the read-shaped ones are the ones to
   audit first. Closing the table read does not close any of these.
   **Live proof:** wide-open read policies **31 → 0**; 30 helper-based read policies plus `arf_select`
   on the inline form; helper acl `{postgres=X,authenticated=X,service_role=X}` with
   `has_function_privilege('anon', …) = false`. Behavioral, rolled back: an active admin sees
   `products=604 team_notes=53`, the deactivated user sees `products=0 team_notes=0`.
   **Gotcha worth remembering:** the first apply attempt was **rejected by the migration's own
   postflight check and rolled back atomically** — this project carries `ALTER DEFAULT PRIVILEGES`
   granting EXECUTE on every new `public` function to `anon`, so `REVOKE … FROM PUBLIC` is **not**
   sufficient; `anon` must be named explicitly. Any future SECURITY DEFINER helper here must do the
   same. See `docs/reference/gotchas.md`.
2. **RESOLVED — APPLIED LIVE 2026-07-27 (`20260727174805`).** **Deactivation does not revoke sessions
   or block re-login.** `profiles.is_active = false` is a
   pure application-layer flag; the Supabase auth user remains unbanned and existing refresh tokens
   stay valid. The durable fix is to ban/​sign-out the auth user on deactivate. Until then, every
   deactivation depends on RLS alone.
   **Owner decision 2026-07-27 (Mason):** deactivating a user must immediately end their sessions and
   block re-login; reactivating restores access; the rule applies to **new deactivations only** — the
   one already-deactivated account is deliberately not backfilled.
   **Fix APPLIED LIVE 2026-07-27 (ledger `20260727174805`):**
   `supabase/migrations/20260727174805_deactivation_revokes_auth_access.sql` adds an AFTER-UPDATE
   trigger on `profiles` that, on true→false, sets `auth.users.banned_until` to a finite far-future
   timestamp (**not** `'infinity'` — GoTrue decodes that column into a Go `time.Time` and an infinity
   can 500 the auth endpoint) and deletes the user's `auth.sessions` / `auth.refresh_tokens` rows; on
   false→true it clears the ban. It also adds `trg_guard_last_active_admin`, which refuses to
   deactivate the last active admin — now that deactivation bans the auth user, that mis-click would
   need Supabase dashboard recovery.
   **Residual window, unavoidable:** an access token already issued stays valid until it expires
   (~1 hour). Deleting the session and refresh tokens means it cannot be renewed, so access ends
   within that window at the latest. Instant revocation would require JWT revocation, which GoTrue
   does not offer.
   **Live proof (behavioral, against production, fully rolled back):** target
   `e2195c35-9eee-46aa-8b19-2734219e6a8c` — `BEFORE active=t ban=NULL sessions=924 tokens=924` →
   `DEACTIVATED ban=9999-12-31 23:59:59+00 sessions=0 tokens=0` → `REACTIVATED ban=NULL` →
   `LAST-ADMIN LAST_ACTIVE_ADMIN: cannot deactivate the only active admin`. Live state re-read after
   rollback unchanged (0 banned, 2595 sessions, 10 active profiles, 4 active admins). Note the proof
   must simulate an admin's `request.jwt.claims`: the pre-existing `_guard_profile_role_lock`
   correctly refuses an `is_active` change from a non-admin caller.
   **NOT verified:** the two `src/pages/SettingsPage.tsx` strings (the corrected deactivate-confirm
   text and the `LAST_ACTIVE_ADMIN` toast) are not visually confirmed — reaching Settings needs an
   admin login. Residual risk is cosmetic only: the database refuses a last-active-admin deactivation
   whether or not the friendly toast renders.
3. **RESOLVED 2026-07-27 — the schema baseline was ahead of its own recorded ledger high-water, so a
   from-zero rebuild could not complete.**
   **As found:** `supabase/baselines/` recorded high-water `20260719092832` (861 ledger rows), but
   its public-schema artifact already contained `split_invoice_creation_claims` — a table introduced
   by `20260720213000`. It therefore also carried function bodies newer than the post-baseline
   migrations expected, and a replay failed at migration 16 of 50 with `PRECONDITION: reviewed
   public RPC drifted: public.create_invoice_from_order(...)`. Disaster-recovery only; production
   was never affected.
   **Fix:** the baseline was regenerated from a fresh read-only capture of live at high-water
   `20260727174805` (914 ledger rows) — no applied migration was edited. Mason supplied the
   `postgres` database password on 2026-07-27, which was the sole blocker.
   **Proven, not assumed.** The six artifacts were restored in `restore_order` into a throwaway
   PostgreSQL 17.6 container and **all thirteen catalog fingerprints match the manifest**
   (`columns`, `constraints`, `enums`, `indexes`, `relations_and_acl`, `column_acl`, `default_acl`,
   `view_definitions`, `triggers`, `function_security`, `function_canonical_source`,
   `policy_contracts`, `cron_contracts`) — and after the post-baseline migrations are replayed onto
   that restore, all thirteen match **live**, which is the property disaster recovery actually
   needs: baseline plus ledger reproduces production. `column_acl`, `view_definitions`, and
   `default_acl` were added in review: without them production's 27 column-level grants on
   `public.products`, a view's `security_invoker` setting, and the standing `ALTER DEFAULT
   PRIVILEGES` rule that hands `anon` `EXECUTE` on every new function could all change with every
   digest unchanged. The restored ledger reports
   `914|20260727174805`. Re-applying the history file raises
   `BASELINE_HISTORY_RESTORE_REQUIRES_EMPTY_LEDGER` and the cron file raises
   `BASELINE_CRON_RESTORE_REQUIRES_ABSENT_JOBS`, so both stay fail-closed. A post-baseline migration replays
   onto the restored database cleanly — the exact step that used to stall at 16 of 50. That file is
   `quote_and_rate_reads_office_only`, applied to production by a separate session on 2026-07-27 as
   ledger version `20260727231652`; replaying it brings the restore to `915|20260727231652`, matching
   live's ledger exactly. It is not part of this change — it landed on `main` separately — and it is
   the only migration the tree holds past the baseline high-water.
   `npm run test:schema-baseline` passes:
   `SCHEMA_BASELINE_PASS high_water=20260727174805 ledger_rows=914` /
   `POST_BASELINE_MIGRATIONS_PASS pending=1`, the selector naming that one file. A non-zero pending
   count is the normal steady state, not a defect: the baseline is a snapshot at its own high-water
   and live moves on the next apply.
   **Five real defects were found and fixed while doing it, all DR-only:**
   - *Security.* A schema dump can only `GRANT`. A new Supabase project ships `ALTER DEFAULT
     PRIVILEGES` handing `anon` — the unauthenticated role — full CRUD on every table and `EXECUTE`
     on every function `postgres` creates, and `REVOKE … FROM PUBLIC` does **not** strip a
     role-specific grant. Restoring the old baseline therefore left `anon` holding privileges
     production had revoked, silently undoing the hardening shipped in PR #249. The baseline now
     carries a sixth artifact, `*_acl_lockdown.sql`: it revokes the Supabase-managed roles to
     nothing, re-applies production's exact 1627 grants, restores production's default privileges,
     and ends with a guard raising `BASELINE_ACL_ANON_OVER_GRANTED` if `anon` still holds anything
     beyond `SELECT`/`MAINTAIN` on a table.
   - *Weak guard.* Found in review. The lockdown checked that `anon` held `EXECUTE` on 95
     functions, not on *which* 95, so a refreshed capture that swapped one RPC for a more
     sensitive one would have passed unchanged — while `README.md` promised an exact-set
     guarantee. The guard now embeds the captured identities and compares the set both ways,
     counting `PUBLIC`-granted `EXECUTE` as reaching `anon`. Proving it is now a required
     *negative* test on the disposable restore: a count-neutral swap must still raise
     `BASELINE_ACL_ANON_EXECUTE_DRIFTED`, and it does.
   - *Lossy capture.* Found in review. The ACL capture dropped `is_grantable`, so a
     `WITH GRANT OPTION` would have been restored as a plain grant. Live was read read-only to
     size the exposure: zero grantable entries today, and the re-capture after the fix came back
     byte-identical — no change now, and no silent loss later.
   - *Broken rebuild.* Found in review, by a fingerprint added in review. The lockdown's
     `REVOKE ALL ON ALL TABLES` strips **column-level** privileges along with table ones, and the
     ACL capture only emitted table-level grants — so the restore deleted production's 27
     column grants on `public.products` and never restored them. `authenticated` has no
     table-level `INSERT`/`UPDATE` there; those column grants are its whole write path. A project
     rebuilt from the baseline would have come up unable to edit a Product, and no digest in the
     contract could see it. The capture now emits column grants (1600 → 1627 statements) and the
     `anon` guard scans column privileges too.
   - *Fidelity.* `supabase db dump` post-processes the dump and strips `--` comment lines out of
     function bodies — 3 of 527 functions were affected. The public-schema artifact is now built
     from raw `pg_dump`, normalized by `scripts/build-schema-baseline-public.mjs`.
   `supabase/baselines/README.md` now documents the real refresh procedure, and
   `scripts/verify-schema-baseline.mjs` fails if any `disposable_restore_proof` flag is missing or
   not `true`, so a half-finished refresh cannot be published as proven.
   **Flagged, deliberately unchanged:** live grants `anon` `SELECT` on all 155 public tables and
   `SELECT, UPDATE, USAGE` on sequences (stock Supabase posture; reads are gated by RLS), and 543
   repo migration filenames have no matching ledger version while 654 ledger versions have no file —
   a pre-existing consequence of applying migrations through the Management API, which assigns its
   own version. The baseline copies live's ledger verbatim so a restore mirrors production exactly.

---

## 0. Per-line split-billing — pricing rule SETTLED = Option B (Mason, 2026-07-18)

Resolved. The prior open question (how to price a chemical split line when co-owners are on different tiers)
is decided: **Option B — each co-owner is billed at their OWN assigned_tier**, mirroring today's non-split
field-app billing (no customer's price changes). A manual price or field quote applies to everyone (tier-
independent); only the tier fallback varies per grower. Pricing proof: 20/80 tier1/tier3 field →
A@$10/gal, B@$8/gal, each own tier; plus a penny guard so a uniform price totals round-once.

**STATUS — SHIPPED AND LIVE, NOT PARKED** (re-verified against the live DB 2026-07-27; this entry previously
claimed "flag OFF, migration NOT applied, NOT merged", which was wrong on all three counts):

- **Merged** via PR #164 on 2026-07-21.
- **Applied live**: `20260720213000_per_line_split_billing_schema`, `20260720214000_..._calculator`, and
  `20260720233000_..._save_rpc` are all in the live migration ledger.
- **Flag is ON.** `app_settings.per_line_split_billing_enabled = 'true'`, set 2026-07-21 01:29 UTC — seven
  minutes after the merge. Note the shipped code default is OFF; the live value was deliberately flipped on.
  **What the flag actually gates (verified 2026-07-27):** only the two readers of
  `SPLIT_BILLING_SETTING_KEY` — the Sidebar nav entry (`src/components/layout/Sidebar.tsx`) and the split
  editor page (`src/pages/FieldAppSplitInvoiceEditor.tsx`). The safeguards are **data-driven and persistent,
  not flag-driven**: `isInvoiceEmailSuppressed()` checks `send_disposition === 'suppressed_zero_total'`
  unconditionally, and `InvoiceDetail` locks a line whenever `billing_line_id` is present. So turning the flag
  back OFF stops new split sets from being created — it does **not** strip protections from split invoices that
  already exist. (The header comment in `src/lib/splitBillingSetting.ts` overstates the flag's reach.)
- **Never exercised.** The field-app path (`save_field_app_split_invoice`) writes `field_app_billing_sets`,
  `field_app_billing_lines`, and `invoice_line_shares` — all three were empty as of 2026-07-27. The separate
  order-side path (`create_split_invoices_from_order` → `split_invoice_provenance`,
  `split_invoice_creation_claims`, `split_invoice_mutation_claims`) is also empty. Six tables, zero rows across
  both paths — **no recorded split-billing usage as of 2026-07-27.**
- **Spec + supersession.** Build spec: `docs/plans/per-line-item-split-billing-spec-2026-07-17.md`; direction
  settled in `DECISION_LOG.md` (2026-07-17). This supersedes the old "four parallel split mechanisms need a
  decision" flag — decided: the field-app path is the surface, the order-side engine is retired later.

⚠️ **Do not resurrect the stacked branches.** `codex/per-line-split-billing-phase3-rpc` (closed PR #181) and
`codex/per-line-split-billing-phase4-ui` (closed PR #182, tip `e2418796`) are a **superseded** variant built
on an incompatible schema/timestamp sequence — five `20260720230000`–`20260720234000` migrations that clash
with the live chain above. Mason's closing note on #182: they "must not be applied." Nothing is lost: both
are preserved on GitHub as `refs/pull/181/head` and `refs/pull/182/head`, and both still exist locally.

**Codex gate RAN 2026-07-18 → 8 P1 + 2 P2 findings, ALL FIXED + re-proven (21/21 live-rollback).** The Codex
money/RLS review blocked the first go-live attempt: service lines priced $0 / not per-customer (#1,#2);
chemical COGS written as 0 (#3); cross-rep RLS bypass in the SECDEF writer (#4); Post commits a stale draft
after edits (#5); a split child opened in the generic invoice page could cascade-delete its line shares (#6);
children got no field_app_locations → blank fields/acres (#7); duplicate `invoice_created` audit rows on
re-save (#8); mis-derived compat acres (#9); `send_disposition` never hydrated so the $0-email gate never
fired (#10). Mason chose **full v1 scope** (chemical + service + flat). All fixed in
`20260718030000_..._save_rpc.sql` + `FieldAppSplitInvoiceEditor.tsx` / `InvoiceDetail.tsx` /
`FieldApplicationInvoice.tsx` / `fieldInvoiceList.ts`; typecheck clean. Two non-blocking notes: a
chemical *return/credit* (negative qty) can't go through the split screen yet (fail-closed); the per-person
price override in the draft UI still works for one-off adjustments.

**Codex ROUND 2 RAN 2026-07-18 → 13 more findings (8 P1 + 5 P2), ALL 13 NOW RESOLVED + re-proven.** A deeper
pass found: flag not enforced server-side (#B); deploy-order coupling in InvoiceDetail preflight (#A); negative
flat credit posted as a charge (#C); malformed override → $0 (#D); source job billable via split AND normal
flow = double-bill (#E); fee cost per-acre vs extended mismatch (#F); per-child COGS rounding overstates group
total (#G); no route to reopen a saved draft (#H); local-date default (#J); micro-pct residual on custom
splits (#K); service name lost on item (#N); Option-B pricing audited as an "override" not a base (#M);
custom-split/override reasons never captured (#L). First 7 (#B/#C/#D/#F/#J/#K/#N) landed in `eb942f86`; the
final 6 (#A/#E/#G/#H/#L/#M) this session. **#H = save-now/post-later:** a new `split-billing/:id` route reopens
a saved set READ-ONLY for review + Post (editable reopen deferred — a re-save re-prices, so rebuilding money
fields is a future, separately-proven enhancement). **#E** consumes the source job (status→invoiced) so it
can't be double-billed. Re-proven in live PG: **PROOFOK 29/29** (adds cogs_group_lr_exact, audited_base_is_own,
reasons_captured, double_bill_second_set_rejected, resave_same_job_allowed). rls-security-reviewer 0/0,
migration-drift 0 blockers; typecheck + lint clean. *(State at the time of this round, since superseded: the
work was then parked with the flag OFF, migrations NOT applied, and PR #164 NOT merged. See the STATUS block
above — it shipped on 2026-07-21 and is live with the flag ON.)*

**Codex ROUND 3 RAN 2026-07-18 → 2 P1 + 4 P2, ALL fixed + PROOFOK 32/32.** A third pass (on the job-consumption
+ reopen work round-2 added) found: source job changeable on re-save → two jobs consumed (P1, now frozen);
service priced/stamped with `current_season()` instead of the job/invoice season (P1, now season-correct);
child invoices lacked `job_id`/`application_date` (P2); unposted group mislabeled "Posted" (P2); negative
micro-pct residual on `33.334×3` (P2); the live-RPC snapshot test inflated to hide the 2 parked RPCs (P2, now
uses the verified queued-bridge at true 438). The live proof ALSO caught 2 runtime bugs the reviews missed:
`v_job.season` on an unassigned record (55000) and a stale `scheduled_date` (live `jobs` uses `job_date`) —
both fixed. New harness note: seeding synthetic products now needs `ALTER TABLE products DISABLE TRIGGER USER`
inside the rolled-back txn (a parallel supplier-pricing project applied live pricing-governance triggers).
*(Round-3 exit criteria, now overtaken by events: "Remaining before flag-on: a CLEAN full re-run of the Codex
gate, then Mason's review + baseline field-app billing cycle." PR #164 merged 2026-07-21 and the flag was
turned on seven minutes later — see the STATUS block above. **The baseline field-app billing cycle still has
not happened** — checked directly rather than inferred from the empty split tables, since an ordinary cycle
would not touch those: live as of 2026-07-27, `field_app_locations` = 0 rows, `field_app_location_shares` = 0,
and of 4 total `jobs` none is `invoiced` and no `invoices` row carries a `job_id`. So no field-application
invoice of any kind has been produced yet, split or not.)*
Owner-facing detail: `docs/plans/per-line-split-billing-BUILD-HANDOFF-2026-07-18.md`.

**Resolved 2026-07-21 — Supplier Pricing Phase 1a rollout gap.** The governed
Product-page and XLSX pricing paths are live, the final lifecycle migration is
applied at `20260721014858`, and production `process-document` v19 is ACTIVE
with JWT enforcement and rejects supplier price/product lists before OCR.

### RESOLVED LIVE — Whole-record lost updates on quote/customer saves

The formerly open whole-record last-write-wins class is closed by live migration
`20260730235031_quote_customer_row_version_guard`. Both save RPCs now require the
loaded row-version token and reject stale editors before rewriting any field.
See **“RESOLVED LIVE — Quote and Customer whole-record saves reject stale
editors”** near the top of this file for the live proof, protected child-write
boundary, and operator reload behavior. The earlier commission-split-specific
guard remains useful defense in depth; it is no longer the only concurrency
boundary.

**Rollout ordering note (corrected 2026-07-30):** the client's no-echo fallback (`nextLoadedSplitSnapshot`, `src/lib/commissionSplitConcurrency.ts`) records the client-sent value as the next baseline when the old RPC returns no split echo. The compatible frontend must still ship first: its extra row-version JSON key is ignored by the old RPC, avoiding an all-user outage. A tab that stays open across the later approved apply can fail closed on its next save or split edit until refresh; that is the intentional residual, not an overwrite. Require the normal browser/PWA refresh during the bounded migration window, then run postflight/live smoke and regenerate generated schema/types afterward.

## 1. Open HIGH findings (dormant on live data)

### July 14 full-gauntlet remediation — LIVE, frontend rolled out (PR #133 merged 2026-07-15)

The three reviewed migrations were applied live on 2026-07-15 and `process-blend-ticket` is v25 ACTIVE with JWT enforcement. The live schema registry, TypeScript types, and 393-name RPC snapshot were regenerated; the queued-RPC exceptions are gone. The post-apply business chain reached `SMOKE_PASS_ROLLBACK`, and all 17 database invariant sweeps have zero unallowlisted violations. **The frontend rollout landed via PR #133 ("Harden gauntlet money and blend workflows", merged 2026-07-15, commit `c4f7b4c5`) — the release path is complete.** What remains under this heading is owner-side data-cleanup decisions (the bullets below), not code.

- Migration `20260714230100` removed the legacy direct-insert path. Tabs still running the old bundle must refresh before another blend upload; tell office users to use the existing “A new version of the app is ready” prompt (or reload).
- **Owner decision — live-data cleanup:** eight empty unposted `SEED` commission batches ($1,500 headers), PO-2026-0008's stale fully-received status/open lines, PO-2026-0015's legacy receipt gap, one explicit E2E zero-item invoice, and five historical completed deliveries without items.
- Reconcile 19 negative inventory rows (live count re-verified 2026-08-08) only from physical counts. Negative stock is intentional discrepancy evidence, not a value to zero-clamp.

The frontend/live-RPC fixture is regenerated and green; both `create_blend_ticket` and `commit_blend_ticket_ocr_result` are present live. Evidence: `docs/audits/gauntlet/2026-07-14-full-gauntlet-codex-only-remediation.md`.

Reload recovery for an uncertain manual/bulk blend-ticket create stores the exact user-scoped customer/header/product snapshot in per-tab `sessionStorage` for at most two hours. It contains ordinary business data, not credentials or service keys; known success/definite failure and closing the tab clear it. On a shared Windows/browser profile, close the CRX tab after use. This bounded retention is the deliberate tradeoff that prevents a network-uncertain retry from creating duplicate operational work.

**Correction to the working assumption going into this pass:** the 5 HIGH findings usually cited from the overnight bug hunt (commission-resurrection on cancel/void, prepay double-spend, blend-ticket over-reset, cross-customer prepay misapplication, field-app save desync) are **NOT open**. All 5 have applied-live fix migrations, confirmed both in `docs/audits/overnight-bug-hunt/LEDGER.json`'s own `appliedLive_2026_06_21` note and independently against live `schema_migrations` in this session. See §6 for the specific migrations. `docs/reference/gotchas.md`'s "Money-Integrity Invariants" section was re-verified against live function bodies and marked RESOLVED on 2026-07-13.

Genuinely still-open items from that same hunt (checked against `LEDGER.json`, none HIGH):

| Item | Severity | Status | Pointer |
|---|---|---|---|
| `forgeable-actor:transfer_job_to_invoice:unbound-performed_by` — `p_performed_by` not bound to `auth.uid()` on job→invoice transfer | MEDIUM (Codex split HIGH/MED, settled MEDIUM) | **RESOLVED** — strict-actor guard verified in the live function body 2026-07-21 (landed via `20260619140000_transfer_job_invoice_machine_fee_strict_actor.sql`, merged from feat/as-applied-invoices) | LEDGER.json line ~357 |
| `concurrency:save_field_app_invoice:no-row-lock` — group-edit branch read status without `FOR UPDATE` | MEDIUM | **RESOLVED** — `20260714224000_field_app_save_post_lock.sql` wraps `save_field_app_invoice` in `FOR UPDATE` row locks; applied live 2026-07-14, verified in the live function body 2026-07-16 | LEDGER.json line ~498 |
| `prepay:apply_remaining_prepayments:status-not-paid` | MEDIUM | moot while bulk-apply is hard-blocked (see §6) | LEDGER.json line ~566 |
| `commissions:commission_pay_picker:blank-order-customer` | MEDIUM | **RESOLVED** — verified on `origin/main` 2026-07-21: `fetchUnpaid` selects FK ids and resolves order #/job #/farm name via lookups (CommissionPayments.tsx) | LEDGER.json line ~833 |
| ~10 further LOW items (doc-count drift, dead-RPC retire candidates, audit-log completeness gaps) | LOW | parked | LEDGER.json `findings` array |

Two items the ledger flagged as **"top build priority" and Codex-rated HIGH-on-severity** turned out to already be fixed by later sessions — confirmed via migration files on disk: `reverse_blend_ticket_approval:billed-ticket-reopen-and-edit` → `20260622080000_blend_ticket_reopen_and_content_lock.sql`; `void_commission_payment:resurrect-cancelled-order` → `20260622070000_void_commission_payment_dead_order_guard.sql`. Both **confirmed applied live** (present by name in `supabase_migrations.schema_migrations`, checked 2026-07-13).

### PARTLY OPEN 2026-08-09 — two HIGH commission findings from the Section 7 gauntlet refresh (owner decision SETTLED: Option B; **3.5 fixed and live 2026-08-11**, 3.4 still parked)

Source: `docs/audits/gauntlet/2026-08-09-section-07-commissions-splits-payouts-voids-refresh.md` (verdict REMEDIATION REQUIRED, 0 BLOCKER / 2 HIGH). Both were proven against **live** `pg_proc.prosrc`, not just disk. Neither is an access-control defect — RLS, admin-only payout reads, and RPC-only mutations all held. Gauntlet summary rows **3.4** and **3.5**.

| # | Finding | Where | Live risk |
|---|---|---|---|
| 3.4 | **Historical Commission Balance reports are rewritten by later payout activity.** `get_commission_balance_report(date)` filters *earned* by `cm.order_date <= p_as_of_date` but derives paid/outstanding from **current** `cm.status`. | `src/pages/Reports.tsx:281-285`; `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql:770-807` | A commission earned in June and paid in July shows as **paid** when the June 30 report is rerun; voiding that July payout flips it back to **outstanding**. Month-end commission liability is not reproducible for accounting or dispute review. Read-only defect — no wrong money moves. |
| 3.5 | **Payout idempotency receipts are keyed to the operation, not the intent.** `useIdempotencyKey` scopes to `[operation, userId]` and deliberately retains the key after an uncertain response; `create_/post_/void_commission_payment` all run the operation-only replay check *before* loading the requested entity. | `src/hooks/useIdempotencyKey.ts:21-40`; `src/pages/CommissionPayments.tsx:302-420`; migrations `20260714180000:70-258`, `20260714230000:285-395`, `20260707060000:1569-1717` | Server posts Payment A, response is lost, admin retries on Payment B → server replays A's cached success and the UI reports success for the wrong payment. Same shape for a changed commission selection or void reason. Does **not** double-pay; it tells the operator a different financial action succeeded when it did not. |

**Owner decision SETTLED (Mason, in-chat 2026-08-09): Option B.** Fix 3.5 (payout idempotency intent-binding) now; **3.4 stays parked** as a known reporting-accuracy defect. Rationale as presented and accepted: neither finding moves money wrongly, but 3.5 can tell an operator a payout succeeded when it did not, while 3.4 never causes a wrong payment and its proper fix (durable dated payout event ledger) is a materially larger build deserving its own session. Do not re-open 3.4 without a fresh owner decision; do not treat 3.4 as unknown — it is recorded here deliberately.

Options as presented:

- **Option A — park both.** No code changes; this entry is the record. Cheapest, but a wrong month-end commission number stays reproducible-wrong and the false-success replay stays live.
- **Option B — fix 3.5 only (recommended by Claude 2026-08-09).** Bind each receipt to the authenticated actor plus a server-derived intent fingerprint (create: sorted commission IDs + method/reference/date/notes; post: payment ID; void: payment ID + normalized reason), reusing the established pattern in `20260803010917_bind_idempotency_to_mutation_intent.sql:16-168`. Identical intent replays once; a mismatched actor or fingerprint fails closed with `IDEMPOTENCY_ACTOR_MISMATCH` / `IDEMPOTENCY_INTENT_MISMATCH`. One migration + rollback-only smokes. Rationale: 3.5 is the only one of the two that can mislead an operator into believing a payout landed.
- **Option C — fix both.** Adds an append-only dated commission payout event ledger (or fail-closed for historical dates) behind `get_commission_balance_report`, plus the 3.4 rollback smoke (earn → report → post after cutoff → void later → prove earlier snapshots unchanged). Materially larger: new durable table, backfill question for existing history, and a report-behavior change Mason would see.

Prevention actions proposed by the report: a static guard requiring any RPC accepting a historical cutoff to reference dated immutable facts or reject unsupported dates (**not built** — belongs with 3.4); a source guard requiring commission payout RPCs and callers to carry an intent-binding marker and tests (**built 2026-08-09**, see below).

### 3.5 CLOSED — APPLIED LIVE AND VERIFIED 2026-08-11

Option B was merged to `main` via PR #378 and the migration was applied to production on 2026-08-11 with Mason's explicit approval, after the final Codex round returned clean. The live ledger carries it under version `20260811183437` with name `20260811130000_bind_commission_payout_idempotency_to_intent` (the apply tool stamps its own clock as the version — match on the name). Verified against production afterwards: the catalog postconditions all hold (one overload per function, no helper survived, `anon` locked out of all three entry points, no PostgREST role able to reach an internal function), and a nine-assertion rollback-only chain run live observed the actor and fingerprint on the receipt, an identical intent replaying to the same payment, `IDEMPOTENCY_INTENT_MISMATCH` on a changed selection / changed reference / a post aimed at a different payment, `IDEMPOTENCY_ACTOR_MISMATCH` for a second admin reusing the key, `IDEMPOTENCY_KEY_REQUIRED` on a NULL key, and a legacy unbound receipt failing closed. Full detail in `docs/CHANGELOG.md` (2026-08-11 closeout) and `docs/reference/migration-history.md` row 867. **3.4 remains open and parked** by the settled owner decision above.

The table below records what was built, and is kept for reference; every row is now live.

| Piece | File | State |
| --- | --- | --- |
| Migration — renames the three payout bodies to `_<name>_intent_impl_20260809` (money logic never retyped) and creates public wrappers that bind each receipt to `request_actor_id` + a SHA-256 `request_fingerprint`; adds the `check_idempotency_intent` helper | `supabase/migrations/20260811130000_bind_commission_payout_idempotency_to_intent.sql` | Written; proven in a disposable container |
| Rollback-only smoke chain | `scripts/smoke/smoke-commission-payout-intent-binding.sql` (registered in `scripts/smoke/smoke-specs.json` under `create_commission_payment`) | Passing |
| Container proof — network-isolated throwaway PostgreSQL 17, prints `COMMISSION_PAYOUT_INTENT_BINDING_PROOF_PASS` | `scripts/smoke/prove-commission-payout-intent-binding.mjs` | Green |
| Frontend — `getIdempotencyBindingRejection` maps the three refusals to plain-English warnings and retires the dead key in all three handlers | `src/lib/idempotency.ts`, `src/pages/CommissionPayments.tsx` | Done |
| Source guard the report asked for | `src/lib/commissionPayoutIntentBindingMigration.test.ts` | Passing |

Two deliberate departures from the `20260803010917` reference pattern, both documented in the migration header:

1. **The wrapper returns the committed receipt itself on an exact replay** instead of delegating back into the implementation. `idempotency_keys.result` is nullable and the implementation's operation-only `check_idempotency` reads a NULL result as "no receipt" — delegating would have re-executed the payout. A SQL-NULL or JSON-`null` stored result now raises `IDEMPOTENCY_RESULT_INVALID`.
2. **No per-entity scope check before returning the receipt in the error DETAIL.** All three payout RPCs are admin-only, the wrapper re-runs `is_admin()` before any receipt is read, and an admin can already read every payout row.

Mutation-tested (guard broken → test red → restored): the fingerprint comparison, the actor comparison, the legacy-receipt bridge, the frontend refusal branch, and the frontend key reset.

**Both Codex reviews returned DO NOT SHIP on 2026-08-09 (sol and terra, independently). Every confirmed finding is fixed on this branch as of 2026-08-10; the branch is still not live and still needs a clean re-review plus Mason's explicit OK before the migration is applied.** What the reviews caught, and what changed:

- **A dead key trapped the operator.** `IDEMPOTENCY_RESULT_INVALID` and `IDEMPOTENCY_RECEIPT_MISSING` were not classified, so the UI left an unusable key in place and every retry failed the same way forever. They are now a third refusal kind, `'receipt'`, with their own wording, and the key is retired like the other two.
- **The UI asserted something the database cannot prove.** On a pre-migration receipt the database knows only that the key is spent, not that the earlier request differed. The warning no longer claims a different payment was involved.
- **The refresh was not awaited**, so the toast told the admin to check a list that had not reloaded yet.
- **The privilege post-condition checked only `anon` and `authenticated`.** A `service_role` grant could have put an unguarded implementation back on a PostgREST-reachable surface. The `DO $verify$` block now denies all three roles across the receipt helper and all three implementations.
- **The concurrency test proved nothing.** Two `docker exec` sessions never actually overlapped, so deleting the advisory lock kept the proof green. The proof now holds both backends at a barrier and widens the window with a session-gated delay; removing the lock fails with two winners, as it should.
- **Structural tests had a first-occurrence bug**: the ordering check compared against the un-keyed delegation branch, so the binding `UPDATE` could have moved ahead of the payout call unnoticed.

Mutation coverage after the fixes: 7/7 behavioural mutations (advisory lock, result-invalid guard, `service_role` grant, two fingerprint fields, legacy replay, actor stamping) and 8/8 structural mutations go red. Full frontend suite green (4,339 tests).

`src/lib/commissionPayoutGuards.test.ts` needed a rename-aware fix: the stale-selection guards moved into the renamed implementation, so a name-based scan read the new thin wrapper and reported them missing. It now reads the body from before the rename and separately proves the wrapper still calls it — worth remembering for any future migration that renames a guarded function out from under its public name.

---

## 1b. RESOLVED 2026-07-22 — commission-recipient close-out: PR #213 MERGED (after PR #216), all migrations live

Branch `claude/nervous-dubinsky-39a725` (worktree `.claude/worktrees/stoic-heyrovsky-ebaaf6`, PR #213 open): **six migrations ALL APPLIED LIVE and individually proven** (ledger rows 812–817; row 817 = `20260722172533_reuse_guard_covers_revivable_quotes`, closing the round-8 terminal-quote finding) plus the CommissionSplitEditor dropdown frontend. Pipeline green. The Codex push-proof gate (rounds 9–10) still refuses the branch on three design-level residuals of NAME-based split identity: (1) invoiced jobs are revivable via `void_invoice` (job returns to completed, reinvoicing re-resolves names) but the reuse guard's jobs branch covers only scheduled/in_progress/completed; (2) recipient ROLE eligibility is dropdown-only, not enforced in the DB validator/creation path; (3) the save-split vs profile-rename concurrency race. The gate is static-diff-only — it explicitly will not accept live-state supersession evidence for gaps in the reviewed diff.

**Decision (Mason, in-chat 2026-07-22): yield to the parallel id-redesign session** (branch `claude/commission-split-recipient-ids`), which already applied live migration `20260722174029` (recipient ids stamped into splits at save; creation helpers consume ids — finding 3 closed in substance) and has role-eligibility in its charter (finding 2). One DB-writing session at a time: this branch stopped writing migrations on discovering the overlap. **To land:** after the id-redesign branch merges (its diff carries the id-binding + role migrations the gate wants), merge/rebase this branch on main, re-run `node scripts/write-codex-push-proof.mjs`, push, merge PR #213. Hand the id-redesign session finding (1) — invoiced-jobs revival — so its guard/redesign covers it. Until merged, rows 812–817's migration files exist only in this worktree (disk-vs-live drift for other checkouts); registry/fixture on this branch intentionally stop at high-water `20260722172533`.

**LANDED 2026-07-22 (same evening):** PR #216 merged first, then PR #213 merged to main (squash 4d686ece, Codex push-proof round 11 CLEAN on the post-merge HEAD, all checks + CodeRabbit green, prod Vercel deploy success). The section below is retained as history; the only open remainder is the follow-up guard-widening chip described in the residual note.

**Update 2026-07-22 (cross-session, id-redesign session):** finding (1) invoiced-jobs revival is **covered by routing** — the `20260722174029` backfill stamped `recipient_user_id` into every job split with no status filter (postflight: 0 id-less elements), and re-invoicing after `void_invoice` routes through `_insert_commissions_for_job` with id-precedence, so a re-acquired name cannot redirect a revived job's commissions while the original profile is active. **One narrow RESIDUAL remains (guard-scope, this branch's function):** if the recipient profile is *deactivated* and the name re-acquired while the job sits `invoiced` (outside `_guard_recipient_name_reuse()`'s jobs branch), then the invoice is voided and re-invoiced, the id-inactive fallback re-resolves the stored name to the new holder. Fix = extend the guard's jobs branch to include `'invoiced'` (mirroring the `20260722172533` revivable-quotes pattern). Requires deactivation + name reacquisition + void + re-invoice in sequence — accepted as a follow-up migration (task chip spawned 2026-07-22), not a #213 blocker.

**RESOLVED 2026-08-07 (harness-guards audit):** the follow-up shipped the same day it was accepted — migration `20260722184744_reuse_guard_covers_invoiced_jobs` (ledger name `20260722180000_reuse_guard_covers_invoiced_jobs`; name-vs-version gotcha) extended `_guard_recipient_name_reuse()`'s jobs branch to include `invoiced`, verified live in the guard body. No further work needed; the 2026-08-07 incident-vs-guard audit initially flagged this as an open gap and confirmed it already closed.

## 2. Parked migrations (written, not applied)

| File | Purpose | Why parked | What unblocks it |
|---|---|---|---|
| ~~`supabase/migrations/20260730114102_vendor_bill_period_close_lock.sql`~~ (submitted `20260729231031_...`, B7-renamed to the server version) | Serializes governed vendor-bill create/update with accounting-period close using month locks | **APPLIED LIVE 2026-07-30** as Supabase ledger version `20260730114102` — no longer parked. Targeted catalog/ACL/constraint verification, the registered Section 9 rollback-only chain (`ERROR P0001 SMOKE_PASS_ROLLBACK`), and all 20 predicates with 0 non-allowlisted rows passed; raw approved output was 7 rows across 5 predicates. | Done. Residual boundaries remain explicit in §0f: direct authenticated-admin `accounting_periods` writes, no existing-vendor-bill close-completeness gate, and the wider pre-existing non-vendor-bill writer race. |
| ~~`supabase/migrations/20260730124308_close_accounting_period_idempotency_recheck.sql`~~ (submitted `20260730121951_...`, B7-renamed to the server version) | Same-key post-month-lock idempotency defense in depth | **APPLIED LIVE 2026-07-30** as Supabase ledger version `20260730124308` — no longer parked. Exact overload/owner/SECURITY DEFINER/search-path/ACL proof passed; two idempotency reads including the structurally asserted post-lock recheck were observed; fixed-date delivery rollback smoke returned `ERROR P0001 SMOKE_PASS_ROLLBACK`. | Done. Current helper key-lock serialization is behaviorally proven; Sol mutation testing showed that removing this redundant block still passes that proof. Independent post-follow-up all-20 sweep CLEAN: 7 raw/7 allowlisted/0 new rows across 5 predicates. |
| ~~`supabase/migrations/20260726201208_void_vendor_payment_vendor_liveness.sql`~~ (submitted `20260726210000_...`, B7-renamed to the live version) | **APPLIED LIVE 2026-07-26** (server version `20260726201208`) — no longer parked. Section 9 follow-up MEDIUM-1: `void_vendor_payment` now locks the vendor row (`deleted_at IS NULL … FOR UPDATE`) so it serializes with `delete_vendor`; a void against a soft-deleted vendor raises `VENDOR_DELETED`. Gate passed (both charters CLEAN) + Mason's in-chat approval; post-apply live body md5 matches disk exactly. | — | Done. Residual RESOLVED 2026-07-26: Mason approved the Deactivate/Reactivate reframe — `reactivate_vendor` RPC **APPLIED LIVE** (gate CLEAN, submitted `20260726213000`, server version `20260726212043`) + Vendors-page Show Inactive view and Reactivate button, giving `VENDOR_DELETED` a one-click remedy; the PR #236 review then caught (and 2026-07-26 same-day fix `20260726215154_vendors_inactive_admin_select` resolved, gate CLEAN + applied live) an RLS gap that hid inactive vendors from the new view. |
| ~~`supabase/migrations/20260722202622_commission_split_lost_update_guard.sql`~~ (submitted `20260722190000_...`, B7-renamed to the live version) | **APPLIED LIVE 2026-07-22** (server version `20260722202622`) — no longer parked. `save_quote`/`save_customer` reject a split overwrite when the client's `*_expected` snapshot no longer matches the stored value, echo the stored (trigger-enriched) split back, and canonicalize `save_quote`'s actor exception to `ACTOR_MISMATCH`. Proven live on both RPCs (conflict/rejection/matching-expected/omitted-key/actor-mismatch). | — | Done. |
| `supabase/migrations/20260807220323_log_customer_fact_rpc.sql` | `log_customer_fact` RPC: retry-safe, role-gated, actor-pinned CRM fact intake replacing the direct `customer_facts` insert in `CustomerFacts.tsx` | **APPLIED LIVE 2026-08-07** as version 20260807220323 (authored 20260807120000). History row 856. Frontend cutover to the RPC landed in the same change. | Done — both Codex charters CLEAN, postflight ACL assertions passed at apply. |
| `docs/audits/nightly-debug/parked-migrations/PARKED-03-cancel-delivery-scheduled-quick-prebook-leak.md` | Release prebooked inventory when a scheduled quick-delivery is cancelled | — | **RESOLVED, applied live 2026-06-16** (`20260616151122_cancel_delivery_release_prebook_on_quick_cancel`). File header already says so — stale-looking filename, not a stale fix. |
| `docs/audits/nightly-debug/parked-migrations/PARKED-07-seed-admin-security-OWNER-ACTION.md` | Flagged `seed-admin` edge function as an unauthenticated admin-mint endpoint | — | **RESOLVED** — `seed-admin` no longer exists in `supabase/functions/` (confirmed on disk this pass; `docs/reference/gotchas.md` line ~118 notes it was deleted 2026-06-16 as a security cleanup). |
| `scripts/.staging-migrations/SUPERSEDED-20260611080937_idempotency_lookup_operation_scope_sweep.sql` | Idempotency lookup operation-scoping sweep | Filename says SUPERSEDED | Nothing — already replaced, safe to ignore/delete |
| `scripts/.staging-migrations/workflow-fix-parked/u12/*`, `.../u13/*` | Draft patches for Applicator "My Day" (U12) and dispatch-assignment unification (U13) | **Verified superseded and removed locally in this ticket.** `docs/loops/business-workflow-fix-ledger.md` confirms both U12 and U13 **SHIPPED LIVE 2026-07-06/07** under different migration names (`20260707010000`/`20260707011000` for U12, `20260707020000` for U13) — not the deleted draft filenames (`20260706060000`, `20260706100000`). | Do not re-apply the removed drafts. |
| `scripts/.staging-migrations/workflow-waves-parked/SUPERSEDED-dispatch-backfill.sql` (was `PARKED-dispatch-backfill.sql`, renamed 2026-07-29) | One-time backfill of `job_location_dispatches` for legacy-assigned open jobs | **RETIRED 2026-07-29 — no longer parked, DO NOT APPLY.** The legacy population it was written for is gone and the live sync triggers cover the ordinary assignment paths. Verified read-only against live 2026-07-29: its own count query returns 0 rows (same as when parked on 2026-07-10), **no** open assigned job is missing a dispatch row at all (0 across every assignee, not just qualifying ones), and `trg_sync_job_location_dispatch_on_applicator_change` on `jobs` + `trg_sync_job_location_dispatch_on_field_insert` on `job_fields` are both live. It is **not** claimed that a gap can never reopen — see the dispatch trigger-coverage row below. | Nothing — it is not waiting on Mason. Do **not** re-run the count query "just in case" and apply it: this is a business-data write. If a dispatch row is ever genuinely missing, diagnose the trigger, do not resurrect this backfill. |
| Dispatch sync triggers skip a job assigned to a non-qualifying profile, and never re-sync (`20260707020000_assignment_unification.sql`) | A job assigned to a profile that is not (`is_active` **and** `role = 'applicator'`) silently gets no `job_location_dispatches` row, so it never reaches the dispatch board | **OPEN — found by cross-model review 2026-07-29, confirmed read-only against live.** Both sync triggers return early on that condition; nothing in the database stops the assignment (`_enforce_applicator_license` only checks license *expiry*, and `assign_job_applicator` validates the **caller's** role, not the assignee's); and no trigger on `profiles` re-syncs dispatches when a profile is later reactivated or changed to `applicator`. So deactivate → assign → reactivate leaves the job permanently off the board. Live today: **2** open jobs are assigned to an `admin`-role profile (both already have dispatch rows, so **0** rows are currently missing) — the path is reachable, the damage is not present. | Not urgent (no live gap right now), and **not** to be fixed with the retired backfill. The real fix is at the write path: either reject an invalid assignee in `assign_job_applicator`, or add a `profiles` trigger that re-syncs dispatches on an `is_active`/`role` transition. Needs its own scoped session — it changes assignment behavior Mason's team relies on. **Detection guard added 2026-08-07:** sweep predicate `scripts/db-invariant-sweeps/predicates/dispatch-sync-nonqualifying-profile.sql` now finds any open/scheduled job whose `job_fields` lacks a dispatch row because the assignee didn't qualify (verified 0 rows live) — the silent skip is no longer invisible, though the write-path fix above remains unbuilt. |
| `supabase/migrations/20260807215532_profile_role_lock_covers_insert.sql` | Extends `_guard_profile_role_lock` to `BEFORE INSERT OR UPDATE` so a logged-in non-admin cannot re-insert their own `profiles` row with `role = 'admin'` (§0d follow-up; closes the admin self-escalation path) | **APPLIED LIVE 2026-08-07** as version 20260807215532 (authored 20260807153000). Predicate `profile-role-lock-insert-arm.sql` verified 2 rows red → 0 green post-apply. History row 855. | Done — both Codex charters CLEAN; live non-admin escalation-insert probe blocked with PROFILE_INSERT_LOCK at apply. |
| `scripts/.staging-migrations/SUPERSEDED-20260717121000_supplier_pricing_phase1a_cutover.sql` | Historical pre-promotion source for the supplier-pricing enforcement cutover (renamed to the `SUPERSEDED-` convention 2026-07-28 so the fleet counter stops listing it as awaiting apply) | **RESOLVED, applied live 2026-07-18** as `supabase/migrations/20260718190000_supplier_pricing_phase1a_cutover.sql` after the governed RPC frontend was proven | Do not apply the staging artifact; its own md5 preflight would now abort, and forcing it past that would overwrite the live pricing functions with 2026-07-17 bodies. Product-page and worksheet edits remain live through the governed preview/apply RPCs |
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
- Related open item from the same review (not owner-decision-gated, just unbuilt): **#117** (`auto_draft_skipped` activity-feed row) — **BUILT 2026-07-21** as migration `20260722012359_auto_draft_skipped_activity_row.sql` (submitted 20260721230000; B7-renamed) (complete_job now logs both silent skip cases: non-office completer — the #107 gap — and already-invoiced job); **APPLIED LIVE 2026-07-21**, ledger version `20260722012359`. The #107 POLICY decision itself remains open and unchanged. **Correction 2026-07-16:** #106 and #109, previously listed here as open, actually SHIPPED LIVE 2026-07-06 via `20260707050000_application_record_integrity` (live v20260706175157) — see `docs/loops/business-workflow-fix-ledger.md` Night-2 entry (N2-7) and `docs/reference/migration-history.md` row #639; moved to §6.

~~Migration-apply approval policy is written two ways~~ — **SETTLED by Mason 2026-07-13** as option (b) with a destructive carve-out: armed autopilot + the apply-guard proof gate suffices in a pre-authorized hands-free run; interactive sessions still ask in chat; data-deleting/dropping migrations are never autonomous. Canonical text: `docs/manual/DECISION_LOG.md` (2026-07-13 entry).

Also open: **Sprint D leftovers** (`docs/loops/workflow-waves-ledger.md`) — D1/D2 shipped live 2026-07-10, but D3 is parked in two owner-decision halves: (a) blend-ticket-path commission minting, deliberately dormant until blend billing is actually used; (b) `jobs.commission_split` visibility to assigned applicators — Mason needs to decide between an admin-only side table or RPC-gating.

---

## 4. Deferred/parked feature work

- **CRM adoption + coverage gaps (2026-08-04 audit)** — the July relationship-intelligence build is intact
  and RLS-clean, but live data is empty: 0 interactions, 0 grower facts, 0 documents, 0 customer applicator
  licenses, and 146 of 150 active customers have no assigned sales rep. That data state — not the code — is
  what makes the unassigned-accounts call list, the crop filter, credit limits, statement email, and RUP
  compliance status non-functional today. Open coverage gaps in priority order: customer applicator-license
  visibility on the customer/prep-card/quote surfaces (legal exposure), pre-quote sales pipeline, duplicate-customer
  detection, bulk-import/bulk-assign of `assigned_sales_rep`, and auto-logging outbound email into
  `customer_interactions`. Also still open from the July loop: the **add-fact path is retry-unsafe**
  (direct insert; the interaction path got its idempotent RPC on 2026-07-17, the fact path did not).
  Full detail and recommendations: `docs/audits/2026-08-04-crm-functional-and-coverage-audit.md`.

- ~~**Per-line-item custom split billing (field-app)**~~ — **no longer deferred. SHIPPED 2026-07-21 (PR #164)
  and live with the flag ON; see §0 for the current status and the one remaining gap (it has never been
  used).**
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

- **Supplier Pricing Phase 3C PR containment remains PARKED.** The trusted `pull_request_target` workflow is a future-PR guard and cannot retroactively protect PR #246 because its base predates the workflow. After the introducing PR merges, only the exact `Phase 3C Trusted Base Containment` check may be enforced by `protect-main` or equivalent immutable required-workflow control, followed by live proof; `Phase 3C Candidate Containment (CI)` is deliberately candidate-controlled and must never be selected as the protected check. Until then, local pre-commit/pre-push hooks are the active guard against accidental private-packet commits, while candidate-controlled PR CI remains advisory. Its unauthenticated `refs/pull/<n>/head` fetch depends on this repository remaining public; private-repository use requires read-only authentication.
- **Phase 3C first-push ancestry cap requires maintenance before 4,096 commits.** The checker currently measures 2,128 commits and deliberately fails closed when a brand-new remote ref would traverse more than `MAX_HISTORY_COMMITS = 4_096`. Reassess and raise the bounded cap with measured scan-budget proof well before repository ancestry approaches the limit; otherwise the first push of every new branch will be blocked.
- **Phase 3C byte and candidate scan budgets require measured maintenance.** The measured first-push proof consumed about 1.61 GiB; `MAX_TOTAL_STRUCTURAL_SCAN_BYTES` was raised from 2 GiB (already about 80.5% used) to 3 GiB, leaving about 46% headroom. The same proof used 71,289 of `MAX_STRUCTURAL_SCAN_CANDIDATES = 100,000`. Re-measure and adjust either bound with adversarial memory/time proof before it reaches 80%; a breach intentionally blocks push and CI rather than scanning an unbounded repository.
- **Proof-file self-attestation** — the migration-apply and Codex-push proof JSONs can be written by the same agent that should be gated by them; nothing binds the proof to an actual reviewer run. Partial raise-the-bar option: have the reviewer subagents write the proof themselves. Full closure impractical (accepted residual for a malicious agent; the fix targets honest confusion). The 2026-07-13 hands-free additions (content-bound `codex-review-mig-<name>.json` Codex proof, exact `queryHash` binding on both proofs, required `reviewers` array naming both reviewer subagents, and timestamp freshness bounded to [0, 30 min] so future-dated stamps fail) raise the honest-mistake bar further but remain self-attestable by a deliberately dishonest agent — same accepted residual. Likewise the destructive-SQL classifier is a lexical scanner, not a SQL parser: it is quote-aware and default-keep (five adversarial Codex rounds closed the comment/literal/dollar-quote hiding tricks), but a genuinely novel obfuscation could still slip it — the classifier's job is stopping honest mistakes, and its false positives merely park a migration for the morning.
- **Migration source provenance closes the quiet path, not the loud one** (added 2026-08-31, from CodeRabbit's Major on PR #525). The apply gate now refuses SQL that is not the exact content of `<checkout>/supabase/migrations/<name>.sql` — an allowlist naming the one permitted directory, so parked drafts, `.REJECTED` files in any spelling, scratch copies and text that was never a file all fail by construction rather than by enumeration. What it does **not** stop: an agent that copies a parked file **into** `supabase/migrations/` and applies it from there. Provenance then passes, and the reviewer + Codex proofs are still required. That is the deliberate boundary — the rule forces a tracked, diffable, reviewable file move instead of a pasted body that leaves no trace on disk, which is the same honest-mistake threat model as the proof self-attestation residual above. Scope is session-local (this checkout and the primary one, never a sibling worktree), matching the reviewer-proof lookup. Do **not** "fix" the residual by adding a blocklist of rejected suffixes or parked directories: the allowlist already covers every location, and a suffix list reopens each round — see the 2026-08-31 `bash-safety-lib` entry above (eight holes across five rounds) and the 2026-08-25/26 `DECISION_LOG` entries on closed allowlists.
- **New live-sweep predicates worth writing** (scripts/db-invariant-sweeps/): a `concurrency-hotspot` predicate asserting the named race-prone functions (inventory reservations, prebook, number sequences, balances) contain `FOR UPDATE`/advisory locks; ~~an `audit-log-completeness` predicate asserting each allowlisted money-mutator RPC writes `financial_audit_log`~~ (**BUILT 2026-08-07** — `predicates/audit-log-completeness.sql`, 0 rows live, non-vacuous over 39 money-mutating SECDEF functions); more `fin-*` arithmetic identities per derived-value family — **PARTIALLY BUILT 2026-08-07**: `fin-vendor-bill-balance-identity.sql` (0 rows live) and `fin-po-receipt-identity.sql` (22 March-2026 import-era violations **accepted-and-baselined by Mason 2026-08-07** — each allowlisted per-key with live figures recorded; sweep nets to 0 and any NEW violation still fails); order/quote `total_profit`, `net_margin_pct`, per-line commissions still unwritten.
- ~~**Write-time forgeable-actor hook**~~ — **BUILT 2026-08-07** as `.claude/hooks/actor-binding-check.mjs` (+ test, wired in `.claude/settings.json` and `.codex/hooks.json`): PreToolUse Write|Edit hook flagging SECDEF migration functions with `p_performed_by`/`p_actor%`/`p_user%` params lacking `ACTOR_MISMATCH` binding, at write time instead of post-write sweeps.
- **Edge Functions are exempt from the assert/check ESLint rules** (Deno) and the coverage ratchet's scope leaves ~130 legacy Supabase reads unchecked — known accepted gaps.
- **Invoice-type leaks and direct-URL edit-lock bypasses** (lifecycle class) have no static guard — stays reviewer-checklist territory (`compliance-reviewer`).
- **Shell string-reconstruction bypasses** of the Bash regex guards (quote-splitting, variable substitution) — accepted residual under the honest-mistake threat model; keep widening regexes as concrete shapes appear.
- **worktree-awareness is a session-start snapshot** — no mid-session warning when a sibling merges or applies; accepted perf tradeoff, re-run `git worktree list`/`/fleet` before done-claims.
- **stop-verify PROOF matching is text-based**, not tool-call provenance — a fabricated PROOF line passes; hardening would require binding to transcript tool_use records.
- **npm `--prefix`/`--workspace` forms escape the script-body guard** (Codex round-5 P2, 2026-07-13) — `npm --prefix client run x` yields no script name to the bash-safety-lib extractor, so the resolved-body check silently skips. Correct handling needs value-taking-option parsing AND resolving the *other* package.json the option points at. Accepted residual: CRX is a single-package repo (these forms never occur here), and the guard's threat model is honest mistakes; revisit if the repo ever becomes a workspace/monorepo.
- **Commission name-reuse guard retirement is PARKED (2026-07-22)** — the durable UUID-routing migration (`20260722170000_commission_split_recipient_ids.sql`) deliberately KEEPS `trg_guard_recipient_name_reuse`. Codex push-proof BLOCKER: while any deployed bundle can still send a name-only split (all pre-change bundles; new bundles via the CommissionSplitEditor RPC-failure fallback list), a re-acquired name would be stamped with the NEW holder's UUID at write time — the guard is what makes name-only writes unambiguous. Retirement unblocks when name-only split writes are impossible: id-carrying frontend fully propagated (PWA needs two reloads) AND the DB rejects id-less elements (small follow-up migration flipping the stamp/validator to require `recipient_user_id`, plus removing/id-ing the editor fallback list). Until then the guard's name-reservation friction on profile renames is accepted, as is the related fail-closed friction Codex round 2/3 examined: after an admin renames a profile, commission ROUTING for stored splits is unaffected (the active id wins at creation time), but a SAVE that resends a split still carrying the old display name is REFUSED until the operator re-picks the person — the resend is a name-vs-id mismatch whose name no longer resolves, indistinguishable at write time from a failed reassignment (a silent id-fallback was tried and reverted — Codex round 3 showed it could misroute a genuinely failed reassignment; deactivating a referenced profile fail-closes both paths as intended).
- **Gauntlet V2 Phase 2 remains intentionally open** — Phase 1 makes missing evidence loud but does not manufacture unavailable evidence. The page-render gate still has 44 reasoned, count-ratcheted skips; five E2E files still contain direct production endpoint literals (Playwright now blocks before setup) and additional auth-token storage keys are production-project-specific; staging Supabase/secrets do not exist yet, so E2E stays `if: false`; `db-sweeps:strict` still needs an authenticated execution path in CI; the live-schema suite remains trusted-run-only via `npm run test:schema-live` because ordinary GitHub Actions has no least-privilege credential (the production service-role key must not be added merely to make CI green); Sentry's 30-day collector remains `BLOCKED` by Unauthorized. None of these may be reported as clean until executed evidence exists.

---

## 5. Known technical debt / accepted quirks

- **Offline work recovery database foundation and browser rollout are live; phone/device E2E remains pending** — all four receipt migrations, including the corrective target-row lock, were applied and verified on 2026-07-14, and PR #124's browser rollout landed on `main` before the 2026-07-15 offline verification pass. Browser retention until proven success, distinct cap/backlog handling, a safe device review panel, audited office `already_completed` / `abandoned` resolution, and cross-tab replay protection are now in code. A saved action that lacks an original queue-time target snapshot is intentionally sent to office review rather than deriving a new baseline after reconnect; therefore snapshot conflict coverage is complete only for actions that captured the snapshot when queued. Still deferred: signature/photo persistence, idempotent email/notification replay, operation-specific conflict preconditions, automatic device discovery of an office resolution, and a general duplicate-action policy. Browser storage remains device-local until the phone reconnects and stages its permanent server receipt, so destroying or clearing that storage before reconnection can still lose work. Source: `docs/audits/2026-07-15-offline-stage1b-rollout-verification.md`, `docs/audits/2026-07-14-offline-receipt-browser-office-resolution-proof.md`, and `docs/roadmap/offline-work-stage1b-receipt-design-2026-07-13.md`.
- **Live `schema_migrations` having more entries than files on disk is OLD, pre-existing drift** — do not treat it as a new problem. Only reconcile migrations newer than the point where the current branch diverged from `origin/main`. (Session memory: `project_migration-disk-vs-live-drift`.)
- **Page-render tests pass in isolation but flake in the full `vitest` suite** — fix with `waitFor`/`findAllBy`, not synchronous `getBy`. See `docs/reference/gotchas.md` and session memory `project_page-test-fullsuite-flake`.
- **A test that clicks Save on `JobDetail` must RETRY the click, not just wait longer** — a *third* root cause, distinct from both flake classes around it. `handleSave` fails closed while the label-rate policy is still loading: it toasts "Checking the label-rate policy — try Save again in a moment." and returns. Those lookups (`guardrailModeLoaded`, `jobLabelsLoaded`) are separate queries from the job/products fetch that renders the page, so awaiting on-screen content does **not** mean the save gate is open. A single `fireEvent.click` landing in that window emits a non-matching toast and returns — and nothing re-fires the save, so a `waitFor` on the expected toast spins until it times out, surfacing as `AssertionError: expected false to be true`. Neither a longer timeout nor `waitFor` can fix this; only a retry can. `JobDetail.billingHazard.test.tsx` routes all nine save clicks through a `clickSave()` helper that re-clicks while the gate is still closed (safe: while closed the save never proceeds, so it cannot double-save), and its mock deliberately holds the by-id products query open so every save-clicking test exercises the fail-closed branch instead of racing past it. Hold it with a **deferred promise, not a timer**: a fixed delay silently stops testing anything once a machine is slow enough that the query resolves before the first click, and `clickSave()` therefore also *asserts* the blocked attempt happened rather than assuming it. Verified 2026-08-25: with that harness and a single un-retried click, 5 tests fail with the production symptom; with the helper, all 14 pass. If you add a save-clicking test to a page with a load-gated `handleSave`, use the same helper shape.
- **ExcelJS workbook tests can exceed the 5s default timeout on a cold cache** — a *different* root cause from the page-render flake above, so the `waitFor` fix does not apply. The first ExcelJS load inside a worker is multi-second (7.0s measured 2026-08-25 on the first `vitest` run after a fresh `npm ci` in a new worktree) versus ~350ms once warm, so whichever test triggers that load sits right on the 5s cap and swings by an order of magnitude. Because `.husky/pre-commit` runs the full suite, a cold-cache miss hard-blocks an unrelated commit — the exact pressure toward the forbidden `--no-verify`. Fix: an explicit generous per-test timeout as the third argument to `it(...)`, never a higher global `testTimeout` (that would relax the 5s contract for the whole suite). All three ExcelJS test files now carry one — `productPricingWorkbook.test.ts` (20s/45s), `supplierPricingWorkbook.test.ts` (20s), and `productPricingSupplierEvidenceWorkbook.test.ts` (30s, added 2026-08-25 after it flaked in PR #476). Every ExcelJS load in these files happens inside a test body (no `beforeAll`/module-scope load), and tests run in file order, so the first test in each file absorbs the cold cost — that is why covering the first test per file is sufficient for the pre-commit gate. Residual: a manually filtered run (`vitest -t "…"`) that selects a *later* test in a file makes that test pay the cold load under the 5s cap; filtered runs do not gate commits, so this is accepted rather than blanket-timed-out.
- **PWA (installed app) needs two reloads after a production deploy** to pick up a new service-worker chunk — expected behavior, not a bug to chase.
- **Prepay bulk-apply (`apply_remaining_prepayments` / `batch_apply_all_prepayments`) is hard-disabled in production** (`RAISE 'PREPAY_BULK_APPLY_DISABLED'`, migration `20260620200000`) rather than properly fixed — the real fix needs the shelved reserved-pool redesign (§2/§4). Per-invoice `apply_prepay_to_invoice` is unaffected.
- **`commission_payments.total_amount` is a legacy numeric-dollar column and remains tracked debt until the full approval gate is proven** — current posting compares the header and item totals directly in the same numeric-dollar unit; only `financial_audit_log.total_impact_cents` converts the posted total to cents. Verify exact numeric arithmetic, clean finite whole-cent values, and an active finite whole-cent CHECK before treating it as an approved compatibility exception. Converting historical payment headers/items safely is a dedicated money-schema migration, not part of the gauntlet cutover; do not casually retype or rewrite it while re-emitting posting guards.
- **Renaming or deactivating a profile still referenced by an unfinished quote/job commission split now fails closed at the next validator touch** (quote edit/conversion, job invoicing) with `COMMISSION_SPLIT_INVALID: recipient … does not match exactly one active user` — since migration `20260722134252` (gauntlet §7). This is deliberate (Mason chose reject-at-creation over silent unpayable commissions, 2026-07-22): the fix is to update the affected split to a current active user (or restore the profile), not to weaken the validator. Codex proposed an automatic profile→split reconciliation build; declined as scope creep for a zero-affected-rows preventive guard. Since migrations `20260722144121`/`20260722150432` (same day): profile names are admin-only to change, two active users cannot share a name, and NO profile — admin actions included — may acquire a name still referenced by a split with future money (`COMMISSION_RECIPIENT_NAME_RESERVED`); update the splits first. Durable follow-up (parked task): store profile ids inside splits instead of names, which retires this whole name-identity guard family.
- See `docs/reference/gotchas.md` for the full list of non-obvious schema/RPC quirks (idempotency column names, generated columns, tables without `updated_at`, etc.) — this file does not duplicate that content.

---

## 6. Recently resolved (last ~30 days)

- **2026-07-22** — Gauntlet §7 HIGH (CommissionSplitEditor "Other" free-text recipient → commissions with NULL `recipient_user_id` that no payout batch can ever select) closed with the reject-at-creation option Mason chose. Live migration `20260722134252_reject_unresolvable_commission_recipients` (submitted `20260722124500`): validator now requires every split recipient to resolve to exactly one active profile (SECDEF boolean helper works under admin-or-self profiles RLS), a `BEFORE INSERT OR UPDATE OF recipient_user_id` backstop trigger on `commissions` refuses NULL-recipient rows on every code path, and the new `list_commission_recipients()` RPC feeds the editor dropdown (commission-eligible roles; picked up Clayton Wells, whom the old hardcoded list omitted). Free-text "Other" removed from the UI. Zero live rows were affected; the single legacy NULL row (cancelled, $0, 2026-03-16) is grandfathered. See §5 for the accepted rename/deactivate fail-closed trade-off. Ranked-queue row 14 in `docs/audits/gauntlet/live-foundation-gauntlet-summary.md` is closed by this.
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
