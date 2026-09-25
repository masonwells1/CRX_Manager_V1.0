## 2026-09-21 — restamp the four field-invoice candidates above the commission cohort

Mason decided on 2026-09-21 that the eight parked commission migrations
`20260914100100`..`20260914100900` (already on `main`) go live BEFORE this PR's four field-invoice
candidates. At their 2026-09-20 stamps all four sorted below that cohort, so once it applied the
strict ordering guard would have refused every one of them. They move as one block, same internal
order, no behaviour change:

| Before | After | File |
|---|---|---|
| `20260911125000` | `20260914101000` | `field_app_invoice_cross_season_edit_guard.sql` |
| `20260911130000` | `20260914101100` | `preserve_unchanged_source_invoice_dates.sql` |
| `20260912165758` | `20260914101200` | `refuse_generic_field_invoice_creation.sql` (phase 1) |
| `20260913040359` | `20260914101300` | `finish_generic_field_invoice_cutover.sql` (phase 2) |

**Reverse hazard, now written into every ledger surface:** none of the four may be applied live
until all eight `20260914100*` migrations are, or the whole cohort is stranded below them. The
pending-set guard reads only `origin/main` and cannot catch this while the PR is unmerged.

**Why `20260914101000`..`20260914101300` and not today's date.** The new stamps sit immediately
above the cohort, which is exactly the position the decision needs. A stamp dated 2026-09-21 would
also sort above it, but `check-doc-drift` then requires `CURRENT_STATE.md` and `KNOWN_ISSUES.md` to
be re-verified against the live database dated 2026-09-21. That is a real guard, and it was not
satisfied by bumping their dates without a live re-read. Choosing a stamp by position follows the
2026-09-20 restamps' precedent.

The move also clears a latent version collision: the parked branch
`claude/adjust-inventory-control-char-keys-20260920` has carried `20260911130000` for a different
migration, the same version the unchanged-date guard held until today. That branch's history also
contains `20260920120000_refuse_control_character_adjust_inventory_keys.sql`. **If that migration
is ever merged and applied, its order relative to these four is still an open owner decision.** It
sorts above them, so applying it first would strand them.

Follow-through: `git mv` of all four files; LF sha256 pins re-computed from the staged blobs and
updated in rows 931-934; `.gitattributes` LF pins; prover file constants plus a new hard assertion
that every candidate sorts above the newest `20260914100*` file; boundary text in
`migration-history.md`, `CURRENT_STATE.md`, `KNOWN_ISSUES.md` and `rpc-functions.md`. Historical
changelogs and handoffs keep their old stamps as the record of what was true then.
`MIGRATIONS_AWAITING_TYPE_REGENERATION` needed no new entry — `src/lib/rpcContracts.test.ts` was
run on the restamped files and passes 96/96, exactly as it did at the previous stamps.

All four remain LOCAL CANDIDATES — NOT APPLIED.
