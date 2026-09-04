## 2026-09-03 — a quote spliced into a path still reached every protected guard file

Round 4 of the same hole, from the exact-SHA `gpt-5.6-sol` review of PR #563
(`VERDICT: BLOCKED`, one High and one Medium). Both findings were real.

**Files:** `.codex/hooks/production-action-guard.mjs`,
`.codex/hooks/production-action-guard.test.mjs`, `scripts/write-codex-push-proof.mjs`,
`scripts/write-codex-push-proof.test.mjs`,
`scripts/apply-live-testdata-maintenance-20260812.mjs`

### High — the guard split on characters the shell deletes

Round 3 replaced spelling-sniffing with token canonicalization, and tokenized on
whitespace, separators **and the quote characters**. Treating a quote as a
separator is the bug: PowerShell does not break a word at a quote or a backtick,
it removes them and joins what remains. So a quote spliced into the middle of a
protected path split one blocked token into two harmless ones, and the write went
through.

Codex confirmed with PowerShell's own parser that both of these resolve to
`.claude/hooks/codex-push-lib.mjs`, and measured `blocked:false` on each:

```
Set-Content .claude/hooks/codex-push-<backtick>lib.mjs
Set-Content .claude/hooks/codex-push-""lib.mjs
```

As with every earlier round, this was never specific to the module under review —
every entry in `PROTECTED_HARNESS_SOURCE` had it, including `codex-push-lib.mjs`,
which the guard loads at startup.

**The fix examines two views of the command.** The first splits on quotes, so a
quoted path is still inspected. The second **removes** them, so an intra-word
splice collapses back to the path the shell will actually open. Neither view
alone covers the other's case.

This is round 4 on one guard. The cap is 6 — after that the shape is wrong and
the answer is a different mechanism, not another pattern. Rounds 2 and 3 both
enumerated spellings; this round generalizes the *class* (characters the shell
discards while building a word) rather than listing its members, which is why it
also closes `''`, mixed quoting, and splices in the directory part — none of
which Codex demonstrated.

### Medium — the redactor missed serialized credentials

The 2026-09-02 narrowing required the separator to touch the variable name. A
credential emitted as JSON — the name in quotes, then the quote, then the colon —
therefore kept its value verbatim, because the closing quote interrupted the
match. Machine-readable output is exactly where a real key shows up.

The name and the value may now each carry a surrounding quote. The value must
still **exist**: one character that is not whitespace, a quote, or a closing
delimiter, so a bare name stays documentation and reviews of permission changes
do not come back empty. Supabase's `sb_secret_` key shape is also recognized on
sight now — before this the pattern knew no Supabase key form at all, so a leaked
one only redacted when a variable name happened to sit beside it.

### Proof — the guard and the redactor, not my tests

Both were exercised by driving the real functions with Codex's verbatim payloads:

```
=== Codex round-4 payloads (expect blocked=true) ===
PASS  blocked=true   Set-Content .claude/hooks/codex-push-<backtick>lib.mjs
PASS  blocked=true   Set-Content .claude/hooks/codex-push-""lib.mjs
PASS  blocked=true   Set-Content .claude/hooks/codex-bot-review-<backtick>lib.mjs
PASS  blocked=true   Set-Content .claude/hooks/codex-bot-review-''lib.mjs
=== earlier rounds stay closed ===
PASS  blocked=true   (all six round-2 and round-3 payloads)
=== must stay allowed ===
PASS  blocked=false  src/components/Label.tsx
PASS  blocked=false  the module's own test file
PASS  blocked=false  an unrelated file reached through a detour
PASS  blocked=false  a spliced READ
PASS  blocked=false  npm run test:correction-guards
PASS  blocked=false  quoted fragments separated by real whitespace
```

The last line is the near-miss canary for the new acceptance rule: whitespace-
separated quoted fragments are two arguments, not concatenation, and de-quoting
must not fuse them into a protected path.

**Mutation-tested in isolation.** Removing only the de-quoted view — in a temp
copy, so the producer's blob-pin gate could not fail the run first and mask the
signal — returns `blocked:false` on all three payloads. The new regression tests
are load-bearing rather than passing for an unrelated reason.

Producer blob pins re-pinned: input `0d15dec22f8c137e90831268dd8df2425369299f`,
output `03a8cc11d2bf5d05268795d606b4d9c236ea73cf`.
