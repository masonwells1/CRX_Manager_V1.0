## 2026-09-03 — F06: a reloaded chemical line now remembers which field the operator typed

**What changed.** A chemical line on a job lets the operator type either the rate per acre
or the total quantity, and the grid fills in the other. The saved row never recorded which
one was typed, so when a saved job's acres changed, a reloaded line could not know which
side to hold, kept both, and `save_job` refused the whole job save
(`CHEM_QUANTITY_NOT_DERIVED`) with no on-screen warning. KNOWN_ISSUES entry "F06".

1. **Migration `20260903150000_job_chemicals_persist_driver.sql` (NOT APPLIED at time of
   writing).** Adds nullable `job_chemicals.driver` (`'rate' | 'qty' | NULL`, CHECK
   `job_chemicals_driver_chk`) and re-emits `save_job` from the applied 20260820120000
   body with only these deltas: read `driver` from each chemical element, store it, refuse
   any value other than NULL/''/'rate'/'qty' as `CHEM_DRIVER_INVALID` (the thirteenth
   refusal, raised before any write), marker `chem_unit_invariant_v2` → `v3`. No refusal
   reads the driver and the derived money is unchanged. NULL = unknown: every existing row
   (4 live rows on 2026-09-03) and every row written by the close-quote and recipe paths.
   Preflight pins the installed body to exactly the live 20260820120000 md5
   `227ab7b6bc2023724adf6952a221d2a8` (starting point) or this file's own candidate body
   md5 `18d08d5f40aea91fe13ac3e5a686c549` (identical replay) — not the marker, so a
   later hotfix that kept the marker can never be silently reverted by a replay; a
   column-drift pin before the ALTER refuses ANY pre-existing `driver` column or CHECK on
   a fresh apply (an unknown column may carry values the file cannot vouch for) and, on a
   replay, accepts them only in the exact shape this file creates; the parent migration's
   idempotency binding-column assertion is carried over. All of it came out of the
   gpt-5.6-sol exact-SHA review across four rounds (three HIGH, one MEDIUM, fixed the same
   day and each pinned by a mutant). The pins, the ALTER and the replacement share one
   transaction.
2. **Client.** `buildJobChemicalsPayload` sends `driver` (null unless exactly 'rate' or
   'qty'); `JobDetail` reads it back on reload so `recomputeChemRowForAcres` follows the
   typed side; rows with no stored driver are still left exactly as saved (the
   quantity == rate × acres heuristic stays reverted, Codex P1). Types updated.
3. **On-screen mirror.** `chemRowDefects` now mirrors `CHEM_QUANTITY_NOT_DERIVED` on the
   units-equal path with the server's exact tolerance (`chemQuantityTolerance`:
   GREATEST(0.0001, LEAST(0.00005 × acres, 0.1))) and `CHEM_QUANTITY_ZERO_BUT_EXPECTED`,
   so a stale line is named per row and the save is refused in the browser before any
   call leaves it. The different-units path was already covered by `chemLineBillingHazard`.

**Proof observed.**
- `scripts/smoke/prove-save-job-persist-driver.mjs` (throwaway postgres:17): both pins
  reproduce (the 20260820120000 body and the file's own candidate body); drift refused
  atomically (body untouched AND column not added); three staged drifts — a
  `NOT NULL DEFAULT 'rate'` column, a generated column, a same-named CHECK admitting a
  third value — refused with `PREFLIGHT_COLUMN_DRIFT`; apply over a bad ACL corrects it;
  replay reinstalls the identical body; a hotfixed body that kept the marker is refused on
  replay and left untouched; all 66 existing T1–T66 tests pass against the v3 body; D1–D8
  pass (rate/qty stored, absent and blank → NULL, `CHEM_DRIVER_INVALID` before any write,
  table CHECK, driver bound into the idempotency intent, identical money for every driver);
  named mutants each caught by the named test or the named assertion, including one that
  widens the replay arm back to the marker and is shown to overwrite the hotfix.
- Browser (real `JobDetail` in a stubbed-data Vite harness, no login): a line stored with
  `driver='rate'` at 1.5 pt/ac / 150 over 100 acres read 300 after the acres became 200;
  a line with NULL driver stayed 150 and showed "its rate (1.5/ac over 200 acres = 300)
  and its quantity (150) no longer agree…"; Save was refused with that message and no
  `save_job` call went out; re-typing the rate refilled 300 and the save then sent
  `driver: "rate"` on both lines; typing a total sent `driver: "qty"` with the back-solved
  rate.
- `src/pages/JobDetail.billingHazard.test.tsx` mounts the real page: a reloaded NULL-driver
  line keeps 150 and is named on screen; `driver='rate'` re-derives 300; `driver='qty'`
  holds 150 and re-derives the rate 0.75; and a save after the acreage change sends
  `driver: 'rate'` with quantity 300 to `save_job` (the Codex LOW follow-up, closed).
- `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`: green.

**Not verified.** The migration has not been applied to the live database; until it is,
every line reloads with an unknown driver and the on-screen mirror (part 3) is the whole
fix in production. `.claude/schema-registry.json` is refreshed after the live apply, not
in this change. The two other writers of `job_chemicals` still store NULL by design.
