## 2026-09-13 — Fix invoice load ownership and cutover retries from final review

CodeRabbit's exact-head #662 review requested changes; that candidate is not
merge-cleared. Retain its review/dispatch history and require fresh independent
proof, CI, and an actual CodeRabbit review of the corrected delivery candidate.

- Invoice loading now rejects obsolete route/request responses after every awaited
  hydration query, including navigation away and back. Existing-invoice controls
  remain hidden until that route finishes loading.
- Generic InvoiceDetail Save retries only the three explicit phase-one cutover
  refusals with SQLSTATE 40001. Each retry makes a fresh request using identical
  data/approval reason/idempotency key; busy responses wait briefly, and retries
  stop after three requests. Other errors are not automatically retried.
- Cutover migration LF diagnostics run before body hashes and name the affected
  migration. Historical handoff supersession is explicit.
- Creator-date finding adjudication: disposable PostgreSQL inspection showed
  baseline transfer_job_to_invoice md5 `78b827f8509a2740ea9879364747c372` and an
  INSERT using CURRENT_DATE. The read-only live body matched that fingerprint;
  later date-compatibility overlays are not this historical prover's control.
  Keep its matching CURRENT_DATE assertion, pin the baseline, and clarify that
  baseline creators are not later live-overlay runtime proof.

Observed regressions failed on the original route/load and missing retry paths;
corrected rendered tests pass. Disposable PostgreSQL proof reached both registered
SMOKE_PASS_ROLLBACK chains and terminal PREVIEW_SEASON_PROOF_PASS after LF diagnostics
and the additional creator-body pin. The first full app run exposed an RPC coverage
scanner mismatch; the approval callback now uses its established block form without
changing the scanner, assertions, or zero-debt baseline. Final app checks remain required.
No applied migration was edited and no live database change was made.
