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

## Review round 5 — the Codex GitHub App at `0cd47568`, and the mirror I missed twice

Found at the moment of posting the CodeRabbit request, by checking whether a review already existed
at the exact head. It did not, but a fresh Codex GitHub App finding did.

**`CustomerDetail` had the identical conflict-recovery defect that round 4 fixed in `QuoteBuilder`.**
`reloadAfterStaleSave` releases the CURRENT render's scope, and the stale-save dialog survives a
route change — so an operator whose save on customer A is rejected, who navigates to B with the
dialog open and clicks Reload, retires B's key and strands A's rejected one. Returning to A replays
the rejected key and re-opens the same conflict.

Same fix: the dialog records the scope that opened it, and the recovery releases only that scope.
Applied at all THREE sites that open this dialog — the conflict branch, the row-version recovery
after a successful save, and the crop-update recovery — so the guard is uniform rather than relying
on a null fallback that would permit releasing the wrong scope.

**This is the same mistake twice in one PR, in opposite directions.** Round 1 fixed
`CustomerDetail`'s key scoping and recorded a deliberate decision that `QuoteBuilder` could not be
scoped; round 3 showed that was wrong. Round 4 then fixed `QuoteBuilder`'s recovery path and did not
look at `CustomerDetail`'s — which is where the pattern had started. The durable rule, now recorded
in project memory: **when a reviewer names one instance of a class, treat every mirror site as
guilty until proven innocent, and check the file the pattern came FROM, not only the file it was
copied to.**

### Verification

Mutation-tested: forcing the new scope check true fails the new CustomerDetail recovery test.

Driven in a real browser through the throwaway harness, on the real page with the real
`assertRpcResult`, `hasRpcCode` and `db.ts`: loaded a customer, edited the farm name, saved against
an `IDEMPOTENCY_PAYLOAD_CONFLICT` reply, and the genuine recovery dialog appeared ("This customer
may have changed in another workflow… Your unsaved edits stay available until you choose Reload",
with Keep editing / Reload Customer). Clicking Reload closed the dialog and restored the
authoritative name, discarding the edit as designed — so the guard does not break the flow it
protects.

Incidentally confirmed live in that same browser session: `RelatedNotes` throws
`get_notes_for_entity returned no data` as an UNCAUGHT promise rejection, which is the separate
pre-existing defect already filed rather than fixed here.

## Review round 6 — the abandoned key, and the merge with #610

### The finding

The Codex GitHub App, reviewing head `d8bb7765a`, found the remaining half of the round-4/round-5
fix. Both pages guarded the recovery so it could not release the WRONG scope's key after a route
change — but the dialog still closed, and the originating record's key was then left in the hook's
map with nothing pointing at it. Returning to that record replayed a key the server had already
rejected on payload fingerprint, so the operator earned a second conflict dialog they had done
nothing to cause. Self-healing on the next recovery, but only after that unearned failure.

### The fix, and why it is conditional

The dialog now records WHY it opened, not only which record opened it, because the two reasons have
opposite safe directions once the route has moved on:

- **`IDEMPOTENCY_PAYLOAD_CONFLICT`** — round 6 RETIRED it, on the reasoning that the server had
  already proven this key was bound to a different payload, so replaying it could only ever produce
  the same rejection. **That reasoning was WRONG and round 7 reverted the change — see below. This
  bullet is preserved as the record of a retracted decision, not as current behaviour. Do not
  reinstate it.**
- **`QUOTE_STALE_WRITE` / `CUSTOMER_STALE_WRITE` / `COMMISSION_SPLIT_CONFLICT`** — the opposite
  case. That key may still be the replay handle for an EARLIER save whose response was lost; in
  fact a stale-write refusal is exactly what an earlier silent commit looks like. Retiring it
  would destroy the only means of learning that outcome, so it stays retained until its own record
  is reloaded.

Codex proposed a broader alternative for the round-1 QuoteBuilder thread — keying the retained key
to a fingerprint of the complete save payload, so that editing a field after an ambiguous reply
mints a new key instead of conflicting. That is declined deliberately: an ambiguous reply means the
first write MAY have committed, and a payload-derived key would send the edited retry under a key
the server cannot match to it, which is precisely the duplicate write F1 exists to prevent. The
conflict dialog in that scenario is the system failing closed, not failing.

Applied to both pages in the same commit, rather than to QuoteBuilder alone and CustomerDetail a
round later, which is the mistake this PR has now made twice.

### The merge with `main`

`main` gained #610 while this branch was open — the QuoteBuilder route-switch fix for the
async-load bug class this PR's investigation filed. The two changes touch the same file and the
same flow, so the merge was resolved by content rather than by side:

- `QuoteBuilder.tsx` merged without conflict. #610's `fetchQuote` now refuses to install a snapshot
  once the route has left that quote, which strengthens this PR's recovery guard rather than
  competing with it: the reload the recovery awaits can no longer install the wrong record.
- `QuoteBuilder.test.tsx` conflicted on its import lines only, where both branches had added
  helpers. Resolved as the union — `act`, `RouterProvider` and `createMemoryRouter` from #610,
  `Link` from this branch — with both sides' tests retained and passing.

### Verification

The P1 thread on `JobDetail.billingHazard.test.tsx` reported 26 unhandled rejections and exit 1 for
a specific four-file command. Re-running that exact command on the merged tree: 4 files, 103 tests,
exit 0, no unhandled rejections and no `Errors` line. That finding was already resolved by the
fixture seeding in the preceding commits; GitHub had carried the comment forward onto the new head
because its anchor line still existed.

Mutation-tested: forcing `payloadRejected` false fails the new assertion in BOTH pages' route-change
recovery tests, and nothing else.

## Review round 7 — `gpt-5.6-sol` at `1dc247a36`: the round-6 fix was a duplicate-write hazard

**VERDICT: DO NOT MERGE.** One BLOCKER, and it was against the change round 6 had just shipped. This
section records the reversal and the reasoning, because the wrong version is the intuitive one and
will be proposed again.

### The blocker

Round 6 retired a payload-rejected idempotency key from its ORIGINATING scope when the recovery
dialog was dismissed after a route change. The stated justification — preserved above with its
retraction — was that such a key "can only ever produce the same rejection, so retiring it costs
nothing."

That is false, and it is false in the direction that creates money records:

1. On `/quotes/new` or `/customers/new`, payload P1 is submitted under key K.
2. The server COMMITS the create and caches the result, including the new row's id. The client
   receives `{ data: null, error: null }` and correctly retains K.
3. The operator edits the form to P2 and retries under K.
4. The server compares P2 against the cached P1 fingerprint and raises
   `IDEMPOTENCY_PAYLOAD_CONFLICT`.
5. The route changes; the operator clicks Reload; round 6's branch deletes K.
6. The cached response for P1 — carrying the id of a row that DID commit — can never be replayed.
   A later retry mints a fresh key and inserts the record a second time.

**The key is not only a retry token. It is the receipt.** It rejects the CHANGED payload while still
redeeming the ORIGINAL one, and on a create that receipt is the only deterministic way to learn what
committed. This distinction was stated correctly in this very document, in the "Binding the retained
key to the submitted PAYLOAD" bullet above — and then contradicted twenty lines later. The reviewer
caught the contradiction as a separate finding, which is the cheapest possible way to be told that
one's own document is arguing with itself.

### The reversal

Both pages return to releasing only when the reload that succeeded is for the record that produced
the conflict. When the route has moved on, the originating key **stays retained**, and the
`resetKeyFor` branch, the `payloadRejected` flag and the structured conflict ref are all removed. The
ref is a plain `string | null` again.

The Codex App finding that prompted round 6 is answered on its merits rather than obeyed: an
abandoned key earns the operator one unearned conflict dialog on returning to that record, which
then self-heals on that record's own reload. That is the SAFER state. A spurious dialog is cheaper
than a duplicated quote or customer, and no client-side rule can tell "the operator edited and
retried" apart from "the first attempt may already have committed" — which is precisely what the
idempotency key exists to answer.

**The self-healing claim above holds for an EXISTING record only, and the difference is the
residual this PR ships with.** On `/quotes/new` and `/customers/new` there is no record to return
to: if the reply was ambiguous and the operator EDITS before retrying, the server answers
`IDEMPOTENCY_PAYLOAD_CONFLICT`, and the client holds neither the original payload nor the created
row's id. Reload cannot resolve it — `quoteId` is still null — so the operator's only exit is to
leave the page, which discards the key map and lets the next create mint a fresh key and duplicate.

This is a RESIDUAL, not a regression, and it was verified against `origin/main` rather than
reasoned about: main resets the key BEFORE `assertRpcResult` (`CustomerDetail.tsx:834-835`,
`QuoteBuilder.tsx:1573-1574`), so today's live behaviour is a SILENT duplicate on the plain retry
path with no edit at all. This PR makes that plain retry replay safely and narrows the failure to
one that requires an edit first, fails visibly, and duplicates only if the operator then abandons
the page. Strictly better, and not closed.

**Its proper close is a server capability, not a fourth client patch:** a receipt lookup by
`(operation, key)` that returns the original outcome without requiring the caller to reproduce the
original payload. That one addition also closes the shared `'new'` scope for two consecutive
creates on one mount, and it is what #535's `fingerprintIntentPayload` was aimed at. Every option
available to the client alone is a choice between a silent duplicate and a visible dead end.
Tracked as its own lane.

The two round-6 tests that asserted the retirement are inverted to assert retention, with the
reasoning inline. The reviewer flagged them separately: they had staged an immediate
`IDEMPOTENCY_PAYLOAD_CONFLICT` with no prior cached receipt, a sequence the real server cannot
produce, and so locked the unsafe behaviour into the suite behind a causally impossible mock.

### What this round says about the proof that preceded it

Round 6 was pushed with CI green, lint and typecheck green, a 4999-test suite green, a mutation test,
and a live browser proof in which the bug was reproduced and then shown fixed. All of it held. The
browser proof exercised the EDIT path; **the blocker lives on the CREATE path**, which it never
touched. A proof that runs the wrong half of the state space is not weak evidence — it is confident
evidence about the wrong thing, which is worse, because it ends the search.

### Findings routed elsewhere, not fixed here

- **HIGH** — a late `save_quote` response installs quote A's row version, commission baseline,
  dirty-clear and success toast over quote B. The pre-send guard does not cover state written after
  the request starts. Same bug class as #610/#611/#616 in a path none of them covered; routed to the
  QuoteBuilder lane.
- **HIGH** — `JobDetail`'s `fetchJob` never receives the effect's `cancelled` flag, so job A's
  response still overwrites job B. Pre-existing; routed to the #611 lane to confirm against its
  current head, which rewrote that ticketing.
- Lower-severity findings on float money math in the quote totals, `searchParams` over-triggering
  the JobDetail load effect, and the lexical ordering pin's false-pass shapes are recorded in the
  proof artifact and left to their owners.

## Round 8 — CodeRabbit, and two defects in the fix itself

CodeRabbit reviewed the merge candidate and requested changes. Two of its Major findings were real,
and both were in this branch's own work.

**The receipt check was never actually checking the receipt.** The save handlers were reordered in
an earlier round to "verify first, retire second", and the verification was `assertRpcResult`. But
`assertRpcResult` rejects only a MISSING reply — `null` or `undefined`. An empty object passes
through it untouched. So `save_quote` or `save_customer` answering `{}` with no error reached the
caller looking like a success, and the key that was the only way to learn what that save had done
was retired anyway. On a create there is no committed id to fall back on, so the operator's retry
minted a fresh key the server could not recognise and wrote the record a second time — the exact
duplicate this branch exists to prevent, reintroduced by the fix for it.

QuoteBuilder made it worse than a missed check: `result.quote_id || quoteId` fell back to the id in
the URL, so on an edit route an unverified save reported itself as confirmed. Both pages now test
the reply with a shared `hasReceiptId` before retiring anything, and the URL fallback is gone.

The round-7 tests did not catch this because they staged `data: null` — the half of the ambiguous
space `assertRpcResult` already rejects, so they passed against code that retires first and checks
later. The `{}` half, which is the half that reaches the caller, was untested on both pages. Two
repo-wide source pins had the same blind spot and were tightened rather than relaxed: they now
require the receipt test, not the weaker `data != null`.

**A recovery dialog claimed an origin it did not have.** Only ONE of QuoteBuilder's eleven dialog
openers is a `save_quote` conflict; the other ten are lifecycle actions — decline, email, version
restore, convert, book-as-order — that own no `save_quote` key at all. CustomerDetail's crop toggle
is the same shape, and crop buttons stay enabled while a save is in flight. Round 7 recorded the
save scope at every opener, which fixed the previous-record leak but told the reload that a
lifecycle recovery was a save recovery, so it retired a save receipt whose own reply had never been
validated. Openers that are not save conflicts now record `NON_SAVE_RECOVERY`, and the release
requires an exact scope match instead of also releasing on `null`.

That change also removed a hazard round 7 had to work around: the two memoized openers needed
`saveQuoteIntentScope` in their dependency lists or they would stamp the scope captured at first
render. A module constant cannot go stale in a closure, so the dependency — and the trap — are gone.

One existing test asserted two key releases on a version-action recovery. The second of those was
the coupling itself; it now asserts one, with the reason inline.

All four new tests were mutation-proven: each was run against the code with its fix removed and
each failed, and only it.

### Findings answered but not fixed here

- **CodeRabbit, JobDetail `fetchJob` stale route responses** — the repo-wide async-load class, owned
  by #611. This branch never touched that file.
- **Codex P2 ×2, retire the rejected key for the originating saved record** — declined, consistent
  with the round-7 retraction. Retiring on a payload conflict is what risks the duplicate; the cost
  of retaining is one unearned conflict dialog that the next reload clears. The residual is named
  above and its proper close is the server-side receipt lookup, not a fourth client patch.

## Round 9 — integrating #618, and a mock that made correct code look broken

CodeRabbit's next pass raised one Major: a late `save_quote` reply installing quote A's state over
quote B. That is #618's subject, and #618 merged to `main` while this branch waited — so the fix
already existed and this branch simply did not have it. Merging `main` brought it in, with a real
conflict in `QuoteBuilder.tsx` and its test file, since both branches rewrote the same save handler.

Resolved by content: #618's `editingSessionChanged()` route guard and this branch's receipt test
both survive, in that order — verify the reply, retire the key, then refuse to apply post-save state
to a quote the operator has left. #618's comment claimed the guard sat "after the reply is
verified", which was true only of `assertRpcResult`; the receipt test is what makes the sentence
true, and it is why the reset now sits below it rather than above the assert as it did on `main`.

**The instructive part was a defect in this branch's own test harness.** After the merge, eight
tests failed with the page stuck on its loading skeleton. The component was fine — proved by running
#618's own unmodified test file against the merged component, which passed 48 of 49. The fault was
that this branch's `useIdempotencyKey` mock returned a fresh object literal on every render, where
the real hook returns `useCallback`-stable functions. #618 had made `resetSaveQuoteIdempotencyKey` a
dependency of `fetchQuote`, so an unstable identity re-created `fetchQuote` every render, re-ran the
load effect, and loaded forever. **A mock that was unrealistic in a way nobody had needed before made
correct production code look broken.**

Fixing the mock exposed a real one underneath. The scoped `resetKey` legitimately changes identity
when the scope changes, and the scope derives from `quoteId` STATE, which lags the route — so every
navigation re-created `fetchQuote` and loaded each quote twice. That is a genuine defect of the two
changes meeting, invisible to either branch alone, and it broke #618's own A → B → A load-ordering
tests. The reopen now retires the key by name with `resetKeyFor(q.id)`, which is memoized on
`[operation, userId]` and does not move.

Stated rather than implied: retiring by name also removes a dependence on the rendered scope
happening to be `q.id` at that moment. It is today — a mutation of that line back to `resetKey()`
still passes the whole suite — so the wrong-target failure is **not** a bug observed here and is not
claimed as one.

Four of #618's tests asserted the page-wide key spelling (`test-idem-key-1`). Updated to the scoped
form, with the reasoning corrected rather than the numbers alone: #618 needed the key to ROTATE off
quote A's committed save before quote B could safely reuse it, and scoping means B never held A's
key to begin with. The hazard is gone rather than re-checked, and the assertion still binds it,
because a regression to a page-wide key would produce a different spelling.

Proof: the identity fix is mutation-proven — restoring the unstable dependency fails exactly the
three A → B → A load-ordering tests and nothing else. Suite 351 files / 5025 passed / 123 skipped;
typecheck, lint and build clean.
