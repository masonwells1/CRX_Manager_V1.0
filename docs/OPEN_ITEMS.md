# Open Items

Deferred findings that survived the Sprints A–G audit cycle. Address when capacity allows.

---

## 1. Order share edits can drift from posted invoices

**Priority:** Medium  
**Area:** Orders / Billing  
**Source:** 2026-04-30 data-integrity audit (P2-2)

If a customer split is changed after an invoice is already posted, the invoice shares reflect the old split. No RPC guard currently prevents this.

**Fix needed:** `save_order` / `update_order_items` should check for any posted/overdue invoices on the order and reject the edit (or at minimum warn). Alternatively, lock the customer-split UI once a posted invoice exists.

---

## 2. Accessibility warnings in FieldAppChemicalEntry

**Priority:** Low  
**Area:** Field App UI  
**Source:** 2026-04-30 money/inventory audit (P3); confirmed via lint

`src/components/field-app/FieldAppChemicalEntry.tsx` lines 204 and 230 have clickable `div`/`span` elements missing keyboard listeners (`jsx-a11y/click-events-have-key-events` — currently warnings, not errors).

**Fix needed:** Replace the clickable non-interactive elements with `<button>` elements. 2-line change per occurrence. Bundle with next field-app pass.
