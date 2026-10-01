## 2026-10-01 — preview-season prover: the 4-argument probe follows the Chicago business date

`scripts/smoke/prove-preview-field-app-season.mjs` failed `npm run proof:field-app-season` every
Sep 30 from 19:00 to 24:00 America/Chicago (observed 2026-09-30 21:00 CDT on head `c9849dacc`):
PHASE 4d (`AFTER_FOUR_ARGUMENT_CALLER`) stopped with "precondition -- a seeded per-customer rate
must be found, not the service default". The prover is test code only. Nothing in the product changed.

**Cause.** The prover read its season once, from `current_season()`, which is
`compute_season(CURRENT_DATE)` on a UTC container. PHASE 4d calls the preview without a date, so the
preview falls back to the America/Chicago business date. For those five hours the UTC date is already
Oct 1 while Chicago is still Sep 30. The probe seeded rates for the UTC season, the preview looked up
the Chicago season, and it found nothing.

**Fix.** The prover now reads two clocks separately. `SEASON_NOW` stays on `current_season()` (UTC),
because the old live preview body that phases 2 and 6a exercise reads the clock that way. A new
`BUSINESS_SEASON` is read from
`compute_season((now() AT TIME ZONE 'America/Chicago')::date)`, and it is asserted to equal
`SEASON_NOW` or trail it by one. `parityProbe` takes an optional `season` that sets which season the
rates are seeded under (default `SEASON_NOW`). PHASE 4d is the only probe that relies on the Chicago
fallback, and it is now seeded and dated in `BUSINESS_SEASON`. Outside the window the two values are
equal, so every probe behaves exactly as before. No assertion was removed or loosened.

**Why `SEASON_NOW` itself was not moved to Chicago.** That was the first proposal. A window
simulation showed it only moves the failure: with `SEASON_NOW` on Chicago, PHASE 2a's same-season
control failed because the old body priced at the UTC season (preview 2222c/acre against save 1111c/acre).

**Proof (Docker, 2026-10-01).** Throwaway copies of the prover, never committed, replaced
`current_season()` inside the container with one that reads one season ahead of the Chicago date.
That is the 19:00–24:00 Sep 30 relationship. Results:

- origin/main's prover: fails at PHASE 4d with the exact message observed on 2026-09-30, so the
  simulation reproduces the real failure;
- `SEASON_NOW` moved to Chicago: fails at PHASE 2a, as described above;
- this change: passed every phase through PHASE 8-cutover, including 4d and all the mutation
  phases. It then stopped in the unchanged-date drift probes (`sourceSeasonCreatorProbe`). That stop is
  caused by the simulation itself. The probe relies on `current_season()` equalling
  `compute_season(CURRENT_DATE)`, which the fake deliberately broke, while in a real window both read the
  same UTC clock. Every probe after 4d passes an explicit date or compares the UTC `CURRENT_DATE` with the
  UTC `SEASON_NOW`, and the four 20260914101000–101300 guard migrations read no clock at all.

The unmodified prover also passed at real time: `npm run proof:field-app-season` printed
`PREVIEW_SEASON_PROOF_PASS`. The second script then printed `RECEIPT_GATE_NARROWING_PROOF_PASS`, and the command exited 0.

**Not verified.** The simulation moves `current_season()` but not code that reads `CURRENT_DATE`
directly, so phases after 4d that read `CURRENT_DATE` directly were not run at a real 19:00–24:00
Sep 30. The next real check is Sep 30, 2027 evening Chicago time. This change adds no
`supabase/migrations` file.
