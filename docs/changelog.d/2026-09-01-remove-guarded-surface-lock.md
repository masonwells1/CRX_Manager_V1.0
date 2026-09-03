## 2026-09-01 — the guarded-surface lock is deleted; review-proof-guard absorbs its real coverage

Removes `guarded-surface-lock.mjs`, `guarded-surface-lib.mjs`, its test suite, and
`scripts/guard-unlock.mjs`; unregisters the hook from `.claude/settings.json` and `.codex/hooks.json`
and drops its test from `package.json`. There is no unlock protocol any more. Mason's decision — see
`DECISION_LOG.md` (2026-09-01).

**Why.** The lock was never a boundary: with the surface locked, a five-line script writing through
node's `fs` created a file inside `.claude/hooks/` and the hook never fired. Worse, it **failed open**
on a `SyntaxError` in its own rule book — the static import killed the process before `deny()` existed,
so it emitted nothing, and a PreToolUse hook that emits no decision is not a denial (reproduced in
isolation: exit 1, empty stdout). On a *runtime* error it failed closed across `matcher: "*"`, denying
every tool call in the session including the ones needed to repair it — twice in fifteen minutes, each
recovery requiring a shell command run outside the agent. An exact-SHA `gpt-5.6-sol` review returned
BLOCKERS on the narrowed lock with three HIGH findings and recommended, unprompted, that command-text
filtering remain only as defense in depth.

**Replacement coverage, so nothing is lost.** `review-proof-guard.mjs` already denied destructive
shell writes everywhere under `.claude/` — verified live, `echo test > .claude/hooks/x` was refused by
the proof guard, not the lock. Its unique reach was four paths, now denied by the same machinery:
`.husky/**`, `.github/workflows/**`, `.codex/hooks*`, `.coderabbit.yaml`. `.claude/hooks` is listed
with them so the overwrite verbs the lock caught and the older `.claude` rule does not —
`git checkout|restore|apply|am|rm|mv` and `patch`, which carry content from history or a patch file
rather than the command text — still deny for hook files. Reads stay allowed throughout.

One over-block is pinned in the tests rather than hidden: `.coderabbit.yaml.bak` also denies, because
widening the boundary to allow it would stop `.codex/hooks.json` matching at all.

Verified live after the change, not only in tests: `echo test > .husky/…` and
`git checkout main -- .claude/hooks/sql-safety.mjs` are both refused, with the new guard's message
naming the new paths; `cat .husky/pre-push` and `git diff .codex/hooks.json` still pass. The
`review-proof-guard` suite passes with the new deny, allow, near-miss, and over-block cases added.

The `ask` tier in `.claude/settings.json` is untouched and remains the gate for native `Edit`/`Write`
on these files.
