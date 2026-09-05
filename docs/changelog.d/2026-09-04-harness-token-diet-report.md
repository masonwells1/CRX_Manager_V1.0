## 2026-09-04 - Shrink the session-start worktree report, state the landing policy once per prompt, add the Claude usage report

**Why.** A timestamp-bounded read of the last 14 days of Claude transcripts (2026-08-21 to
2026-09-04, deduplicated by API response, subagents included) showed 44,759 model calls carrying an
average of ~315K tokens of context each; weighted at Anthropic's standard price ratios, about 80% of
spend is context being re-sent on every call. Two fixed pieces of that context were pure repetition:

- the SessionStart worktree report had grown to ~22KB with 74 worktrees — two lines per worktree
  plus one "PARKED STATE UNKNOWN" clause per worktree, 55 of them word-for-word identical;
- the two per-prompt reminders (gauntlet, ship-intent) each embed the same ~1.2KB `PUSH_POLICY`
  paragraph, and one prompt frequently trips both.

An independent adversarial review of the audit by Codex `gpt-6-astra` (high reasoning) required
that any compaction keep every actionable signal visible and that nothing change deletion
eligibility. This change does presentation only.

**What changed.**

- `.claude/hooks/worktree-awareness-lib.mjs` + `worktree-awareness.mjs`: every worktree that is
  not provably finished — unmerged, merge-state unknown, unreadable, or carrying real uncommitted
  changes — keeps its full two-line entry, unchanged wording. Worktrees that `origin/main` provably
  contains, with no real changes, fold into ONE counted line that still names each of them; a
  detached worktree whose merge state is unknown keeps its detailed lines. UNTRACKED files in the
  Codex CLI `/import` folders (`.agents/skills/source-command-*/`) are recognised by region and
  LABELLED ("24 dirty files (all Codex-import skill dirs)"), never dropped; a staged, modified, or
  deleted file under that folder is real dirt (Codex App review of PR #613). The "PARKED STATE
  UNKNOWN" tail lists each distinct reason once with the worktrees that share it. The cleanup hook
  and its classifier are untouched: nothing becomes deletable that was not deletable before.
- `.claude/hooks/hook-router-runtime.mjs` + `prompt-router.mjs`: `runHookRouter` accepts
  `dedupeBlocks`; the prompt router passes `PUSH_POLICY`, so when two reminders fire in one turn
  the second carries "LANDING POLICY: as stated above (unchanged)." instead of the full paragraph.
  A single reminder is unchanged. The Codex adapter invokes the same router, so both surfaces
  benefit.
- `scripts/claude-usage-report.mjs` (new, read-only): the analyzer behind the audit, repaired per
  the Astra review — events filtered by their own timestamp inside an explicit window, one usage
  record per API response, tool calls deduplicated by id, synthetic records excluded, human prompts
  separated from machine envelopes, parse diagnostics printed. It reads local transcripts only and
  prints no prompt text unless `--titles` is passed. `docs/manual/OWNER_PLAYBOOK.md` tells Mason
  how to ask for it. Not scheduled: Astra's condition was one validated reporting cycle first.

**Proof.** `node .claude/hooks/worktree-awareness-lib.test.mjs`, `node .claude/hooks/hook-router.test.mjs`,
`npm run test:agent-workflows`, and the live hook run against this checkout's 74 sibling worktrees
(report size before/after recorded in the PR).

**Deferred, with reasons.** Adding `model:`/`effort:` frontmatter to the read-only report commands
(`status`, `fleet`, `parked`) is supported by Claude Code but those command files have no frontmatter
today and the Codex adapter generator reads their first line as the description, so it needs a
generator change first. Disabling the marketing/product-management/PDF plugins is a desktop-app
setting Mason changes himself. Letting cleanup ignore the Codex-import folders is a deletion-eligibility
change and is presented to Mason as a separate decision with counts.
