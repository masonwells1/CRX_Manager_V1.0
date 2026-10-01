## 2026-09-30 — CodeRabbit review of PR #836: four documentation fixes

CodeRabbit's review of `8205630c` requested changes. All four findings were checked against the files
and were valid, and all four are fixed:

- `docs/reference/coderabbit-native-review.md`: the fix loop ran the exact-SHA Sol proof *before*
  applying `ready-for-coderabbit`, which contradicts the landing rule (Sol runs **last**, after
  CodeRabbit clears the head) and could leave an expired proof after the review wait. The loop now
  runs Sol after clearance, then the migration apply, then the merge.
- `docs/reference/gotchas.md`: the merge-evidence rule still required the APPROVED review's
  `commit_id` to equal the live head, which would reject every follow-up clearance. That match now
  applies only to exact-head approval; a follow-up requires CodeRabbit's authenticated `Review
  completed` status on the live head plus the reference's other evidence.
- `docs/changelog.d/2026-09-29-defer-to-826-hand-back-fix.md` and
  `docs/changelog.d/2026-09-30-audit-brace-expansion-fast-uri.md`: each now states what was not
  verified.

No other live command, skill, workflow or reference doc put the **final** Sol proof before the
CodeRabbit request; the final proof always runs after CodeRabbit clears the head. The `codex-review`
skill's early *advisory* Sol round for genuinely complex work is a different thing: it mints no
proof and is unaffected. This change is documentation only, with no gate logic changed.

**Proof.** `npm run test:agent-workflows` and `npm run lint` pass.
**Not verified:** no Codex Luna round or Sol proof has run on these edits, and the reordered fix
loop has not yet been followed end to end on a real landing.

Follow-up (CodeRabbit's re-review of `53d14569`): `docs/reference/gotchas.md` and the landing line in `.claude/commands/ship.md` said the follow-up
needs "nothing posted since" the approval, which is stricter than the gate. It now says "no later
substantive CodeRabbit content", with the empty `COMMENTED` reply artifact named as tolerated,
matching `standingCodeRabbitApproval()`.
