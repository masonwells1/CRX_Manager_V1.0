## 2026-08-31 — Recover applied SQL before deleting its source branch

Sixth Codex pass on PR #529, and the first finding rated **P1**. Verified and correct. It lands on
the guidance that would actually drive the branch deletions, so it is the most consequential finding
of the review so far.

### What was wrong

The inventory's review order told the reader that, for a branch holding a migration absent from
`main`, once the migration is established as applied live "the branch can go once recorded in
`docs/reference/migration-history.md`".

That is wrong where the branch holds the **only exact source** of SQL running in production. A prose
ledger entry describes the migration; it does not put the migration back in the repository. Delete
the branch on that basis and production behaviour is absent from `main` — and a cleanup tag does not
close the gap, because a preserved commit object is not the same as `supabase/migrations/`
describing the live database.

### The precedent is already in this repository

`docs/reference/migration-history.md` carries a recovery note for rows 880–885: six migrations
applied to production on 2026-08-12 by concurrent sessions that never landed their files — "no
branch, no worktree and no pull request carried them, so for part of a day `main` did not describe
production and six migrations running against live money could not be reviewed by anyone."

The remedy recorded there is not a ledger entry. It is publishing the exact `apply_migration`
payload **byte-identical** under `supabase/migrations/`: "The files here are **not**
reconstructions. Each is the exact `apply_migration` payload recovered verbatim… **All six are
published byte-identical.**" Fidelity was then proven rather than asserted, by md5-comparing
function bodies extracted from the recovered text against live `pg_proc.prosrc`.

### Fixed

The report now carries a dedicated section, **"If a migration here is applied live, recover the SQL
before deleting the branch"**, placed inside the absent-migration section ahead of the per-branch
filenames. It states that a `migration-history.md` entry is necessary but not sufficient, cites the
rows 880–885 precedent including the byte-identical requirement and the `pg_proc.prosrc` fidelity
proof, and requires the SQL to land in `supabase/migrations/` **before** the branch is released.

The review order was corrected to match: step 2 no longer offers the ledger entry as a sufficient
condition, and points at the recovery rule instead.

### Proof observed

The recovery note and its byte-identical language were read directly from
`docs/reference/migration-history.md` rather than taken from the review comment.
`npm run check:docs` passes.

### Lesson

The previous findings on this file were about measuring the branches correctly. This one was about
what the reader is told to *do* with a correct measurement — a wrong instruction on top of right
data, which is the more dangerous of the two, because the numbers looking sound is exactly what
would carry the instruction through unexamined.
