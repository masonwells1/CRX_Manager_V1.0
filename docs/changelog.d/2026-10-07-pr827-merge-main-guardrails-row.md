## 2026-10-07 — PR #827: merge main after #841–#887

`main` moved on after CodeRabbit approved #827 at `48cafb5`. Merging it conflicted on one
table in `docs/reference/agent-guardrails.md` (SessionStart hooks): `main` rewrote the
`session-context-reminder.mjs` row for the 2026-10-03 plan-then-proceed rule, and #827
extends the `session-snapshot.mjs` row with the reflog anchor. The resolution keeps
`main`'s `session-context-reminder.mjs` row and #827's `session-snapshot.mjs` row.
`package.json` merged automatically; its `test:correction-guards` line still differs from
`main` only by `.claude/hooks/stop-wrap-ledger.test.mjs`. The branch's earlier carries of
`main` fixes (dependency audit bumps, the field-application season-date test) now match
`main` exactly and no longer appear in the PR's diff.

### Proof observed

- `node .claude/hooks/stop-wrap-ledger.test.mjs`: 20 assertions pass.
- `npm run test:correction-guards`, `npm run lint` and `npm run build` pass on the merge.
- Throwaway repositories driven through the real `session-snapshot.mjs` and `stop-wrap.mjs`:
  a session whose only commit is a clean merge of `main` is blocked with "Commits exist this
  session but no ledger file was touched" by `main`'s hook and allowed by #827's; a session
  with a hand edit and no ledger entry, and one with a hand-resolved merge conflict and no
  ledger entry, are still blocked by both.
