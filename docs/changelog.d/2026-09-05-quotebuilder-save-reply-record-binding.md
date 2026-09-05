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
  slow connection. Both sequences are proven at the page level with the real component and
  the real router.
