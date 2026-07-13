# ChemMan Gap-Closeout Loop — LEDGER

**State: 🚀 SHIPPED LIVE 2026-07-01 (Mason approved go-live).**
Both migrations APPLIED TO PROD in order (weather `20260630180000` → diluent `20260630190000`) via apply-guard proof + rls/drift reviewers clean; prod-verified (single 22-arg overload, nullable cols, no new CHECK, anon revoked). Code merged to `main` @`17b4445e` + Vercel deployed; PROVEN live by grepping the deployed field-app chunk on croprxsolutions.app (`Diluent / Carrier Water` + `Get Weather` + `modeled, not measured`). Follow-up (non-blocking): regen `.claude/schema-registry.json` for the 14 new `invoices` columns. This file is the **source of truth for resume**.

## Scope (bounded — do NOT expand)
The **two** remaining ChemMan-gap items on the field-application invoice. Everything else from the ChemMan comparison is **already built** on this branch — confirm before touching, do not rebuild.

## Progress: 2 / 2 sections built ✅

| # | Section | Status | Migration(s) | Commit | Notes |
|---|---------|--------|--------------|--------|-------|
| 1 | Weather auto-fill (Get Weather; start+end; manual override; modeled-not-measured disclaimer) | ✅ BUILT | `20260630180000_field_app_invoice_weather_capture` | `36382c95` | 13 nullable weather cols on invoices mirroring job_applied_records + override flag; drift-safe RPC (1 overload, anon revoked); reuses weatherCapture.fetchWeatherForDateTime (free Open-Meteo). Subagent 12-round Codex + drift/compliance clean; orchestrator DB-verified + independent Codex clean |
| 2 | Diluent / carrier-water per acre (rate input + computed total; persisted + printed) | ✅ BUILT | `20260630190000_field_app_invoice_diluent_per_acre` | `00b1f05a` + `141952c2` (P2 fix) | additive nullable `diluent_rate_gpa` on invoices; total computed live (NOT generated — save_field_app_invoice doesn't write invoices.total_acres, verified); RPC now 22-arg single overload; diluent on all 3 PDF paths (editor/list/InvoiceDetail). Orchestrator independent Codex found+fixed the posted-invoice PDF gap; fix Codex clean |

## Solo / safety state
- Solo check (2026-06-30): on `feat/chemman-gap-closeout`, tree clean. `node_modules` installed. `package-lock.json` install churn is NOT staged.
- HARD gates in force: commit only to this branch; never push/merge/deploy; migrations → LOCAL throwaway DB only; additive NULLABLE schema only; weather stays free Open-Meteo; production gate is a HARD STOP for Mason.

## Production gate (REACHED — HARD STOP for Mason)
Apply the **2** migrations to PROD in TIMESTAMP order, ONLY after Mason's explicit approval, then deploy the code:
1. `20260630180000_field_app_invoice_weather_capture.sql` — §1: 13 nullable weather cols on invoices + drift-safe extend of `update_field_app_applied_info` (6-arg → 20-arg).
2. `20260630190000_field_app_invoice_diluent_per_acre.sql` — §2: nullable `diluent_rate_gpa` on invoices + drift-safe re-extend of the same RPC (20-arg → 22-arg). **Must apply AFTER #1** (it drops #1's exact 20-arg signature).
- ⚠️ **beyond-parity must be on `main` first or together** — these gaps sit on top of `feat/fieldapp-beyond-parity`.
- **Apply the migrations BEFORE/WITH the code deploy** — the new frontend calls the 22-arg RPC that only exists after both migrations. Timestamp order enforces #1-then-#2.
- At apply: bind each apply-guard proof to the **TRANSMITTED** SQL hash (MCP strips a trailing newline); run the 5 migration reviewers + a real Codex pass; `/regen-schema-registry` + db-invariant-sweeps after.
- On live, re-confirm `save_field_app_invoice` still does NOT write `invoices.total_acres` (the §2 no-generated-column design hinges on it).

## Open question for Mason (non-blocking)
- **§2 print placement:** the diluent rate + total currently print on the **customer-facing** invoice PDF (both standard + legacy), matching ChemMan. Keep customer-facing (recommended) or gate internal-only (small follow-up, no data change).

## Parked-Low (follow-ups, none blocking)
- **§1 (a) DEPLOY-ORDER (gate note):** the new frontend sends the extended `update_field_app_applied_info` call, which exists only after the migrations apply → apply migrations **before/with** the code deploy (timestamp order already enforces this). Not a code change.
- **§1 (b) provenance-after-reload:** a save→reload of a partially hand-corrected auto weather set loses per-value auto/manual provenance (one source flag per set, not per value) — accepted trade-off (a pessimistic wipe would destroy saved manual data; the modeled-not-measured disclaimer covers verify-on-site).
- **§2:** none parked (the 2 P2s + the orchestrator-found InvoiceDetail P2 were all fixed).
