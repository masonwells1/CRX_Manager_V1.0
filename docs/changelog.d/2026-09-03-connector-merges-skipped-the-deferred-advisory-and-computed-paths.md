## 2026-09-03 — the connector merge route skipped the deferred advisory; computed shell paths are now refused, not parsed

Codex round 9 on PR #563, two Highs — the exact-SHA `gpt-5.6-sol` proof of head
`dc965401f` (the branch after round 8). Follows
`2026-09-03-chained-merge-advisory-starvation-and-cmd-caret-escape.md`.

**Files:** `.codex/hooks/production-action-guard.mjs`, `.codex/hooks/production-action-guard.test.mjs`,
`.claude/hooks/codex-bot-review-lib.test.mjs`, `scripts/apply-live-testdata-maintenance-20260812.mjs`
(guard blob re-pin only)

### HIGH 1 — a regression round 8 introduced

Round 8 moved the Codex App advisory lookup out of the per-merge gate so a chained shell
command could not let merge #1's lookup starve merge #2's hard checks: the gate now returns
`{ blocked:false, advisoryRequest }` and the **shell** loop queues and drains it. The
**GitHub-connector** merge tool (`mcp__github__merge_pull_request`) calls the same gate — and
returned its result untouched, so a connector-driven merge got no advisory at all. Codex proved
it with a mocked unresolved Codex thread on the exact head: connector → `blocked:false`, the same
PR through `gh pr merge` → `blocked:true`. Exactly the one-sided asymmetry `AGENTS.md` forbids.

**Fix.** The connector route merges one pull request per call, so there is no later segment for
its advisory to starve: it *is* the command's allow point, and the route now runs the deferred
lookup right there. Pinned behaviourally on both routes — the standing-thread stub denies the
connector merge with the App-review denial text, the shell merge with the same text, and a clean
connector merge with a fail-open advisory is still allowed. A source-position pin asserts the
connector route calls the advisory; the ordering pins now measure the *last* call site (the shell
drain), the one a regression would move back into the loop.

### HIGH 2 — a destination the guard cannot read cannot be gated

Every protected-path check reads literal tokens. A path assembled at run time has none:

```
Set-Content (".claude/hooks/codex-bot-review-" + "lib.mjs") -Value ""
Copy-Item evil.mjs (Join-Path ".claude/hooks" "codex-bot-review-lib.mjs")
```

Both returned `blocked:false`. Rounds 2, 3, 4, 7 and 8 on this matcher were each one more
spelling of "somewhere else" (`../`, `./`, drive prefix, quote splice, trailing period, caret).
Enumerating the ways PowerShell can build a string would be round 10, 11, 12.

**Fix — refuse the shape.** A **mutating** shell segment whose text carries a computed
expression — a parenthesised (sub)expression, a `$` variable or `$(…)`/`${…}`, `Join-Path`, or
the `-f` / `-join` operators — is denied outright, with a message saying to spell the destination
literally. This is the stance the guard already takes on shell-expanded interpreter arguments and
on merge segments carrying a command substitution. Scoped to the mutating **segment** (the same
pipeline/chain units the merge and push gates use), so
`npm test 2>&1 | Where-Object { $_ -match "fail" }` — a redirect in one stage, a variable in
another — stays allowed, as do a literal destination with an ordinary value, a plain redirect,
and a computed expression in a non-mutating command. Nine payloads denied with the
computed-destination reason; five near-miss canaries stay allowed.

**Cost, stated plainly:** Codex can no longer write to a computed path from the shell
(`echo x > "$env:TEMP/a.txt"` is refused). It can still spell the path, or use the file tools,
which are gated on their own. That is a real narrowing of everyday shell use on the Codex side,
chosen over a matcher that has now been escaped seven times.

### Mutation check

With the connector's advisory call disabled and the computed-text pattern made unmatchable, the
probe reproduces Codex's exact observation: both computed writes `blocked:false`, the connector
merge `blocked:false` while the shell merge stays `blocked:true`. Restored, all cases hold.
