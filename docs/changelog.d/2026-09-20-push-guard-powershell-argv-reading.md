## 2026-09-20 - Push guard reads PowerShell argv as well as POSIX

A Windows destination ending in a backslash hid the option that followed it from
every push predicate. The word splitter follows POSIX, where a backslash binds
the next character into the same word, so a destination ending in a separator
joined with the next argument and the guard saw one word carrying no options.
PowerShell passes git two arguments there, so the option is real and the gate
was blind to bulk, force, deletion and receive-pack relay intent behind such a
destination.

Every push predicate now judges both readings and keeps the dangerous answer;
the one allow-predicate requires every reading to agree. Proven by a
differential probe of the four commands from the review, by new assertions in
`.claude/hooks/codex-push-lib.test.mjs`, and end to end through
`codex-push-guard.mjs` in `.claude/hooks/guards.test.mjs` (deny on all four).

Found by the `gpt-5.6-sol` exact-SHA review of `7b298c08f` (HIGH) on PR #630.
