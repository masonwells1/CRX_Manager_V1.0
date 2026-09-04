## 2026-09-04 — PR #588 review follow-ups: make the money-precision refusal visible where review found it silent

Mason asked for a CodeRabbit review and a fresh Codex review of PR #588 (money inputs refuse
amounts with more than two decimals). CodeRabbit (2 findings) and the Codex GitHub App (2
findings) reviewed the frozen head `010f0c686`; the exact-SHA Codex push proof on that head was
CLEAN with one LOW. Every finding was verified against the current code and fixed in one commit.

**What changed.**

1. **`src/pages/PaymentAllocation.tsx`** (CodeRabbit). A refused check amount parsed to `null`,
   which the page coerced to `0` — that hid the payment summary and disabled both Auto-Allocate
   and Apply Payment, so the handler toasts that name the reason could never fire. The operator
   typed `12.345` and nothing happened. `MONEY_PRECISION_MESSAGE` now renders directly under the
   Check Amount field (`role="alert"`, `aria-invalid`, red border) while the buttons stay
   disabled. New page test: types `12.345`, sees the message and no toast, corrects to `12.34`,
   sees it clear.
2. **`src/pages/CallLists.tsx`** (Codex App P2). The prepay threshold was validated AFTER the
   rows were cleared and the request sequence bumped, so a refused value left the page saying
   "This call list is clear" for a list that was never re-queried. Validation now runs before any
   state changes. New test: the applied rows survive, the toast names the field, no RPC fires.
3. **`src/pages/FieldAppSplitInvoiceEditor.tsx`** (CodeRabbit). `dollarsToCents()` returned `null`
   for both "not entered" and "refused", so `validateForSave()` reported "no valid positive
   amount" for a typed `12.345`. A `hasExcessPrecision()` check now runs first and names the
   real cause for the line, flat-fee and per-person override prices; a blank still gets the
   existing message.
4. **Agent guidance** (Codex App P2): `.claude/agents/compliance-reviewer.md`,
   `.claude/hooks/money-safety.mjs`, `.claude/hooks/session-context-reminder.mjs` and
   `docs/build-loops/field-map-ux/LOOP_PROMPT.md` still said the shared parser "currently
   truncates excess precision", which would make later reviews flag the now-compliant callers.
   They now state the refuse-with-`null` contract and name coercing `null` to `0` as the thing
   to flag. `npm run test:agent-workflows` (adapter parity) passes.

**DEFERRED, not decided (needs an owner call).** Codex proof LOW: `PrepaymentManagerPanel`
drops a zero-valued bucket split (`0.000` included) before the precision check, so that one
input silently ignores an excess-precision zero while every other money input refuses it. The
money impact today is nil (the value is zero; a non-zero excess-precision split is still refused
by label), but the inconsistency is not intentional design. Left as-is in this PR; Mason decides
whether a zero split with extra decimals should be refused like everything else. A second LOW
from the follow-up proof, `NewVendorBill`'s header total preview showing a refused field as
`$0.00` before the save path refuses it by name, is display-only and already recorded in the
2026-09-03 entry.

**Proof observed.** `vitest` 85/85 across the four touched suites (two new cases), `tsc` clean,
`eslint` clean on the five source files, adapter parity PASS. Browser (real pages in the
gitignored stubbed-data Vite harness, fake rows only, no login):
- Payments: picked a customer, typed `12.345` in Check Amount → the red line "Enter an amount
  with no more than two decimal places." appeared under the field, `aria-invalid="true"`,
  Auto-Allocate disabled, no RPC recorded, no console errors. Corrected to `12.34` → line gone,
  `aria-invalid="false"`.
- Call Lists (Prepay prospects, one fake row on screen): set Minimum prior spend to `12.345`,
  clicked Apply and refresh → toast "Minimum prior spend: Enter an amount with no more than two
  decimal places.", the row stayed on screen, no "This call list is clear", no new RPC.
  Corrected to `12.34` → the list RPC fired with `p_min_prior_spend_cents: 1234`.
- `FieldAppSplitInvoiceEditor` was not driven in a browser (its save validation stops earlier on
  the unresolved default split in the harness); covered by typecheck and the existing suite.
