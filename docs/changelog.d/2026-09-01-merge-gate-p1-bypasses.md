## 2026-09-01 — Two P1 bypasses closed in the merge gate itself

Found by the Codex PR bot reviewing the candidate that adds the merge gate
hardening (see `2026-09-01-github-manual-review-override.md` for the override
those guards protect). Both bypasses were real, and both were reproduced red
before fixing.

### `--auto=false` was treated as an auto-merge

`gh` accepts `--auto=false` as "do not auto-merge", so that command lands the
pull request **immediately**. `ghMergeRequest()` classified every `--auto=`
spelling as an auto-merge, which exempts the request from the green-pipeline
check — and, once the override work landed the approval check, from that too.

The exemption is only sound for a *real* auto-merge, because GitHub itself holds
one until every requirement is met. An immediate merge wearing the auto label
skipped both gates. The flag's value is now parsed (`false`/`0`/`no` mean not
auto), the same way `--admin=false` already was.

### A recognized outer `gh pr merge` shielded a raw merge in a substitution

`gh pr merge 1 --body "$(curl -X PUT .../pulls/9/merge)"` parsed as an ordinary
gh merge, was gated on the *named* PR, and reached `continue` before the
raw-destination scan ever ran — so the embedded call was never inspected. The
same held for backtick substitution.

Both guards now scan merge destinations on **every** segment regardless of what
else matched, rather than only on segments where no gh form was recognised.
Occurrences are counted so that a legitimate `gh api -X PUT .../pulls/<n>/merge`
does not deny its own gated route: one mention is accounted for by the parsed
request, any additional mention is a second, unresolvable merge and is denied.

### Verification

- `.claude/hooks/pr-merge-guard.test.mjs` — 74 assertions, covering
  `--auto=false` / `--auto=0` / `--auto=true` / bare `--auto`, and both
  substitution forms.
- `.codex/hooks/production-action-guard.test.mjs` — the same two substitution
  forms, plus a case proving an ordinary gh merge still routes through the real
  gate rather than being swallowed by the destination rule.
- Red-before / green-after confirmed for every new assertion.
- Both blob pins in `scripts/apply-live-testdata-maintenance-20260812.mjs`
  re-pinned; inputs verified against the working tree, outputs taken from the
  producer test's printed candidate.
