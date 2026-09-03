## 2026-09-03 — the advisory Codex-App lookup could starve every hard merge gate

Codex round 6 on PR #563, High. The Codex GitHub App review check this branch adds
ran **before** the hard denials on both guards. Because it is advisory, fail-open and
network-bound, a slow GitHub could kill the hook before those denials ran — and a
PreToolUse hook that is killed denies nothing.

**Files:** `.claude/hooks/codex-bot-review-lib.mjs`, `.claude/hooks/pr-merge-guard.mjs`,
`.codex/hooks/production-action-guard.mjs`, plus both test suites and the producer blob pins

### The arithmetic

| | hook budget | advisory worst case |
|---|---|---|
| `production-action-guard.mjs` | **15s** (`.codex/hooks.json`) | 4 × 10s `gh` calls = **40s** |
| `pr-merge-guard.mjs` | **30s** (`.claude/settings.json`) | 4 × 10s `gh` calls = **40s** |

Each `gh` call is individually capped at 10s, and the lookup makes one metadata call plus
up to three paging calls. So the advisory alone can outlive either hook.

The consequence is the part that matters, and it was already settled in this repo:

> a hook killed mid-call emits nothing, and a PreToolUse hook that emits nothing does NOT
> deny — so a generous timeout here is a fail-open
> — `.claude/hooks/migration-apply-lib.mjs:199` (PR #502)

Starved gates: `CHANGES_REQUESTED`, the green-pipeline requirement, the risky-diff
classification, and the exact-SHA `gpt-5.6-sol` proof. On the Codex side the advisory
preceded **all** of them; on the Claude side, all but the objection check.

### Fix — the advisory runs at the ALLOW points

Extracted into `codexAdvisory()` / `codexAppAdvisory()` and invoked only where the
alternative is returning ALLOW anyway. Nothing it does can now prevent a hard denial,
whatever GitHub's latency.

`collectCodexThreads` also takes an optional `deadlineMs`, checked before every request.
Exceeding it **throws** rather than returning a partial read: a truncated walk that
reports "nothing standing" is indistinguishable from a clean one, which is the defect
CRX-REV-002 fixed. Callers turn the throw into their existing fail-open notice. Budgets
are 5s (Codex, ⅓ of 15s) and 12s (Claude, under half of 30s).

### This inverts an earlier pin, deliberately

The original tests required the App-review check to run **first**, so an unanswered review
comment would be the message the reader got rather than "wait for CI". That was a
message-quality argument, and it bought a security hole. The pin is now the other way, and
both directions are asserted, because each alone is satisfiable by a broken guard:

- **ordering** — every hard denial precedes the advisory;
- **reachability** — the advisory is still actually invoked. The Claude guard must call it
  at **both** allow points; one call site would mean the other path silently skips it. That
  is the dead-code failure the original pin existed to prevent (round 2 found the check
  sitting behind the Codex guard's approval deny, unreachable for any PR without a formal
  approval).

The Claude-side ordering is asserted **per path**: the proof gate is reachable only on the
risky path, so requiring the non-risky allow point to follow it would be wrong, not
stricter.

### Proof

**A behavioural pin, not a source-order one.** A `runGh` stub that throws if the GraphQL
read is reached, on a `CHANGES_REQUESTED` PR: the objection still denies, and
`advisoryAttempts === 0`.

**With a control, because the assertion is vacuous without one.** On a clean, green,
proof-backed merge the advisory **is** reached (`controlAttempts > 0`) and a failed lookup
fails open. Writing that control is what exposed a flaw in the test itself: the stub's PR
JSON had no `url`, so the advisory short-circuited before GraphQL and "never reached" would
have held even with the advisory running first. Both stubs now answer the
`--json number,url` lookup, so only the ORDER decides the outcome.

**Mutation-tested in isolation** (a temp copy, so the producer blob-pin gate could not fail
the run first and mask the signal). Moving the advisory back in front of the objection
check:

```
MUTANT (advisory moved back in front): blocked=true advisoryAttempts=1
KILLED — with the advisory first, the guard DOES reach it before the objection deny.
```

Suites: `codex-bot-review-lib` 104 assertions, `pr-merge-guard` 97, production action guard
green. Producer blob pins re-pinned — input `447378b10dd2f5bb8383c25ee5dc1551c6bb6477`,
output `2cc037a2df5cbd239addc2e843f2da073ffdb3e2`.
