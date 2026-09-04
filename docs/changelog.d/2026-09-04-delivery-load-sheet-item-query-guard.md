## 2026-09-04 — Stop incomplete delivery load sheets after item-query failures

- Delivery load-sheet generation now aborts when any delivery's item query fails, so warehouse staff are not given an incomplete PDF with a false success message.
- The real Deliveries page test clicks **Load Sheet**, supplies a plain Supabase-style error, and proves that no PDF or success toast is produced. A successful item-query control still generates the PDF.
- The regression failed before the guard and again when the guard was deliberately removed, then passed after restoration.
- No live data was queried and no physical print/download flow was opened; the PDF renderer itself was unchanged.
