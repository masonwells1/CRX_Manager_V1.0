## 2026-09-04 — Stop incomplete delivery load sheets after item-query failures

- Delivery load-sheet generation now aborts when any delivery's item query fails or returns no item rows, so warehouse staff are not given a blank item list with a false success message.
- The real Deliveries page test clicks **Load Sheet**, supplies a plain Supabase-style error, and proves that no PDF or success toast is produced. It also covers the empty-item case, while a successful control proves the expected product and quantity reach the PDF generator.
- The regression failed before the guard and again when the guard was deliberately removed, then passed after restoration.
- No live data was queried and no physical print/download flow was opened. The PDF renderer and the existing best-effort customer/order/address lookups were unchanged.
