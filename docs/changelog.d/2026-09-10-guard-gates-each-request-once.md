## 2026-09-10 - Guards gate a merge request once, not once per reading of it

Round 6 on the shared-parser branch. CodeRabbit reviewed the exact head and found a
consequence of round 5 that round 5 had not looked for.

`splitCommandSegments` returns the UNION of two readings, so any command carrying a quote
or an escape resolves to the same merge request twice. Both guards then gated it twice —
two `gh pr view` calls and two Codex advisory lookups for a verdict already known.

That is not merely wasteful. Both merge hooks are bounded (15s in Codex, 30s in Claude)
and each `gh` call is capped at 5–10s. A `PreToolUse` hook killed mid-call emits nothing,
and **a hook that emits nothing ALLOWS**. Duplicated lookups spend the budget that protects
the hard gates, so the waste is fail-OPEN. Measured before the fix: one merge, two advisory
attempts.

Both guards now gate each DISTINCT request once, keyed by a new shared `mergeRequestKey`.

### The suggested fix would have opened a hole

The review proposed de-duplicating "by selector and repository". That is unsafe against
this splitter, and the case that breaks it is the one the gate exists for:

```shell
gh pr merge 123 --body 'note&more' --admin --squash
```

The two readings are identical in selector AND repository and differ ONLY in `admin` —
measured as `{"123","",false}` and `{"123","",true}`. Keying on selector+repo collapses
them to one, and if the survivor is the `admin:false` reading the administrator override
disappears from the gate's view entirely.

So the key covers the COMPLETE parse, sorted over all own keys, which also means a field
added to a request shape later widens the key automatically. For a de-duplicator, keeping
distinct parses distinct is the fail-safe direction. Pinned by an assertion that the
`--admin` reading survives and still denies, naming the flag.

### Also in this round

- Every `spawnSync` in the Codex guard's test file is bounded. The review named four; the
  file had eight and none were bounded. Fixing only the named four would have left the same
  defect in the same file. A wedged guard now fails fast instead of hanging until the CI job
  timeout, where it reads as "CI is slow" rather than "a guard hung".
- Language tags on this branch's fenced blocks, for the `docs/changelog.d/` markdownlint
  scope.

### Proof

The de-duplication assertion was mutation-tested: with the skip disabled the advisory count
goes to 2 and the test fails, so it measures the fix rather than restating it. Both guards
re-run as real `PreToolUse` subprocesses on the `--admin` case and still deny, naming the
override.
