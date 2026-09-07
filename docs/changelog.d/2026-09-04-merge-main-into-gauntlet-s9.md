## 2026-09-04 - Merge origin/main into the Section 9 gauntlet branch (PR #535)

Resolves the 7-file conflict between PR #535 and `main` at `f5563ccdb`. Every conflict was
resolved by content — no `--ours` / `--theirs` on any file, and neither side's assertions were
dropped.

### The money parser — both rules now hold at once

`src/lib/parseCents.ts` had two independent money rules colliding in one region:

- **From `main` (#588):** `parseDollarsToCents` / `parseDollarsToCentsSigned` return `number | null`
  and REFUSE more than two fractional digits instead of truncating, plus the shared
  `MONEY_PRECISION_MESSAGE`.
- **From #535:** `isWholeCentDollarInput`, whose closing `Number.isSafeInteger(...)` bound rejects
  amounts too large to be exact whole cents.

Both survive. They are genuinely independent: `isWholeCentDollarInput`'s regex already caps decimals
at two, so the parser's new `null` return is unreachable from inside it — neither rule is quietly
doing the other's job. `Number.isSafeInteger` is declared `(number: unknown)`, so the `number | null`
argument typechecks, and `Number.isSafeInteger(null)` is `false`, which refuses in the correct
direction. Confirmed by `npm run typecheck`, not assumed.

The `isWholeCentDollarInput` doc comment claimed "the legacy parsers ... truncate extra fractional
digits". After this merge they refuse instead, so that sentence was false and has been rewritten.

### Test files — the resolution that compiles while deleting a safety check

`main` had **deleted the entire `describe('isWholeCentDollarInput')` block** (15 cases), correctly,
because that function does not exist on `main`. Taking either side wholesale compiles, runs green,
and silently drops one lane's guard. Both sides are kept; `main`'s deletion of
`it('truncates beyond 2 decimals')` is accepted, since that test asserts the superseded behaviour.

Declaration-count conservation, checked against both parents: ours 40, theirs 45, resolved **51**
(= 45 + our restored 5 + 1 new). The new case pins that the two rules stay independent.

`rpcIdempotencyScope.test.ts`: each side added different keys to `INTERNAL_OPERATION_REFERENCES`.
All four entries and both comments kept — dropping either side's keys breaks the scan.

### Pages

`NewVendorBill.tsx` / `VendorBillDetail.tsx`: `main` never had the PO-overage confirmation flow, so
the apparent deletions were #535's additions. The overage flow, the `currentBillIdRef`
route-generation guard, and `setEditing(false)` in `finally` are all intact. Both money checks are
kept — `isWholeCentDollarInput` also bounds magnitude and rejects `$`-formatted input, which the
parser's null return does not. Two questions were settled from the real merge base rather than
guessed: `fmt()` is #535's improvement over the base's `.toFixed(2)` and stays; and `handleSave`
already has a `finally { setSaving(false) }`, so neither parse ordering could strand the button.

The overage banner reset is deliberately placed AFTER the precision refusals — those are validation
bounces too, and clearing the banner there would drop the explanation while the pending request that
caused it is still unresolved.

### F1 ordering guard — four correct sites were being reported as defects

Merging surfaced a real integration failure: `main`'s new `idempotency-reset-order.test.ts` flagged
four reset sites that #535 introduced. All four were verified in source as CORRECT, and the guard
was the thing that needed fixing:

- `classify()` recognised only two recovery markers. #535 uses a third,
  `getIdempotencyBindingRejection` (INTENT/ACTOR mismatch, or an unusable receipt — nothing committed
  under that key, so retiring it is what lets the retry mint a fresh one). Added.
- `classify()` read only the lines ABOVE a reset, so the single-line form
  `if (marker(error)) idem.resetKeyFor(scope);` was unclassifiable. That form is the STRONGEST
  same-branch evidence available — there is no room between marker and reset for a branch to open —
  so it is now matched on the reset's own line.
- `CycleCounts.tsx`: the reset moved INSIDE the `try`, immediately after the awaited
  `.throwOnError()`. Behaviour is unchanged (the catch rethrows on every path, so it was already
  reachable only on success); it is now adjacent to the call it retires instead of sitting past a
  catch block, which is what makes its reason locally verifiable.

Recognising the third marker also re-classified `VendorBillDetail.tsx:573`, which had been passing
as `throw-on-error` — laundered by a `.throwOnError()` above it in the window. Its true reason is
`recovery`; both are now declared. That is the exact laundering this per-site scheme exists to stop,
and it was passing for the wrong reason before this change.

**Mutation-proven, not assumed:** stripping the `if (getIdempotencyBindingRejection(error))`
condition from `InventoryPage.tsx:732` makes the guard report
`InventoryPage.tsx:732 (no reason found)` — observed RED, then restored. The widened guard still
fires on a genuinely unguarded reset.

### Verification

`npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` all pass.
**357 test files, 5047 passed, 0 failed** (pre-merge baseline: 355 files / 5016 passed), so no
resolution ate a test.

**Not behaviourally verified, stated plainly:** the vendor-bill money inputs and the CycleCounts
completion were not driven in a browser for this merge. They are covered by the branch's
pre-existing `NewVendorBill.overage.test.tsx`, `VendorBillDetail.routeReset.test.tsx` and cycle-count
tests, which pass — but those are tests, not a real-path observation. The merge changes validation
ordering and messages on those forms; it does not change what the RPCs receive on the success path.
