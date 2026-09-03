## 2026-09-03 — cmd.exe `%VAR%`/`!VAR!` expansion counts as computed text; cmd's write verbs join the mutation list

Codex round 10 on PR #563, High — the exact-SHA `gpt-5.6-sol` proof of head `b95a519a7`.
Follows round 9 (`2026-09-03-connector-merges-skipped-the-deferred-advisory-and-computed-paths.md`),
which introduced the computed-destination rule this entry completes.

**Files:** `.codex/hooks/production-action-guard.mjs`, `.codex/hooks/production-action-guard.test.mjs`,
`scripts/apply-live-testdata-maintenance-20260812.mjs` (guard blob re-pin only)

### The gap in round 9's rule

The computed-text rule counted PowerShell's and POSIX's ways of building a string but not
cmd.exe's `%VAR%` / delayed `!VAR!` expansion, so

```
cmd /c "set a=.claude/hooks/codex-bot-review-&& echo x > %a%lib.mjs"
```

assembled the protected path with no literal token spelling it. Both forms (and substring
expansion, `%a:~0,-4%`) now count as computed text in a mutating segment — the same two patterns
`maintenanceProducerCommandMentioned()` already uses to spot dynamic syntax, so the guard now
agrees with itself. Scoping is unchanged: `echo 100% done > docs/out.txt` (a lone percent) and
`Write-Output %date% | Out-Null` (an expansion in a non-mutating segment) stay allowed.

### Found on the way — worth Mason's attention

**cmd.exe's own write verbs were missing from the mutation list entirely.** `copy`, `move`,
`xcopy`, `robocopy` and `mklink` were not mutations to this guard, so
`copy evil.mjs .claude\hooks\codex-push-lib.mjs` — a plain literal path, no trick — returned
`blocked:false` on the guard as it stands on `main` today. They are on the list now; five payloads
denied, an ordinary `copy` between docs files still allowed.

### Residual, stated rather than glossed

`robocopy` takes a directory and a file name as *separate* arguments
(`robocopy staged .claude\hooks codex-push-lib.mjs`). The literal gate matches whole paths, and
pairing a directory token with a basename token would contradict the round-4 canary that
whitespace-separated fragments are *not* a path. That form is not caught here; it belongs with the
follow-up that also covers `main`'s Claude-side `review-proof-guard`.

### Mutation check

With the two cmd forms removed from the computed-text pattern and the cmd verbs removed from the
mutation list, all three probe payloads (`%a%`, `!a!`, plain `copy`) return `blocked:false`.
Restored, all three return `blocked:true`.
