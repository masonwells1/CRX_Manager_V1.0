## 2026-09-27 — Fewer permission prompts, automatic CodeRabbit review, GitHub-required approval

Mason asked for fewer permission prompts for Claude and Codex, a guaranteed adversarial review, and
much more CodeRabbit use. Decision record: `docs/manual/DECISION_LOG.md`, 2026-09-26 (fewer prompts /
automatic CodeRabbit). Rebuilt on top of the autonomous-landing change (#804) after both touched the
same files; replaces PR #822.

- `.claude/settings.json`: the `ask` tier drops routine guard/tooling edits (186 of Mason's 209
  prompts in two weeks, all approved) and keeps deploys, GitHub/filesystem MCP writers, the two
  settings files, and every file whose uncommitted local edit could change what reaches production
  before PR review (30 files: execution-time hooks in both manifests and every module they load,
  the Codex adapter and `hooks.json`, the proof writers, the private-artifact containment check,
  `.husky/**`, `.github/workflows/**`, and `package.json`, whose npm scripts could hide a merge
  from the command-text guard). `gh pr merge` moves to `allow` (Mason's "No prompt", 2026-09-28).
- New `.claude/hooks/merge-guard-launcher.mjs`: runs `pr-merge-guard.mjs` as a child process and
  denies any call that could merge when the guard crashes, fails to load, exits abnormally, prints
  something that is not a verdict, or is still running at 36 seconds (hook timeout now 45 seconds).
  Without it, a guard that crashed or was killed printed nothing, which allowed the merge without the
  Sol proof (Sol, 2026-09-27). Output other than silence or a real PreToolUse decision counts as a
  failure (Luna). Codex's production guard already denies on a crash; a watchdog for a kill at its
  timeout is a recorded follow-up.
- `scripts/check-agent-guidance.mjs`: derives that production-gate set from the hook manifests and
  the import graph and fails if any file lacks its prompt.
- `scripts/agent-manifest-parity.mjs` and the "wired hooks documented" row of
  `scripts/check-doc-drift.mjs`: read only each manifest's `hooks` block, so `ask` rules that name
  hook files are not mistaken for hook wiring.
- `.coderabbit.yaml`: automatic review of every non-draft PR, on open and on every push, never
  pausing. The workflow test pins the effective `reviews.auto_review` keys and values with a
  strict built-in reader (CI runs that test before `npm ci`, so it cannot load the `yaml` package)
  that fails on quoted or duplicate keys, flow collections, anchors, tags, merge keys, tabs, extra
  documents, and anything that would make the file invalid YAML (CodeRabbit may then ignore it); a
  second test runs 23 such edits on every CI pass. For a head CodeRabbit skipped, agents post
  `@coderabbitai review` once (Mason's "Post", 2026-09-27); the `ready-for-coderabbit` label no
  longer triggers a review. Both merge-gate messages and the guidance say so.
- `scripts/run-claude-review.mjs` stays behind the edit prompt (a proof writer; Sol, 2026-09-27).
- `.codex/config.toml`: the Supabase MCP entry, dead since 2026-08-10, is `enabled = false`.
- Docs: `ship.md`, `AGENTS.md`, the `deploy-check` and `codex-review` skills (+ `.agents/` copies),
  `SAFE_DEVELOPMENT_RULES.md`, `gotchas.md`, `agent-guardrails.md`, `coderabbit-native-review.md`,
  `OWNER_PLAYBOOK.md` (a stuck CodeRabbit means the merge waits; agents re-request a review and
  never touch the protection rule), and the hook landing reminder.
- Outside the repository, on Mason's machine and GitHub: 17 of 24 CRX Codex hooks that Codex had
  been silently skipping were re-trusted; Mason's `~/.claude/settings.json` lost its `gh pr merge`
  prompt; and the `protect-main` ruleset now requires one approving review of the latest push with
  stale approvals dismissed (made in Mason's browser at his request, verified via the API).

**Proof observed:**
- Codex: a shell call ran 3 PreToolUse hooks before the re-trust and 6 after, and `hooks/list`
  reports 24/24 trusted.
- The desktop app log shows prompts firing only for protected gate files.
- CodeRabbit auto-reviewed PR #822 with no label.
- The ruleset API reports `required_approving_review_count: 1` and
  `dismiss_stale_reviews_on_push: true`.
- The CodeRabbit schema check passes (with a negative control).
- `coderabbit-final-review.test.cjs` 253/253, also from a copy with no `node_modules` (where the
  `yaml` version failed as CI did), plus the agent-workflow and guard suites and the parity tests.

**Not verified:**
- No PR has yet merged on a CodeRabbit approval under the new ruleset; #841 is the first.
- That CodeRabbit ignores an invalid `.coderabbit.yaml` and uses its web settings is assumed, not
  tested against CodeRabbit, and which YAML parser CodeRabbit uses is unknown. The only parser run
  against the test's edits was the `yaml` package (YAML 1.2); the U+2028/NEL line-break cases rest
  on the YAML 1.1 rules, not on a run.
- Two recorded gaps stay open: a watchdog for Codex's production guard, and a merge run from an
  npm script (DECISION_LOG 2026-09-26 residuals).
