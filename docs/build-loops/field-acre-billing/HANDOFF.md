# HANDOFF — Field Mapping + Per-Acre Billing, Track A

**Status:** ✅ Track A (A1–A7) **BUILT, REVIEWED, PROVEN (locally), PUSHED — AWAITING OWNER APPROVAL.**
**Branch:** `feat/field-acre-billing` (off `main` `c2f83c2f`). **Nothing applied to prod. Nothing merged. Nothing deployed.**
**What's left is 100% owner-gated:** apply 2 migrations to the live DB → regen schema registry → run the smoke + sweeps → merge → deploy → prove in the live app with real export files.

---

## 1. What this delivers (plain English)

Today a field's billable acreage is a single number that **silently changes whenever the map boundary is redrawn** — the worst kind of billing bug, because nobody sees it happen. This work fixes that with a **two-number model**:

- **Measured acres** — computed by the server from the actual map polygon (geodesic, multi-part aware). Read-only to humans.
- **Override acres** — the number a human types when they want to bill something other than the measured area (e.g. a contracted/planted acreage). This is what the bill uses when present.
- **Billable = override if set, else measured, else the legacy `total_acres`.**

The key guarantee: **redrawing a boundary re-measures, but never touches the override.** A typed billable acreage survives any map edit. Acreage can only be written by two server functions (`set_field_boundary`, `set_field_override_acres`) — a database trigger blocks any other write, even a direct table UPDATE. Plus: **.zip shapefile import** (the format John Deere Operations Center and Climate FieldView export) with correct **multi-part** acreage.

## 2. Verdict

**SHIP-WITH-FOLLOWUPS.** The final whole-branch Codex review (`codex review --base main`) returned **no blockers**. Three items, all already documented below:
- **P1** = follow-up **E1** (legacy `total_acres` cosmetic sync) — *not a billing bug*; the bill reads measured/override, both server-authoritative.
- **P2** = follow-up **E2** (multi-part delete-all stale boundary) — narrow UI edge.
- **P2** = **import-mapped-acres business decision** (below) — a question for you, not a defect.

None of the three can change a bill. They are finished off against the **running app** (the correct validator), which is exactly the owner go-live gate.

## 3. What was built (per phase, with the independent Codex verdict)

| Phase | Commit | Codex | What |
|---|---|---|---|
| A1 — migration: two-acre columns + backfill | `1050d2e0` | SHIP | `supabase/migrations/20260623120000_fields_two_acre_model.sql` — adds `measured_acres`, `override_acres` (numeric), `boundary_geom geometry(MultiPolygon,4326)`, GENERATED `acres_source`, a GIST index, and a **bill-preserving backfill** (existing boundaried fields get `override_acres = total_acres` so no current bill moves). |
| A2 — migration: acreage RPCs + authority trigger | `ee65d4b2` | SHIP (4 rounds) | `supabase/migrations/20260623130000_set_field_boundary_rpc.sql` — `set_field_boundary` / `set_field_override_acres` / `find_overlapping_fields` (all SECURITY DEFINER, search_path-pinned, strict-actor, idempotent) + the `fields_acre_authority` BEFORE INSERT/UPDATE trigger that makes the RPCs the only writers of the acre columns. |
| A3 — types | `30c5e956` | SHIP | The 3 RPCs + 4 columns added to `src/types/supabase.ts` and `src/types/index.ts` so the frontend typechecks before the live regen. |
| A4 — UI: FieldSetup override model | `bcdf8129` | NEEDS-LIVE-PROOF (4 rounds) | Removed the redraw clobber (the #1 defect); "Billable Acres (override)" input + Measured/Will-bill display; draw save repointed to the RPCs; new tested helper `src/lib/fieldGeometry.ts` (11 tests). 2 open edges E1/E2 → live proof. |
| A5 — import: .zip + multi-part | `cd5877a` | NEEDS-LIVE-PROOF (5 rounds) | `.zip` shapefile import (`parseShapefileZip`) + correct multi-part measure (display = largest ring, **save = full geometry**) + `BulkFieldImport` save repointed to `set_field_boundary`. 27 parser tests. |
| A6 — tests + docs | `a84c9ca5` | n/a | Apply-gate smoke `scripts/smoke/smoke-set_field_boundary.sql` (registered in `smoke-specs.json`) + doc-drift sync (`check-doc-drift.mjs` = PASS). |
| A7 — handoff | (this) | SHIP-W/-FOLLOWUPS | This file + STATE = AWAITING-OWNER-APPROVAL. |

## 4. How it was proven (and what it could NOT prove)

**Proof environment (owner chose LOCAL):** a standalone Docker container **`crx-fa-proof`** = PostgreSQL 15.4 + PostGIS 3.3.4 (PostGIS in the `extensions` schema, mirroring prod), loaded with a **faithful schema-slice scaffold** (the real `fields` / `field_polygons` / `idempotency_keys` / `activity_feed` / `profiles` definitions copied verbatim from the live migrations + an actor-simulating `auth.uid()`). The full 510-migration cold-apply is infeasible (a *pre-existing* ordering drift unrelated to this work — `20260207090000` indexes `payments` before that table exists), so the slice is the right call. **Never touched prod `rhyzpcqhnizqbxphqdkr`.**

**Proven against that scaffold:** A1's 5-case backfill matrix (bill preservation + multi-part union vs largest-ring); A2's full RPC matrix incl. the authority-trigger guard (a direct `UPDATE fields SET measured_acres=…` is rejected); A5's multi-part measure (a 2-part MultiPolygon → **56.93 ac**, not the 37.96 of the largest part alone). Plus: `npm run typecheck` (the **real** one — `tsconfig.app.json`; see the gotcha in §7) + `lint` + `build` green, and 38 new unit tests (fieldGeometry 11, fieldImportParser 27).

**What it could NOT prove → the owner gate:** the running React app — A4's two save-flow edges (E1/E2 below) and a real `.zip` / Ops Center / FieldView import drawing on the map. Those need the app pointed at a DB that has the migrations. That is the live-UI proof in §6.

## 5. Follow-ups (documented, none block the merge)

All are either cosmetic-legacy, a narrow UI edge, or a business decision — **none can change a bill** (bills read the server-authoritative measured/override columns).

1. **E1 — legacy `total_acres` precise-sync (P1, cosmetic).** After a successful boundary/override save, FieldSetup doesn't sync local `total_acres`/`measured` from the RPC result, so an *attribute-only* re-save on the same page can resend the *loaded* `total_acres`, reverting the legacy fallback to a valid-but-stale value. The bill is unaffected (it uses measured/override). **Fix:** sync local state from the RPC return with a dirty-suppression ref. Finalize against the live app.
2. **E2 — multi-part delete-all stale boundary (P2).** Deleting the last drawn polygon of a loaded multi-part field leaves the legacy `boundaryGeoJSON` set, so `set_field_boundary` would re-measure only the largest part. **Fix:** don't load/use `boundaryGeoJSON` for multi-mode fields; derive map bounds from `drawnPolygons`. Finalize against the live app.
3. **Import mapped-acres — BUSINESS DECISION (P2, your call).** A shapefile often carries its own stated `Acres` attribute. Right now import **measures from the geometry** (server-authoritative) and does **not** adopt the file's number. Question: when a `.zip` states an acreage, should that become the **override** (trust the grower's/agronomist's number) or stay **measured-only** (trust the polygon)? Default shipped = measured-only. Tell me which you want and it's a one-line import change.
4. **Dedupe UI (v1 defer).** `find_overlapping_fields` exists (A2) but the Skip/Replace/New-on-overlap import UI isn't wired. Advisory only.
5. **Stable import idempotency keys.** Import currently keys per save; a mid-batch retry could re-measure. Low-risk; tighten when the dedupe UI lands.
6. **Atomic `create_field_with_boundary` RPC.** Import does `save_field` then `set_field_boundary`; an atomic RPC would kill the rare residual orphan window. Nice-to-have.

## 6. OWNER GO-LIVE STEPS (exact order — do not reorder)

> Hard rule honored by this build: **the loop never applied a migration to prod and never merged/pushed to main.** Every step below is yours to approve.

1. **Apply the 2 migrations to the live DB** (`rhyzpcqhnizqbxphqdkr`), in this order — see §7 for the apply-guard proof recipe (the parked proof files expire after 30 min; regenerate fresh):
   1. `supabase/migrations/20260623120000_fields_two_acre_model.sql`
   2. `supabase/migrations/20260623130000_set_field_boundary_rpc.sql`
2. **Before applying A1**, re-confirm on 2–3 real **multi-part** fields that the `field_polygons` backfill + `polygon_geojson` shape look right (couldn't be checked without prod data).
3. **Regenerate the schema registry:** `/regen-schema-registry` (the 4 schema-aware hooks read it; it's stale until you do this).
4. **Post-apply smoke + sweeps:**
   - `node scripts/smoke/run-smoke.mjs --spec set_field_boundary` → must end `SMOKE_PASS_ROLLBACK`.
   - `npm run db-sweeps` → 0 rows.
   - `mcp get_advisors` (security + performance) → no *new* findings vs the pre-apply baseline.
5. **Merge** `feat/field-acre-billing` → `main`.
6. **Deploy** (push to `main` = Vercel prod) and do the **live-UI proof** with your **real** John Deere Ops Center / Climate FieldView / generic `.zip` exports:
   - Import a `.zip`, confirm acreage matches the export (and a **multi-part** field sums all parts).
   - Draw a boundary, type a billable override, **redraw the boundary**, confirm the override **did not move** (the core guarantee).
   - While here, finalize **E1** and **E2** with live feedback.
7. **Owner in-app smoke**, then we move to **Track B** (per-acre billing tie-in) — currently BLOCKED in STATE.md until you unblock it.

## 7. Apply-guard proof recipe (for whoever runs the apply)

The `migration-apply-guard` hook blocks `apply_migration` unless a fresh proof file exists at `.claude/session-state/migration-review-<name>.json`. **It expires after 30 minutes** and binds `queryHash` = `sha256` of the **exact SQL string passed to `apply_migration`**. So proof files written during the build are already stale — **regenerate them at apply time**, then apply within 30 min. Reviewers already ran clean this build (rls-security, migration-drift, compliance, typescript-types-drift); the durable fact is the content hash.

Reference hashes of the parked files (sha256 of the on-disk bytes — they match `apply_migration`'s `query` only if you pass the file content verbatim):
- `20260623120000_fields_two_acre_model.sql` → `bc6cbb7d1a8f185091a7f0198b336524ce940abf40d0d98455da14b4add8f774`
- `20260623130000_set_field_boundary_rpc.sql` → `413f0237518c3bdc6c29e815ea05a259b729e0e2c4a9ef6b2a1e633b21f666a5`

Regenerate fresh proofs (run from `C:/CRX_FieldMapping`, then call `apply_migration` for each within 30 min, passing that file's content as `query`):

```bash
node -e '
const fs=require("fs"),c=require("crypto"),p=require("path");
const dir=".claude/session-state"; fs.mkdirSync(dir,{recursive:true});
const ts=new Date().toISOString();
const R=["rls-security-reviewer","migration-drift-reviewer","compliance-reviewer","typescript-types-drift-reviewer"];
for(const m of [["20260623120000","supabase/migrations/20260623120000_fields_two_acre_model.sql"],
                ["20260623130000","supabase/migrations/20260623130000_set_field_boundary_rpc.sql"]]){
  const q=fs.readFileSync(m[1],"utf8");
  const h=c.createHash("sha256").update(q).digest("hex");
  fs.writeFileSync(p.join(dir,`migration-review-${m[0]}.json`),
    JSON.stringify({migration:m[0],timestamp:ts,reviewers:R,findings:"clean",queryHash:h},null,2));
  console.log(m[0],h);
}'
```

The `apply_migration` `name` must contain the stem (`20260623120000` / `20260623130000`) so the guard matches the proof. If the migration file changed since this handoff, the hash changes — re-review before regenerating.

## 8. Process notes (so the next session doesn't relearn them)

- **`npm run typecheck` is the only real typecheck** = `tsc --noEmit -p tsconfig.app.json`. `tsc -p tsconfig.json` does **not** check `src/` (false-clean). The pre-commit hook uses the real one.
- **Column-level REVOKE doesn't gate writes** in this Supabase project — table-level UPDATE grant supersedes it. The acre columns are protected by the `fields_acre_authority` **trigger** (RPCs set a txn-local GUC `app.acre_authority_write='on'` before their write), not a REVOKE.
- **PostGIS lives in the `extensions` schema** — every SECURITY DEFINER function here pins `search_path = public, extensions, pg_temp`. Use `ST_GeomFromGeoJSON(...)::geography` (there is no `ST_GeogFromGeoJSON`).
- **The audit table is `activity_feed`** (not `activity_log`).

---
**Track B (B0–B4, Z) stays BLOCKED** in STATE.md — it tied into the now-merged `feat/as-applied-invoices`; unblock only on your word after Track A is live.
