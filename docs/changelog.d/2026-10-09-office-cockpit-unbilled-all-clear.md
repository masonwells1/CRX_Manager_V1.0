## 2026-10-09 - Office Cockpit: accurate all-clear on "Delivered, not invoiced"

- The tile's empty message read "Every completed delivery has an active invoice", which is false
  when the only remaining deliveries were billed outside CRX (Chem Man). It now reads "No
  completed deliveries need invoicing" (Codex connector review on PR #889).
- The tile now pages back through completed deliveries (50 at a time, at most 1,000) and drops
  the ones an active invoice covers or that were billed outside CRX BEFORE applying its limit.
  Before, it checked only the newest 50 completed deliveries, so 50 recent Chem-Man-billed or
  invoiced deliveries could hide an older one that still needs invoicing (CodeRabbit, PR #889).
  The footnote now reads "More deliveries may need invoicing; open Deliveries for the full list"
  when the tile is full. Test: OfficeCockpit.delivered-not-invoiced.test.tsx.
- If all 1,000 scanned deliveries are covered, the tile says older ones were not checked instead
  of showing an all-clear (Luna LOW).
- Luna MED (recording guard misses an invoice naming the delivery but no order) refuted: the
  existing invoice guard refuses such an invoice (INVOICE_DELIVERY_ORDER_REQUIRED) and one naming
  another order; the real-schema proof now asserts both.
- CodeRabbit follow-ups: the page-wide "All clear!" banner is also suppressed when the delivery
  scan hit its cap; the proof asserts the exact INVOICE_DELIVERY_LINEAGE_INVALID refusal.
- The page-wide "All clear!" banner now also requires every tracked check (delivered-not-invoiced,
  shortfalls, planned bookings, watchdog) to have loaded; a failed check no longer reads as clear
  (CodeRabbit).
