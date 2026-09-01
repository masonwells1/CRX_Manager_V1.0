## 2026-08-31 — Third baseline move; the drift rate is itself the finding

`main` advanced again, to `67e6da9d` (PR #526), and was merged into this branch as `167e6b20`. The
merge was verified not to alter any file this PR authored. The report is re-measured against the new
baseline.

### What changed

Headline figures held: 12 branches carrying migrations absent from `main`, 4 modifying an existing
migration, 14 distinct, 3 mechanically safe. No migration classification moved.

What did change is a PR status. `claude/crx-manager-cleanup-5da404` was PR #526, listed as **open —
leave it alone**. It is now merged. It still holds unique content, so it is not newly safe, but the
row's stated *reason* for protecting it no longer applies.

### The rate is the point

`main` moved **three times in the few hours** this report was in review — and a fourth followed,
after this entry was written, which is exactly the behaviour this entry predicts. The report's
own baseline section now states the count as a floor rather than an exact figure, for that
reason. As of this round:

| Baseline | What it changed in the report |
|---|---|
| `ec90015d` | Deleted two workflow files; unique-content figures moved for seven branches that received no pushes. |
| `4436aded` | Merged Dependabot PR #520; a branch flipped from "leave alone" to **mechanically safe**. Safe count 2 → 3. |
| `67e6da9d` | Merged PR #526; a branch flipped from open PR to merged. |

Three moves, three changes, zero pushes to any of the affected branches. On a repository this
active, a branch inventory is a photograph of something in motion — and no amount of re-measuring
fixes that, because the next merge lands while the reader is still reading.

**That is not an argument against the report; it is the argument for the two re-checks it already
requires.** Every classification was correct at its stated baseline. The report now says so plainly
and tells the reader that re-running `git ls-remote origin refs/heads/main` and a fresh PR lookup
*at the moment of deletion* is what makes the staleness stop mattering.

This entry exists so the next person to run a branch cleanup budgets for it: expect the baseline to
move underneath you, and design the procedure around re-verification rather than around a
freshly-generated table.

### Proof observed

- Local scan ref after fetching, `git rev-parse origin/main` →
  `67e6da9d9ab409b65d5bbfd319de69b8783322e8`; the report's pinned baseline names that commit. This
  is the ref the scan actually ran against; a reader re-checking the baseline must ask the server
  with `git ls-remote origin refs/heads/main` instead.
- Re-scan of all 63 branches: `newMig=12 modMig=4 safe=3` — unchanged from the previous baseline.
- `claude/crx-manager-cleanup-5da404` moved from the open-PR set to the merged set; it retains
  `uniqueModified=2`, so it is not in the mechanically-safe list.
- The merge commit `167e6b20` alters no file this PR authored.
- `npm run check:docs` passes.
