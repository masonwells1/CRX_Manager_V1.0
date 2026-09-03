## 2026-09-03 — invoice due dates: basis settled as the invoice date; four UTC `invoice_date` fallbacks moved to the Chicago business day (migration NOT APPLIED at time of writing)

**Owner decision (Mason, 2026-09-03; `docs/manual/DECISION_LOG.md` 2026-09-03 entry).** A
`codex-transaction-review` finding reported that invoice due dates derive from the invoice date
rather than the Chicago posting date, so late-evening invoices land on the wrong day. A read-only
investigation at HEAD and against the LIVE function bodies found two separate things in that one
report:

1. **The basis.** The posting RPC stamps `due_date = invoice_date + terms days`
   (`_post_invoice_impl_20260714`, `20260702160000_a8_terms_to_due_date.sql:133`); the 2026-07-16
   spec literally says "posting date". Mason chose the **invoice date** (what the customer reads;
   standard AR practice). The posting RPC is therefore **deliberately unchanged**, no invoice row
   is touched, and the client is untouched. Exactly one live invoice differs between the two
   bases — CS-2026-0119, invoice-dated 2026-04-08 and posted 2026-08-18 — and it stays due
   2026-05-08 and flagged overdue with that consequence in front of him. The spec now carries an
   amendment so nobody "corrects" the code back.
2. **The timezone hole.** The live DB clock is UTC. That mechanism affects **zero** live invoices:
   0 of 3 posted invoices crossed the UTC/Chicago day boundary (both sides tested), and both
   invoice screens send the browser-local date. The only real hole is four server-side fallbacks
   that stamp `invoice_date = CURRENT_DATE` when a payload omits the date.

**What changed — `supabase/migrations/20260903170000_invoice_date_fallbacks_chicago.sql`.** Each
of the four bodies is re-emitted from its LIVE installed text (read read-only on 2026-09-03; three
were created by RENAME, so no single migration file carries their applied text) with exactly one
delta: the `invoice_date` fallback becomes `(now() AT TIME ZONE 'America/Chicago')::date`, the
repository's settled idiom (~2026-07-10 rule).

| function | delta |
|---|---|
| `_price_order_below_cost_impl_20260810` | `invoice_date = CURRENT_DATE` (G3 price-month) |
| `_save_invoice_lineage_unaware_impl_20260827` | `COALESCE(payload invoice_date, CURRENT_DATE)` |
| `_save_field_app_invoice_impl_20260714` | same fallback |
| `_save_field_app_split_invoice_impl` | same fallback, in the season derivation and the INSERT |

Preflight pins each installed body to exactly its live md5 (fresh apply) or the file's own
candidate md5 (identical replay) — never a marker — and refuses `PREFLIGHT_BODY_DRIFT` otherwise;
the split-invoice body is live with CRLF, so its pin is that CRLF md5 and the file installs the LF
form. The supported clean-rebuild baseline holds that same text with LF endings
(`4a05478da4a8d6601eefd4aed5c0ab3b`), so that LF preimage is a third accepted starting body — a
disaster-recovery rebuild must reach the replacement, not be refused for line endings. That arm
came out of the gpt-5.6-sol exact-SHA review (round 1, HIGH) and is proven in the container. Pins, four replacements and postflight share one transaction. Postflight asserts each
candidate md5, no CR bytes, the expected `CURRENT_DATE` count, at least one Chicago conversion,
SECURITY DEFINER with `search_path=public, pg_temp`, and one overload. `CREATE OR REPLACE` keeps
each function's ACL. No data is rewritten, no row deleted, no grant moves.

**Deliberately not changed, tracked as follow-up.** `_save_field_app_split_invoice_impl` carries a
third `CURRENT_DATE` — the date written on a commission record at save time. It is the same class
of UTC exposure but outside the decision this change implements (the invoice_date fallbacks), so it
stays exactly as it is and is named here rather than folded in.

**Proof observed.**
- `scripts/smoke/prove-invoice-date-fallbacks-chicago.mjs` (throwaway PostgreSQL 17 container on
  the supported schema baseline, replaying every ledger-selected post-baseline migration): all four
  live pins reproduce from the repository (split body CRLF, as live); BEFORE the candidate,
  `save_invoice` with no `invoice_date` under a session clock whose day differs from Chicago's
  stamps the session day (the defect reproduced); a drifted body is refused with
  `PREFLIGHT_BODY_DRIFT` and all four bodies are untouched; the candidate applies with
  `PREFLIGHT_OK` + `POSTFLIGHT_OK` and every body hashes to its candidate pin, LF, SECDEF intact;
  replay reinstalls the identical bodies; AFTER the candidate the same call stamps the Chicago
  day; a mutant that leaves `CURRENT_DATE` in the split season fallback aborts in
  `POSTFLIGHT_CURRENT_DATE` with nothing installed; a mutant with one drift pin removed no longer
  refuses that drift (the pin is load-bearing). Observed 2026-09-03: `ALL PHASES PASSED`, with
  the BEFORE probe stamping 2026-09-04 (the session day) and the AFTER probe stamping
  2026-09-03 (the Chicago day) at the same instant.
- `npm run check:migration-hard-rules`: no new finding.
- Docs: DECISION_LOG entry (basis + the two-issues separation), spec amendment, this note.

**Not verified / not done.** The migration is NOT applied to the live database; that waits for
Mason's typed OK in the applying session with a fresh `write-apply-proofs.mjs` mint. The
`_price_order_below_cost_impl_20260810` and field-app paths were proven structurally (md5 pins,
postflight) and by the shared expression, not by a driven call; only `save_invoice` was driven
end to end in the container.
