# Section 14 Refresh — Testing and Prevention

**Date:** 2026-07-25
**Verdict:** FOLLOW-UPS REQUIRED — no confirmed application defect, but two medium prevention/coverage gaps and two low signal-quality gaps remain.
**Scope:** Read-only audit. No application, hook, test, configuration, schema, live-service, or CI change was made.

## Baseline and isolation

- Fetched `origin`; audit worktree was created from exact `origin/main` commit `25363345adeabb5b2b08a3772a0de3f0edcb3952` on branch `codex/section14-testing-prevention-refresh-20260725`.
- Audit worktree: `C:\Users\mason\.codex\worktrees\section14-testing-prevention-refresh-20260725\CRX_Manager`; start and pre-commit working tree were clean, and `origin/main...HEAD` was `0 0` before the report commit.
- Collision check: the root checkout had unrelated Section 3/Supplier documentation, smoke, and migration work; the active Supplier Phase 3 worktree had Product/Supplier/frontend changes. This worktree touched neither lane and this report is the sole intended tracked change.
- A fresh exact-tree Graphify build at commit `25363345` reproducibly produced `8,113` nodes and `16,659` edges. `graphify affected "scripts/db-invariant-sweeps/run-sweeps.mjs" --depth 2` returned `No affected nodes`. Because `.graphifyignore` excludes `.claude/`, `.github/`, `tests/`, and `docs/`, the hook, test, CI, and historical-report findings below came from direct source/configuration inspection, not Graphify.

## Confirmed current gaps

### MED-14.1 — No automated, executable live catalog-sweep path is available

**Classification:** confirmed prevention gap, not a reported live database defect.

`scripts/db-invariant-sweeps/run-sweeps.mjs:109-110` can execute predicate SQL only when both `SUPABASE_DB_URL` and `psql` are available. Its strict mode deliberately exits `2` rather than treating print-only output as a pass (`:219-239`). In this clean worktree, `psql` was not on `PATH`, `SUPABASE_DB_URL` was unset, and `npm run db-sweeps:strict` exited `2` before connecting to any service. The inventory itself is substantial: 18 read-only predicates and 61 allowlist entries.

The required GitHub Actions path runs correction guards, workflow checks, RPC contracts, and coverage, but no `db-sweeps:strict` or other live catalog step (`.github/workflows/ci.yml:79-101`). Its own comment expressly keeps live schema verification opt-in until a least-privilege CI credential or disposable database exists (`:87-91`). Thus a change can pass every required local/CI check while live grants, deployed RPC bodies, policies, overloads, and catalog-only invariants remain unexecuted.

**Risk:** a live-only security or integrity regression is detected only by a separately arranged read-only review, not by a routine gate.

**Prevention action:** provision a least-privilege, read-only database connection for a scheduled/CI strict-sweep job (or an approved equivalent runner), then make the job publish per-predicate results and fail on unallowlisted rows. This needs owner-controlled credentials; do not put a database URL or password in the repository.

### MED-14.2 — Browser smoke coverage is intentionally absent from every PR and main CI run

**Classification:** confirmed coverage gap, not a failure in the E2E safety controls.

The E2E job is explicitly disabled with `if: false` in `.github/workflows/ci.yml:109-126`. The project has a fail-closed staging-only configuration: `tests/e2e/utils/safety-guards.ts` rejects missing credentials and production URLs, while `playwright.config.ts` refuses an existing server and requires that safety configuration before startup. Those are good safeguards, but they do not execute because the CI job never starts.

**Risk:** browser-level regressions in routing, authentication handoff, network behavior, realtime behavior, and critical user workflows can merge without any staging execution. Unit coverage does not exercise that boundary.

**Prevention action:** create/provision the staging Supabase project and staging-only E2E credentials named in the CI re-enable checklist, prove the suite against staging, then replace `if: false` with the documented push/PR condition. This is owner/platform work because it creates an external environment and secrets.

### LOW-14.3 — Backup-staleness control gives a false “no backup” warning in isolated worktrees

**Classification:** confirmed warning-quality prevention gap.

`.claude/hooks/session-staleness.mjs:26,176-182` resolves `backups/LATEST-OK.json` under the current worktree. From this isolated worktree the hook emitted “No database backup exists yet,” and `npm run agent-health` therefore finished with one warning. The shared root checkout contains `C:\CRX_Manager\backups\LATEST-OK.json` with `completed_at: 2026-07-21T13:11:41.635Z` (150 tables, 7,887 rows); this is four days old, not absent.

**Risk:** repeated false backup alarms reduce trust in a control intended to surface a genuinely missing or stale recovery copy. This evidence only proves metadata presence, not backup restore quality.

**Prevention action:** make the hook resolve the primary checkout/common project backup location when running in a linked worktree, or label the backup check “unavailable in this worktree” rather than reporting a missing backup. Add a linked-worktree regression case alongside the existing session-staleness tests.

### LOW-14.4 — The frontend validator still has a non-blocking 17-warning signal

**Classification:** confirmed signal/coverage gap; no money defect was proven.

`scripts/validate-frontend.sh:86-114` warns whenever a name resembling money is used with `.toFixed(2)` and exits successfully unless it finds a separate violation. The current full run passed with **17 warnings and 0 violations**. Direct examples demonstrate why the heuristic is noisy: `BulkTicketUpload.tsx:481` formats an image-size value, `CustomerSharesTable.tsx:103-108` formats acreage/percentages, and `CustomerTransactionReview.tsx:73-75` converts cents to display dollars before CSV formatting. Other warnings were not re-adjudicated individually in this no-fix audit.

**Risk:** developers can become accustomed to passing warning output and overlook a future unsafe cents calculation.

**Prevention action:** retain the hard floating-money checks, but narrow this display-only heuristic or introduce reviewed, narrowly-scoped suppressions plus a regression test for the intended warning count. Do not make warnings blocking until the remaining population is classified.

## Historical claims that must not be carried forward as open findings

The 2026-06-17 Section 14 report correctly recorded the state then, but several entries are stale as current findings:

| Historical claim | Current refresh evidence | Current disposition |
|---|---|---|
| Schema registry behind live database | `sections-2-15-remediation-LEDGER.md:24` marks the remediation shipped; `npm run test:correction-guards` passed and reported `SCHEMA_BASELINE_PASS high_water=20260719092832 ledger_rows=861`. | Historical finding resolved in repo controls; live registry equivalence was not queried in this audit. |
| WPS notice PDF lacked a dedicated regression test | Ledger row `:25` records the shipped test; `npx vitest run src/lib/wpsNoticePdf.test.ts` passed 1 file / 16 tests. | Resolved. |
| 31 frontend-validator warnings | Ledger row `:26` records the original cleanup. The exact count is stale: the current run has 17 warnings, which is residual warning quality, reported above as LOW-14.4. | Do not repeat “31 warnings” as a current result. |
| Sweep README reported an open `generate_rup_sales_records` grant finding | `scripts/db-invariant-sweeps/README.md:117-132` explicitly labels it closed and documents the revocation. | Resolved historical documentation claim. |

## Controls verified healthy in this refresh

- Hook/workflow wiring: `npm run test:agent-workflows` passed. It confirmed 30 worktree-aware Codex command hooks, 35 synced Codex workflow adapters, manifest parity, and the tested production-action/review-proof paths.
- Guard regressions: `npm run test:correction-guards` passed, including stop verification, worktree awareness/cleanup, shell/MCP safety, migration proof, idempotency-body, review proof, registry freshness, session staleness, ledger update, and baseline checks.
- RPC prevention contracts: `npm run test:contracts` passed — 3 files / 100 tests, including the mutator/idempotency inventory.
- Full local unit coverage gate: `npm run test:coverage` passed — 286 files / 3,888 tests passed / 118 skipped. Measured coverage was statements 41.18%, branches 34.18%, functions 30.43%, and lines 43.45%, above the configured ratchets in `vite.config.ts:144-166`.
- Historical WPS coverage: focused WPS output tests passed 16/16.
- The pre-commit path is substantive: `.husky/pre-commit` runs migration/frontend validation, lint, typecheck, build, unit tests, agent-workflow tests, correction guards, dependency verification, and map generation. This audit did not change that path.

## Evidence deliberately blocked or not attempted

- **No live database query or mutation was performed.** The strict sweep failure is a local capability result, not a claim about the current live predicate rows.
- **No Supabase security-advisor invocation was attempted.** This audit was scoped to local/current configuration and had no need to authenticate against a live service.
- **No E2E test was run.** The suite creates/deletes fixtures and is correctly staging-only; the required staging environment and credentials are not available here.
- **No GitHub Actions run was invoked or observed.** CI configuration was inspected locally only.

## Recommended next step

Treat MED-14.1 and MED-14.2 as one owner/platform hardening batch: establish a disposable or least-privilege staging/live-read-only verification environment, then enable strict catalog sweeps and staging E2E in CI. In the same small follow-up, fix the isolated-worktree backup false warning and reduce the remaining frontend validator noise before making any warning path stricter.
