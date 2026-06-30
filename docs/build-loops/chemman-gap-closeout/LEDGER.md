# ChemMan Gap-Closeout Loop — LEDGER

**State: SCAFFOLDED — docs authored; build not yet started.**
Branch `feat/chemman-gap-closeout` (based on `feat/fieldapp-beyond-parity`). Worktree `C:\CRX_GapLoop`. Nothing pushed/merged/applied-to-prod. This file is the **source of truth for resume** (regenerated from `PROGRESS.json`).

## Scope (bounded — do NOT expand)
The **two** remaining ChemMan-gap items on the field-application invoice. Everything else from the ChemMan comparison is **already built** on this branch — confirm before touching, do not rebuild.

## Progress: 0 / 2 sections built

| # | Section | Status | Migration(s) | Commit | Notes |
|---|---------|--------|--------------|--------|-------|
| 1 | Weather auto-fill (Get Weather; start+end; manual override; modeled-not-measured disclaimer) | ⏳ PENDING | (planned `20260630180000_field_app_invoice_weather_capture`) | — | mirror job_applied_records weather cols on invoices; reuse weatherCapture.fetchWeatherForDateTime (free Open-Meteo) |
| 2 | Diluent / carrier-water per acre (rate input + computed total; persisted + printed) | ⏳ PENDING | (planned `20260630190000_field_app_invoice_diluent_per_acre`) | — | additive nullable cols on invoices; mirror jobs.carrier_rate_gpa; extend invoicePdf |

## Solo / safety state
- Solo check (2026-06-30): on `feat/chemman-gap-closeout`, tree clean. `node_modules` installed. `package-lock.json` install churn is NOT staged.
- HARD gates in force: commit only to this branch; never push/merge/deploy; migrations → LOCAL throwaway DB only; additive NULLABLE schema only; weather stays free Open-Meteo; production gate is a HARD STOP for Mason.

## Production gate (end of run — not yet reached)
- Apply the **2** migrations to PROD in TIMESTAMP order, ONLY after Mason approves.
- ⚠️ **beyond-parity must be on `main` first or together** — these gaps sit on top of `feat/fieldapp-beyond-parity`.
- At apply: bind each apply-guard proof to the **TRANSMITTED** SQL hash; run the migration reviewers + a real Codex pass; `/regen-schema-registry` + db-invariant-sweeps after.

## Parked-Low (follow-ups)
- (none yet)
