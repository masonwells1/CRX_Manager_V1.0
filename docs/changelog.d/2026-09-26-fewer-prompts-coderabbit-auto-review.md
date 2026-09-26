## 2026-09-26 — Fewer permission prompts, automatic CodeRabbit reviews, Codex hooks re-trusted

Mason asked for fewer permission prompts for Claude and Codex, a guaranteed adversarial review,
and much more CodeRabbit use. Decision record: `docs/manual/DECISION_LOG.md`, 2026-09-26.

- `.claude/settings.json`: the `ask` tier drops the guard-file, CI, `.husky`, `package.json`,
  `.coderabbit.yaml`, `.codex/**` and proof-script entries (186 of Mason's 209 prompts in the prior
  two weeks, all approved). Kept: edge-function and Vercel production deploys, GitHub-MCP writes,
  Desktop Commander / filesystem MCP writers, and edits to the two Claude settings files.
  `gh pr merge` moves to `allow`; `pr-merge-guard.mjs` remains its hard gate. After the exact-SHA
  `gpt-6-sol` review returned HIGH, Mason chose to keep the prompt on the ten files that decide
  what reaches production (the merge, push and migration-apply guards and their libraries, the
  review-proof guard, Codex's production guard and `hooks.json`, and the two proof writers).
  `scripts/agent-manifest-parity.mjs` now reads hook references from each manifest's `hooks` block
  only, so those `ask` rules naming hook libraries are not mistaken for one-sided hook wiring.
  A second Sol pass extended the list to every repository module those gate files load (16 files
  in all, including Codex's `codex-hook-adapter.mjs`), and `scripts/check-agent-guidance.mjs` now
  re-traces that import closure and fails if any file in it lacks its `ask` prompt. A third Sol
  pass added `.husky/**` and the private-artifact containment check the git hooks run (plus its
  helper): an artifact pushed to the public repository cannot be recalled.
  A fifth Luna round added `.github/workflows/**` to the same prompt list (a branch-pushed workflow
  runs with a write `GITHUB_TOKEN` before review), and `pullRequestReviewBlocked()` now also reads
  the review objects, so any reviewer's standing CHANGES_REQUESTED blocks even when
  `reviewDecision` is empty.
- `.coderabbit.yaml`: automatic review on open and on every push, never auto-pausing, drafts
  excluded, summary kept out of the PR body. The `ready-for-coderabbit` label route is retired.
- `.codex/config.toml`: the Supabase MCP entry, whose OAuth grant has been dead since 2026-08-10,
  is `enabled = false` (`codex mcp list` reports it `disabled`).
- `/ship`, `deploy-check`, `codex-review`, `SAFE_DEVELOPMENT_RULES.md`, `AGENTS.md` and the
  hook reminder text: every code change gets at least one `gpt-6-luna` review round; the
  CodeRabbit steps describe automatic review instead of the label route; the pre-merge check is
  now "an undismissed `APPROVED` review from `coderabbitai[bot]` exists for the exact head being merged" instead of the
  retired label workflow's receipt match (Mason confirmed this replacement explicitly).
- `review-proof-guard.mjs`: message and comment text only (no longer points at the removed `ask`
  tier); blocking logic unchanged.
- **Both merge gates now DENY unless `coderabbitai` has an undismissed `APPROVED` review of the
  exact head** (`coderabbitApprovedHead()` in `codex-push-lib.mjs`, used by `pr-merge-guard.mjs`
  and `.codex/hooks/production-action-guard.mjs`; `gh pr view` now requests `reviews`). Read from
  the review objects, not `reviewDecision`; not exempt for `--auto`. Before this it was a stderr
  notice. This closes the third Luna round's two HIGH findings: an agent merging during a window
  in which Mason has the server rule off, and an approval from anyone but CodeRabbit. The fourth
  round's two MEDs are answered in the helper's comment: `coderabbitai` is an Organization account
  that cannot author reviews, and `request_changes_workflow` makes CodeRabbit approve only once its
  comments are resolved.
- Mason's `~/.claude/settings.json`: the `gh pr merge` prompt removed.
- After the `gpt-6-luna` review raised a BLOCKER (a locally edited merge guard plus an unprompted
  merge could land an unreviewed PR), Mason chose to have GitHub require one approving review of
  the latest push again (`protect-main` ruleset, stale approvals dismissed, no bypass actors). The
  guidance, `pr-merge-guard.mjs` messages, `.coderabbit.yaml` comment and `OWNER_PLAYBOOK.md` (how
  to unblock a stuck CodeRabbit) describe that. Mason applies the ruleset change himself BEFORE this
  change merges (a second Luna round flagged the reverse order as a BLOCKER), so this PR is the
  first to need CodeRabbit's approval. The pre-merge check is an undismissed `APPROVED` review from
  `coderabbitai[bot]` at the exact head.
- Mason's machine, outside the repository: 17 of 24 CRX Codex hooks (every Write/Edit content
  guard, the three MCP guards, `production-action-guard`, `review-proof-guard`,
  `hold-latch-guard`, both routers) were silently skipped by Codex because their definitions had
  changed since last trusted. They were re-trusted through the Codex app-server; `~/.codex/config.toml`
  was backed up first and only `hooks.state` lines changed.

**Proof observed:** a Codex `codex exec` probe ran 3 PreToolUse hooks on a shell call before the
re-trust and 6 after; `hooks/list` reports all 24 project hooks `trusted`; feeding sample payloads to
`production-action-guard` returns DENY for `git push --force` and `gh pr merge --admin`. The
desktop app log shows this session raised no permission prompt for its edits to
`.codex/config.toml`, `.claude/hooks/*.mjs` or its second `.coderabbit.yaml` edit after the `ask`
tier change (it raised two for `.claude/settings.json`, which stays on the list). Tests:
`npm run test:agent-workflows` (194 PASS, 0 FAIL) and the pr-merge-guard, prompt-hooks and
review-proof-guard test files.

**Not yet verified:** CodeRabbit's automatic review is proven only once this change's own PR is
reviewed without a label.
