## 2026-09-20 — the six document-number generators now take their year from Chicago on live (issue #617)

**What happened.** `supabase/migrations/20260908140000_number_generators_year_chicago.sql` merged as
`6171c0a20` (PR #726) and was **applied live** on 2026-09-20 under ledger version `20260920051333`
(B7 convention: the ledger row's `version` is the apply timestamp, its `name` carries the file's
stamp). It is now the effective ordering high-water. Mason gave the attended go-ahead in session.

The six generators — `next_application_record_number`, `next_commission_payment_number`,
`next_cycle_count_number`, `next_job_number`, `next_po_number`, `next_return_number` — previously
took the year from the UTC `CURRENT_DATE`. From about 18:00 Chicago on 31 December they minted next
year's number. Each now reads `(now() AT TIME ZONE 'America/Chicago')::date`. The written record of
the change itself is `docs/changelog.d/2026-09-19-six-number-generators-year-chicago.md`.

**Gates cleared before the apply.**

- Exact-SHA `gpt-5.6-sol` high-effort review of `71bde00` through `scripts/write-codex-push-proof.mjs`:
  CLEAN, no findings. That wrapper worked again only because PR #725 rebuilt its sandbox for Codex
  CLI 0.155 the same night.
- CodeRabbit: APPROVED, "No actionable comments were generated", reviewing `3b1b559..71bde00` across
  all seven changed files.
- `scripts/write-apply-proofs.mjs`: both reviewer charters CLEAN from `gpt-5.6-sol/high`, run
  markers present — `rls-security-reviewer` ("Safe to apply", 0 BLOCKER/HIGH/MED) and
  `migration-drift-reviewer` (no drift blocker, stamp strictly above the then high-water
  `20260908130000`).
- Full vitest suite (378 files), `test:correction-guards`, `check-doc-drift` and
  `check-migration-hard-rules` all green on the merge commit.
- Immediately before the apply, a read-only live read confirmed all six `md5(prosrc)` still equalled
  the file's live pins — zero drift since the bodies were read on 2026-09-19.

**Applied through** `scripts/apply-migration-file.mjs --confirm` (all five gates inside the script;
the Supabase token was read from Windows Credential Manager in-process and never written anywhere).
`APPLY OK — HTTP 201`, one transaction, 53,649 bytes including the ledger row.

**Post-apply verification, read-only against the live catalog** (not the HTTP status):

- All six `md5(prosrc)` now equal the file's candidate pins — `9bf10abe…`, `3f876d75…`, `d6626bf1…`,
  `b97a23c4…`, `0fd0c786…`, `0c5ab61f…` — and every body contains `America/Chicago`.
- All six remain `SECURITY DEFINER`, `search_path=public, pg_temp`, owner `postgres`, zero-argument.
- On the live server the boundary instant `2027-01-01 02:00+00` (20:00 Chicago, 31 December 2026)
  yields UTC year **2027** and Chicago year **2026**, which is exactly the six-hour window that
  produced the wrong label.
- Ledger: 1003 rows / 996 distinct names, `max(version)` `20260920051333`.

**Unblocked by this.** The pending-migration guard refused every unapplied migration stamped above
this file. With it applied, the parked `20260914100100`..`20260914100900` cohort, #664's
`20260911120000` and the field-app season files (`20260908190000`, `20260912165758`,
`20260913040359`, `20260913152700`) are free to apply in their own order.

**The migration file is unchanged.** Its `PARKED` header stays byte-exact to what ran; applied status
lives in `docs/reference/migration-history.md` row 929 (corrected 2026-09-10 after the #646 finding).

Docs updated with the apply: `migration-history.md` (new boundary block and row 929),
`CURRENT_STATE.md` and `KNOWN_ISSUES.md` ledger stamps and status.
