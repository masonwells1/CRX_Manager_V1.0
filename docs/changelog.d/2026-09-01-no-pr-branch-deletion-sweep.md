## 2026-09-01 — 14 no-PR branches deleted, all recoverable from tags

Remote branch count 58 → 44. Every deleted tip is preserved by a real tag on `origin` under
`archive/2026-09-01/*`; `docs/audits/2026-09-01-no-pr-branch-restore-ledger.md` records each OID and
the restore procedure.

Disposition reasoning is in `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md`, which went
through two `gpt-5.6-sol` review rounds. Round 1 returned NOT SAFE TO EXECUTE AS WRITTEN with 28
findings; round 2 withdrew all four findings the plan had refuted, concurred with every disposition
row, and raised three new issues — one of them a defect introduced by the corrections themselves.

### Verified immediately before deleting, not carried forward from the survey

- All 14 tips unchanged against the 2026-08-31 inventory (PR #529).
- **A fresh all-states lookup across 400 PRs: none of the 14 has ever had a pull request.** This is
  its own check because a branch can acquire an open PR without a single commit being pushed to it.
- None checked out in a registered worktree — and, separately, local branch refs were compared to
  their remotes, because orphaned worktree folders are invisible to `git worktree list`. That found
  one unpushed local commit on `codex/fleet-scan-parked-state`; it is recorded in the ledger and is
  not affected by deleting a remote ref.
- The live migration ledger was re-queried in the same session as the deletion. It confirms the Wave
  A set, the draw-down owner migration, and the Section 1 migration are all absent from
  `supabase_migrations.schema_migrations`, and that only the `20260826220000` successor is applied.

### The two rows worth naming

`claude/restrict-draw-down-owner` was deleted because it is **contradicted by an owner decision**
(`docs/manual/DECISION_LOG.md`, heading `## 2026-08-16 — Any sales rep may draw down any customer's
booking`, "Any rep"), not merely superseded. Its owner-gate
predicate would reverse a settled call. The check that cleared it was semantic rather than a string
match: the live `draw_down_quote` chain has exactly one overload per function, correct ACLs, and **no
`created_by` or assignment predicate anywhere**. Every other protection that migration carried —
`AUTH_REQUIRED`, `ACTOR_MISMATCH`, `INSUFFICIENT_ROLE`, the soft-delete exclusion, `BOOKING_CLOSED` —
was confirmed live first, because the decision entry says removing the owner gate removes *only* the
owner gate.

`claude/rescue-unique-docs-20260807` and `claude/zealous-agnesi-aa7423` were deleted only after their
eleven unique documents landed in PR #542. Preserve first, delete second.

### The force-with-lease plan did not survive contact

The reviewed plan specified `git push --force-with-lease=<ref>:<oid> origin :<branch>` as an atomic
compare-and-swap delete. **The repository's own guards refuse it** — the `.claude/settings.json` deny
list blocks that command form and the Codex production-action guard refuses force-pushes. An owner's
verbal approval does not override a deny rule, and the correct response is not to find a spelling
that gets past it.

What ran instead: per branch, serially, read the current tip with `git ls-remote origin`, compare it
to the ledger, and delete through the GitHub ref API only on an exact match. That is a branch
deletion rather than a history rewrite. It is **not atomic**: there is a sub-second window between
check and delete, and the ledger says so rather than claiming compare-and-swap.

Two weaknesses in that are recorded rather than hidden: reading through `origin` while deleting
through a hardcoded repository path means a differently-configured `origin` could validate one
repository's branch while the API deletes another's, and the comparison was a person reading two
strings rather than a test that aborts.

**There is no corrected script to copy — from the ledger or from here.** The ledger is a prose
record and deliberately carries no copy-paste procedure. Repeating a sweep like this is a deliberate
Claude-session-or-Mason-run operation planned at the time, not a paste; a Codex session cannot run
the deletion at all, because its production-action guard refuses `gh api -X DELETE`.

A commit pushed inside that window **would be lost**. The tag was cut from the pre-read OID and
nothing fetches the newer one locally, so there is no object to recover it from; an earlier draft
claimed otherwise and was corrected. The residual risk was accepted because all 14 branches were
quiescent — no pull request, no registered worktree, every tip matching the inventory — and because
the tags were pushed and verified on `origin` before any deletion. The tag covers every failure mode
except a concurrent push.

Verified after the sweep: zero of the 14 remain, and the tags still resolve on `origin`.

### Still standing, deliberately

`claude/offline-review-stale-snapshot` is checked out at `C:\crx-wt\ledger-gitdir` and is held until
that lane is handed off. `claude/pr364-guard-commits-local-20260831` is protected while a separate
session works PR #364; its "stranded commits" finding was **withdrawn** — `main` is strictly stronger
on that guard and re-applying them would regress it — but the branch has never been enumerated for
incidental value.

The 28 branches whose PRs closed or merged were inventoried separately and then **left in place**:
Mason declined further deletions on 2026-09-02 after review found five of them holding commits that
exist only in local checkouts, which tagging a remote tip does not preserve. That inventory is not on
`main` — it is `docs/audits/2026-09-01-closed-pr-branch-disposition-plan.md` on the unmerged branch
`claude/closed-pr-branch-disposition` — so it is named here as a pointer, not cited as a landed
record.
