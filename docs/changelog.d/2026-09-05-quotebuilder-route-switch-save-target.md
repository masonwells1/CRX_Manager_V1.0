## 2026-09-05 — QuoteBuilder: a route change can no longer save the quote the operator left

`src/App.tsx` routes both `quotes/new` and `quotes/:id` to one `<QuoteBuilder />` with
no `key`, so navigating between two saved quotes re-runs the id effect on the **same
mounted component**. `quoteId`, the form contents and the `p_quote_id` save target all
survived the navigation, which produced two ways to write to the wrong record. Found by
the exact-SHA `gpt-5.6-sol` review of PR #603 head `5dad64e2` (rated MEDIUM);
pre-existing on `main`, not introduced by #603.

1. **A → B, save before B loads.** The URL said B while `quoteId`, the form and
   `p_quote_id` were still A. The operator saved A while looking at a page they believed
   was B.
2. **A → B → C with B slower than C.** `fetchQuote` installed its result without
   checking whether its request had been superseded, so C loaded and was then replaced
   by B's late response. A later save targeted B while the route said C.

### What changed (`src/pages/QuoteBuilder.tsx`)

- `fetchQuote` re-checks **two independent conditions** after **every** await, and a load
  failing either returns `false` having installed nothing — not the form, not `quoteId`,
  not the row-version token — and without touching toasts, navigation or `loading`.
  - **A load serial** orders *calls*, so reopening the same quote twice still resolves to
    the newer call rather than to whichever reply happens to land last.
  - **A route binding** ties a call to a *record*, comparing the id the load was started
    for against a ref holding the id the URL currently names (captured during render, so
    it is already correct for any effect or handler on the new route).

  Both halves are required, and neither subsumes the other. `fetchQuote` is also called
  from two stale closures that survive a navigation — the stale-save reload
  (`reloadAfterStaleSave`) and the post-conversion refetch — and such a call **mints the
  newest serial for the quote the operator already left**. A serial check on its own would
  therefore have *certified* that stale snapshot as current instead of rejecting it, which
  is worse than no guard. The two operands come from genuinely independent sources: this
  component's own call order, and the router.
- The id effect sets `loading` back to `true` on a route change, so the previous quote's
  form is replaced by the skeleton rather than presented as current.
- `saveQuote` fails closed when `isEditing && quoteId !== id`, before any validation or
  RPC. This is the backstop for the reachable case the skeleton does not cover: a load
  that **errors** clears `loading` while deliberately keeping the operator's existing
  edits on screen, leaving a live Save button over the record they navigated away from.
  Refusing before the RPC also means no idempotency key is ever minted against the wrong
  quote, so the save target and the key scope cannot diverge.

The previous snapshot is deliberately **not** cleared on transition. The existing error
path preserves an operator's unsaved edits on purpose ("Your current edits were kept");
blanking the form would destroy real work whenever a load failed. The skeleton hides the
stale snapshot for the whole successful transition, and the save refusal covers the
failed one.

### Proof

Five regression tests added to `src/pages/QuoteBuilder.test.tsx`, mounting the real page on
a real data router (`createMemoryRouter`, using App.tsx's own `/quotes/:id` pattern so both
ids resolve to the same route and the element is reused rather than remounted) with
deliberately gated loads:

| Test | The one guard that catches it |
|---|---|
| stops presenting quote A once the route points at a quote B that has not loaded | route-transition `loading` |
| drops quote B late response after the operator has moved on to quote C | the load guard |
| keeps the newer load of the SAME quote when the older one lands last | the **call-serial** half |
| refuses a reload started from a stale closure holding the newest load serial | the **route-binding** half |
| refuses the save when a failed switch leaves quote A on screen under quote B's address | the `saveQuote` refusal |

- The first three failure modes were run against the unfixed source and **failed**.
- Every guard was then disabled **individually** — including each half of the load guard on
  its own — and the suite re-run. **Exactly one test failed each time.** The two same-quote
  and stale-closure tests exist specifically because every other test navigates between
  *different* quotes, where the route binding alone suffices: without them, the call-serial
  half could have been deleted against a fully green suite.
- `npm run typecheck`, `npm run lint`, `npm run build` clean.
- `npm run test`: exit code 0, no failures and no `Errors` line.

### Not verified

Not exercised against the live app in a browser — the failure needs two real quotes and
a slow network, which is not reproducible on demand in this environment. The five
sequences are proven at the page level with the real component and the real router.
