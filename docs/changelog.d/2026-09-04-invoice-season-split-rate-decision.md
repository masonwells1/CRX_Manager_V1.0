## 2026-09-04 - Mason settled the split-rate question on cross-boundary field-application edits

- Follow-up to `docs/changelog.d/2026-09-04-invoice-season-follows-invoice-date.md`. Both reviewers
  raised it against `20260904180000_invoice_season_follows_invoice_date.sql`, and the container
  prover reproduced it as an observed outcome (PHASE 6d) rather than an inference, so it went to
  Mason as one question with the money consequence stated.
- **Decision (Mason, 2026-09-04): an invoice is priced at the season IT is filed under, and an edit
  never re-seasons an existing invoice.** Canonical entry in `docs/manual/DECISION_LOG.md`.
- Accepted consequence he was shown and chose: a field application billed in one season and then
  edited across October 1 *while adding a grower* yields one invoice group whose members sit in two
  seasons and are therefore billed at two different per-acre rates — observed as the pre-existing
  grower at 1111c/acre (season 2026) and the added grower at 2222c/acre (season 2027) on one
  application, one group, one date.
- Chosen over the two alternatives because it never rewrites an existing invoice. Forcing one season
  across the group would make the added invoice disagree with its own date; re-seasoning the whole
  application would move already-issued invoices onto a different year-end statement.
- No code change resulted — this confirms the shipped behaviour. `docs/manual/KNOWN_ISSUES.md` now
  records the three consequences as SETTLED rather than open, so they are not re-opened as bugs.
- Two operative rules recorded for future maintainers, both of which a "cleanup" would otherwise
  reintroduce as defects: do NOT collapse the field-application save to one pre-loop season feeding
  both the invoice stamp and the `customer_application_rates` lookup (that is prover PHASE 8d's
  mutant, which no static guard catches), and do NOT add `season = ...` to that function's UPDATE
  branch.
