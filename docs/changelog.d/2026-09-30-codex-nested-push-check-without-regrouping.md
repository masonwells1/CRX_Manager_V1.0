## 2026-09-30 - Codex guard: a grouped command beside a push is not a nested push (PR #795)

CodeRabbit found that the Codex production guard read nested pushes with the `{ }` / `( )` regrouping pass,
which re-emits the outer command itself. So `git push origin HEAD:feature/x && (npm test)` and
`git push origin HEAD:feature/x; if ($LASTEXITCODE) { exit 1 }` were refused as a push "inside another
shell", while Claude's push guard, which reads without regrouping, allowed them. The Codex guard now reads
nested pushes the same way; a push behind grouping is still refused by its whole-command composition check.

Proof with the real hooks: neither command is refused as a nested push anymore (each is still refused by
an older, separate rule: the Codex guard's computed-text rule for `(npm test)`, and the accepted
`if ($…)` over-refusal), while `{ git push origin HEAD:main --force; }`, `(git push --force origin HEAD:main)`
and `bash -c 'git push …'` are still refused by both push guards.

Not verified: other grouping spellings (`&{ }`, nested parentheses inside quotes) were not tried one by one.
