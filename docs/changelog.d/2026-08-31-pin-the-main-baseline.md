## 2026-08-31 — Pin the `main` baseline; two workflows this PR documented were deleted underneath it

`main` advanced to `ec90015d` while PR #529 was awaiting its final review. Both new commits landed
directly on top of claims this PR makes, and merging the base in without re-checking would have
shipped a documentation cleanup that was wrong on the day it merged.

### `DEPLOYMENT.md` named four workflows; two no longer exist

`ec90015d` (#525) retired the production migration approval gate and deleted
`.github/workflows/production-migration.yml` and `production-approval-canary.yml`. This PR's whole
purpose was replacing a fictional workflow section with the real one — and the real one had just
changed. The table now lists the two surviving workflows and records the removal explicitly, so a
reader who remembers the other two learns they were retired rather than assuming the doc is stale.

The rest of the section re-verified against the merged tree and still holds: `e2e-smoke` is still
pinned `if: false` at `ci.yml:498`, `npm run check:docs` still runs at `ci.yml:379`, and all six
job names are unchanged.

### The branch inventory pinned every branch tip but not the baseline

The previous round added tip OIDs for all 63 branches after CodeRabbit pointed out that a branch
name is not a fixed reference. That fix was half of the problem. Every figure in the report is a
comparison *against `main`*, and `main` moves too — so the report could go stale without a single
branch being touched.

That is not hypothetical; it happened immediately. Re-measuring against `ec90015d` moved every
branch's *Behind* count and changed the unique-content figures for seven branches that received no
pushes at all. The clearest case: both `dependabot/github_actions/*` branches bump an action
version inside the two deleted workflow files, so what was a modification of a file `main` had has
become the addition of a file that `main` lacks.

The report now states the baseline OID in its own section and tells the reader to confirm it with
`git ls-remote origin refs/heads/main` — the server, not a bare `git rev-parse origin/main`, which
reads the local remote-tracking ref and returns a stale OID in an unfetched checkout — before
acting on any count. The migration classifications and the two
mechanically-safe branches were unaffected, so the headline findings stand: 12 branches carrying
migrations absent from `main`, 4 modifying an existing migration, 14 distinct, 2 safe to delete.

### A "not verified" note that is no longer true

This PR recorded that the schema registry was behind 6 migrations. `5258b0f2` (#531) refreshed it
to high-water `20260827113443`; no migration on disk is newer. The entry now says the finding was
real when made and has since been closed, rather than leaving a resolved gap reading as open.

### Proof observed

- `.github/workflows/` contains exactly `ci.yml` and `phase3-private-artifact-containment.yml`
  after the merge.
- `if: false` at `.github/workflows/ci.yml:498`; `npm run check:docs` at `:379`.
- No migration filename sorts above the registry's `migrations_high_water` of `20260827113443`.
- The 63-branch scan was re-run against `origin/main` at `ec90015d` and diffed row-by-row against
  the previous run; the seven changed branches were identified from that diff, and the two
  Dependabot cases confirmed with `git diff --name-only origin/main <branch> -- .github/`.
- `npm run check:docs` passes.
