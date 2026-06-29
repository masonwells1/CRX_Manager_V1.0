# Field-App Parity — End-of-Run Codex Remediation

Source: real Codex (gpt-5.5) batch over 11 money/migration commits (#1,#6,#12,#12-guard,#18,#24,#25,#27,#28,#32,#33) → 32 findings → triage workflow verified each against live code+DB.
**Result: 15 REAL (2 P1, 8 P2, 5 P3) · 17 dismissed (14 ALREADY_FIXED by later commits, 3 FALSE_POSITIVE).**
Owner decision (2026-06-29): split-invoice **Unpost = ALL-OR-NOTHING** (atomic group), matching Post.

## Fix waves (sequential agents to avoid git races; each verified + committed)

### WAVE 1 — P1 (critical)
- [x] **P1 SECURITY** (commit 4d45c63 — proven: ATTACK-1/2 RAISE, transfers OK) — `_enforce_billed_job_immutability` exempts `invoice_id` → a non-admin sales_rep can NULL/repoint a billed job's invoice link (proven live). NEW migration: CREATE OR REPLACE the fn adding `AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id` to the protected block; drop invoice_id from the exempt comment. Prove: ATTACK-NULL + ATTACK-repoint now RAISE; transfer_job_to_invoice (writes while status='completed') + transfer_invoice_to_job (under app.admin_override) still succeed.
- [x] **P1 MONEY** (commit b807da4 — 240 pt not GAL, cost $674 not $5400; 13 tests) — `JobDetail.tsx` updateChemRow autofill (~2093-2111): product with stock unit≠rate unit (e.g. unit_size=GAL, rate_unit=pt/ac) autofills qty=rate×acres but labels it the STOCK unit → saves 240 GAL not 240 pt, inflating loader gal + cost/price ~8×. Fix: express qty+unit+cost in ONE consistent measure (rate's base unit). Add a GAL/pt-ac unit test. Re-check the in-page gal/lb preview (2622), totals (1410-1411), loader (1462).

### WAVE 2 — P2
- [x] convert_to_gl_lb (2a: 20260629140000; GAL/gal/Gallon=10, unknown→dash; 35 tests): liquid branch only matches 'GL'; add GAL/Gal/Gallon(S) aliases + NULL for unknown (NEW migration). Strengthen chemCalculator parity test.
- [x] Unpost-isAdmin removed (2a, commit 7f90cc48; Void untouched) button gated `&& isAdmin` but RPC allows sales_rep → drop `&& isAdmin` (keep Void admin-only).
- [x] applied-record RLS membership (2a: 20260629150000; foreign field_id rejected — smoke)/UPDATE RLS: add job-field membership check `EXISTS(job_fields jf WHERE jf.job_id=r.job_id AND jf.field_id=…)` (NEW migration).
- [x] co-billed SECDEF batch RPC (2a: 20260629160000 get_jobs_billed_customers; applicator+dispatchee see split set; anon revoked) customers: applicator RLS hides share customers → resolve via SECURITY DEFINER (batch get_jobs_billed_customers RPC or reuse get_job_billed_customers).
- [x] JobDetail gal/lb preview form (2b, 7fb5f4e2; oz-liquid→1.563 gal not 12.5 lb) drops product_form → bare 'oz' liquid misclassified as lb; pass product_form (same root as ef668faa fix, this call site remains).
- [x] dup-job guard (2b, 7fb5f4e2; sub-write try/catch+navigate — no silent duplicate): idempotency key reset BEFORE crew/loader sub-write → sub-write fail → retry mints new key → DUPLICATE JOB. Wrap sub-write in try/catch + navigate to saved job (mirror the applicator-reassign pattern).
- [x] atomic save_job_applied_record RPC (2b: 20260629190000, SECURITY INVOKER, bad child→whole rolls back — smoke): non-atomic parent+child save → wrap in a save_job_applied_record txn RPC (covers #21 crew rows too).
- [x] **[owner=ALL-OR-NOTHING]** unpost_invoice_group (2a: 20260629170000; paid member→whole RAISES — proven; routed both surfaces) unpost split group: NEW `unpost_invoice_group` RPC (atomic, modeled on post_invoice_group) routed from both UI surfaces when invoice_group_id set.
- [x] shares-loading save guard (2b, 7fb5f4e2; 6 tests): save before async seedSharesForField resolves → empty split snapshot persisted; block save while a selected field's shares are still loading.

- [x] get_job_billed_customers dispatch leg (2b: 20260629180000; dispatched applicator now reads it — role-sim) (Wave1 mig 20260625180000) has the SAME narrow self-gate → a per-location-dispatched applicator's compliance PDF (#10/#11) is REFUSED; add the _is_dispatched_to_me leg (one-line, NEW migration). [folded from spawned task_f10e6bb4]

### WAVE 3 — P3
- [ ] FieldApplicationInvoice.tsx:2469 + InvoiceDetail modal: "can be edited" copy vs a completed job being non-editable → text-only fix ("returns the job to Completed so it can be re-invoiced or cancelled"). Do NOT change the lifecycle.
- [ ] transfer_invoice_to_job cancel path leaves stale total_cost_cents → NEW migration adds `total_cost_cents=0` to the cancel UPDATE.
- [ ] Jobs.tsx 500-cap: client filters run after the newest-500 cap → add a "showing newest 500" banner when data.length===500.
- [ ] appliedRecords.ts sumDraftFieldAcres: a row with acres but no field_id is summed into the parent but dropped as a child → skip field-less rows in the sum (or reject in validate).

## Dismissed (for the record) — NOT actioned
14 ALREADY_FIXED (Jobs totals #15; #18 acres follow-up 20260624181000 = REVOKE public + RESTRICT FK + all-records rollup; salesman/applicator carry-over db061bc5; FieldAppChemicalEntry oz fix ef668faa; fuel-surcharge guards db592aff/20260625141000; discount/PDF rework dd535989; chemical-summary NUL e923cfbc + form-conflict 24a8fd25) · 3 FALSE_POSITIVE (bare CREATE TRIGGER replay; grouped-invoice redirect unreachable; split-group deleted-member status filter already excludes).
