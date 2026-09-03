## 2026-09-03 — GitHub branch cleanup audit lands, with its Codex review and three newly tracked fixes

`docs/audits/2026-09-02-github-branch-cleanup-audit.md` classifies every one of the 43 GitHub
branches that had no open pull request on 2026-09-02: 10 that never had a PR, 27 whose PR closed
unmerged, 6 whose PR merged but the branch survived. It measures each branch's files against `main`
by blob identity (IDENTICAL / ABSENT / BRANCH-ONLY / MAIN-MOVED), checks every local copy for
commits GitHub does not hold, and proposes a 6-branch deletion set gated on Mason's explicit
go-ahead. Nothing was deleted by this change.

A `gpt-5.6-sol` high-effort read-only review returned NOT SAFE on the first draft (1 BLOCKER,
1 HIGH, 5 MEDIUM, 4 LOW). All eleven findings were accepted and corrected in place; the review
outcome is recorded in the document's §9 so each original claim sits beside its correction. The
blocker was the report's own proof standard — it called ABSENT "the only category that can be real
loss" while BRANCH-ONLY edits are equally unlanded — not a defect in code.

**Three code-level gaps are now tracked in `docs/manual/KNOWN_ISSUES.md`** (they were previously
recorded only in the 2026-09-01 disposition plan and on branches 150–690 commits behind `main`):
F1, idempotency keys reset before `assertRpcResult` on ~22 money screens; F2, eight `next_*_number`
generators callable by any authenticated session without an active-profile or role gate; F3, nine
enforcement-file patterns missing from the `.claude/settings.json` `ask` list. None is fixed here;
each is scoped for its own change through its own gate.

Also landing in the same change: the 2026-09-01 closed-PR branch disposition plan (the inventory
behind Mason's 2026-09-02 decision to leave those branches in place, until now cited by `main` as
"not on `main`"), and seven rescued documents — see the sibling
`2026-09-02-rescue-eight-orphaned-audit-documents.md` entry, corrected from eight to seven because
`docs/audits/2026-08-04-pending-doc-updates.md` was deliberately deleted from `main` by PR #331 once
its entries were applied, and restoring it would have undone that cleanup.

### Lessons-to-checks ratchet — why no executable check ships here

The audit names BLOCKER/HIGH findings. Every one of them is a correction to the audit's own prose
and proof standard; nothing in the repository's behaviour was found wrong or changed by this
document. The three code gaps it tracks are deliberately left **open** for their own changes, where
a real test can assert a real fix. Writing a check now would claim a fix that has not landed.
