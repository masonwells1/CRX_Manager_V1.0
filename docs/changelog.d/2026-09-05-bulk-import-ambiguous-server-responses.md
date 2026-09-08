## 2026-09-05 - Stop the bulk field import calling an ambiguous server response a rejection

Second Codex round on the same PR. The previous commit split "the server rejected this row"
from "we never found out", but it drew the line in the wrong place, so a whole class of
failure was still being reported to the operator as safe to re-import.

### The finding

The discriminator was `saveStatus === 0 ? 'unknown' : 'rejected'` — any non-zero HTTP status
was taken as proof that PostgreSQL had answered and rolled back. It is not. A gateway or
proxy sitting in front of Supabase can answer `502`, `503`, `504` (or a `408` / `429`
timeout) **after** the `save_field` RPC already reached PostgreSQL and committed. The screen
then told the operator that row was safe to re-import, each retry mints a fresh idempotency
key, and a duplicate field appears that a `sales_rep` cannot delete — the exact outcome the
warning exists to prevent.

### The fix

A failure now counts as a genuine rejection only when **both** hold:

- The status is a **4xx**. `postgrest-js` reports `0` when fetch itself failed and no response
  arrived; anything `>= 500` can have been produced downstream of a commit.
- The body carried an **error code**. PostgREST answers a rejection with JSON carrying `code`
  (a SQLSTATE such as `42501`, or a `PGRST###`). A gateway answers with HTML or plain text,
  which `postgrest-js` surfaces as `{ message: <body> }` with an empty code.

Everything else — including a `5xx` that *does* carry a code — falls into the unknown bucket
and the operator is told to look that row up rather than that it is safe to retry. The `5xx`
case is deliberately conservative and pinned by its own test: a PostgREST `500` usually does
mean PostgreSQL raised and rolled back, but Supabase's edge can synthesise a JSON error too,
and nothing on the client can tell those apart. Being wrong in the safe direction costs one
lookup; being wrong the other way creates an undeletable duplicate.

The discriminator lives in a named `saveFieldDefinitelyRolledBack()` helper rather than inline,
because the reasoning is the whole point and it needs somewhere to live.

### Two rendering defects found by looking at the result

Neither was in the review; both were found by screenshotting the real rendered panel.

1. **The gateway's error page was printed verbatim.** A real proxy `502` body is a whole HTML
   document. Printed raw it pushed the "check the field list before re-importing" instruction —
   the one thing that row exists to tell the operator — off the visible area. A
   `shortServerReason()` helper now strips tags and clamps the text to 120 characters while
   keeping the status, which is what support needs.
2. **A long unbroken token still overflowed.** With the clamp in place the 120-character run
   had no wrap opportunity, so the errors panel scrolled sideways and the instruction sat off
   screen. The results error and warning lines now carry `break-words`. The parse-warning list
   on the earlier preview step was left alone — it is outside this change.

### Verification

- `npm run typecheck` clean · `npm run lint` clean · `npm run build` succeeded.
- `npm run test` — 352 files, 5018 passed, 0 failed, 123 skipped.
- Four new tests in `src/components/fields/BulkFieldImport.duplicateWarning.test.tsx`
  (10 total): a gateway `502` with an HTML body; a `429` carrying no code; a `500` that *does*
  carry a code; and a 3000-character gateway error page, asserting the status survives, the
  instruction is still present, and the document is not.
- **Fourteen mutations, each verified to be a real edit and not a silent no-op, source restored
  byte-identical after every run — all fourteen caught.** Six are new: reverting to the
  status-alone discriminator; dropping the code check; removing the `< 500` bound; printing the
  raw server body; removing the clamp; and no longer stripping tags.
- **Rendered and looked at**, twice more. The first render is what exposed the raw error page;
  the second exposed the sideways scroll. The panel was captured from the real component's test
  DOM and served through the dev server each time.
- Not verified: no live-database round trip. The suite drives the real React tree but mocks the
  Supabase boundary, so the real `save_field` / gateway behaviour is reasoned from the installed
  `postgrest-js` source, not observed against production.

### Still open — unchanged

Re-importing still duplicates. This is operator guidance, not a fix; the durable server-side
per-row identity described in the previous entry remains a migration awaiting Mason's decision.
