## 2026-09-10 — PR #646: the applied migration is byte-exact again, and a wrong rejection corrected

`20260908120000_close_pr535_live_gaps.sql` was applied live on 2026-09-08. Afterward its header
comments were edited to narrate that fact. This entry records why that was wrong, how it was
proved, and what was restored.

### The defect

An applied migration must not change, comments included. `scripts/apply-migration-file.mjs`
transmits the LF-normalized file, records `sha256` of exactly those bytes as the `queryHash` the
reviewer proofs bind to, and stores the same SQL in the live ledger row
(`supabase_migrations.schema_migrations.statements[1]`). Editing the header afterward left three
different artifacts: the applied bytes `f64aff27…`, the committed file `010457…`, and after a
further docs commit `6b5362…`. The committed file could no longer prove which bytes ran.

Production was never affected. The installed function is exactly what was reviewed and proofed;
this was a repository audit-trail defect only.

### A rejected finding that was valid

Codex raised this as **P1** on PR #646. CodeRabbit raised the same point and asked for the changes
to the applied migration to be reverted. **That rejection, on 2026-09-09, was wrong.** The rebuttal
proved that `md5(pg_proc.prosrc)` of the installed function matched the committed file — a narrower
object than the one the finding named. The function body did match. The file did not.

The half of CodeRabbit's finding that remains declined is its scope: it asked that the executable
assertions be reverted too. Those were added *before* the apply and are part of the transmitted
bytes, so removing them would recreate the same mismatch in the other direction.

### What was restored, and the proof

The exact applied bytes were recovered from git — the original parked header from `914a6d36a`
followed by the body from `d933555c2` — and verified two independent ways before anything was
committed:

| Check | Value |
|---|---|
| LF `sha256` of restored file | `f64aff271eb8ea830f91ca89d0578b37bba9f18ae6416d3f554b4ad2462cb769` |
| Recorded apply `queryHash` | identical |
| `md5` of restored file | `7f080ba8bad57642300223fac1e2cba8` |
| `md5(statements[1])` of ledger version `20260909023300` | identical, 20875 characters |
| Executable-SQL diff, restored vs. previous branch head | empty — the drift was entirely comment prose |

The ledger text was read read-only on 2026-09-10. `sha256()` is refused inside the database by the
live-data guard, so the comparison used `md5` server-side and `sha256` locally.

### Why the file still says PARKED

The restored header opens `-- PARKED - NOT APPLIED LIVE`, which reads oddly for a migration that is
live. That is the intended shape: applied status belongs to
`docs/reference/migration-history.md` row 923, and `validateParkedMigrationCrossReferences` in
`.claude/hooks/worktree-awareness-lib.mjs` accepts a parked header exactly when its history row
records APPLIED LIVE. Row 923 now also carries the byte-exactness proof.

One consequence: the note recording CodeRabbit's `has_function_privilege` / `pg_roles`
AND-ordering hazard could not stay in the migration, since the file cannot change. The hazard is
real but unfixable in place — that code sits in a `DO` block which ran once during the apply and
installed nothing, both roles exist on this database so it did not misfire, and a replay is already
refused by the md5 precondition. It is recorded here instead.

### Still owed, unchanged

The seven `20260905*` migrations remain mechanically unappliable and need their own restamp.
