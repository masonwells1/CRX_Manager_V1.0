## 2026-09-04 - discard a rendered field-app preview when the transaction date changes

From the `gpt-5.6-sol` push-proof review of PR #599 (the exact-SHA adversarial gate, run once Codex
credits were restored). It returned `CODEX_PROOF_VERDICT: BLOCKERS` with two HIGH findings.

### Fixed — the stale-preview vector

`src/pages/FieldApplicationInvoice.tsx:2645`. The transaction-date input updated
`transactionDate` and set the dirty flag but did **not** clear `previewData`, even though every
other pricing input already did: locations (`:1314`), chemicals (`:1367`), and the
application-service selector (`:2672`).

The date is not a cosmetic field here — it decides the season, the season selects the
`customer_application_rates` row, and that row is the per-acre price. So an operator could click
Preview on 2026-09-30, change the date to 2026-10-01, and save while the season-2026 rate was still
displayed, having approved a breakdown that is not what got billed.

Worth separating from the known preview/save divergence already tracked in `KNOWN_ISSUES.md`: that
one needs a migration and only bites at a season boundary. **This one needed no boundary and no
timezone** — any date edit after a preview, in either direction, left a stale price on screen. It
was reachable year-round and fixable in one line.

Proven by mutation, not by a green suite: a new test drives the real create -> pick field ->
Preview flow, asserts the preview-only discount input is rendered, changes the date, and asserts it
is gone. Removing `setPreviewData(null)` from the handler makes that test **fail**; restoring it
returns 25/25.

### Not changed — a settled owner decision

The review's second HIGH ("a cross-season group edit can produce mixed fiscal seasons and rates
within one application") describes the exact behaviour Mason **decided to keep** on 2026-09-04:
*an invoice is priced at the season it is filed under, even when that splits a field application*
(`docs/manual/DECISION_LOG.md`). It was put to him with the money consequence stated, and he chose
it because it never rewrites an existing record. The reviewer proposes rejecting cross-season date
edits or implementing atomic group re-seasoning; both reverse a decision that is his to make, so
neither is applied here. This is the known shape where an adversarial gate cannot converge on an
owner decision — it will keep re-raising it, correctly, as a risk.

### Also confirmed by the same review

The packet proof passed every copied-file SHA-256 check, both snapshot commit SHAs matched the
review manifest, the re-emitted function bodies differ from base only at the intended season
statements, both source MD5s match their migration pins, and search paths, ACL history, actor
checks, idempotency handling and overload guards are intact. No new RLS, CHECK, grant-widening,
secret, floating-point-money or destructive-data issue was found.
