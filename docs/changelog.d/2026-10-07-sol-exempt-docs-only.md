## 2026-10-07 - documentation-only pull requests merge without the final Sol review (Mason approved #870)

Mason approved PR #870's proposal ("i appve 870"). This change builds it and supersedes #870. It
touches the agent safety layer, so it went through the full review path, including Sol, and **Mason
merges it by hand**. That hand-merge is what adopts the rule; no agent merges it.

- **The rule.** A pull request whose every changed file is documentation, as listed in
  `docs/reference/sol-exempt-paths.md`, may merge into `main` without the exact-SHA Sol proof. It
  still needs CodeRabbit APPROVED on the exact head, every check green, the `--match-head-commit`
  pin and a head that contains its base. `AGENTS.md`'s Sol sentence now names the exception.
- **One shared module.** `.claude/hooks/sol-exempt-lib.mjs` holds the lists and asks GitHub's
  compare API which files `base...head` changes. Both merge guards call it, and only when no
  valid Sol proof was found: `pr-merge-guard.mjs` with its budgeted `gh`, and the Codex
  `production-action-guard.mjs`, which excuses only its "Sol proof missing" denial.
- **Allow-list, fail closed.** Only `.md` files under eight `docs/` folders qualify. Sol is still
  required for a failed or odd GitHub answer, a comparison that is not exactly base..head, 250 or
  more files, an empty list, a rename or copy from a non-exempt name, and odd path spellings.
- **Plain files only (Luna round 1).** GitHub's comparison names files but not their kind. So a
  second lookup (one GraphQL query) checks that every changed path is a plain file: added and kept
  files at the head, deleted files and old names at the base (Luna round 2). A symlink, submodule
  or executable named `x.md` needs Sol. The comparison must also end at the head, and each change
  status must be a plain edit.
- **Reviewer disagreement, left for Mason.** Luna round 2 rated it a BLOCKER that
  `docs/manual/DECISION_LOG.md` stays eligible. It is kept eligible because Mason's approved list
  includes `docs/manual/` with only `OWNER_PLAYBOOK.md` excluded, and a log entry cannot open any
  gate. `docs/reference/sol-exempt-paths.md` now says exactly which documents count as
  rule-defining.
- **Luna's base-move finding refuted with live evidence.** It said the base could move after the
  check. `main`'s branch protection has `strict: true` (up-to-date branches required), read
  2026-10-08. A pull request whose base moved is therefore out of date, and GitHub refuses the merge.
- **Stricter than the proposal.** Only `.md` files qualify (`docs/audits/` holds `.mjs` workflow
  scripts and draft `.sql`). `claude-model-tuning.md`, `sol-exempt-paths.md` and
  `migration-history.md` stay excluded. A nested `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`AGENT.md` (agents load these
  as folder instructions) or a package file needs Sol in any folder. Matching ignores case.
- **Protected.** The module joined the Codex guard's protected-file list and the
  `.claude/settings.json` `ask` tier, like the other merge-guard libraries.
- Updated `docs/reference/agent-guardrails.md`, `docs/manual/DECISION_LOG.md`, `.claude/commands/ship.md`
  and the proposal's status (`docs/plans/2026-10-02-sol-skip-for-low-risk-changes.md`, brought over
  from #870).

### Proof observed

- `node .claude/hooks/sol-exempt-lib.test.mjs` passes 173 assertions. A docs-only pull request is
  exempt. Adding any never-eligible file brings Sol back, including a hook, a migration, a `src/`
  file, `package.json`, a `docs/workflows/` file and a nested `CLAUDE.md`. So do renames, unreadable
  answers, truncated lists, symlinks, submodules, executables, odd statuses and a comparison for
  another head. The readable doc and the module list exactly the same paths. Each of 48
  deliberately loosened copies of the module fails the contract: a wider allow-list, a dropped
  never entry, any file type, case-sensitive matching, ignored old names, no truncation limit, and
  unchecked comparison, status, file kind or head.
- `production-action-guard.test.mjs` drives the Codex guard on a real temporary repository. A
  merge-ready docs-only PR with no proof is allowed. A hook, migration, `src/`, `package.json`,
  `docs/workflows/`, `AGENTS.md` or nested `CLAUDE.md` file, a rename from a hook, a symlink or
  submodule named like a docs file, a failed compare call, a 300-file list, a comparison for another
  head or a behind head each bring Sol back. A missing CodeRabbit approval, a red
  check, a missing pin, `--auto` or a head without its base are still refused by their own gates.
  Changing the wiring to "always exempt" or "never exempt" makes it fail (checked by hand).
- **Real guard, real PRs (decision only, no merge).** The actual `pr-merge-guard.mjs` on PR #874
  (hook files, CodeRabbit APPROVED, CLEAN) denied: "the documentation-only exemption does not apply:
  .claude/hooks/bash-safety-lib.mjs is never exempt". On PR #870 (docs only, not yet approved) it
  denied at the CodeRabbit gate. The module against GitHub's real file lists returned EXEMPT for
  #870 and #861 (docs only) and SOL REQUIRED for #874, #882 and #827 (hook files).
- `npm run test:correction-guards`, `npm run test:agent-workflows`, `npm run agent-health`,
  `npm run lint` and `npm run build` pass.

### Not verified

- The Claude-side guard cannot be driven end to end in tests on Windows (a fake `gh` cannot be
  spawned), so its wiring is pinned at source level. Its behaviour is proven by the shared module's
  tests, the Codex guard's end-to-end tests and the real-PR runs above.
