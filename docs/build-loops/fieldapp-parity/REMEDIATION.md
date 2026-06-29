# Field-App Parity — End-of-Run Codex Remediation

Source: real Codex (gpt-5.5) batch over 11 money/migration commits (#1,#6,#12,#12-guard,#18,#24,#25,#27,#28,#32,#33) → 32 findings → triage workflow verified each against live code+DB.
**Result: 15 REAL (2 P1, 8 P2, 5 P3) · 17 dismissed (14 ALREADY_FIXED by later commits, 3 FALSE_POSITIVE).**
Owner decision (2026-06-29): split-invoice **Unpost = ALL-OR-NOTHING** (atomic group), matching Post.

## Fix waves (sequential agents to avoid git races; each verified + committed)

### WAVE 1 — P1 (critical)
- [x] **P1 SECURITY** (commit 4d45c63 — proven: ATTACK-1/2 RAISE, transfers OK) — `_enforce_billed_job_immutability` exempts `invoice_id` → a non-admin sales_rep can NULL/repoint a billed job's invoice link (proven live). NEW migration: CREATE OR REPLACE the fn adding `AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id` to the protected block; drop invoice_id from the exempt comment. Prove: ATTACK-NULL + ATTACK-repoint now RAISE; transfer_job_to_invoice (writes while status='completed') + transfer_invoice_to_job (under app.admin_override) still succeed.
- [x] **P1 MONEY** (commit b807da4 — 240 pt not GAL, cost $674 not $5400; 13 tests) — `JobDetail.tsx` updateChemRow autofill (~2093-2111): product with stock unit≠rate unit (e.g. unit_size=GAL, rate_unit=pt/ac) autofills qty=rate×acres but labels it the STOCK unit → saves 240 GAL not 240 pt, inflating loader gal + cost/price ~8×. Fix: express qty+unit+cost in ONE consistent measure (rate's base unit). Add a GAL/pt-ac unit test. Re-check the in-page gal/lb preview (2622), totals (1410-1411), loader (1462).

### WAVE 2 — P2
- [ ] convert_to_gl_lb: liquid branch only matches 'GL'; add GAL/Gal/Gallon(S) aliases + NULL for unknown (NEW migration). Strengthen chemCalculator parity test.
- [ ] InvoiceDetail.tsx:1163 Unpost button gated `&& isAdmin` but RPC allows sales_rep → drop `&& isAdmin` (keep Void admin-only).
- [ ] job_applied_record_fields INSERT/UPDATE RLS: add job-field membership check `EXISTS(job_fields jf WHERE jf.job_id=r.job_id AND jf.field_id=…)` (NEW migration).
- [ ] Jobs.tsx co-billed customers: applicator RLS hides share customers → resolve via SECURITY DEFINER (batch get_jobs_billed_customers RPC or reuse get_job_billed_customers).
- [ ] JobDetail.tsx:2622 gal/lb PREVIEW drops product_form → bare 'oz' liquid misclassified as lb; pass product_form (same root as ef668faa fix, this call site remains).
- [ ] JobDetail.tsx new-job save: idempotency key reset BEFORE crew/loader sub-write → sub-write fail → retry mints new key → DUPLICATE JOB. Wrap sub-write in try/catch + navigate to saved job (mirror the applicator-reassign pattern).
- [ ] AppliedRecordsManager.tsx: non-atomic parent+child save → wrap in a save_job_applied_record txn RPC (covers #21 crew rows too).
- [ ] **[owner=ALL-OR-NOTHING]** unpost split group: NEW `unpost_invoice_group` RPC (atomic, modeled on post_invoice_group) routed from both UI surfaces when invoice_group_id set.
- [ ] JobDetail.tsx shares-loading: save before async seedSharesForField resolves → empty split snapshot persisted; block save while a selected field's shares are still loading.

### WAVE 3 — P3
- [ ] FieldApplicationInvoice.tsx:2469 + InvoiceDetail modal: "can be edited" copy vs a completed job being non-editable → text-only fix ("returns the job to Completed so it can be re-invoiced or cancelled"). Do NOT change the lifecycle.
- [ ] transfer_invoice_to_job cancel path leaves stale total_cost_cents → NEW migration adds `total_cost_cents=0` to the cancel UPDATE.
- [ ] Jobs.tsx 500-cap: client filters run after the newest-500 cap → add a "showing newest 500" banner when data.length===500.
- [ ] appliedRecords.ts sumDraftFieldAcres: a row with acres but no field_id is summed into the parent but dropped as a child → skip field-less rows in the sum (or reject in validate).

## Dismissed (for the record) — NOT actioned
14 ALREADY_FIXED (Jobs totals #15; #18 acres follow-up 20260624181000 = REVOKE public + RESTRICT FK + all-records rollup; salesman/applicator carry-over db061bc5; FieldAppChemicalEntry oz fix ef668faa; fuel-surcharge guards db592aff/20260625141000; discount/PDF rework dd535989; chemical-summary NUL e923cfbc + form-conflict 24a8fd25) · 3 FALSE_POSITIVE (bare CREATE TRIGGER replay; grouped-invoice redirect unreachable; split-group deleted-member status filter already excludes).
