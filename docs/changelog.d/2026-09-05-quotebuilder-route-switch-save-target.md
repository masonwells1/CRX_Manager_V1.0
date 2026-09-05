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

- `fetchQuote` takes a load serial number and re-checks it after **every** await. A
  superseded load returns `false` having installed nothing — not the form, not
  `quoteId`, not the row-version token — and without touching toasts, navigation or
  `loading`.
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

- Three regression tests added to `src/pages/QuoteBuilder.test.tsx`, mounting the real
  page on a real data router (`createMemoryRouter`) with deliberately gated loads, one
  per failure mode.
- Each test was run against the unfixed source and **failed**. Each of the three fixes
  was then disabled individually and re-run: exactly one test failed each time, so no
  test is passing on a different fix's behaviour.
- `npm run typecheck`, `npm run lint`, `npm run build` clean.
- `npm run test`: exit code 0, 349 files / 4979 passed / 123 skipped, no failures and no
  `Errors` line.

### Not verified

Not exercised against the live app in a browser — the failure needs two real quotes and
a slow network, which is not reproducible on demand in this environment. The three
sequences are proven at the page level with the real component and the real router.
