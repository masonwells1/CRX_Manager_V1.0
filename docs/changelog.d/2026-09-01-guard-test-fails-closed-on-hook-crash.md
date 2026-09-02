## 2026-09-01 - Guard test fails closed when a hook crashes instead of reading it as "allowed"

Follow-up to `2026-09-01-overnight-intent-escape-hatch.md`, raised by Codex (`gpt-5.6-sol`,
exact-SHA review) as a minor finding on an otherwise clean verdict, and fixed rather than
deferred — it is the same failure class as the bug that entry is about.

## The defect

`.claude/hooks/overnight-intent-clear.test.mjs` spawns every registered PreToolUse hook and
records which ones deny a command. Its `denialsFor()` helper threw on a timeout or a signal,
but **not** on any other spawn error (`ENOENT`, `EACCES`) and **not** on a nonzero exit. Those
cases fell through to "no `permissionDecision` parsed" — which the helper scored as **the hook
allowed it**.

So a hook that failed to launch, or crashed, would have counted as that hook *permitting* the
command under test. A guard test that reads "did not answer" as "allowed" measures nothing while
staying green — exactly how `autopilot-lib.test.mjs` asserted a blocked command was allowed for
months.

## The fix

Any spawn error, any signal, and any nonzero exit now throws, naming the hook and its exit
status. Nothing is scored until the hook has actually run to completion.

## Verification — proven, not asserted

Replaced a real registered hook (`.claude/hooks/hold-latch-guard.mjs`) with a stub that exits 3,
then re-ran the suite. It went **red**:

```
FAIL every shell command the deny message advertises survives the real chain
     hook hold-latch-guard.mjs exited 3 — a crashed hook must not read as "allowed"
```

Before this change that crash would have been scored as "no denial" and the suite would have
stayed green. The stub was then restored from HEAD (`git diff --stat` empty) and the suite
returned to 9/9 passing.

## Note for future guard tests

This is the second time in one change set that the *test* — not the guard — was the thing
quietly not working. When a test decides a verdict from a subprocess, the absence of a verdict
must be a failure, never a pass.
