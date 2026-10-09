# Sol-exempt paths: documentation-only merges

**Rule (Mason, 2026-10-07):** a pull request whose every changed file is plain
documentation, as defined below, may merge into `main` without the final Sol review.
It still needs CodeRabbit APPROVED on the exact head and every required check green.
The head must still be pinned with `--match-head-commit` and contain its base. Every
other change still needs the fresh exact-SHA Sol review, run last (`AGENTS.md`,
"Safety and Protected Delivery").

The merge guards enforce this in code. Both `.claude/hooks/pr-merge-guard.mjs` and
`.codex/hooks/production-action-guard.mjs` call `.claude/hooks/sol-exempt-lib.mjs`.
That module is the source of truth. This page is its readable copy, and
`.claude/hooks/sol-exempt-lib.test.mjs` fails if the two disagree. To change the lists,
change both in one pull request. That pull request touches `.claude/`, so it needs Sol.

## How a pull request qualifies

The guard asks GitHub's compare API for the files `base...head` changes, where `base`
is the commit GitHub will merge onto. The exemption applies only when:

1. GitHub's answer is readable and is exactly the base-to-head diff. The head is ahead
   of the base, not behind it; the comparison starts at the base; and its newest commit
   is the head;
2. the list holds at least one file and fewer than 250. GitHub stops listing at 300
   without saying so, so a longer list may be incomplete;
3. every change is a plain `added`, `modified`, `removed`, `renamed` or `copied`. GitHub's
   `changed` means a file's kind changed;
4. every changed file, and the old name of every renamed or copied file, is a plainly
   named `.md` file under an eligible folder;
5. none of those names matches a never-eligible path or name; and
6. a second GitHub lookup (GraphQL, one query) confirms that every changed path is a plain
   file (git mode `100644`) where it exists. Added and kept files are checked at the exact
   head; deleted and edited files, and the old names of renames and copies, are checked at
   the base. A symlink, a submodule or an executable named `notes.md` is not documentation,
   and the comparison alone cannot tell them apart. Checking an edited file at the base
   means turning one of them into a plain file still needs Sol.

**What "rule-defining documents" means here.** The rule-defining documents are the ones
listed under "Never eligible" below: `AGENTS.md`, `CLAUDE.md`, `docs/workflows/`, the
guardrails and model-tuning references, the owner playbook and this page. The other
`docs/manual/` files, including `DECISION_LOG.md`, `KNOWN_ISSUES.md` and `CURRENT_STATE.md`,
stay eligible because Mason approved `docs/manual/` with only `OWNER_PLAYBOOK.md` excluded.
When Luna twice asked for `DECISION_LOG.md` to always need Sol, Mason chose to keep it
eligible ("keep it", 2026-10-09). A
decision-log entry records a decision; it cannot open a gate. Approval for a gated action
comes only from Mason in the current conversation, and the guards enforce the gates in code.

Anything else, including a failed GitHub call, means the Sol review is required.

## Eligible folders

Only `.md` files in these folders qualify. The match is case-sensitive, from the
repository root. Other file types in them (scripts, SQL drafts, JSON) still need Sol.

<!-- sol-exempt:eligible -->
- `docs/changelog.d/`
- `docs/manual/`
- `docs/reference/`
- `docs/plans/`
- `docs/reports/`
- `docs/audits/`
- `docs/handoffs/`
- `docs/research/`
<!-- /sol-exempt:eligible -->

## Never eligible: paths

A folder (ending in `/`) or one exact file, from the repository root. The match ignores
case, because Windows treats `docs/Reference/Agent-Guardrails.md` as the same file.

<!-- sol-exempt:never-paths -->
- `src/`
- `supabase/`
- `scripts/`
- `.github/`
- `.claude/`
- `.codex/`
- `.agents/`
- `.husky/`
- `.coderabbit.yaml`
- `docs/workflows/`
- `docs/manual/OWNER_PLAYBOOK.md`
- `docs/reference/agent-guardrails.md`
- `docs/reference/codex-model-tuning.md`
- `docs/reference/claude-model-tuning.md`
- `docs/reference/sol-exempt-paths.md`
- `docs/reference/migration-history.md`
<!-- /sol-exempt:never-paths -->

The last three go beyond the approved proposal, and each is stricter:

- `claude-model-tuning.md` sets reviewer models and prompts, as `codex-model-tuning.md` does.
- `sol-exempt-paths.md` is this page, the rule's own definition.
- `migration-history.md` is a ledger that hooks and the migration review packet read,
  not only prose.

## Never eligible: file names anywhere

These names need Sol in any folder. The match ignores case. Claude Code and Codex both
load a nested `CLAUDE.md` or `AGENTS.md` as instructions for its folder, so
`docs/plans/CLAUDE.md` is agent configuration, not documentation. `GEMINI.md` and `AGENT.md` are
the same kind of file for other agents.

<!-- sol-exempt:never-names -->
- `AGENTS.md`
- `AGENTS.override.md`
- `AGENT.md`
- `CLAUDE.md`
- `CLAUDE.local.md`
- `GEMINI.md`
- `package.json`
- `package-lock.json`
- `npm-shrinkwrap.json`
- `yarn.lock`
- `pnpm-lock.yaml`
- `bun.lockb`
<!-- /sol-exempt:never-names -->

## Why the agent safety files stay excluded

The hooks under `.claude/hooks/` decide whether the other checks run at all. A hook
change that slips through review can switch off protection for every later change, so
those files need the strongest review. A change to this rule touches
`.claude/hooks/sol-exempt-lib.mjs`, so it can never use the exemption it defines.
