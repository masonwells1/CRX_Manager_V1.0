## 2026-09-05 — RelatedNotes: a failed notes load now reaches the operator instead of hanging the card

`src/components/team/RelatedNotes.tsx` is embedded on five detail pages (Job, Order,
Delivery, Customer, PurchaseOrder). Its mount effect had three defects in the same few
lines, found by the exact-SHA `gpt-5.6-sol` review of `dff631f1` during the PR #603
aliased-idempotency-reset sweep:

1. The RPC reply was destructured as `const { data } = await supabase.rpc(...)` — the
   `error` was thrown away, so a raised Postgres error (permission denied, an RLS
   refusal, a network failure) was silently dropped.
2. `assertRpcResult` ran with no `try`/`catch`. It throws on a null payload, and inside
   an async effect that throw escaped as an **unhandled promise rejection** — nothing
   the operator or the page could see.
3. `setLoading(false)` ran only on the success path, so any failure left the card on its
   loading skeleton indefinitely.

### What changed

The load now follows the house pattern used by `CustomerPrepCard`: the `error` is bound
and thrown, the whole load is wrapped in `try`/`catch`, the failure is reported through
`Sentry.captureException` (from `src/lib/sentry`, tagged
`source: fetch / component: RelatedNotes / rpc: get_notes_for_entity`) and surfaced to
the operator as an error toast via the shared `useToast` hook, and `setLoading(false)`
moved into a `finally` so no throw can leave the card hanging.

Two smaller correctness points came with it:

- A failed load no longer renders as `Team Notes (0)`. The header count is suppressed on
  failure and the body shows a distinct, retryable "Couldn't load related notes." state —
  a failure must not read as "this record has no notes".
- The `cancelled` cleanup flag was replaced with a request-sequence ref so the retry
  button re-enters the same guarded path. The guard is still on the **call**, not the
  entity id: only the newest request may write state.

### Proof observed

- New `src/components/team/RelatedNotes.test.tsx` — 5 tests. There was no test file for
  this component before, which is why the defect survived; every page that embeds it
  mocks it out in that page's own tests.
- Against the **unfixed** source the three failure-path tests fail, with exactly the three
  unhandled rejections the defect produces (`get_notes_for_entity returned no data`).
- Guards mutation-tested, not just run: deleting `if (error) throw error` fails the
  raised-error test; moving `setLoading(false)` out of the `finally` back onto the success
  path fails all three failure tests. A fifth test pins that the loading skeleton really
  does render while a load is in flight, so the "skeleton is gone" assertions cannot pass
  vacuously.
- The raised-error test deliberately supplies a **valid empty array** as `data`, so only
  the `error` binding can reach the catch. With a null payload `assertRpcResult` would
  throw anyway and the test would pass without proving the error is bound at all.
- `npm run typecheck`, `npm run lint`, `npm run build` — all exit 0.
- `npm run test` — exit 0, 350 files passed, 4981 passed / 123 skipped, and **no `Errors`
  line**, i.e. zero unhandled errors across the suite.

### Not verified

- Not exercised in a real browser against live data. The failure paths were driven
  through a real React render with the real `ToastProvider`, the real `assertRpcResult`
  and the real `sanitizeError`, and asserted against the resulting DOM; the screen itself
  is auth-gated, so no live click-through was done.
- The `vi.mock('../components/team/RelatedNotes', ...)` stubs in `CustomerDetail.test.tsx`,
  `DeliveryDetail.followupRetry.test.tsx`, `OrderDetail.test.tsx` and
  `OrderDetail.pickListShortage.test.tsx` were deliberately left in place — that is correct
  isolation for those page tests, and the new focused unit test is what covers the
  component itself.
- Correction to the triage note that accompanied this task: `JobDetail.billingHazard.test.tsx`
  does **not** mock `RelatedNotes` and does not emit unhandled rejections from it. Run
  against the unfixed component it is 26 tests passed, 0 errors — the "26" was its test
  count, not a rejection count. The defect itself reproduced exactly as described.
