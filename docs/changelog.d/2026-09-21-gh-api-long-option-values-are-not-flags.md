## 2026-09-21 - The gh api reader no longer mistakes a long option's value for a flag

`gh api` long options such as `--template`, `--jq`, `--header` and `--cache` take
a value, and when that value is written as the next word gh accepts it whatever
it looks like. The shared reader did not skip that word, so it could read the
value as a flag instead.

`gh api repos/o/r/issues/1/comments -f body=test --template -iX=GET` is a POST to
gh (`-f` supplies a field and `-iX=GET` is only the template). The bundled-short
reader added on this PR read `-iX=GET` as `-X GET`, reported a read, and the Codex
production guard let the call through. On main the older reader missed the
bundled form but had the same gap for `--template -XGET`.

Now every value-taking long option of `gh api` (from gh's manual) skips its
detached value before the next word is examined, in both readers: the one that
decides whether a call mutates and the one that recognizes a REST merge. A
detached `--field`, `--raw-field` or `--input` still counts as a field.

Locked in by assertions in `.claude/hooks/pr-merge-guard.test.mjs` (both
directions, plus the merge-endpoint reader) and end-to-end denials in
`.codex/hooks/production-action-guard.test.mjs`.

Found by the `gpt-5.6-sol` exact-SHA review of `54db1e707` (HIGH) on PR #630.
