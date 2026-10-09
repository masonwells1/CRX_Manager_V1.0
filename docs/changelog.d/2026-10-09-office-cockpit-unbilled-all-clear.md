## 2026-10-09 - Office Cockpit: accurate all-clear on "Delivered, not invoiced"

- The tile's empty message read "Every completed delivery has an active invoice", which is false
  when the only remaining deliveries were billed outside CRX (Chem Man). It now reads "No
  completed deliveries need invoicing" (Codex connector review on PR #889).
