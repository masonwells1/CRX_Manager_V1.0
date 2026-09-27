## 2026-09-27 — stop-wrap: a merge from main no longer triggers a false "no ledger" loop

`stop-wrap.mjs` warns when commits landed during a session but no ledger file was touched.
On 2026-09-26 it blocked session end in a loop even though the branch's changelog entry was
already committed. The only commit made after the session-start snapshot was a merge of
`main`, and `git log --name-status` lists no files for a merge commit, so the check saw
"commits, but no ledger".

Fix: a **clean** merge no longer counts as session work. It authors nothing new, and the
merged-in commits carry their own ledger through the pre-commit guard
(`scripts/check-ledger-update.mjs`).

A merge whose result differs from every parent carries edits authored while resolving a
conflict, so it still counts (Codex P2, PR #824). `git diff-tree --cc --name-status` lists
exactly those files, and they join the ledger scan. A file that is new relative to every
parent keeps its "added" status, so a changelog entry written during the resolution counts as
this session's record (Codex P2, PR #827). A session with a real, unrecorded commit is still
warned.

### Proof observed

- New `.claude/hooks/stop-wrap-ledger.test.mjs`, wired into `npm run test:correction-guards`.
  It runs the real hook in a temp git repo with four cases:
  - a clean-merge-only session gets no warning;
  - a merge with a hand-written conflict resolution still warns;
  - a merge whose resolution adds a changelog entry counts as recorded;
  - an unrecorded real commit still warns.
- Forcing every resolution file to "modified" makes the added-entry case fail, which is the
  PR #827 finding.
- Without any fix, the clean-merge case fails with the exact warning from 2026-09-26.
- With only `--no-merges`, the conflict-resolution case fails; this is the gap Codex found.
- With the final fix, all three cases pass.
