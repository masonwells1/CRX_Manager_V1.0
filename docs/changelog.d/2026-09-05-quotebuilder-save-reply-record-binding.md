## 2026-09-05 — QuoteBuilder: a save's REPLY can no longer land on the quote the operator moved to

#610 made `saveQuote` fail closed when the loaded quote is not the quote the URL names.
That check runs **before the request is sent**, so it cannot cover anything written
**after the reply lands** — and `save_quote`'s reply installs a great deal: the
authoritative row-version token, the commission baseline, `setQuoteId` on a create, the
stale-write recovery dialog on failure, and via the return value the callers' dirty-clear,
success toast and navigation.

Navigate between two quotes while a save is in flight and all of that lands on the wrong
quote. `runWithBelowCostApproval` can also park that await on an operator decision, so the
window is not only a round trip — it is however long a below-cost approval dialog stays
open.

Found by the exact-SHA `gpt-5.6-sol` review of PR #603's head `1dc247a36`, rated HIGH, and
routed here. Verified from source on `main` at `069354b97` before acting. Same bug class as
#610, #611, #616 and #604; a different code path, and **#610 did not cover it**.

### The damage is worse than "wrong toast"

Reproduced against unfixed source: quote A's reply carries A's next token, which does not
line up with quote B's loaded version, so the row-version resolver treats it as a recovery
case and **clears quote B's token**. Quote B's next save then goes out with
`row_version_expected: null` — that is, with its lost-update protection switched off. The
regression test asserts on exactly this.

### What changed (`src/pages/QuoteBuilder.tsx`)

`saveQuote` captures which record the request belongs to *before* sending it, and re-checks
after the reply in two places:

- **On the error path**, before the stale-write recovery dialog or a bare error toast. Quote
  A's failure is not quote B's. It is not swallowed either — the operator left believing the
  save succeeded, so the toast **names the quote**, because the page they are looking at is a
  different one and an unqualified failure would read as that quote's. This path deliberately
  does **not** touch the idempotency key: the request failed, so the key must survive for the
  retry (F1), exactly as on the in-route error paths.
- **On the success path**, after the reply is verified and the key rotated, before anything
  is installed. Returning `null` is what suppresses the callers; all four gate their
  post-save work on a non-null id (verified at each call site, not assumed).

Placement on the success path is deliberate and was corrected during the work. An earlier
version rotated the key in a second, earlier place, which added a new
reset-before-verify call site — the very ordering `src/__tests__/idempotency-reset-order.test.ts`
pins this file against. That guard failed the build and was right to. The single existing
rotation is now reused: the save committed wherever its reply lands, so retiring its key
stays correct, and a later unrelated save cannot replay this committed result.

### Proof

Two regression tests added to `src/pages/QuoteBuilder.test.tsx`, on the real-router switch
harness #610 introduced (real page, real `createMemoryRouter`, `quotes/:id` so both ids
resolve to the same route and the element is reused rather than remounted).

| Test | The one guard that catches it |
|---|---|
| drops a late `save_quote` reply for quote A rather than installing its token on quote B | the **success-path** check |
| keeps quote A's failed save off quote B, and says which quote failed | the **error-path** check |

- Both **fail** against unfixed source.
- Each half was then disabled individually and the suite re-run. **Exactly one test failed
  each time.**
- The idempotency-key rotation is pinned too: test 1 asserts quote B's next save carries a
  rotated key, and removing the rotation fails it. That assertion exists because the comment
  claiming the rotation was necessary should not be the only thing holding it.
- `npm run typecheck`, `npm run lint`, `npm run build` clean.
- `npm run test`: exit code 0, 351 files / 5002 passed / 123 skipped, no failures, no
  `Errors` line.

### Review round — exact-SHA `gpt-5.6-sol` on this branch (head `bb2827d7b`)

Verdict BLOCKERS, two findings. Both were checked against source before disposition.

**CRX-1 (High) — accepted and fixed.** The first version of this fix bound the reply to the
route id alone. A route id is not unique over time: leave quote A for B and come back, and it
matches again, so the abandoned reply is accepted into a **different editing session of the same
quote** — clearing the dirty flag and toasting "Quote saved as draft" over edits made after the
return, which were never in that request. Silent loss of quote edits.

The guard now carries **two operands with independent sources**: the route id *and*
`quoteLoadSerialRef`, the per-load serial that returning to quote A necessarily bumps. Each is
load-bearing and neither subsumes the other — the same pairing, and for the same reasons, already
documented at `quoteLoadSerialRef`'s declaration and used by `fetchQuote`. The serial alone would
be certified by a stale-closure call holding the newest serial; the route alone is the hole above.

Proven, not asserted: with the guard reverted to route-only, the new test fails on
`toast('success', 'Quote saved as draft')` firing over the reloaded quote — the defect in plain
sight. Exactly that one test fails; the other 43 in the file pass.

The error path took the same second operand. Latching `quoteVersionRecoveryRequiredRef` on the
return-to-A path would have stranded a freshly loaded quote behind a "reload before saving" gate
it had already satisfied.

**CRX-2 (Medium) — hazard agreed, proposed fix declined, with reason.** `useIdempotencyKey('save_quote', …)`
is scoped by operation and user but not by quote, so quote B can inherit quote A's unresolved
retry key. That is real. It is also **pre-existing and unchanged by this diff**: the generic error
path already retained the key, and the new moved-route branch retains it on exactly the same F1
grounds.

The proposed remedy — pass a record scope to the hook — was already tried in this repo and
deliberately reverted. `src/__tests__/idempotency-reset-order.test.ts` names QuoteBuilder in its
excluded list: route-id scoping "would NOT match what the RPC targets and would give false
assurance", because `save_quote` targets component state `quoteId` rather than the route, and
`/quotes/new` has no route id at all. Its round-4 HIGH adds the sharper reason: route scope binds
the record, not the payload, and `save_quote` carries the entire quote payload — a per-record
retained key would replay the FIRST payload while the screen shows the edited one. Correct binding
needs payload-level intent, which is tracked as follow-up in `docs/manual/KNOWN_ISSUES.md`.

Adopting the suggestion here would have re-landed a reverted change and traded a Medium for a
High. It stays out of this diff, and this paragraph exists so the next reviewer does not have to
rediscover why.

### Second review round — P2 at `a9793c311`, accepted and fixed at the root

> `fetchQuote(B)` increments this global serial before rejecting itself because the route is A.
> If A has a save in flight, `editingSessionChanged()` therefore treats that unrelated rejected
> load as an A session change and returns `null` after A's save committed.

Correct, and it is a defect **this branch introduced**: before the save guard read the serial,
a doomed load could not affect a save at all. Note the direction of failure — the save
*commits*, the database is right, and only the on-screen confirmation is suppressed. The
operator sees an apparently unsaved quote, saves again, and lands in stale-write recovery on a
document that drives cost and price.

Fixed at the cause rather than by swapping operands. `fetchQuote` took its serial on the first
line and only checked the route *after* its awaits, so a load for a quote the operator had
already left still **burned a serial on its way to rejecting itself**. The serial is a shared
resource; spending one is never free. The route check now runs **before** the increment, so a
doomed load turns round at the door.

This also removes a pre-existing live defect on the load path, not just the one against the new
save guard: a doomed load that steals the serial supersedes the legitimate load of the quote now
on screen, which then installs nothing while `loading` stays true — the page strands behind a
skeleton that never clears. That is the same failure proven live on `main` for CustomerDetail in
#616, and this is the same door-refusal discipline used there.

Rejected the alternative of adding a third ref that counts only route commits. It would have
left the ticket theft in place — still stranding the load path — and bought a second counter to
work around a bug rather than fix it. Reachable through both surviving-closure callers: the
delayed post-conversion `fetchQuote(savedId)` the reviewer named, and `reloadAfterStaleSave`.

Proof: a fourth regression test fires the reload dialog's closure for quote A while the route is
on quote B and asserts the doomed load issues **no database read at all** — no read, no serial
consumed. Removing the door refusal fails exactly that test, and the failure shows the extra read
(3 → 4).

### Third review round — P2 on the wording, accepted

> When the operator navigates away and the RPC response is lost after PostgreSQL commits,
> Supabase surfaces the network failure through this same `error` branch, so the toast
> incorrectly guarantees that the changes "were not stored."

Correct, and it contradicted the reasoning three lines above it in the same function. The key is
retained on this path **because the outcome is unknown**; the message then told the operator the
save definitely did not happen. A reply lost in transit after the database committed arrives
through exactly this branch, and the operator is not even looking at this quote to check.

The message now says the save could not be **confirmed**, and what to do: reopen it, and save
again if the changes are missing. The retained key is what makes that retry safe if it did in
fact commit. The regression test now pins both halves — the quote is still named, and the message
must not assert a rollback.

### Not verified / flagged, not fixed

- The `catch` block's toast is still unguarded: a malformed reply for quote A, which makes
  `assertRpcResult` throw, would toast over quote B. Pre-existing, on an already-anomalous
  path, and left alone to keep this diff narrow.
- The conversion path at the `status === 'accepted' && quoteId` branch skips `saveQuote`
  entirely and awaits `convert_quote_to_order` with a `quoteId` read before that await. It
  looks like the same class of stale-reply hazard on a different RPC. Not investigated here.
- `routeQuoteIdRef` is written during render on this page, whereas `CustomerDetail` writes
  its equivalent in a layout effect and documents why render-time writes are unsafe. For the
  save path the render-time write fails **closed** (a discarded render can only cause a
  legitimate install to be refused, never a stale one to be accepted), so it is not a defect
  here — but the two pages disagree and one of them should change.
- Not exercised against the live app in a browser: the failure needs two real quotes and a
  slow connection. All three sequences are proven at the page level with the real component
  and the real router.

### The rest of this page is NOT covered, and the inventory says so

Prompted by a peer lane's warning that #611 widened from three named sites to six and still
missed a seventh, the whole file was enumerated rather than trusting the sites the reviewer
named. **A reviewer names the sites it looked at, never all of them.**

`src/pages/QuoteBuilder.tsx` declares 29 async functions. Exactly two carry a record guard:
`fetchQuote` and, as of this change, `saveQuote`. The other 27 await and then write screen
state with no binding to the record they started on.

The sharpest instance is navigation. Seven `navigate()` calls fire **after** an await inside
unguarded handlers — `handleSelectTemplate`, `handleRollover`, `handleScheduleJob`,
`handleDrawDown` (two), and `executeConvertToOrder` (two). Each can pull an operator who has
moved on to another screen back to a record they left. Several of them also create orders and
jobs, so their reply handling is worth more scrutiny than a quote save's.

Two more found while checking this change, both pre-existing and both left alone:

- **A save that settles after the page is gone.** `handleSaveDraft` ends with
  `if (!isEditing) navigate('/quotes/' + result)`. `quotes/new` and `quotes/:id` are separate
  routes in App.tsx, so leaving `/quotes/new` unmounts this component — and unmounting runs no
  route effect here, so **both** of this change's operands still match and the guard permits the
  navigate. Create path only, no data loss: the quote really was created. Not fixed here because
  proving it needs a create-path harness this file does not have, and shipping an unproven guard
  on a money page is worse than a recorded gap. The fix is a mounted flag folded into the same
  predicate.
- **The continuation after the save.** Once `saveQuote` returns, `handleSaveDraft` awaits again —
  `create_planned_holds`, then `loadActivePlannedHolds` — and toasts on the result without
  re-checking. The guard covers the save's own reply, not what the handler does afterwards.

None of this is a regression from this change; it is the same bug class, unowned, on the rest of
the page. It is recorded here so the next lane starts from the list instead of rediscovering it
one review round at a time.

### Fourth review round — High at `d6b12058b`, accepted in part

> **Below-cost approval can mutate an abandoned quote.** The new session guard runs only after
> `runWithBelowCostApproval()` finishes. That wrapper can display its global approval modal and
> then retry the mutation before the checks below run. (1) Save quote A below cost. (2) Navigate
> to quote B while the first attempt is awaiting its response. (3) The approval modal appears over
> B without identifying A. (4) "Approve and Retry" writes A's captured pricing/status. (5) The new
> guard then drops the success response, concealing that A changed.

Verified from `src/contexts/BelowCostApprovalContext.tsx`: the runner awaits `attempt(null)`,
parses the below-cost error, awaits an operator reason from a modal mounted **above the route**,
then calls `attempt(reason)` again. Both halves of the reproduction are real, and they are two
different problems with two different owners.

**Fixed here — the retry is refused before it is sent.** The retry callback belongs to this file,
and `reason` is non-null only on the retry, so `saveQuote` can decline its own second send without
touching the shared context. An approval collected while the operator was looking at a different
quote is not consent to write this one, so it is not spent on it. The first attempt was rejected by
PostgreSQL, which rolls back, and the retry never goes out — so the outcome here is genuinely
**known**, and unlike the lost-reply message above, this message is entitled to say the quote was
not saved. It names the quote and says to reopen it and save again.

Refusing the send also removes the concealment the finding's step (5) describes: with nothing
written, there is no success to drop.

**Not fixed here, and not this branch's to fix — `BelowCostApprovalModal` never says which record
it is approving.** It shows a product name, a price, a cost and a shortfall. The operator is asked
to approve a below-cost price with no way to see which quote it belongs to. That is a consent
defect in a shared component on a money path, and this page is not its only caller:
`restore_quote_version` (:2376), `draw_down_quote` (:2565) and `convert_quote_to_order` (:2785)
route through the same modal and would each need the same treatment. Flagged for Mason as a
separate decision rather than widened into this diff.

**Proof.** Two tests, both on the **real** `BelowCostApprovalProvider`, mounted above the router
the way `App.tsx` mounts it — not a stand-in runner, because the hazard is a property of the real
one: its dialog, and the send parked behind it, survive a navigation.

| Test | What it holds |
|---|---|
| sends the below-cost retry when the operator is still on the quote being approved | the positive control: without it, a dialog harness that never produced a retry would satisfy the refusal test perfectly |
| refuses the below-cost retry for quote A once the operator has moved to quote B | the fix |

With the refusal disabled, exactly one test fails, and it fails on the defect itself: `save_quote`
was called a second time — quote A written from an approval given while quote B was on screen.

**One shared guard was widened to keep counting this call site.**
`src/lib/assertRpcCoverage.test.ts` recognised a wrapped RPC only when the runner callback's body
*is* the `supabase.rpc(...)` call. Adding a check before the call turned that arrow into a block
and the call site stopped being counted at all — the guard failed **open**, reporting the file as
an orphan assertion rather than reporting the RPC. It now also matches a block-bodied runner
callback, stopping at the first `supabase.rpc` inside it. Every file in `src/` was scanned before
the change: this is the only block-bodied runner callback in the repo, so no other file's count
moved, and the baseline stays at zero.

- `npm run typecheck`, `npm run lint`, `npm run build` clean.
- `npm run test`: exit code 0, 351 files / 5006 passed / 123 skipped, no failures, no `Errors` line.
