# Restore ledger — six merged-PR leftover branches deleted (2026-09-03)

**Status: EXECUTED 2026-09-03 with Mason's explicit in-chat instruction ("don't merge but delete if
you are for sure").** Every branch below is recoverable from its tag on `origin`.

These six are rows 4–9 of the delete list in `docs/audits/2026-09-02-github-branch-cleanup-audit.md`
(§2 there): branches whose pull request **merged** but which were never deleted. They are the only
rows that needed nothing else to happen first — no pending landing, no owner decision. Rows 1–3
(dependent on PRs #576 and #577 merging) and rows 10–11 (owner decisions) were **not** deleted.

## What was verified immediately before each deletion, in this session

- `git ls-remote --heads origin <branch>` returned the same commit the audit measured on 2026-09-02.
- A fresh all-states PR lookup by head branch: each has exactly one PR, and it is MERGED
  (#485, #549, #404, #559, #493, #317). No open PR.
- No registered worktree has the branch checked out; where a local branch exists it is 0 commits
  ahead of the remote.
- Re-measured at `origin/main = b044bf2a4`: zero ABSENT and zero BRANCH-ONLY files on five of the
  six; the sixth (`log-session-attribution-fix`) has exactly one ABSENT file,
  `docs/audits/2026-08-04-pending-doc-updates.md`, which `main` added on 2026-08-04 and
  **deliberately deleted in PR #331 on 2026-08-07**, so it is not lost work.
- Independently, the Codex `gpt-5.6-sol` review recorded in the audit's §9 re-derived all six as
  safe by patch comparison (see its Section 8 answer 1).
- The preservation tag was pushed and read back from `origin` before the branch was removed.

## The table

| Branch | Deleted commit | Tag on `origin` | PR |
|---|---|---|---|
| `claude/jobdetail-savegate-flake` | `60700533eb38ae0c19ce525e523ae71486617c48` | `archive/2026-09-03/jobdetail-savegate-flake` | #485 merged |
| `claude/split-billing-invoice-button-c1e4d6` | `ae044bd9285a30391984d1a144bb9c27ae62324f` | `archive/2026-09-03/split-billing-invoice-button-c1e4d6` | #549 merged |
| `claude/draw-down-price-tier-lines` | `b4c80b37c2a4085b97357ea610c5839a340c8607` | `archive/2026-09-03/draw-down-price-tier-lines` | #404 merged |
| `claude/github-pr-required-review-4d52c9` | `d773c1d1afc7038d0cce8cdba631aaddad664147` | `archive/2026-09-03/github-pr-required-review-4d52c9` | #559 merged |
| `claude/xenodochial-dubinsky-b55362` | `b7e847d98ccd07807fb5c712c5f554911294816b` | `archive/2026-09-03/xenodochial-dubinsky-b55362` | #493 merged |
| `claude/log-session-attribution-fix` | `f9f5e5642b307da349fb1ff3b46c67112c0c1a1b` | `archive/2026-09-03/log-session-attribution-fix` | #317 merged |

## Restoring a branch

Everything needed is in the table: the branch name, the exact commit, and the tag on `origin` that
still holds it. Create a branch at that commit and push it under the old name. As with the
2026-09-01 ledger, this document deliberately carries **no copy-paste command**: a shell procedure
embedded in Markdown is untested code, and the 09-01 rounds found every defect in the recovery
procedure was in exactly such a snippet.

## Mechanism and its known weaknesses (unchanged from 2026-09-01)

Deletion went through the GitHub ref API, one branch at a time, only after the live tip was
re-read and compared to the table. The repository's own guards refuse `--force-with-lease` deletes,
so the check-then-delete is **not atomic**; a commit pushed to one of these branches inside that
interval would be lost, because the tag was cut from the pre-read commit. The residual was accepted
because all six were quiescent: merged PR, no worktree, no local-ahead commits, tips unchanged for
between one and four weeks.

## Sequencing note — and the mistake it records

This ledger was written before the deletions but **not landed on `main` first**; the tags on
`origin` were the preservation, and the ledger reached `main` afterwards through its own PR. That
is the same gap the 2026-09-01 ledger admits, repeated.

It was also nearly stranded. The session that ran the deletions believed PRs #576 and #577 were
still open (its merge attempt had been refused by the agent-side gate for lack of a Codex proof,
and Codex's usage limit was exhausted until 2026-09-06). In fact **Mason had merged both himself in
GitHub** at 03:37Z and 03:38Z — CI was green and neither diff was Codex-worthy — roughly thirty
minutes before this ledger was pushed to the #577 branch. That push therefore recreated a
closed PR's branch with a commit no PR carried: exactly the orphaned-document shape the audit
had spent the night rescuing. The merge-coordination session caught it; the ledger was moved to a
fresh branch off `main` and this PR.

**Lesson, stated once:** on a night with several live sessions, PR state decays in minutes. Re-read
`gh pr view <n> --json state` in the same turn you act on it, never from a snapshot taken earlier
in the session.

Remote branch count after the six deletions: 46 audited branches remain, plus
`backup/pr432-multitarget-20260825` (retained by rule) and this PR's own branch.
