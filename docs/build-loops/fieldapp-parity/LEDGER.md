# Field-App Parity — Progress Ledger

**Branch:** `feat/fieldapp-parity` (off `origin/main` d65d15d7)  
**Worktree:** `C:\CRX_Manager\.claude\worktrees\fieldapp-parity`  
**Step-0 re-audit:** 2026-06-24 → **0 DONE · 19 PARTIAL · 22 TODO** (all 41 need work). Full evidence: `STEP0-AUDIT.json`.

**Status key:** `PENDING` (audited, awaiting build) · `IN-PROGRESS` · `BUILT` (built+verified+Codex-clean this run) · `DONE` (already met criteria — none).

## Orchestration notes (read on resume)
- **I am the orchestrator.** Build each section via a FRESH subagent in the topo order below following `BUILD-SUBAGENT-TEMPLATE.md`; verify (ran & proven); Codex-review; fix High/Med; commit to `feat/fieldapp-parity`; update THIS file; next.
- **Harness gotcha:** this session is rooted at `C:\`, NOT the worktree → the project `.claude` apply-guard hook + reviewer subagents do NOT auto-fire. Migrations apply to LOCAL only during the run, so the prod apply-guard is not in play. Run the 5 reviewer concerns + apply-guard MANUALLY at the production gate. (git pre-commit/pre-push hooks DO still fire.)
- **Cross-dep wrinkle:** #7 Mass-edit lists a dep "Loader worksheet (bulk-editable fields)" = section #10, which is built (P4) AFTER #7. Build #7's date/status/recipe mass-edit first; wire the loader-worksheet bulk column when #10 lands (revisit #7 after #10).

## Local environment (READY 2026-06-24)
- **Local Supabase (throwaway):** API `http://127.0.0.1:54321` · DB `postgresql://postgres:postgres@127.0.0.1:54322/postgres` · project dir `C:\Users\mason\fieldapp-local-db`. Heavy services excluded (db+auth+rest+kong only).
- **Worktree `.env`** (gitignored, NEVER commit) points `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` at the LOCAL stack.
- **Local admin login:** `admin@local.test` / `localadmin123` (profiles.role=admin). DB otherwise empty of business data (2 seed entity profiles) — build agents seed their own test data against local.
- **Query local DB:** no host `psql` — use `docker exec supabase_db_fieldapp-local-db psql -U postgres -d postgres -c "…"`.
- **Test a new migration:** author in real `supabase/migrations/`, copy to `C:\Users\mason\fieldapp-local-db\supabase\migrations\`, apply via `docker exec -i supabase_db_fieldapp-local-db psql -U postgres -d postgres < file` (or `supabase migration up` from project dir); smoke RPCs via `SUPABASE_DB_URL=<DB_URL> node scripts/smoke/run-smoke.mjs --spec <rpc>`.
- **Baseline caveat (pre-existing repo tech-debt, NOT mine):** the 517-migration history does not replay cleanly from scratch — needed 29 copy-renames (19 duplicate-version collisions + 2 short-ts), 5 shim objects that exist on live but no migration creates (`products.deleted_at`, `allocation_sets.season/payment_date`, `customers.prepay_balance_cents`, `rate_limits`, `cleanup_rate_limits()`, `execute_sql_readonly()`), ~34 content patches — ALL on COPIES (real files untouched). Local schema matches live structurally for field-app tables. My NEW additive migrations are well-formed and apply to live normally at the gate. Detail: `C:\Users\mason\fieldapp-local-db\copy-fixes.log`.

## Build order (topological; PLAN-phase tie-break) — PENDING unless marked

- [ ] ** 1.** (#1, P1-Jobs) `(DB)` **Job list + create/edit job parity** — _PARTIAL_ (2/11) · PENDING
      ↳ gaps: Row is MISSING most required columns: no color tag chips, no chemicals+rate+unit, no crop(… / No totals row summing total acres + remaining acres across the list
- [ ] ** 2.** (#2, P1-Jobs)       **Recipes (save/reuse tank mixes on a job)** — _PARTIAL_ (2/5) · PENDING
      ↳ gaps: No 'use last used recipe' shortcut in the job editor (no last_used/lastUsed concept anywhe… / No 'save current job chemicals as a new recipe' control in the job editor — save_blend_rec…
- [ ] ** 3.** (#4, P1-Jobs) `(DB)` **Color-coded job tags (create/edit/delete + chips + filter)** — _TODO_ (0/8) · PENDING
      ↳ gaps: No job tag manager (create tag w/ name + color) / No edit-tag (name/color) flow for jobs
- [ ] ** 4.** (#5, P1-Jobs)       **Field/location route-ordering (drag to set applicator drive order)** — _PARTIAL_ (3/5) · PENDING
      ↳ gaps: No drag-and-drop reorder UI — fields can only be added/removed; order is implicitly the ad… / Order is NOT reflected on any applicator printout / map pin numbering as a deliberate rout…
- [ ] ** 5.** (#6, P1-Jobs) `(DB)` **Full filter set (AND-combined)** — _PARTIAL_ (2/6) · PENDING
      ↳ gaps: Filter bar supports only Status, Customer (single-select, not multi), Start/End date — MIS… / No explicit SEARCH/apply button (filters auto-run) and no CLEAR ALL control that resets ev…
- [ ] ** 6.** (#3, P1-Jobs) `(DB)` **Job batches (group jobs into named batches)** — _TODO_ (0/5) · PENDING
      ↳ gaps: No multi-select-to-batch from the job list (the only bulk actions are CSV/PDF/Delete) / No create-named-batch flow — jobs.batch_id is a single free-text field on the editor, ther…
- [ ] ** 7.** (#7, P1-Jobs)       **Mass edit selected jobs (dates / status / loader worksheets)** — _TODO_ (0/7) · PENDING
      ↳ gaps: No Mass Edit toolbar action (bulk actions are only Export CSV, Download PDF, Delete Jobs) / No Mass Edit modal stating 'N jobs selected'
- [ ] ** 8.** (#8, P1-Jobs) `(DB)` **Customizable list columns (List Settings)** — _TODO_ (0/6) · PENDING
      ↳ gaps: No List Settings control / gear on the job list / No per-column on/off toggles (columns are hard-coded in dataColumns)
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
_(none yet)_

## Migrations created this run (apply to PRODUCTION only at end, with Mason's approval)
_(none yet)_

## Open questions for Mason (don't block — keep building)
_(none yet)_

## Run log (one line per section as completed)
- 2026-06-24: Step-0 re-audit complete (5 area agents). Build order set. Local-DB baseline up (corrected-copy replay, no live touch). Local admin seeded. Build env green (typecheck+build pass).
