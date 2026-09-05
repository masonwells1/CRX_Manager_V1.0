# Build Loop — Field Mapping + Per-Acre Billing (autonomous, Codex-gated)

> **What this is.** A self-running runbook for a **dedicated session** (worktree `C:/CRX_FieldMapping`, branch `feat/field-acre-billing`) to build the field-mapping → per-acre-billing upgrades to "ready," using **Codex as helper + reviewer every phase**, proving on a **Supabase dev branch (never prod)**, then **stopping at the human gates**. Read `SCOPE-OF-WORK.md` first. Track progress in `STATE.md` — update it after every phase so the loop is **resumable**.

## How to run it (the loop driver)
On each turn: **read `STATE.md` → execute the *first* phase whose status is `PENDING` (in order) → on success, mark it `DONE` with commit SHA + Codex verdict → continue.** If the next phase is `BLOCKED` / `IN-PROGRESS` / `AWAITING-OWNER-APPROVAL`, **STOP — do not run it** (those need a human). Stop also at a hard gate, a stuck phase (round cap), or when all runnable phases are `DONE`. Launch self-paced with `/loop` (see `README.md`). It runs unattended; it needs the owner only at the human gates.

> **TRACK B IS BLOCKED BY DESIGN.** Track A phases (A1–A6) are `PENDING` and run now. Track B phases (B1–B4) are `BLOCKED` because a parallel session (`feat/as-applied-invoices`) is editing those exact files. The loop will run Track A, write the Track-A handoff, and STOP at Track B. The owner unblocks Track B (in `STATE.md`) only after confirming the as-applied session merged to `main` — then the loop re-grounds and builds Track B.

## Codex is used TWO ways every phase
- **Helper (before/while building):** `codex exec "<design draft/question>"` (non-interactive, `--sandbox read-only`) — critique the design, propose SQL/RLS, spot edge cases *before* you commit. Input, not gospel.
- **Reviewer (after committing):** `git fetch origin` first, then `/codex-review --base main` (review against the freshly-fetched remote merge-base, never a stale local `main`). Writes `.claude/session-state/codex-review-latest.txt`, returns SHIP / SHIP-WITH-FOLLOWUPS / NEEDS-WORK. Fix BLOCKER/HIGH, re-review to SHIP. **Commit before reviewing** — never `codex review --uncommitted` (it stashes your tree). Codex down → STOP + hand off; never skip the gate.

## Per-phase recipe (apply to every build phase)
1. **Helper pass** — `codex exec` to pressure-test this phase's design; fold in what's sound.
2. **Build** — implement just this phase. Honor the `AGENTS.md` CRX Hard Rules + canonical patterns (money=cents, RLS, `checkMutationResult`/`assertRpcResult`, idempotency, strict-actor, `search_path = public[, extensions], pg_temp`, lazy pages, Lucide, single db client). PreToolUse hooks block bad writes — a block = a real defect.
3. **Prove it runs** ("done = ran and proven"). Preferred: a **Supabase dev branch** — `create_branch` → **record its ID in `STATE.md`** → `apply_migration` ONLY against that recorded non-prod ID → exercise the RPCs/UI → keep or discard. **Target-lock (mandatory):** never `apply_migration` unless the target is the recorded dev-branch ID; if you cannot positively confirm it's the dev branch, **ABORT** (prod = `rhyzpcqhnizqbxphqdkr`, never apply there). **Fallback:** SQL-only smoke in `BEGIN … ROLLBACK` ending `SMOKE_PASS_ROLLBACK` + component tests with mocked RPCs — never a prod UI/PostgREST mutation to "prove" anything.
4. **Verify** — the narrowest useful subset of `npm run typecheck / lint / build / test`.
5. **Subagent review** — `rls-security-reviewer` + `migration-drift-reviewer` for SQL; `typescript-types-drift-reviewer` for types/migrations; `compliance-reviewer` always for `src/`+migrations. Confirm each finding against the cited line.
6. **Commit on `feat/field-acre-billing`** (never `--no-verify`).
7. **Codex review gate** — `/codex-review --base main`; fix confirmed BLOCKER/HIGH; re-review to SHIP.
8. **Learning capture** — for any confirmed BLOCKER/HIGH, add a regression test that fails on the pre-fix code, or route to a hook/lint/sweep.
9. **Push the FEATURE branch** to origin (`git push -u origin feat/field-acre-billing` — a feature branch, NOT main). A Vercel **preview** build for the branch is non-prod and fine; only main is prod. Update `STATE.md`.
10. **Round cap: 3** fix→re-review rounds per phase. If the same finding survives two rounds, or round 3 still has an open BLOCKER/HIGH, STOP and write both positions to `STATE.md`.

---

## Phases

### Phase 0 — Setup & grounding  *(no feature code; environment gate)*
- Confirm the isolated worktree: `git rev-parse --show-toplevel` must be `C:/CRX_FieldMapping` (NOT `C:/CRX_Manager`); branch `feat/field-acre-billing` off latest `main`; `npm ci` done; clean tree (besides the carried planning + harness docs).
- Verify **Codex**: `codex --version` + `codex login status` (exit 0). If down → STOP.
- **Refresh the schema registry** via Supabase MCP introspection + `/regen-schema-registry` (the schema-aware hooks must validate against current live schema — note the session-staleness hook flags `20260621160000` newer than the registry).
- **Re-ground** against the live schema + code: confirm the PHASE2 design's facts still hold (`fields` columns, `save_field`/`save_field_geometry` signatures, `fieldImportParser.ts` + `BulkFieldImport.tsx` shape, the proven `ST_GeomFromGeoJSON(...)::geography` idiom, no existing `ST_Area`). If reality differs, update the SOW before building.
- Confirm the parallel session's branch (`feat/as-applied-invoices`) so Track A avoids its files; verify Track A's files are NOT in that branch's working set.
- Helper: `codex exec` a sanity check of the Track A approach.
- **Gate:** environment green, Codex up, registry fresh, grounding confirmed → `STATE.md` Phase 0 = DONE.

### Phase A1 — Migration: fields two-acre columns + backfill
- Helper: `codex exec` to critique the column set, the `boundary_geom geometry(MultiPolygon,4326)` choice, the backfill SQL, and the `billable = COALESCE(override, measured, total_acres)` rule (no new RLS/table; index choice).
- Build one new migration: the 4 columns + GIST index + backfill from existing `boundary` (and the multi-polygon `field_polygons` second backfill — verify against known multi-part fields).
- **Prove:** dev-branch apply → assert `measured_acres` populated for existing boundaried fields, `billable_acres` correct with/without override. `plpgsql_check` n/a (no fn yet); 0 new overloads.
- Review (`migration-drift` + `compliance`) → fix → commit → `/codex-review --base main` → SHIP.

### Phase A2 — Migration: set_field_boundary RPC (+ override + dedupe)
- Helper: `codex exec` to critique `set_field_boundary` (geodesic `::geography` cast, `ST_MakeValid`/`ST_IsValid`/`ST_IsEmpty`, the 0.1–5,000 band, strict-actor, idempotency, keeping legacy `boundary`/`centroid` fed) + `set_field_override_acres` (>0 validation, NULL clears) + `find_overlapping_fields`.
- Build one new migration (reproduce any touched existing function VERBATIM before patching — the #1 drift bug class; byte-verify).
- **Prove (dev branch):** the PHASE2 design §8B smoke matrix — 40.00-ac polygon → 40.00±0.02; self-intersecting → `ST_MakeValid` (no garbage); 9,999-ac & 0.05-ac → `AREA_OUT_OF_BAND`; double-submit key → one write + replay; wrong actor → `ACTOR_MISMATCH`. `plpgsql_check`=0; exactly 1 overload each.
- Review (`rls-security` + `migration-drift` + `compliance`) → fix → commit → `/codex-review` → SHIP.

### Phase A3 — Types
- Add `measured_acres`/`override_acres`/`acres_source` to `Field`, `ParsedImportField`, `FieldLocation` in `src/types/index.ts`. `typecheck`; `typescript-types-drift-reviewer` + Codex → SHIP. Commit.

### Phase A4 — UI: FieldSetup override model (the #1 defect fix)
- Helper: `codex exec` on the override UX (billable input bound to `override_acres`, "Measured" label, removing the `onPolygonsChange` clobber, draw→`set_field_boundary`).
- Build it. **Prove:** against the dev branch via preview tools — draw/import a field, type an override, **redraw → override survives** (the regression), enter 0 → rejected; screenshot.
- Verify + `compliance-reviewer` + Codex → SHIP. Commit.

### Phase A5 — Import: .zip + multi-part + dedupe
- Helper: `codex exec` on the `.zip` branch (shpjs zip ArrayBuffer), multi-part preservation, and the dedupe-choice UX.
- Build it. **Prove:** import a sample `.zip` shapefile against the dev branch → measured acres correct, boundary draws; re-import → dedupe flags → Skip → no duplicate; multi-part → acres = sum of parts. *(Real Ops Center / FieldView export proof moves to the owner gate — Mason supplies one of each.)*
- Verify + `compliance-reviewer` + Codex → SHIP. Commit.

### Phase A6 — Track A tests + docs
- Regression tests: `set_field_boundary` guards (band/validity/actor/idempotency) + **override-survives-redraw** + 0-acre reject. `typecheck/lint/build/test` green.
- Docs: `database-schema.md`, `rpc-functions.md`, CLAUDE.md Snapshot counts, `docs/CHANGELOG.md`; `node scripts/check-doc-drift.mjs` = 0.
- Full `/codex-review --base main` over Track A → SHIP. Commit + push feature branch.

### Phase A7 — Track A handoff  *(HARD STOP for Track A)*
- Write the **apply-guard proof files** for the Track A migrations: `.claude/session-state/migration-review-<safe-name>.json` (`migration`, real ISO-8601 UTC `timestamp`, `reviewers`, `findings:"clean"`, `queryHash` = `crypto.createHash('sha256').update(fs.readFileSync('<path>')).digest('hex')` computed LOCALLY with **Node, not PowerShell** — PowerShell adds a BOM and the guard skips the file). **Do NOT call `apply_migration` to get the hash** (that applies live).
- Write **`HANDOFF.md`**: what Track A built, per-phase Codex verdicts, proof method (dev-branch ID), and the exact ordered owner steps to go live (apply migrations → `/regen-schema-registry` → post-apply smoke + `db-sweeps` → merge → deploy → in-app proof with Mason's real export files).
- Set `STATE.md` Track A = `AWAITING-OWNER-APPROVAL`. Notify the owner. **STOP.**

### Phases B1–B4 — Billing-engine track  *(BLOCKED — see Track B in SOW)*
- **Do not run** until the owner sets these `PENDING` after confirming `feat/as-applied-invoices` is merged.
- **B0 re-ground first:** re-read live `pg_get_functiondef('save_field_app_invoice')` + `preview_field_app_invoice_split` + `FieldApplicationInvoice.tsx` (their line numbers / bodies will have moved); confirm Codex's 5 findings + the `:313` bill-tie-in seam still apply before building.
- Then B1 (hardening) → B2 (bill tie-in) → B3 (transfer_job convergence) → B4 (polish), same per-phase recipe, same dev-branch proof, same handoff.

---

## Hard safety gates (binding on the whole loop)
- **No live migration apply. No merge/push to `main`. No deploy. No data deletion.** All require the owner's explicit OK at handoff.
- Migration proof is **dev-branch ONLY** (recorded ID) or rolled-back smoke — never prod.
- Codex review **mandatory each phase**; Codex down → STOP + hand off.
- Feature-branch push to origin = allowed; main = NOT.
- Never `--no-verify` / `@ts-ignore` / `any`; never weaken RLS or remove an existing migration; reproduce existing function bodies verbatim.
- **Track B stays BLOCKED** until the owner confirms the as-applied session merged.
- Judge DB/migration "drift" against `origin/main`'s merge-base, never the local checkout.
