# SOW-F2 - Stronger Applicator Mix-Up Flag (INVESTIGATE FIRST)

## Goal
Catch a **mistaken full-field bill**: an applicator sprayed only part of a field, but the billing
page auto-filled the applied acres to the field's full (system) acreage, so the customer gets billed
for the whole field. Today's divergence flag (shipped as Track B #1) compares applied acres vs system
acres and flags +/-10% - but because applied acres DEFAULT to system acres, a fresh job starts at 0%
divergence and the flag never fires on the common auto-fill case.

## Why it's different from the others
To flag a full-field bill as *possibly wrong*, the system needs an independent signal of what was
**actually applied** - otherwise "applied == system" is just the normal expected case and nudging on
every full-field job would be noise. So this feature is **investigate-first**.

## Decision already made by Mason
**Investigate the data. If a clean "what was actually applied" signal exists, build the flag. If not,
build ONLY the safe display improvement (below) and PARK the auto-nudge with a plain-English writeup
in STATE.md for Mason to decide.** Do not invent a partial-spray rule.

## Step 0 - INVESTIGATE (do this before writing any flag logic)
Determine whether, at the point of billing a field-application invoice, there is an applicator-entered
"acres actually applied" value that can differ from the field's system acres. Read:
- `src/pages/FieldApplicationInvoice.tsx` - how each location's `applied_acres` is defaulted
  (Bundle A+B: defaults to `billableAcres(...)`), and what upstream record the invoice came from.
- The job / application path: `transfer_job_to_invoice`, `application_records`, `field_app_locations`,
  `jobs` - is there an `applied_acres` (or planted/treated acres) the applicator recorded in the field
  that is distinct from the field's `total_acres` / `measured_acres`? (Check `src/types/index.ts` and,
  read-only, the live columns via the Supabase MCP - a SELECT is fine, no schema change.)
- The field's on-file system acres via `billableAcres` (already loaded on the page for the existing
  divergence alert).

### Branch A - a clean signal EXISTS
Build the flag (frontend-only if the value is already loaded, or via a read-only SELECT - NO
migration):
- Compare the invoice's `applied_acres` (auto-filled to system) against the upstream recorded applied
  acres. If they diverge by >= the existing threshold (`ACRE_DIVERGENCE_THRESHOLD_PCT`, reuse
  `acreDivergence` from `fieldGeometry.ts`), show a clear advisory:
  `This bills the full field (X ac) but the recorded application was Y ac - confirm before posting.`
- Keep it advisory (badge + banner), never a hard block - matches the existing divergence alert's
  posture.

### Branch B - NO clean signal
- Build ONLY the **safe display improvement** (frontend-only, no new logic, no data dependency):
  beside the applied-acres input show the field's on-file **System acres** with an explicit
  **"matches file" vs "edited"** state, so the biller can see at a glance whether they accepted the
  auto-fill or changed it. (Some of this may already exist from Track B #1 - read it first; only add
  what's missing.)
- **PARK the auto-nudge.** Write into STATE.md (and surface to Mason) the plain-English options he'd
  choose between, e.g.: (1) add an applicator "Did you spray the whole field? Yes / I sprayed less"
  confirm captured in the field (needs a small data field = a migration, owner-gated); (2) a per-job
  "partial" toggle; (3) leave it as the clearer display only. Do NOT build any of these without Mason.

## Files (read first)
- `src/pages/FieldApplicationInvoice.tsx`, `src/lib/fieldGeometry.ts` (acreDivergence already exists),
  the applied-acres input + the existing divergence badge/banner (Track B #1).

## Acceptance ("done" given the auth wall)
- Branch A: a unit test proves the flag fires when applied (auto-filled) diverges from the recorded
  applied acres, and stays quiet when they agree. Lint + typecheck + build + tests green. Ship live.
- Branch B: the display improvement ships (lint/typecheck/build/tests green, ship live), AND STATE.md
  has a crisp parked-decision writeup for Mason. Do not ship a noisy always-on nudge.

## Gates
Standard cycle. The display improvement is frontend-only -> ship live when green. The auto-nudge in
Branch B is PARKED for Mason (do not build).

## Owner gate
Branch B's auto-nudge, and any option that needs a new data field (a migration), are owner-gated -
PARK and stop that sub-part; the display improvement still ships.
