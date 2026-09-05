## 2026-09-05 - Finish F1 for the RENAMED idempotency resets, and stop JobDetail swallowing a job-number failure

PR #584 fixed F1 — *verify the server's reply before retiring the idempotency key* — at every site
that calls the reset by its literal name, `resetKey()`. Components that DESTRUCTURE the hook rename
that method (`const { resetKey: resetSaveQuoteIdempotencyKey } = useIdempotencyKey(...)`), so the
literal sweep never saw them and two defects stayed live on `main`. This closes them.

## Why the ordering matters

A mutating RPC that answers `{ data: null, error: null }` is **ambiguous**: nothing failed, but the
payload is empty, so the screen cannot tell whether the row committed. `assertRpcResult` exists to
reject exactly that reply. Retiring the key *before* that check sends the operator's retry under a
brand-new key — one the server has never seen and therefore cannot replay — so the work is applied
a second time. On these two screens that means a duplicate quote or a duplicate customer.

## The sweep

The alias set was enumerated structurally rather than by name: find every destructuring of
`useIdempotencyKey`, capture the local identifier each one binds, then search for that identifier.
A name-based grep is what under-reported the first time. All 14 files that bind a renamed reset
were resolved and every call site read in context.

Result: **3 defects, 2 files.** Everything else in the alias class is correct and stays untouched —
including the resets that live in a recovery branch (a reset after a lookup PROVES the row does not
exist is right, because it lets a retry mint a fresh key), the route-change rotations, and the
intent-rotation resets in `ProductDetail`, `PurchaseOrderDetail`, `JobDetail`'s notice keys,
`BulkTicketUpload` and `ManualTicketCreate`.

## Fixed

- **`src/pages/QuoteBuilder.tsx`** — `save_quote` retired its key one line before the assert that
  verifies the reply. Reordered.
- **`src/pages/CustomerDetail.tsx`** — `save_customer` had the same reset-before-assert. Reordered.
- **`src/pages/CustomerDetail.tsx`**, route-changed-mid-flight branch — released the key on `!error`
  alone, which does not rule out an empty reply. This branch cannot assert (it must return quietly
  rather than throw into a customer that is no longer on screen), so it now applies the same
  emptiness test inline: `!error && data != null`.
- **`src/pages/JobDetail.tsx`** — `next_job_number` was called as `if (!error && data)`, which
  discarded BOTH failure shapes and left the job-number field blank with no toast and no Sentry
  event. Harmless while the RPC could not fail; not harmless since the F2 number-generator gate
  applied live on 2026-09-04, which raises `INSUFFICIENT_ROLE` for a deactivated or out-of-role
  profile. That user now gets a message naming the cause instead of an empty box.

## Proof

Every test below was confirmed to FAIL against the unfixed source before it passed. The main save
handlers and the JobDetail number path were proven by MOUNTING the real screens; the quiet
route-changed branch in `CustomerDetail` is the exception — it carries a lexical source pin only,
because its mounted route-switch test exercises a non-empty reply rather than the null reply that
this change makes important. That limit is stated here rather than left to be inferred.

- `QuoteBuilder.test.tsx` and `CustomerDetail.test.tsx` each drive their real save handler with an
  empty-but-error-free reply and assert the key is not retired AND that a retry carries the SAME
  key. Both bind the pair; asserting only "the key survived" would pass if the retry minted a fresh
  key some other way.
- `JobDetail.billingHazard.test.tsx` mounts `/jobs/new` and asserts a toast for both failure shapes
  — a raised `INSUFFICIENT_ROLE` and an empty reply.
- `src/__tests__/idempotency-reset-order.test.ts` gains source-order pins for the aliased class.
  They assert ORDER, not proximity: "an assert appears near this reset" is satisfied *by the bug*,
  because the buggy order still has the assert — one line below.

### A stubbed guard that hid the defect class

Three test harnesses mocked `assertRpcResult` as `vi.fn((d) => d)` — a passthrough that never
throws. That stub DELETES the ambiguous-reply path from every test in those files, so a screen that
retires its key before checking the reply stayed green no matter what. `QuoteBuilder.test.tsx`,
`CustomerDetail.test.tsx` and `JobDetail.billingHazard.test.tsx` now import the real function, which
is what made behavioural proof possible at all. `JobDetail.billingHazard.test.tsx` was also missing
`hasRpcCode` and `RpcErrorCodes` from its `../lib/db` mock.

## Known-unfixed list

`KNOWN_UNFIXED_SITES` shrinks accordingly: `QuoteBuilder`'s aliased entry is gone, and
`CustomerDetail` drops from two entries to one. The remaining `CustomerDetail` entry is the
route-changed branch — now correct, but still reported by a scanner that reads LINE ORDER and cannot
see an inline emptiness test. It stays pinned so the scan stays honest, and its fix is separately
bound by a test that fails if the `data != null` check is deleted.

## Review round 1 — the `gpt-5.6-sol` finding, fixed rather than deferred

The exact-SHA `gpt-5.6-sol` review of `4ab55579` returned CLEAN with one LOW: `save_customer`'s key
carried no per-customer scope, while this change makes it OUTLIVE an ambiguous reply. Since the page
does not remount when only `:id` changes, customer B could inherit customer A's unresolved key; the
server fingerprints a different payload against it and answers `IDEMPOTENCY_PAYLOAD_CONFLICT`, so it
fails closed with no cross-customer write — but B gets a conflict dialog it did nothing to earn.

Accepted and fixed: the key is now scoped by route id. That is sound *here specifically* because the
RPC targets the route record (`p_customer_id: (isNew ? null : id)`) — route scope binds the record,
not the payload, so it is not a general answer. **Residual, stated rather than implied:** two
consecutive CREATES both scope to `'new'`, so an unresolved create can still be inherited by the
next one. Binding that needs PR #535's `fingerprintIntentPayload`.

**The regression test required fixing a second mock.** `CustomerDetail.test.tsx` stubbed
`useIdempotencyKey` scope-blind — one key for every customer — so an A→B test would have passed
against a completely unscoped hook, asserting a property of the mock rather than of the page. The
mock now honours `intentScope`, and the new test was confirmed to fail without the scope.

## Review round 2 — the Codex GitHub App P1, and a lesson about reading test output

Swapping the passthrough for the real `assertRpcResult` had a consequence in
`JobDetail.billingHazard.test.tsx` that the summary line hides. `RelatedNotes` is rendered by
JobDetail and fetches `get_notes_for_entity` on mount; this file's fixture answers EVERY RPC with
`{ data: null, error: null }`, which the real helper correctly rejects. The rejection escapes as an
unhandled promise rejection.

**Vitest then reports `Test Files 349 passed / Tests 4985 passed` — and exits 1 with `Errors 26`.**
A grep for `FAIL` or for the `Tests` line sees a totally green run. This was claimed green on that
basis and was not; CI's `Lint, Type Check, Test, Build` failed on `26edc763` accordingly. The
durable rule: **read the exit code, not the summary** — a vitest run can pass every assertion and
still fail.

Fixed by mocking the unrelated child, the same isolation `CustomerDetail.test.tsx` already applies.
The alternative — teaching every per-test `mockRpc` override about an unrelated RPC — breaks again
the next time someone calls `mockRpc.mockResolvedValue`.

### The two P2s are the same cross-lane dependency, deliberately not fixed

Both `QuoteBuilder` and `CustomerDetail` are flagged for binding the retained key to the submitted
PAYLOAD, not just the record. The concrete case: an ambiguous reply retains the key, the operator
EDITS a field and retries, the server fingerprints the changed payload and raises
`IDEMPOTENCY_PAYLOAD_CONFLICT`, so the stale-reload flow discards the new edits.

That is a real consequence of F1 retention and is stated here rather than papered over. It is also
exactly what PR #535's `fingerprintIntentPayload` exists to solve, and it is another lane's work —
flagged to that lane rather than routed around. The trade this PR makes is deliberate: a silent
DUPLICATE WRITE (the old behaviour) is worse than a conflict dialog on an edited retry.

## Found, NOT fixed — reported rather than silently widened

An independent scan of ALL 274 reset call sites (literal, aliased and `idem.resetKey()` member
form) flags **28 further reset-before-assert sites** in the member-call form, across ~20 files
including money paths (`allocate_payment`, `batch_apply_prepayments`, `draw_down_quote`,
`transfer_job_to_invoice`). These are NOT new: every one is already pinned in
`KNOWN_UNFIXED_SITES`, which is asserted to equal the scanner's output, so none can drift
unnoticed. Four of them (`DeliveryDetail` complete/cancel/void, `OrderDetail` void) carry in-code
notes explaining that a reorder alone is insufficient — they send mutable payload fields and need
PR #535's `fingerprintIntentPayload`. Widening this PR to ~20 files would collide with the parallel
sessions holding several of them. Flagged for a scoping decision instead.

## Review round 3 — the exact-SHA `gpt-5.6-sol` review of `dff631f1`, at Mason's request

Twelve findings plus a release-state note. Six were fixed here; the rest are recorded below with
the reason they are not this PR's to close. The review ran against the candidate commit with source
access, not against the diff alone.

### Fixed

- **`save_quote`'s key was still page-wide** (MEDIUM) — the exact mirror of the CustomerDetail
  finding fixed in round 1, and one this PR CREATED: retention is what lets a key outlive the quote
  it was minted for. QuoteBuilder does not remount when only `:id` changes, so quote B's save would
  have gone out under quote A's unresolved key and earned B an `IDEMPOTENCY_PAYLOAD_CONFLICT` it did
  nothing to cause. The key is now scoped to `(quoteId && isEditing) ? quoteId : 'new'`, which
  mirrors `p_quote_id` exactly and therefore binds the record the RPC writes rather than the route.
  Route-id scoping would have been wrong here — `/quotes/new` has no route id. `create_quote_version`
  in the same file already scoped this way, for this same reason.

  Round 1 recorded a decision NOT to scope this key. That decision was wrong, and the reasoning
  behind it — that the route id was the only thing available to scope by — was the error.

- **A `/jobs/new` number failure could surface over a DIFFERENT job** (MEDIUM) — also created here.
  JobDetail is reused across `jobs/:id`, so making the failure loud introduced a new way to be
  wrong: a slow refusal for the create route could raise its toast, or overwrite the number, after
  the operator had opened an existing job. The effect now carries a cancellation flag; the toast and
  both state writes are gated on it. Sentry is deliberately NOT gated — the server failure really
  happened.

- **"Reserve" overstated what `next_job_number()` does** (LOW) — it reads `MAX(job_number)+1` under
  a transaction-scoped advisory lock and returns text. It persists nothing; `save_job()` assigns the
  number that is kept. The operator-facing message, the comments and the test names now say
  *look up* / *preview*, so nobody later treats the preview as durable state.

- **The new source-order pins could be satisfied by a comment** (LOW) — they scanned RAW lines, and
  each pinned region is preceded by a long comment naming the very tokens being searched for. A
  comment-only stripper (strings kept, since the pins locate a call by its RPC name) is now applied
  first, and `stripCommentsAndStrings` was hoisted to module scope alongside it.

- **The scope-aware hook mocks used ONE shared generation counter** (LOW) — so resetting customer B
  would have changed the key later handed back for customer A, which the real per-scope `Map` never
  does. Both `CustomerDetail.test.tsx` and `QuoteBuilder.test.tsx` now model generations per scope.
  This is the same class as the two mock defects already recorded above: a mock that misrepresents
  the contract turns a regression test into an assertion about the mock.

- **`hasRpcCode` was more permissive in tests than in production** (LOW) — the stub matched a code
  appearing anywhere in the message. `CustomerDetail.test.tsx` now imports the real helper.

### Recorded, not fixed

- **Binding the retained key to the submitted PAYLOAD** (MEDIUM, both screens) — the same cross-lane
  dependency already recorded above; PR #535's `fingerprintIntentPayload`. The review adds a sharper
  point: for an unresolved CREATE, minting a new key for a changed payload is not sufficient either,
  because the first create may already have committed. Closing it properly needs a server-side
  receipt lookup by original key, which is a schema-touching change and not this PR's.
- **`/customers/new` and `/quotes/new` share one create scope** (MEDIUM) — already stated as the
  residual of route/target scoping. Same dependency as above.
- **A definitive rejection during a route change leaves the old scope's key in place** (MEDIUM) —
  verified against `main` as PRE-EXISTING: the branch read `if (!error) reset()` before this change
  and retained the key on a raised error exactly as it does now. Not introduced here, and fixing it
  means separating ambiguous from definitive failures in a branch that must stay silent.
- **`assertRpcResult` only rejects null/undefined** (LOW) — a non-null but malformed reply such as
  `{}` still retires the key. True, and a property of the shared helper rather than of these screens.
- **`RelatedNotes` ignores its RPC error and can hang on "loading" forever** (MEDIUM) — a REAL
  pre-existing defect in a different component, surfaced by mocking it out of the JobDetail suite.
  Filed separately rather than widened into this PR.

### Release state

The branch was two commits behind `origin/main` when the review ran (#601 landed
`.claude/schema-registry.json` and `scripts/check-migration-hard-rules.mjs`; no file overlap with
this PR). It is brought up to date after this commit, which is why the reviewed tree and the merged
tree are recorded here as different SHAs.

## Review round 4 — confirming review of the pushed head, and what it found in the round-3 fixes

The head was sent back to `gpt-5.6-sol` because the round-3 fixes had not themselves been reviewed.
It confirmed all six as correct — including, checked from source rather than taken on trust, that
`(quoteId && isEditing) ? quoteId : 'new'` mirrors `p_quote_id` on every path (existing quote before
its fetch, after its fetch, a new quote after `setQuoteId` but before navigation, and a successful
create), that moving the hook below the `quoteId` declaration creates no conditional-hook violation,
that `next_job_number()` inserts nothing and advances no sequence so "look up" is the honest word,
and that every `CustomerDetail.test.tsx` conflict fixture still takes its named branch under the
real `hasRpcCode`.

It also found nine more. Three are fixed here; the rest are recorded.

### Fixed

- **Scoping the key broke the conflict dialog's recovery** (MEDIUM, a NEW interaction created by the
  round-3 fix). `reloadAfterStaleSave` releases the CURRENT render's scope. While one page-wide key
  existed that was always the right one; once scoped, an operator who navigates A → B with A's
  stale-save dialog still open and then clicks Reload would retire B's key and strand A's rejected
  one, so returning to A replays the rejected key and re-opens the same conflict. The recovery is
  now bound to the quote that produced it. Retaining is the safe direction: a retained key can still
  replay, a wrongly retired one cannot.
- **Sentry lost the message on a plain PostgREST error** (LOW). Supabase errors are plain objects,
  not `Error` instances, so `new Error(String(err))` reported `[object Object]` — every job-number
  failure event arrived with no cause. The message is carried across now, and the test asserts the
  captured message contains `INSUFFICIENT_ROLE` rather than merely `expect.any(Error)`, which the
  broken form satisfied.
- **The new route-change test never proved the request was in flight** (LOW). It created a pending
  promise and clicked immediately, so the click could land while `loadLookups()` was still running —
  the test would pass without exercising the race, and would then FAIL against a stricter effect
  that returns early after the lookups. It now waits for the RPC before navigating.

### Recorded, not fixed

- **`stripCommentsOnly` is a scanner, not a TypeScript lexer** (LOW, new). A regex literal
  containing a quote opens a false string state and lets the next line's comment survive; a `//`
  inside a template interpolation survives too; and since strings are deliberately kept, a set of
  string constants naming the call, the assert and the reset would still satisfy all three offsets.
  The same weakness pre-exists in `stripCommentsAndStrings`, which hoisting preserved unchanged. The
  helper's own comment now states all of this rather than implying more. It raises the bar from "any
  comment satisfies the pin" to "only a contrived construct does"; the behavioural tests are what
  actually prove the ordering, and a real AST guard is its own change.
- **The hook mocks still key state only by `intentScope`** (LOW) — the real hook is per-instance and
  keys by `[operation, userId, intentScope]`. The reviewer confirmed the two A→B assertions are
  valid despite this, but resetting a different mocked operation sharing a scope could rotate these
  keys in tests where production would not.
- **JobDetail's cancellation covers only the three writes this PR added** (HIGH, PRE-EXISTING). The
  effect does not check `cancelled` after `await loadLookups()`, and `fetchJob` never reads it at
  all — so job A's late fetch can overwrite job B's loaded form, and a save then targets B while the
  form holds A. Filed separately; fixing it properly needs a request-generation guard threaded
  through `fetchJob`, which is a larger change than this PR's scope and would collide with it.
- **QuoteBuilder can save the previous quote during a route change** (MEDIUM, PRE-EXISTING). Saving
  after A → B but before B loads sends A, because `quoteId`, the form, the key scope and
  `p_quote_id` all still hold A — they agree with each other, which is why the scoping fix is
  correct, but they agree on the wrong record. Filed separately. Note for whoever takes it: any
  guard must keep the scope expression and `p_quote_id` in agreement.

### Verification

The two new guards were mutation-tested: forcing the conflict-scope check true fails the new
QuoteBuilder recovery test; reverting the Sentry construction to `new Error(String(err))` fails the
strengthened JobDetail assertion. The job-number paths were additionally driven in a real browser
against the real `assertRpcResult` and `sanitizeError` through a throwaway harness that stubs only
`createClient` — empty reply, refused permission, and success all render as intended.
