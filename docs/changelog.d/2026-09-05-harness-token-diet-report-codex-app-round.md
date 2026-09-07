## 2026-09-05 - Review rounds on the harness token diet (PR #613), and the one defect they found

`2026-09-04-harness-token-diet-report.md` went through two exact-SHA `gpt-5.6-sol` rounds via
`scripts/write-codex-push-proof.mjs` and one Codex GitHub App review:

| round | finding | disposition |
|---|---|---|
| Sol 1 | a detached worktree folded on the "detached" label alone, not on proof that `origin/main` contains its head | fixed: fold only on `MERGED into origin/main`; an unknown-state detached worktree keeps its detailed lines |
| Sol 1 | `--denials` could overwrite any path while the script called itself read-only | fixed: refuses an existing file, writes with the exclusive flag, header names the one write exception and why its text is not redacted |
| Sol 2 | hand-made files under `.agents/skills/source-command-*` are classified like the CLI's own output | accepted: the worktree is still named and labelled; cleanup eligibility never reads this classification |
| Codex App (P2) | a STAGED, modified, or deleted file under an import folder was counted as importer litter, so a merged worktree carrying deliberate agent-instruction changes could fold into "no real changes" | fixed: only untracked (`??`) entries are importer dirt; the other statuses are real dirt and un-fold the worktree; pinned for staged, modified, deleted, and staged-plus-modified entries |
| Codex App (P2, second pass) | the usage report kept its own short envelope list, so a `<scheduled-task>` or `<heartbeat>` record — machine envelopes the hooks already recognise — counted as a prompt Mason typed and could become a `--titles` session title | fixed: the report imports `isMachineGenerated` from `.claude/hooks/prompt-source-lib.mjs` (one list, anywhere in the text or as the opening tag) and adds only the desktop app's `<ci-monitor-event>` on top |

| Codex App (P2, third pass) | a peer session's `<cross-session-message>` is deliberately not a machine envelope in the hooks, so the report counted another agent's words as a prompt Mason typed and could show them as a `--titles` session title | fixed: the report runs the hooks' `authoredByMason` stripper (peer blocks, fenced/inline code, quoted lines removed); a record whose authored remainder is empty is not counted, and the title is the remainder |
| CodeRabbit (minor ×2, `CHANGES_REQUESTED` on b1044ba48) | subagent transcripts were opened without the modification-time pre-filter the main transcripts get, so a bounded report parsed historical files and inflated the parse diagnostics; and a refused tool result whose `tool_use` fell before the window start still counted as a denial, so the denial rate's numerator and denominator used different populations | fixed: the same `mtimeMs >= start` pre-filter applies to subagent files; a denial is counted only when its call is in the window, and the skipped results are reported as `unpairedDenials` in the diagnostics line |

Sol rounds 1–4 returned `CODEX_PROOF_VERDICT: CLEAN` (rounds 3 and 4 re-bound the proof after the
App fix and after `main` moved); the App and CodeRabbit findings were each fixed on top of a CLEAN
head and re-proved before the push.
