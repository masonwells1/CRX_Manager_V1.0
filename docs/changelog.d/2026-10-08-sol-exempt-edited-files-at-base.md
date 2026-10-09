## 2026-10-08 - Sol exemption: an edited file is kind-checked at the base too (Luna round 5)

Luna's fifth review of the documentation-only Sol exemption found a BLOCKER. The file-kind lookup
checked an edited file only at the head. So a pull request could take an executable (or a
symlink or submodule) named like a docs file, such as `docs/audits/check.md`, turn it into a plain
file, and still skip Sol, because the head shows a plain file. Deleted files and old names were
already checked at the base (round 2); edited files now are too. An added file is still looked for
only at the head, where it exists.

- `.claude/hooks/sol-exempt-lib.mjs`: an edited (`modified`) file is looked up at the base as
  well as the head. Both must be plain files.
- Luna's LOW finding: the proposal's status line said "matching ignores case". Only the
  never-eligible lists ignore case; the eligible folders must match exactly. The proposal,
  `docs/reference/agent-guardrails.md` and the main changelog entry now say so.

### Proof observed

- `node .claude/hooks/sol-exempt-lib.test.mjs` passes 182 assertions with 51 mutants caught. New
  cases: an edit that removes the executable bit, or turns a symlink or submodule into a plain
  file, needs Sol; so does an edited file GitHub cannot show at the base, and an edit that adds
  the executable bit. Editing a plain docs file stays exempt, and an added file is not looked for
  at the base. The new mutant "edited files not kind-checked at the base" puts back the old
  behaviour, and the tests catch it.
- `node .codex/hooks/production-action-guard.test.mjs` passes, including a new end-to-end case: a
  merge-ready docs PR whose edit removed an executable bit is refused with "not a plain file at
  the base".
