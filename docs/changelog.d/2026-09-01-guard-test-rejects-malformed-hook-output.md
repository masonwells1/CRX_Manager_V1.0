## 2026-09-01 - Guard test rejects malformed hook output instead of scoring it "allowed"

Third and final instance of the false-green class in this change set, raised by Codex
(`gpt-5.6-sol`, exact-SHA review) as a minor finding on a clean verdict.

## The defect

`denialsFor()` in `.claude/hooks/overnight-intent-clear.test.mjs` already failed closed on
spawn errors, signals, and nonzero exits. But a hook that exited **0** while writing
non-empty, unparseable stdout still had its `JSON.parse` failure swallowed:

```js
try { decision = JSON.parse(res.stdout || "{}")?.…; } catch { /* no decision */ }
```

A malformed answer therefore scored as **no denial** — the hook counted as permitting the
command under test.

## The fix, and the distinction that matters

Empty stdout is the *legitimate* answer: most hooks exit 0 saying nothing, meaning "I defer
to the normal permission flow." That must keep passing. Non-empty but unparseable output is
a **malformed** answer and now throws.

Only silence may mean "no decision."

## Verification — both halves, against a real registered hook

Replaced `.claude/hooks/hold-latch-guard.mjs` with stubs and ran the suite:

| Stub | Result |
|---|---|
| exits 0, writes `<html>not json</html>` | **red** — `emitted unparseable output — a malformed answer must not read as "allowed"` |
| exits 0, writes nothing | **green** — the legitimate defer still passes |

That second row is the point: a fix for this could easily have become over-strict and broken
every deferring hook. It didn't. The stub was restored from HEAD (`git diff --stat` empty)
and the suite returned to 9/9.

## Pattern worth keeping

Three separate defects in this one helper, all the same shape: **a guard test that derives a
verdict from a subprocess must treat every non-answer as a failure, and must distinguish the
one form of silence that is a real answer.** Timeouts and signals, then crashes and spawn
failures, then malformed output. Each was found by review, never by the test going red on
its own — which is exactly what a false-green test does.
