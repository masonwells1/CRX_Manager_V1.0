# STATE — Field Mapping + Per-Acre Billing build loop

> The loop reads this at the start of every turn and updates it after every phase. Status: `PENDING` · `IN-PROGRESS` · `DONE` · `BLOCKED` · `AWAITING-OWNER-APPROVAL`.
> **The loop runs ONLY the first `PENDING` phase each turn, and STOPS (does not run) on `BLOCKED` / `IN-PROGRESS` / `AWAITING-OWNER-APPROVAL`.** Append-only log; never delete history.

**Overall status:** IN-PROGRESS — Phase 0 DONE; building Track A (A1).
**Worktree:** C:/CRX_FieldMapping
**Branch:** feat/field-acre-billing (off main c2f83c2f)
**Proof target (owner chose LOCAL):** standalone Docker container **`crx-fa-proof`** = PostgreSQL 15.4 + PostGIS 3.3.4 (in `extensions` schema, mirrors prod PG15/PostGIS3.3.7). The full 510-migration cold-apply is INFEASIBLE (pre-existing ordering drift — `20260207090000` indexes `payments` before it exists), so the proof env is a **faithful schema-slice scaffold** (`fields`/`field_polygons`/`idempotency_keys`/`activity_feed`/`profiles` copied verbatim from the real migrations + an actor-simulating `auth.uid()`), at `/tmp/crx-fa-proof/scaffold.sql`. Migrations are applied + smoke-tested there via `docker exec` (NEVER prod `rhyzpcqhnizqbxphqdkr`). **DEFERRED (low-risk for additive Track A, will confirm at Mason's live-apply gate):** schema-registry refresh + prod-column-existence confirm (needs read-OAuth; the 4 new columns are confirmed absent on-disk).
**Parallel session to avoid:** feat/as-applied-invoices — **ALREADY MERGED to main** (20260622030000 on origin/main; no remote branch). Track A has no live collision. Track B stays BLOCKED until the OWNER unblocks it.
**Started:** 2026-06-23
**Last updated:** 2026-06-23 (Phase 0 grounding complete; stopped at proof-tooling gate)

## Phase checklist
| Phase | Status | Commit SHA | Codex verdict | Notes |
|---|---|---|---|---|
| 0 — Setup & grounding | DONE | — | n/a | env+codex GREEN; on-disk grounding DONE (critic=GO, PHASE0-GROUNDING.md); proof env = local PostGIS scaffold (container crx-fa-proof). Registry refresh + prod-column confirm DEFERRED to live-apply gate (low-risk; columns confirmed absent on-disk). |
| A1 — Migration: fields two-acre columns + backfill | DONE | 1050d2e0 | SHIP | measured/override/boundary_geom + GENERATED acres_source + GIST + bill-preserving backfill. Proven on local PostGIS scaffold (5-case matrix: bill-preservation + multi-part overwrite). 4 reviewers clean; Codex: no actionable regressions. |
| A2 — Migration: set_field_boundary RPC (+ override + dedupe) | PENDING | — | — | server ST_Area + band + strict-actor + idempotency; §8B smoke matrix |
| A3 — Types | PENDING | — | — | Field / ParsedImportField / FieldLocation |
| A4 — UI: FieldSetup override model | PENDING | — | — | remove 854-857 clobber; billable-override input; draw→set_field_boundary |
| A5 — Import: .zip + multi-part + dedupe | PENDING | — | — | shpjs zip branch; preserve multi-part; dedupe choice |
| A6 — Track A tests + docs | PENDING | — | — | override-survives-redraw regression; doc-drift = 0 |
| A7 — Track A handoff | PENDING | — | — | apply-guard proofs + HANDOFF.md → AWAITING-OWNER-APPROVAL → STOP |
| B0 — Re-ground vs merged as-applied code | BLOCKED | — | — | unblock after `feat/as-applied-invoices` merges to main |
| B1 — save_field_app_invoice hardening (Codex's 5 findings) | BLOCKED | — | — | 0/neg acre reject · deleted_at-aware · override cost · salesman_id · acre rounding |
| B2 — Bill tie-in (mapped acres → invoice default) | BLOCKED | — | — | :313 default + 5 threadings + server COALESCE + ZERO_APPLIED_ACRES |
| B3 — transfer_job_to_invoice convergence | BLOCKED | — | — | service-fee line + actor binding |
| B4 — Polish (recipe pricing, reconciliation view) | BLOCKED | — | — | blend_recipe_items price; applied-not-invoiced view |
| Z — Track B handoff | BLOCKED | — | — | apply-guard proofs + HANDOFF update → AWAITING-OWNER-APPROVAL |

## Run log (append-only)
- 2026-06-22 — harness authored (SCOPE/BUILD-LOOP/STATE/README) in worktree C:/CRX_FieldMapping; npm ci green; NOT launched (awaiting owner OK).
- 2026-06-23 — Phase 0 launched. Env GREEN (worktree/branch/clean/npm ci). Codex GREEN (0.140.0, logged in). Confirmed feat/as-applied-invoices ALREADY merged to main (no Track-A collision). Ran a 10-agent on-disk grounding workflow (critic=GO; 7 CONFIRMED, 2 PARTIAL_DRIFT) + a Codex `exec` design helper pass — both written to **PHASE0-GROUNDING.md** (durable). Folded-in refinements: A1 backfill must set override=total to preserve current bills; robust geometry normalization (Force2D→MakeValid→CollectionExtract(3)→UnaryUnion→Multi); MultiPolygon can't cast to legacy POLYGON; RPC input must be a Geometry not FeatureCollection; total_acres ownership collision (draw save must route through set_field_boundary); inline strict-actor gate; audit table is activity_feed not activity_log.
- 2026-06-23 — Proof-tooling gate resolved: **owner chose LOCAL** (AskUserQuestion). Full 510-migration cold-apply FAILED (pre-existing ordering drift at `20260207090000` — payments index before payments table). Pivoted to a standalone **PostGIS 3.3.4 / PG15.4 Docker container `crx-fa-proof`** (postgis in `extensions`, matches prod) + a faithful schema-slice scaffold. Geography acreage idiom verified locally (synthetic ~94-ac polygon → correct). **Phase 0 DONE.**
- 2026-06-23 — **A1 DONE** (commit 1050d2e0). Migration `20260623120000_fields_two_acre_model.sql`: 4 net-new fields columns (acres_source GENERATED, no drift), GIST index, bill-preserving backfill. PROVEN on local scaffold — 5-case matrix all pass: F2 (typed 38.5 ≠ polygon 37.96 → bill stays 38.5), F5 (multi-part measured 37.96 = union, not 18.98 half), F4 legacy, F3 adopt-measured, generated acres_source. Reviewers (rls/drift/compliance/types) clean (1 MED = migration-history.md doc, → A6). Codex `review --commit`: no actionable regressions = SHIP. Field type updated. Next: A2 (set_field_boundary + override + dedupe RPCs).

## Open issues for the owner
- **[deferred, low-risk] Finish the read-only Supabase sign-in** (OAuth URL in chat) when convenient → lets me refresh the schema registry + confirm prod's `fields` doesn't already carry the new columns. Not blocking (columns confirmed absent on-disk; will re-confirm at the live-apply gate).
- **[for the live-apply gate] The multi-part `field_polygons` backfill** and `polygon_geojson` shape can't be verified without prod data — re-confirm on a couple of real multi-part fields before applying A1 live.

## Hard gates NOT crossed by the loop (handled at handoff, owner approval required)
- [ ] apply migrations to live DB
- [ ] regen schema registry (post-apply)
- [ ] post-apply smoke-chain + db-sweeps
- [ ] merge feat/field-acre-billing → main
- [ ] deploy (Vercel) + live UI proof (with Mason's real shapefile / Ops Center / FieldView exports)
- [ ] owner in-app smoke
- [ ] unblock Track B (after as-applied session merges)
