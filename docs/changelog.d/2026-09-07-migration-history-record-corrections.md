## 2026-09-07 — Migration history corrected: row 916 recorded a LIVE migration as never applied

Documentation only. **No SQL was written, no migration was applied, and no migration file was
edited.** Three record corrections, one of which was materially dangerous.

### 1. Row 916 claimed a live migration was neither applied nor merged (the real find)

`docs/reference/migration-history.md` row 916 (`20260904185900_refuse_null_job_field_acres.sql`)
carried the parked-draft marker, asserted neither merge nor live apply, and closed with
"No live apply or mutation was performed." **All of it was false**, and it had been for two days.

Verified from primary sources, not from any summary:

- **Applied live.** `mcp__supabase__list_migrations` (read-only) returns server-assigned version
  `20260905185938`, name `refuse_null_job_field_acres`.
- **Merged.** `git log --diff-filter=A` on the migration path returns `719faac73`,
  `fix(jobs): guard server-side field acreage (#606)`, merged 2026-09-05T14:12:20Z. The live apply
  therefore followed the merge by roughly 4h47m.

**Why it mattered.** The ledger of record was wrong in the dangerous direction — it *under*-reported
live state. A session reading row 916 would have seen an unapplied candidate and could have applied
it a second time. The applied-migrations snapshot could not have contradicted it either; that
snapshot is stale from 2026-08-27 and was deliberately left alone here (refreshing it is a separate
job with its own verification).

**The mechanism, which is very unlikely to be unique to this row.** A hand apply lands under a
version PostgreSQL/Supabase assigns *at apply time*, not under the file's own stamp. So searching
migration-history for the file's version `20260904185900` finds only the stale row, and searching
for `20260905185938` finds nothing at all — and that absence reads as confirmation the migration was
never applied. It is the same failure shape as the two false greens this branch already hit: **an
empty result set read as a negative result.** Reconcile by NAME against `list_migrations`, never by
the file's own version.

**What was deliberately NOT written.** The approver, the wall-clock apply time, and any post-apply
proof are unrecorded and could not be reconstructed. They are named in the row as missing rather
than filled in with plausible values — a complete-looking false record is worse than an admitted
gap. The server-assigned version is the only apply-time artifact that survived.

**The SQL file was not touched.** Its header still reads `STATUS: NOT APPLIED — DO NOT APPLY`. An
applied migration is immutable under the CRX hard rules, so the correction goes in the ledger — the
same treatment row 827 records for the same reason, and the ledger outranks any file header.

### 2. Row 917 said `NOT MERGED` after PR #614 merged

`20260905090000_next_invoice_number_year_chicago.sql` merged to main 2026-09-07T01:21:34Z as
`336f92e4d`. The row now says so. **`LOCAL CANDIDATE` and `NOT APPLIED` were kept adjacent and
intact on purpose** — 917 is still an unapplied candidate, and
`localCandidateMigrationPathsFromHistory` registers it only on that exact adjacency. Nothing else in
the row changed. `docs/manual/KNOWN_ISSUES.md` was checked and left alone: its heading says
"NOT APPLIED", which is still exactly true.

### 3. Stale line citations in the 2026-09-07 CodeRabbit entry

That entry rejected a finding by pointing at the executable MD5 pins, and cited lines 156-157, 298
and 86-87 — numbers taken from the file *before* the same commit added 22 header lines above them.
The reasoning was unaffected; only the pointers rotted, which is a silent failure since nothing is
false and no guard trips. It matters because the whole value of writing a dismissal down is that
someone can re-verify it without the author, and a rejection pointing at the wrong lines is a
rejection nobody can check.

Rewritten as **stable anchors** (`IF v_md5 NOT IN (`, `IF v_md5 <> '7cbf50dd`) rather than renumbered,
so the pointer cannot rot again. General rule worth carrying: **editing a file to answer a review
finding invalidates the line numbers you cited while answering it** — cite last, or prefer a
distinctive token over a bare line number in anything durable.

### Guard interaction, checked before editing rather than after

Removing the candidate marker from row 916 moves that path out of the registry, which sends it down
the `validateParkedMigrationCrossReferences` branch requiring a history row matching
`APPLIED LIVE|RETIRED CODE-ONLY ARTIFACT|SUPERSEDED` for its basename — so the row must carry the
literal `APPLIED LIVE`, and it does. The old wording is described rather than quoted anywhere in
this repo's history rows, because quoting it verbatim would re-register the path as a parked
candidate and reintroduce the defect being fixed.

### Proof, and one thing the mutation test exposed

The edit was proven against the real `migration-history.md` and the real guard — not fixtures —
across all 905 migration files: the registry parses `known`, row 916's path is no longer registered
as a parked candidate, row 917's still is, and `validateParkedMigrationCrossReferences` returns
`known`. Each assertion was then mutation-tested so it cannot pass vacuously: stripping `APPLIED
LIVE` from row 916 makes the cross-reference refuse with *"parked header has no applied/retired
history record for its migration version"*, and restoring the old adjacency silently re-registers
the path.

**A pre-existing fragility surfaced while mutating, and it is NOT introduced by this change.**
Removing row 917's leading `LOCAL CANDIDATE` marker does **not** de-register it — the row's own
prose explains the registry rule and quotes `LOCAL CANDIDATE` and `NOT APPLIED` verbatim, so the row
satisfies the parser through its own explanation rather than through its status marker. Only
stripping *every* occurrence empties the registry. Two consequences worth knowing before anyone
edits that row: a parked migration can stay registered even after its marker is deleted, and
paraphrasing the explanatory sentence can silently unregister a genuinely parked migration. Filed as
an observation here rather than fixed — changing the parser is a guard change with its own gates.

### What is NOT claimed here

Nothing was applied to the live database and nothing was merged by an agent. The invoice-year fix
recorded at row 917 remains **PARKED**: it is on main, it is not live, and applying it still needs
Mason's explicit approval. Issue #617 (six sibling `next_%_number` generators with the same UTC-year
defect, same 31 December 2026 deadline) stays open.
