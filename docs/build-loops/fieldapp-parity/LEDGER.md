# Field-App Parity — Progress Ledger

**Branch:** `feat/fieldapp-parity` (off `origin/main` d65d15d7)  
**Worktree:** `C:\CRX_Manager\.claude\worktrees\fieldapp-parity`  
**Step-0 re-audit:** 2026-06-24 → **0 DONE · 19 PARTIAL · 22 TODO** (all 41 need work). Full evidence: `STEP0-AUDIT.json`.  
**Progress this run:** 8 / 41 sections BUILT. Machine state: `PROGRESS.json`.

**Status key:** `PENDING` (awaiting build) · `IN-PROGRESS` · `BUILT` (built+verified+Codex-clean this run) · `BLOCKED`.

## Orchestration notes (read on resume)
- **I am the orchestrator.** Build each PENDING section via a FRESH subagent in the topo order below following `BUILD-SUBAGENT-TEMPLATE.md`; verify (ran & proven); Codex-review; fix High/Med; commit to `feat/fieldapp-parity`; update `PROGRESS.json` + regenerate this file; next. Build sequentially (all Phase-1 sections touch Jobs.tsx/JobDetail.tsx — concurrent agents in one worktree would clobber each other).
- **Harness gotcha:** session rooted at `C:\`, NOT the worktree → project `.claude` apply-guard + reviewer subagents do NOT auto-fire. Migrations apply to LOCAL only during the run. Run the 5 reviewer concerns + apply-guard MANUALLY at the production gate. (git pre-commit/pre-push hooks DO still fire.)
- **Cross-dep wrinkle:** #7 Mass-edit dep "Loader worksheet (bulk-editable fields)" = section #10, built (P4) AFTER #7. Build #7 date/status/recipe mass-edit first; wire loader-worksheet bulk column when #10 lands.
- **Tag-chips column** in the job list is a SLOT (built in #1); section #4 populates it with the real tag manager/table/filter.

## Local environment (READY 2026-06-24)
- **Local Supabase (throwaway):** API `http://127.0.0.1:54321` · DB `postgresql://postgres:postgres@127.0.0.1:54322/postgres` · project dir `C:\Users\mason\fieldapp-local-db`. Heavy services excluded.
- **Worktree `.env`** (gitignored, NEVER commit) → LOCAL stack. Local admin: `admin@local.test` / `localadmin123` (role=admin). DB empty of business data — agents seed their own.
- **Query local DB:** `docker exec supabase_db_fieldapp-local-db psql -U postgres -d postgres -c "…"`. **Test new migration:** copy to `C:\Users\mason\fieldapp-local-db\supabase\migrations\`, apply via `docker exec -i … psql … < file`; smoke via `SUPABASE_DB_URL=<DB_URL> node scripts/smoke/run-smoke.mjs --spec <rpc>`.
- **Baseline caveat (pre-existing repo tech-debt, NOT mine):** 517-migration history doesn't replay from scratch — 29 copy-renames + 5 shim objects + ~34 content patches, ALL on COPIES (real files untouched). New additive migrations apply to live normally at the gate. Detail: `C:\Users\mason\fieldapp-local-db\copy-fixes.log`.

## Carry-forward notes (from built sections — read before building dependents)
- #1 → #26 auto-split: per-field per-customer shares persist in job_field_shares(job_id, field_id, customer_id, split_pct, is_primary), defaulted from field_billing_defaults, validated to 100% per field. save_job rejects shares for fields not on the job. Canonical split engine to reuse: derive_customer_shares_from_fields(uuid[], jsonb).
- #1 → #10/#18 remaining-acres: jobs.applied_acres (default 0) + GENERATED jobs.remaining_acres = GREATEST(total_acres - applied_acres, 0). As-applied work UPDATEs applied_acres; NEVER write remaining_acres directly.
- #1 new columns: jobs gained call_date,date_proposed,time_proposed,schedule_date,date_expires,consultant_id,loader_comment,additional_info,internal_memo(NOT printed - keep off customer PDFs),updated_by,printed_at(stamped by WPS-notice action). job_fields gained planted_acres,crop,strip,pests. job_chemicals gained diluent_rate,rei_hours,phi_days,warehouse(free text - products has no warehouse col),vendor.
- #1 save_job signature unchanged (6 args, ONE overload). New data rides in p_job_payload (field_shares[], scheduling, memos) + p_fields/p_chemicals arrays. Don't add an overload.
- #1 reusable: tabbed-editor pattern + snapshot-based dirty tracking in JobDetail.tsx; toGallonOrLbEquivalent + converter in src/lib/chemCalculator.ts.
- ENV (local only, not code): the throwaway local DB needed the standard GRANT SELECT/INSERT/UPDATE/DELETE TO authenticated/anon on public tables (applied to local; live already has them). If a later section's local app can't load any page, that's the fix.
- #4 → #6 filter set: job-tag filter state = useState<string[]>([]) of job_tags.id; pure predicate jobMatchesTagFilter(jobTagIds, selectedTagIds) in src/components/jobs/jobTagFilter.ts (empty=passes all, OR within tags). It's applied CLIENT-SIDE in a visibleJobs=useMemo() that drives DataTable+totals+useRowSelection. Status/customer/date are SERVER-side query filters; tags ride the joined query. #6 must FOLD into this same visibleJobs pipeline, not rebuild it. assignmentsByJob: Map<jobId,Set<tagId>> already built on the page.
- #5 → #9/#16: job_fields.sort_order is the SINGLE authoritative applicator route order (0..n, contiguous, renumbered on every save). Read fields ORDER BY sort_order (PostgREST doesn't guarantee embedded-row order). Map pin # = sort_order+1 = 'Stop N'.
- #6 → #3/#7/#8: Jobs filter is now ONE JobFilters object (draft edited, applied drives query+memo) feeding the SAME visibleJobs memo that drives DataTable + bottom totals + useRowSelection. Extend there; don't add a parallel filter. selectedRows (useRowSelection) operates over visibleJobs, so #3/#7 bulk actions get the filtered+selected set for free. REUSE src/components/jobs/MultiSelectDropdown.tsx (generic {value,label,color?}). Reference lists already on the page: customers/applicators/vehicles/appServices/crews/allTags.
- #6 → #7: status multi-select uses canonical list scheduled/in_progress/completed/invoiced/cancelled — keep mass-edit status a SUPERSET of the live CHECK.
- #6 → #13/#21: ground crews now EXIST (ground_crews + ground_crew_members tables w/ RLS, jobs.ground_crew_id). #6 owns the crew CATALOG + job-level crew (persisted via a direct .update() in JobDetail, NOT save_job — the 6-arg save_job contract is frozen; if a future section puts crew in the save_job payload, extend the RPC body too). #13/#21 should attach crew/members to the APPLIED-INFO record and reuse GroundCrewsManager — do NOT recreate the tables.
- #3 → #7/#8: job batches = job_batches table (RLS) + jobs.batch_ref FK (ON DELETE SET NULL, one-batch-per-job, distinct from many-to-many tags). Batch filter = JobFilters.batchIds (SERVER-side on batch_ref); batchOptions/batchByJob Map/batchMemberCounts already on the Jobs page. #7 mass-edit can 'Set batch' via the same direct .update() (admin/sales gated) — reuse JobBatchAssignModal's single-choice pattern. #8 columns: a sortable 'Batch' column (key 'batch_name') is in dataColumns — include it in the per-column on/off toggle set.
- #7 → #10: wire the loader-worksheet bulk option at the '#10 INSERTION POINT' comment in src/components/jobs/JobMassEditModal.tsx; add the opt-in flag(s) to MassEditDraft in jobMassEdit.ts and include the column(s) in buildFieldPatch() (clean patch object — drops in without touching date/status/applicator/batch).
- #7 → any bulk-status section: reuse partitionByStatusLegality() + allowedSourceStatuses() in src/components/jobs/jobMassEdit.ts (they mirror _enforce_job_status_transition). FORWARD steps (in_progress/completed/invoiced) MUST go through start_job/complete_job/transfer_job_to_invoice (they create application records/inventory moves/invoices) — never a raw status update. Bulk mass-edit only applies 'cancelled'.
- #8 → all later list work: the Jobs list now renders via a per-user VISIBLE set (orderedVisibleColumnIds, registry order). Any new job-list column must be added to JOB_COLUMN_REGISTRY in src/components/jobs/jobListColumns.ts (id,label,shared,defaultVisible) AND to dataColumns in Jobs.tsx, or it won't appear. user_list_settings is a GENERIC per-user table keyed (user_id, list_key) with RLS auth.uid()=user_id — REUSE it for the Phase-3 invoice lists (add a list_key or extend the shared map; isInvoiceColumnVisible already shares the 'jobs' list_key for 3 shared columns). showCompleted=false hides completed jobs UNLESS the status filter explicitly includes 'completed'.

## Build order (topological; PLAN-phase tie-break)

- [x] ** 1.** (#1, P1-Jobs) `(DB)` **Job list + create/edit job parity** — **BUILT** 11/11 · commit `faf90ad7` · mig `20260624120000_job_parity_scheduling_agronomy_shares.sql`
      ↳ Independently confirmed: job_field_shares table + RLS, 10 new jobs cols (remaining_acres GENERATED), job_chemicals/job_fields extras all on local; typecheck+build+2226 tests green; agent ran full flow in-app vs local DB.
- [x] ** 2.** (#2, P1-Jobs)       **Recipes (save/reuse tank mixes on a job)** — **BUILT** 5/5 · commit `7210f583`
      ↳ Spot-checked: commit on branch, typecheck PASS, no active frontend load_recipe_into_job call. Agent verified save-as/last-used/load (merge+replace, price-preserving) in-app vs local DB.
- [x] ** 3.** (#4, P1-Jobs) `(DB)` **Color-coded job tags (create/edit/delete + chips + filter)** — **BUILT** 8/8 · commit `ac1bf74` · mig `20260624130000_job_tags.sql`
      ↳ Orchestrator spot-check: HEAD ac1bf74, tree clean, typecheck PASS, both tables RLS=true (4+3 policies) on local. Independent adversarial reviewer CLEAN (live RLS/constraint/index probing). Agent ran tag create/assign/chip/filter/bulk in Chrome vs local.
- [x] ** 4.** (#5, P1-Jobs)       **Field/location route-ordering (drag to set applicator drive order)** — **BUILT** 5/5 · commit `6de0509`
      ↳ Spot-check + agent ran in-app vs local: dragged + keyboard-reordered 3 fields, saved, DB sort_order confirmed (0=East 40,1=North 80,2=South Creek), persisted across reload; per-field shares moved with rows.
- [x] ** 5.** (#6, P1-Jobs) `(DB)` **Full filter set (AND-combined)** — **BUILT** 6/6 · commit `c326e05e` · mig `20260624140000_job_ground_crews_and_filter_indexes.sql`
      ↳ Spot-check: HEAD c326e05e, tree clean, typecheck PASS, crew tables RLS=true, ground_crew_id + filter indexes present on local. Reviewer CLEAN (live RLS/FK/index probing). Agent ran multi-filter AND-narrowing in-app (7→3 jobs, totals 645→325 ac) + CLEAR ALL reset.
- [x] ** 6.** (#3, P1-Jobs) `(DB)` **Job batches (group jobs into named batches)** — **BUILT** 5/5 · commit `6357b94` · mig `20260624150000_job_batches.sql`
      ↳ Spot-check: HEAD 6357b94, tree clean, typecheck PASS, job_batches RLS=true + jobs.batch_ref present. Multi-lens panel CLEAN. Agent ran create/assign/filter/remove/reload in-app vs local.
- [x] ** 7.** (#7, P1-Jobs)       **Mass edit selected jobs (dates / status / loader worksheets)** — **BUILT** 7/7 · commit `5e827066`
      ↳ Spot-check: HEAD 5e827066, tree clean, typecheck PASS, no cancel_job RPC to bypass. Reviewer CLEAN (status-legality + cancel side-effects + selection). Agent ran 3-job mass-edit (date/status/applicator/batch) in-app vs local; unselected + unfilled-field jobs proven untouched.
- [x] ** 8.** (#8, P1-Jobs) `(DB)` **Customizable list columns (List Settings)** — **BUILT** 6/6 · commit `77ad2ef1` · mig `20260624160000_user_list_settings.sql`
      ↳ Spot-check: HEAD 77ad2ef1, tree clean, typecheck PASS, user_list_settings RLS=true 4 policies all auth.uid()-bound. Multi-lens CLEAN. Agent ran toggle+persist+reload+per-user-isolation in-app/DB; 2326 tests pass.
- [ ] ** 9.** (#17, P2-Applied) `(DB)` **As-applied entry record (applicator, vehicle, application date)** — _PARTIAL_ (1/6) · PENDING
      ↳ gaps: Applicator is a free-text input, NOT selected from the applicator/profile list (FieldAppli… / No Vehicle field at all on the field-app invoice, and no auto-default-from-applicator
- [ ] **10.** (#18, P2-Applied) `(DB)` **Applied acres per location + remaining-acres tracking (partial / multi-day)** — _PARTIAL_ (2/7) · PENDING
      ↳ gaps: No Total vs Applied vs REMAINING acres tracking per job (Remaining = planned - sum applied… / No live 'X of Y remaining' indicator anywhere (grep for remaining-acres in field-app conte…
- [ ] **11.** (#19, P2-Applied) `(DB)` **START + END weather pair on field-app invoices (Open-Meteo auto-pull)** — _TODO_ (0/9) · PENDING
      ↳ gaps: No START weather set with Time/Temp/WindDir/WindMph/Humidity — the invoice has only two fr… / No END weather set at all (no pair — single snapshot only)
- [ ] **12.** (#20, P2-Applied) `(DB)` **Tach hours (beginning / end / net engine hours)** — _TODO_ (0/6) · PENDING
      ↳ gaps: No Beginning Tach field anywhere (no beg_tach column, no UI) / No End Tach field anywhere
- [ ] **13.** (#21, P2-Applied) `(DB)` **Ground crew + ground crew members** — _TODO_ (0/6) · PENDING
      ↳ gaps: No managed Ground Crews list (no crews table, no create/rename/deactivate UI) / No Ground Crew Members list/table (crew has-many members)
- [ ] **14.** (#22, P3-Invoice)       **Unposted invoice list (working list parity)** — _PARTIAL_ (2/8) · PENDING
      ↳ gaps: No dedicated 'Unposted' page listing ONLY un-posted invoices (it is one combined list with… / No ChemMan filter bar: missing Invoice-Number filter, Customer multi-select, and Transacti…
- [ ] **15.** (#23, P3-Invoice)       **Posted invoice list (committed list parity)** — _TODO_ (1/7) · PENDING
      ↳ gaps: No dedicated 'Posted Field Application Invoices' page / No Season/Batch/Month-to-date scope selector on a posted filter bar
- [ ] **16.** (#24, P3-Invoice)       **Invoice editor parity (tabs, locations, applied info, notifications)** — _PARTIAL_ (3/7) · PENDING
      ↳ gaps: No Notifications tab (only 4 tabs; the 5th ChemMan 'Notifications' tab is absent) / No Consultant selector in the header (salesman_id is set implicitly to profile.id; not use…
- [ ] **17.** (#25, P3-Invoice)       **Per-acre pricing from price book (Chemical/Charges tab)** — _PARTIAL_ (4/6) · PENDING
      ↳ gaps: Chemical line lacks Warehouse and Vendor columns (ChemMan shows both per line) / No explicit gallon-equivalent / lb conversion display on Total Applied (e.g. FL OZ -> GL);…
- [ ] **18.** (#27, P3-Invoice)       **TRANSFER JOB to INVOICE button and flow** — _PARTIAL_ (4/6) · PENDING
      ↳ gaps: No reverse 'Transfer to Scheduling' action on the invoice editor (push the invoice back to… / Per-customer auto-split on transfer not confirmed in the transfer path code read (split is…
- [ ] **19.** (#26, P3-Invoice)       **Auto-split one job into per-customer invoices by share** — _PARTIAL_ (4/7) · PENDING
      ↳ gaps: No '<jobnumber>-<NNN>' split numbering convention verified in the engine-built editor path… / No 'Customer Shares By' basis selector (by location / by share) control on the Customers t…
- [ ] **20.** (#28, P3-Invoice)       **POST and UNPOST on the field-app invoice screen** — _PARTIAL_ (4/6) · PENDING
      ↳ gaps: No 'Unpost' action exposed on the field-app invoice screen (FieldApplicationInvoice has Po… / No unpost capability anywhere — no unpost_invoice RPC found in migrations or src (so unpos…
- [ ] **21.** (#29, P3-Invoice)       **VOID on the field-app invoice screen** — _PARTIAL_ (3/5) · PENDING
      ↳ gaps: Void is NOT exposed on the per-acre FieldApplicationInvoice editor (engine-built field inv… / Tester cannot void from the dedicated field-app (per-acre) screen and be forced to enter a…
- [ ] **22.** (#30, P3-Invoice)       **PRINT invoice (current + legacy format)** — _PARTIAL_ (2/6) · PENDING
      ↳ gaps: Current-format print is NOT reachable from the per-acre FieldApplicationInvoice editor too… / No legacy 'Old Print' format variant exists (invoicePdf has only field_application/chemica…
- [ ] **23.** (#31, P3-Invoice)       **EMAIL invoice to customer from the field-app screen** — _PARTIAL_ (3/5) · PENDING
      ↳ gaps: Email is NOT wired into the FieldApplicationInvoice editor toolbar / Email is NOT a per-row action on the FieldInvoices list rows
- [ ] **24.** (#32, P3-Invoice) `(DB)` **FUEL SURCHARGE (configurable setting, OFF by default)** — _TODO_ (0/6) · PENDING
      ↳ gaps: No Fuel Surcharge company/settings flag (default OFF) — no fuel/surcharge/diluent columns … / No blank owner inputs for current fuel price / per-acre or percentage surcharge rule
- [ ] **25.** (#33, P3-Invoice)       **Header/footer notes, PO ref, due date, terms, discount-earned** — _PARTIAL_ (2/5) · PENDING
      ↳ gaps: The field-app FieldApplicationInvoice editor only exposes header_notes (labeled 'Notes'); … / No early-pay 'Discount Earned' / discount-date capture per customer on the Customers tab (…
- [ ] **26.** (#34, P3-Invoice)       **Customer Invoice Summary (combined chem sales + field-app statement)** — _TODO_ (0/5) · PENDING
      ↳ gaps: No 'Customer Invoice Summary' screen combining a customer's unposted chemical sales AND un… / No inputs for Customer / Heading Date / Discount Date / Terms / Invoice Comment
- [ ] **27.** (#9, P4-Print) `(DB)` **Applicator Field Sheet (Original / Custom / Enhanced)** — _TODO_ (0/9) · PENDING
      ↳ gaps: No print action offering three named formats (Original/Custom/Enhanced) on the job / No applicator-sheet PDF generator at all (only a WPS pre-application notice PDF exists)
- [ ] **28.** (#10, P4-Print) `(DB)` **Loader Worksheet PDF wired to FIELD JOBS** — _PARTIAL_ (1/8) · PENDING
      ↳ gaps: No per-product per-load quantity breakdown (only a single total-gallons / loads-needed fig… / No 'Invalid'/'enter capacity' guard state — when capacity missing the worksheet card is si…
- [ ] **29.** (#11, P4-Print)       **Chemical Application Report (per job)** — _TODO_ (0/6) · PENDING
      ↳ gaps: No 'Chemical Application Report' print action on the job or job-list row / No per-job chemical-centric PDF listing rate/acre + unit + total applied + gallon/lb conve…
- [ ] **30.** (#12, P4-Print)       **Chemical Summary Report (across selected jobs)** — _TODO_ (1/5) · PENDING
      ↳ gaps: No 'Chemical Summary Report' action — bulk actions are only Export CSV, Download PDF (gene… / No cross-job per-chemical aggregation (sum rate x acres by product) — the PDF/CSV export l…
- [ ] **31.** (#13, P4-Print)       **Projected Use Report** — _TODO_ (0/6) · PENDING
      ↳ gaps: No 'Projected Use Report' action in the job-list toolbar/reports menu / No projection query (planned rate x scheduled acres summed per product)
- [ ] **32.** (#14, P4-Print)       **Master Mix Summary** — _TODO_ (0/6) · PENDING
      ↳ gaps: No 'Master Mix Summary' action on the job list / No combined per-product mix aggregation across selected jobs
- [ ] **33.** (#15, P4-Print)       **Print the job list** — _PARTIAL_ (2/5) · PENDING
      ↳ gaps: Prints only the checkbox-SELECTED rows, not the currently displayed/filtered list (no 'pri… / Columns are a fixed hardcoded set (Job#/Date/Status/Customer/Applicator/Acres/Price), not …
- [ ] **34.** (#16, P4-Print) `(DB)` **Map / Logs per job + attach log files** — _TODO_ (0/6) · PENDING
      ↳ gaps: No per-job 'Map / Logs' view plotting the job's field locations (map components exist for … / No 'Attach Log Files' capability on a job — no upload UI, no storage usage in JobDetail/Jo…
- [ ] **35.** (#35, P5-Dispatch)       **Dispatch board parity (dedicated field/tablet mode)** — _PARTIAL_ (1/7) · PENDING
      ↳ gaps: Not a dedicated DARK/high-contrast/touch-friendly field-tablet mode — it is a light split-… / No left nav with Jobs (View Map/View List) and Dispatch (Dispatch Jobs/View Dispatched Lis…
- [ ] **36.** (#36, P5-Dispatch) `(DB)` **Per-location dispatch + assignment (3-step wizard)** — _TODO_ (0/7) · PENDING
      ↳ gaps: No 3-step dispatch flow (Select Locations / Assign Selections / Finish Dispatching) — no D… / No per-location selection for dispatch (the existing SelectLocationsModal is for as-applie…
- [ ] **37.** (#37, P5-Dispatch)       **Assigned-to tracking + Dispatched-Jobs list** — _TODO_ (0/5) · PENDING
      ↳ gaps: No 'Dispatched List' view listing currently-dispatched jobs/locations with assignee and id… / No per-row status + applied-of-total acres on a dispatched tracker
- [ ] **38.** (#38, P5-Dispatch)       **Phone/mobile applicator field view (clean job cards, map/list)** — _TODO_ (0/7) · PENDING
      ↳ gaps: No phone-width applicator job-card view for application JOBS — FieldRoute ('My Route') is … / No 'show only my assigned jobs' for applicators (depends on per-location assignment from #…
- [ ] **39.** (#39, P5-Dispatch)       **Filter jobs by recipe in the field** — _TODO_ (0/5) · PENDING
      ↳ gaps: No 'Filter Jobs By Recipe' control on the dispatch/field view (no recipe references in Dis… / No recipe-based narrowing of list and map
- [ ] **40.** (#40, P5-Dispatch) `(DB)` **Pre-notification to customer (before application), wired to jobs** — _TODO_ (0/6) · PENDING
      ↳ gaps: No 'Send Pre-Notification' action on a job row or job editor / No recipient resolution from the job's customers/location shares for a pre-notice
- [ ] **41.** (#41, P5-Dispatch)       **Post-notification to customer (after application), wired to jobs** — _TODO_ (0/5) · PENDING
      ↳ gaps: No 'Send Post-Notification' action on the job or the field-application invoice editor / No post entry recorded in a per-job/invoice Notifications log (no such log exists)

---

## Parked-Low (Codex low-severity findings, deferred — review at end)
- [#1 P3] Job-list footer totals don't follow the DataTable's internal in-table search box (the named status/date/customer filters DO update totals). Fixing needs a shared DataTable API change — out of section scope.
- [#3 Low] Batch member-count hints (JobBatchesManager 'N jobs', assign-modal coverage, delete-confirm copy) derive from the capped/filtered in-memory jobs list so can undercount with >500 jobs or an active filter (display-only; ON DELETE SET NULL still un-batches correctly). Same root as #6 row-cap. Fix: dedicated aggregate count query, or soften the copy.
- [#3 Low / RECURRING across #3/#4/#6 new tables] INSERT policies gate on is_admin()/is_sales_rep() but don't bind created_by to auth.uid() (privileged-only audit-attribution nit; frontend always passes real profile.id). Consider a one-shot hardening migration before the production gate.
- [#4 test-gap] No automated test asserts an applicator CANNOT write job_tag_assignments (RLS verified live by reviewer; a defense-in-depth test would be nice). Non-blocking.
- [#6 Low] Deactivating a crew already on a job makes the JobDetail crew dropdown render blank (id retained in state; only lost if user actively changes the dropdown). Optional: include/append the inactive crew in the picker.
- [#6 Low] Date-preset click spreads the current draft into applied, committing any pending non-date draft edits along with the date. Optional: base preset on applied.
- [#6 Low] Direct crew .update() fires on every save even when unchanged (idempotent no-op write; harmless).
- [#6 Low/known-limitation, PRE-EXISTING from #4] A job matching only a CLIENT-side filter (tags/crop/county/state/chemical/fieldName) that sorts past row 500 (job_date DESC) is truncated before the client filter sees it. Affects only >500 server-matched jobs. Long-term: move all filters server-side or paginate.
- [#7 Low] Non-status field bulk update (date/applicator/batch) is one atomic .update().in() — if one job fails a trigger (e.g. enforce_applicator_license LICENSE_EXPIRED), the whole field batch rolls back all-or-nothing (surfaced honestly via toast, not swallowed). Could note atomicity in the modal copy.
- [#7 Low] Mass-edit writes updated_by; single-job cancel (JobDetail) does not — cosmetic consistency nit (column nullable).
- [#8 Low] List Settings toggles fire-and-forget full-snapshot upserts; rapid out-of-order completions could land a stale snapshot last (self-heals on next load/change; no money/cross-user). Optional: debounce ~300ms or serialize.
- [#8 Low] anon retains an inherited table-level SELECT grant on user_list_settings, neutralized by RLS + no anon policy (anon SELECT=0 rows; matches project convention). Optional project-wide REVOKE.

## Migrations created this run (apply to PRODUCTION only at end, with Mason's approval)
- `20260624120000_job_parity_scheduling_agronomy_shares.sql` — section #1 (Job list + create/edit job parity)
- `20260624130000_job_tags.sql` — section #4 (Color-coded job tags (create/edit/delete + chips + filter))
- `20260624140000_job_ground_crews_and_filter_indexes.sql` — section #6 (Full filter set (AND-combined))
- `20260624150000_job_batches.sql` — section #3 (Job batches (group jobs into named batches))
- `20260624160000_user_list_settings.sql` — section #8 (Customizable list columns (List Settings))

## Codex review status (gate — must be clean before production gate)
- **Codex CLI hit its usage limit during section #2 (resets 2026-06-25 ~07:02). Interim gate = builder self-review + orchestrator spot-check + (for DB/money/RLS sections) a fresh adversarial reviewer agent. Run a real Codex pass over all codex:pending sections when limits reset, BEFORE the production gate.**
- Sections awaiting a real Codex pass:
  - #1 (partial, commit faf90ad7) — Job list + create/edit job parity
  - #2 (pending, commit 7210f583) — Recipes (save/reuse tank mixes on a job)
  - #4 (pending, commit ac1bf74) — Color-coded job tags (create/edit/delete + chips + filter)
  - #5 (pending, commit 6de0509) — Field/location route-ordering (drag to set applicator drive order)
  - #6 (pending, commit c326e05e) — Full filter set (AND-combined)
  - #3 (pending, commit 6357b94) — Job batches (group jobs into named batches)
  - #7 (pending, commit 5e827066) — Mass edit selected jobs (dates / status / loader worksheets)
  - #8 (pending, commit 77ad2ef1) — Customizable list columns (List Settings)

## Open questions for Mason (don't block — keep building)
_(none yet)_

## Run log (one line per section as completed)
- 2026-06-24: Step-0 re-audit complete. Build order set. Local-DB baseline up (corrected-copy replay, no live touch). Local admin seeded. Build env green.
- 2026-06-24: #1 Job list + create/edit job parity — BUILT 11/11 (commit faf90ad7)
- 2026-06-24: #2 Recipes (save/reuse tank mixes on a job) — BUILT 5/5 (commit 7210f583)
- 2026-06-24: #4 Color-coded job tags (create/edit/delete + chips + filter) — BUILT 8/8 (commit ac1bf74)
- 2026-06-24: #5 Field/location route-ordering (drag to set applicator drive order) — BUILT 5/5 (commit 6de0509)
- 2026-06-24: #6 Full filter set (AND-combined) — BUILT 6/6 (commit c326e05e)
- 2026-06-24: #3 Job batches (group jobs into named batches) — BUILT 5/5 (commit 6357b94)
- 2026-06-24: #7 Mass edit selected jobs (dates / status / loader worksheets) — BUILT 7/7 (commit 5e827066)
- 2026-06-24: #8 Customizable list columns (List Settings) — BUILT 6/6 (commit 77ad2ef1)
