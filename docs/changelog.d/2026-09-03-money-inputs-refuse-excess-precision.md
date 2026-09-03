## 2026-09-03 — money inputs refuse amounts with more than two decimals (never round, never truncate)

**Owner decision (Mason, 2026-09-03).** Asked whether a typed dollar amount with more than two
decimal places (for example `12.345`) should be refused or rounded to the nearest cent, Mason
chose the recommended option: refuse. This closes the KNOWN_ISSUES entry "`parseCents.ts`
truncates excess fractional precision", which had been carried as debt since the 2026-08-10
exact-whole-cent policy.

**What changed.**

1. **`src/lib/parseCents.ts`.** `parseDollarsToCents` and `parseDollarsToCentsSigned` now return
   `null` when the fractional part has more than two digits (`'1.999'`, `'$12.345'`, `'1.500'`).
   Before, they silently truncated (`'1.999'` → 199 cents). The return type is `number | null`,
   so TypeScript forces every caller to handle the refusal. Malformed input (`'1e5'`, `'1.2.3'`,
   `'12-34'`) still returns 0 exactly as before; the refusal is deliberately **`null`, not `0`**
   — see below. The one shared message is exported as `MONEY_PRECISION_MESSAGE`:
   "Enter an amount with no more than two decimal places."
2. **Every caller (15 files, 26 call sites)** now handles `null`. A read-only audit before the
   change found that 13 of those sites would have saved a `0` without telling anyone, and at
   several of them a `0` means something real: a `$0` credit limit disables the credit check on
   quick deliveries (`CustomerDetail`), `edit_prepay_credit` would wipe a live prepay bucket to
   `$0` (`PrepaymentManagerPanel`), and a field's price override would be silently **cleared**
   because the save path maps `0` to `null` (`FieldSetup`). That is why the refusal signal is
   `null` and every site stops on it:
   - Submit-time sites show `MONEY_PRECISION_MESSAGE` (prefixed with the field name where a form
     has several money fields) and return before any RPC or insert: `WriteOffModal`,
     `PrepayWorkspacePanel` (names the invoice), `PrepaymentManagerPanel` (balance edit, check
     total, each bucket split by label), `ApplicationServiceDetail` (default rate, cost per acre
     — a refused cost can no longer masquerade as the "leave cost alone" `null`, customer rate
     override), `BlendRecipes` (names the item), `CallLists` (the threshold must not fall through
     to the legitimate show-everyone `0`), `InvoiceDetail` (payment, apply credit), `NewVendorBill`
     (subtotal and adjustment, checked before `setSaving`), `PaymentAllocation` (check amount, on
     both auto-allocate and submit — kept separate from the "Enter a check amount" case so the
     reason is named), `Rebates` (claim amount), `VendorBillDetail` (payment, subtotal,
     adjustment).
   - Live-typing price boxes whose displayed value is re-derived from the parsed cents refuse the
     keystroke AND show the same message (so a vanished character is not mistaken for a typo):
     the box keeps its last accepted value and emits no change, so no `$0` manual
     override, unit price, credit limit, price override or allocation is ever produced:
     `FieldAppChemicalEntry`, `InvoiceDetail` line unit price, `CustomerDetail` credit limit,
     `FieldSetup` price override, `PaymentAllocation` per-invoice allocation.
   - `FieldAppSplitInvoiceEditor` maps the refusal to its existing "not entered" `null`, which
     `validateForSave()` already turns into a named, save-blocking message.
   - `NewVendorBill`'s header total preview is display-only and shows a refused field as 0; the
     save path refuses it by name first.
3. **Tests.** `src/lib/__tests__/parseCents.test.ts` replaces the "truncates beyond 2 decimals"
   assertion with a refusal group (positive, currency-formatted, thousandth of a cent, trailing
   zeros, the signed variant, and "refusal ≠ the malformed-input 0"). `WriteOffModal.test.tsx`
   proves `12.345` shows the message and calls no RPC. `FieldAppChemicalEntry.test.tsx` proves a
   third decimal digit emits no change and the box keeps `65.00`. The two page tests that mock
   the parser (`InvoiceDetail.test.tsx`, `PaymentAllocation.test.tsx`) export the message
   constant from their mock; their rounding mocks are unchanged and still do not exercise the
   refusal.

**Proof observed.**
- Browser (real `WriteOffModal` in the gitignored stubbed-data Vite harness, no login): typed
  `12.345` and a reason, clicked Apply Write-Off → the red toast "Enter an amount with no more
  than two decimal places." appeared, the typed text stayed visible in the box, no RPC was
  recorded, zero page or console errors during the interaction. Corrected to `12.34` → RPC
  `apply_write_off` recorded with `p_amount_cents: 1234`.
- `npm run typecheck`: clean. `eslint src --max-warnings=0`: clean. Focused suites for every
  touched screen (19 files, 265 tests) plus the new cases: green. Full `npm run test` and
  `npm run build`: recorded in the PR.

**Not verified.** Only the write-off modal was driven in a browser; the other 14 screens are
covered by the type change (a caller that ignored the refusal would not compile), the audit table,
and their existing test suites. The two rounding mocks remain a known gap.
