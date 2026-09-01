## 2026-08-31 — The baseline moved again mid-review, and it changed a deletion verdict

`main` advanced to `4436aded` while this PR was awaiting its final review — a second move, after the
`ec90015d` one already recorded. Someone merged `main` into this branch (`370c73b9`), which is how
it surfaced. The report was re-measured against the new baseline.

### What changed, and why it matters more than the first move

The first baseline move changed *file counts* for seven branches. This one changed a **deletion
verdict**.

`4436aded` merged Dependabot PR #520. Its branch,
`dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea`, was listed in this report as **open PR — leave
it alone**. That PR is now merged and its content is on `main`, so the branch holds nothing unique
and is now one of the **mechanically-safe** branches. Safe-to-delete count: **3**, not 2.

Nothing was pushed to that branch. Only the baseline moved.

This is the exact hazard the report's own baseline section warns about, demonstrated live against
the report itself while it was under review. It ran in the harmless direction here — a reader would
have over-protected a branch that no longer needed protecting. The same mechanism runs the other way
just as easily: a branch whose PR *opens* after a scan keeps a stale "no PR" row, and deleting on
that row destroys live work. That is why the report requires a fresh `git ls-remote origin
refs/heads/main` **and** a fresh PR lookup immediately before any deletion, rather than trusting
either column.

Across both baseline moves, no branch's *migration* classification changed. Recorded as luck rather
than as a property of the measure, because nothing in the method guarantees it.

### Proof observed

- Local scan ref after fetching, `git rev-parse origin/main` →
  `4436aded119d1437e43499ee90f394e5092be03f`; the report's pinned baseline now names that commit.
  This is the ref the scan actually ran against; a reader re-checking the baseline must ask the
  server with `git ls-remote origin refs/heads/main` instead.
- Re-scan of all 63 branches against the new baseline: `newMig=12 modMig=4 safe=3`, up from `safe=2`.
- `dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea` moved from the open-PR set to the merged set
  and appears in the "nothing unique" list; PR #520 is the merge commit `4436aded` on `main`.
- The merge commit `370c73b9` was verified not to alter any file this PR authored — the only
  `docs/changelog.d/` change it brings is a new entry from `main`.
- `npm run check:docs` passes.
