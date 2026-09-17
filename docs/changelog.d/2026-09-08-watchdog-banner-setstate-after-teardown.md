## 2026-09-08 — "has a newer load started?" is not "is there still a component to write to?"

`WatchdogFlagBanner` ended every load with `if (seq === loadSeq.current) setLoading(false)`.
That token answers only whether a **newer** load has superseded this one. Unmount with nothing
newer behind it — navigate away from `/jobs/:id` while the watchdog RPC is still in flight —
leaves the token matching, so the component wrote state into a torn-down tree.

**Files:** `src/components/watchdog/WatchdogFlagBanner.tsx`,
`src/components/watchdog/WatchdogFlagBanner.unmount.test.tsx` (new)

### The CI symptom this explains

On PR #592 head `0eb710369` the "Lint, Type Check, Test, Build" job **exited non-zero while
359 files and 5,123 tests all PASSED**. From that job's log (run `34187499784`, attempt 1,
job `101939658042`):

```
ReferenceError: window is not defined
 ❯ getCurrentEventPriority  react-dom.development.js:10993:22
 ❯ requestUpdateLane        react-dom.development.js:25495:19
 ❯ dispatchSetState         react-dom.development.js:16648:14
 ❯ src/components/watchdog/WatchdogFlagBanner.tsx:108:36   <- setLoading(false)
 ❯ src/components/watchdog/WatchdogFlagBanner.tsx:141:5    <- await fetchFlags(seq)
This error originated in "src/components/JobDetailRoute.test.tsx"
```

React 18's `dispatchSetState` reaches `requestUpdateLane` → `getCurrentEventPriority` **before**
it discovers the fiber is gone, and that function reads a bare `window`. Once Vitest has torn
the jsdom environment down, that reference throws. Hence the shape of the failure: every test
green, one unhandled rejection, non-zero exit. Not #592's doing — the banner is byte-identical
to `main` on that branch — and it passed on re-run, which is what an intermittent race does.

### The fix

A second, **independent** operand: a `mounted` ref set false by an unmount cleanup, checked
alongside `loadSeq` at the three post-await write sites. Kept *alongside* the token rather than
replacing it — "superseded" and "gone" are different questions and neither implies the other.

The same defect sat 70 lines down in `FlagItem.handleDismiss`, whose `setPending(false)` and
`setDismissing(false)` run after two awaits; both are now guarded. `dismissIdem.resetKey()` and
`onDismissed()` are deliberately left ungated — the dismiss already committed server-side, so
retiring the idempotency key is a fact about the RPC, not about the row still being on screen.

### Proof

`WatchdogFlagBanner.unmount.test.tsx` reproduces the race deterministically instead of waiting
for it: it holds the read pending, unmounts with no newer load behind it, removes the global
`window` binding the way teardown does, and only then resolves. Against the unguarded component
it fails with the identical `ReferenceError: window is not defined` from `dispatchSetState`;
against the guarded one it passes. Both directions were run.

The real trigger, `src/components/JobDetailRoute.test.tsx`, arrived with PR #611 and was **not
on `main`** when this work started at `96fa0b424`. **PR #592 merged at 2026-09-08 05:45:06Z**,
bringing it and 36 other commits onto `main` (`214125f4b`) while the banner stayed unguarded —
so the defect and its trigger are now on `main` together and the flake can recur in `main`'s own
CI. This branch was rebased onto `214125f4b` and re-verified there: the regression test still
fails against that tree's unmodified banner and passes with the guard, `JobDetailRoute.test.tsx`
passes alongside it, and the full suite is 360 files / 5,124 passed / 123 skipped / 0 errors —
CI's own 359 / 5,123 plus this one new test.
