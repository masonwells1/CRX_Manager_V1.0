## 2026-10-09 - ship.md: the landing steps skip Sol for a documentation-only change (Codex review on #888)

The Codex GitHub App's review of PR #888 (P1) found that `.claude/commands/ship.md` named the
documentation-only exception in Step 6 but still required the Sol pass in Step 8 item 4, in the
step sequence and in the "NEVER merge" rule. An agent following `ship.md` would stop for Sol on a
change the merge gates already accept without it. All three places now name the exception. Step 8
says to skip Sol only for a change that qualifies under `docs/reference/sol-exempt-paths.md`, and
to run Sol if the merge gate refuses, since a refusal means the change did not qualify.

### Proof observed

- `node scripts/sync-agent-workflows.mjs --write` made no adapter changes (none mirrors this
  text). `npm run test:agent-workflows` and `npm run agent-health` pass.
