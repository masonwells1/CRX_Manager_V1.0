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
