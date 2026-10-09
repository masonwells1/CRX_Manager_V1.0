## 2026-10-09 - Sol exemption: the repository placeholders are pinned (Sol review on #888)

Sol's review of PR #888 (head `27511df8d`) raised one HIGH. It said that when `gh pr merge` names
no `--repo`, the file-kind lookup sends GitHub the literal text `{owner}` and `{repo}`, so a real
docs-only PR would still need Sol. Sol noted that this fails closed.

**Refuted live.** `gh api --help` says gh fills `{owner}`, `{repo}` and `{branch}` in typed `-F`
fields from the current repository, and the module sends both as `-F`. Run with real GitHub
calls and no `--repo`, on a real `main` commit that only edited `docs/manual/KNOWN_ISSUES.md`
(71761db7d7), the module sent `owner={owner}` and `name={repo}` as `-F` fields and returned
EXEMPT. A control sending the same query with raw `-f` fields got "Could not resolve to a
Repository with the name '{owner}/{repo}'". So the probe can tell the two apart, and the
module is on the working side.

What changed:

- `.claude/hooks/sol-exempt-lib.mjs`: a comment says why owner and name must stay `-F`.
- `.claude/hooks/sol-exempt-lib.test.mjs`: a new case checks that with no `--repo`, owner and
  name go as `-F` fields. A new mutant switches them to raw `-f`, and the tests catch it.

### Proof observed

- `node .claude/hooks/sol-exempt-lib.test.mjs` passes 188 assertions with 53 mutants caught.
- The live probe and control above (real GitHub, 2026-10-09).
