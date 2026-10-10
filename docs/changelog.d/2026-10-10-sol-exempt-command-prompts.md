## 2026-10-10 - Sol exemption: commands' canonical prompt files always need Sol; reminder wording (CodeRabbit and Codex on #888)

**Codex GitHub App (P1).** `/architecture-weakness-audit`, `/foundation-ultra-review` and
`/map-drift-audit` each say their "full, canonical instructions" live in a
`docs/audits/*-prompt.md` file that agents must execute exactly. Those files sat in an eligible
folder, so a PR could change what those commands do without Sol.

- All three join the never-eligible list in `.claude/hooks/sol-exempt-lib.mjs` and
  `docs/reference/sol-exempt-paths.md`. The proposal and `DECISION_LOG.md` name them.
- A new test scans every `.claude/commands/*.md` for "canonical instructions live in" a docs file
  and fails if that file is eligible, so a future command's prompt file cannot slip through.
- Not changed: the gauntlet index (`docs/audits/gauntlet/live-foundation-gauntlet-index.md`). It
  is the progress record every gauntlet run updates, and the runner's sections are encoded in
  code, so making it need Sol would put Sol on every progress note.

**CodeRabbit (3 Minor).** The three injected reminders read "a documentation-only change,
docs/reference/sol-exempt-paths.md", which could be read as calling the policy page itself
exempt. They now say "as defined in docs/reference/sol-exempt-paths.md": the LANDING POLICY in
`prompt-source-lib.mjs`, `session-context-reminder.mjs` and `autopilot-intent-reminder.mjs`. The
two tests that pin the wording were updated.

### Proof observed

- `node .claude/hooks/sol-exempt-lib.test.mjs` passes 207 assertions with 58 mutants caught; the
  scan finds the three commands and each prompt file needs Sol.
- `node .claude/hooks/prompt-hooks.test.mjs` (626 assertions) and
  `node .claude/hooks/session-context-reminder.test.mjs` pass.
