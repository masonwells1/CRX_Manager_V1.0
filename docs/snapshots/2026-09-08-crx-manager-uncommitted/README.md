# Snapshot — the uncommitted working tree of `C:/CRX_Manager`, 2026-09-08

**This is an archive, not source.** Every file here has `.txt` appended to its original
repository-relative path. To restore one, drop the `.txt`:

```
docs/snapshots/2026-09-08-crx-manager-uncommitted/src/lib/fieldAppPreviewSeasonContract.test.ts.txt
                                              -> src/lib/fieldAppPreviewSeasonContract.test.ts
```

## Why it exists

On 2026-09-08 the shared checkout `C:/CRX_Manager` (on `main` at `96fa0b424`) was carrying 16
uncommitted files that existed **on no branch, local or remote, and nowhere else on disk**.
`git log --all` returned zero commits touching five of them. A `git clean` or a hard reset of
that folder would have destroyed them permanently. This branch is the off-machine copy.

## Why `.txt` rather than the real paths

The snapshot is a **mid-merge state that was abandoned**: no `MERGE_HEAD` or `REBASE_HEAD`
exists, but five files still contain `<<<<<<< ours` / `>>>>>>> theirs` markers —
`.gitattributes`, `docs/manual/DECISION_LOG.md`, `docs/manual/KNOWN_ISSUES.md`,
`docs/reference/migration-history.md` and `src/pages/FieldApplicationInvoice.tsx`.

An earlier attempt to push these at their real paths was **correctly refused by the pre-push
type check** (`error TS1185: Merge conflict marker encountered`, three times in
`FieldApplicationInvoice.tsx`). That guard was right, and it was not bypassed. Archiving under
`docs/` with a `.txt` suffix preserves the bytes without presenting broken code as source.

## What is genuinely unique here, and what is superseded

**Superseded** — the `#599` preview-season work. Branch `codex/pr599-reconcile-20260908`
(worktree `C:/CRX_pr599`) carries a larger, reviewed successor migration,
`20260906120000_preview_field_app_season_follows_invoice_date.sql` (51 KB vs. the 17 KB draft
here, applied live per commit `542bd84a3`), and already wires `p_invoice_date` through
`FieldApplicationInvoice.tsx`. The draft here is an earlier attempt, not the live change.

**Unique — on no other branch at the time of writing:**

- `src/lib/fieldAppPreviewSeasonContract.test.ts`
- `scripts/smoke/smoke-preview-field-app-season-parity.sql`
- `docs/changelog.d/2026-09-04-field-app-preview-season-parity.md`
- `docs/handoffs/2026-09-04-pr584-consolidate-scope-resume.md`

## Ownership note

`.claude/hooks/guards.test.mjs` and `.claude/hooks/live-testdata-lib.mjs` belonged to another
live session (last written 06:52:55Z and 06:54:20Z that morning). They are copied here read-only
so a `git clean` cannot destroy them. **Ownership stays with that session** — do not treat this
archive as the authoritative version of either file.

`C:/CRX_Manager` itself was not modified: it stayed on `main` at `96fa0b424` with all 16 files
still dirty in place. Every file was copied and byte-compared against its source; the only
difference between the committed blobs and the on-disk originals is git's usual line-ending
normalization, and a checkout reproduces all 16 byte-identically.
