## 2026-09-20 — merge PR #736 and restamp the season guard above the new ordering high-water

Fifth merge of current main (`57f80909f`). One conflict, in the boundary block at the top of
`docs/reference/migration-history.md`, resolved in main's favour — see below. No behaviour changed
in any migration; both restamps this PR now carries are position-only. All four guard migrations
remain LOCAL CANDIDATES — NOT APPLIED.

### Why main's boundary block won the conflict

Both sides described the same 2026-09-20 apply, but main's is better evidence. This branch's block
was **transcribed from PR #739's apply record**, and said so. Main's block (from PR #736) is a
**real read-only ledger read**: 1004 rows / 997 distinct names, `max(version)` `20260920052149`, and
it records both applies of that morning in order — `20260908140000_number_generators_year_chicago`
under `20260920051333`, then `20260911120000_bind_adjust_inventory_receipt_to_intent` under
`20260920052149`. A transcription should not outrank a live read, so main's block was taken whole
and this branch's was dropped rather than merged.

### RESTAMPED: the season guard now sorts above the high-water

`20260908190000_field_app_invoice_cross_season_edit_guard.sql` →
**`20260911125000_field_app_invoice_cross_season_edit_guard.sql`**.

Main's boundary block states the rule plainly: a candidate must sort above the high-water, and *"of
the field-app season files, only `20260908190000` sorts BELOW that high-water and must be restamped
before it can apply."*

An earlier revision of this branch argued the opposite — that this file did not need a restamp,
because it shares no database object with `20260911120000` (verified: this file replaces
`preview_field_app_invoice_split`, `_assert_field_app_invoice_date_in_filed_season` and
`guard_field_app_invoice_season_date`; `20260911120000` replaces `adjust_inventory` and its receipt
trigger), because register-not-restamp is an established precedent here, and because apply order is
Mason's decision. **That position is withdrawn.** The rule is now written into the ledger from a
live read, complying is mechanical, every affected file is unapplied so nothing live moves, and
arguing with the repository's own stated ordering rule inside a delivery PR is the wrong place to
have that argument. It also removes a standing disagreement a later reviewer would raise again.

**The payoff:** for the first time all four candidates sort above the live high-water, and their
ascending stamp order is finally also their correct apply order:

    20260911125000  season guard          (row 931)
    20260911130000  unchanged-date fix    (row 934)
    20260912165758  cutover phase 1       (row 932)
    20260913040359  cutover phase 2       (row 933)

Row numbers are insertion order and are deliberately left alone, so the rows no longer read in
stamp order. Every document that states the sequence now says so explicitly.

`20260911130000` still depends on the two guard identities created by `20260911125000` and still
must follow it, which the new stamps preserve.

### Stale "apply this first" instructions removed

`20260908140000` is applied. Three migration headers still called it UNAPPLIED and told operators
to apply it first; `KNOWN_ISSUES.md` and `CURRENT_STATE.md` still implied it was pending. All
corrected, with the ledger version recorded and an explicit **do not reapply**. A second apply
would fail.

### Hash repins — all four

Every migration's header changed (the restamp notes, the corrected prerequisite wording, and the
cross-references between the four files), so all four canonical LF SHA-256 pins were recomputed and
updated in `docs/reference/migration-history.md`, plus
`2026-09-13-phase-two-cutover-lf-pin.md` for phase 2:

- `20260911125000` — `629d249b…624006`
- `20260911130000` — `5f871a60…909760`
- `20260912165758` — `160e6d7c…38f6a05`
- `20260913040359` — `b6d05012…5c9c39b6`

`.gitattributes` was repointed to the new filename. That pin is what keeps the hash reproducible on
Windows: without it a CRLF checkout changes the bytes, which changes `pg_proc.prosrc` and fails the
migration's own MD5 postflight. All four candidates are pinned, and the pins were verified to
reproduce from the **committed blobs**, not the working tree.

### Codex CRX-SEC-1 disposed of, not fixed

The previous head's review reported this candidate as REMOVING main's exact-acreage guard
(`fieldAcresSurvivesSave`) and deleting its regression tests — a money-path finding. Checked against
source rather than accepted: the guard is absent from `17826e9c3`, the main commit this branch had
merged, and landed afterwards in PR #740 (`387d5aed4`). The candidate never had it to delete. It
was stale, not destructive; "absent because behind" is indistinguishable from "deleted" when a
review diffs against a newer main. The fourth merge brought the guard in, and no acreage code in
this branch differs from main.

### Registry staleness, stated once and clearly

`.claude/schema-registry.json` still carries the 2026-09-17 snapshot
(`migrations_high_water 20260915033227`, 995 applied names) and has not been refreshed since either
2026-09-20 apply. Tooling that derives a boundary from it — the `rpcContracts` mutator inventory and
the pending-set guard's applied-name list — therefore still computes `20260908130000` and still
counts both applied migrations as pending. That errs toward refusing too much, never too little.
Refreshing it needs a live read and is a separate owner-gated action, not done here. The ledger now
says this in one place instead of leaving it implied.

Repository merge does not apply any migration or authorize a live SQL or data change.
