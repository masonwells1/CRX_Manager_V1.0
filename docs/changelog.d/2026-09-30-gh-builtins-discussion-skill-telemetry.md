## 2026-09-30 - Guards: `gh discussion`, `gh skill` and `gh telemetry` are known gh commands (PR #795)

Codex's GitHub reviewer found that the list of gh's built-in commands, which the merge guards use to
refuse aliases and extensions, was missing `discussion` (gh 2.96) and `skill` and `telemetry` (listed by
gh 2.92's own `gh help`). Harmless commands such as `gh discussion list` were refused as suspected
aliases. All three are now on the list; none can merge or push. Proven with the real guard hooks:
`gh discussion list` and `gh skill --help` pass, and the unknown `gh mm 123` is still refused.

Not verified: only gh 2.92 was run here (`discussion` comes from the reviewer's gh 2.96 report), and gh extensions installed on other machines were not checked.
