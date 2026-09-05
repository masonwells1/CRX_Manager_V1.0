## 2026-09-05 - Review rounds on the harness token diet (PR #613), and the one defect they found

`2026-09-04-harness-token-diet-report.md` went through two exact-SHA `gpt-5.6-sol` rounds via
`scripts/write-codex-push-proof.mjs` and one Codex GitHub App review:

| round | finding | disposition |
|---|---|---|
| Sol 1 | a detached worktree folded on the "detached" label alone, not on proof that `origin/main` contains its head | fixed: fold only on `MERGED into origin/main`; an unknown-state detached worktree keeps its detailed lines |
| Sol 1 | `--denials` could overwrite any path while the script called itself read-only | fixed: refuses an existing file, writes with the exclusive flag, header names the one write exception and why its text is not redacted |
| Sol 2 | hand-made files under `.agents/skills/source-command-*` are classified like the CLI's own output | accepted: the worktree is still named and labelled; cleanup eligibility never reads this classification |
| Codex App (P2) | a STAGED, modified, or deleted file under an import folder was counted as importer litter, so a merged worktree carrying deliberate agent-instruction changes could fold into "no real changes" | fixed: only untracked (`??`) entries are importer dirt; the other statuses are real dirt and un-fold the worktree; pinned for `A `, ` M`, ` D`, and `AM` |

Both Sol rounds returned `CODEX_PROOF_VERDICT: CLEAN`; the App finding was fixed on top of the
second CLEAN head and re-proved before the push.
