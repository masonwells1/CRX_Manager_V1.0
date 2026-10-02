## 2026-10-02 — field-season migrations `20260914101000`..`20260914101300` applied live

The filed-season guard is live. Mason said "start the field season installs" in chat and approved
`20260914101000` with Windows Hello. The four files then applied from PR #871's checkout through
`scripts/apply-migration-file.mjs`, in stamp order, between 20:14 and 20:16 UTC:

| Migration | Ledger version |
|---|---|
| `20260914101000_field_app_invoice_cross_season_edit_guard` | `20261002201451` |
| `20260914101100_preserve_unchanged_source_invoice_dates` | `20261002201523` |
| `20260914101200_refuse_generic_field_invoice_creation` | `20261002201542` |
| `20260914101300_finish_generic_field_invoice_cutover` | `20261002201609` |

The gate checked these, all fresh, before each apply:
- the reviewer and Sol apply proofs;
- CodeRabbit APPROVED and a Sol merge proof on #871's head `705ffd253`;
- `npm run proof:field-app-season` on that head;
- for `101300`, the quiet-database check, which returned no rows.

Every file's in-transaction postflight passed (HTTP 201).

Post-apply read-only checks:
- The ledger holds 1017 rows; the high-water is `20260914101300`.
- The preview wrapper body md5 is `294b3e1a…`, and the pre-apply body `83f66004…` is preserved as
  `_preview_field_app_invoice_split_impl_20260908`.
- Both `101100` helpers match their file pins and are postgres-only.
- `invoices.aa_guard_field_app_invoice_season_date` is enabled.
- `save_invoice(jsonb,jsonb,text)` is the single overload.
- The daily cross-season invoice check returned zero rows.

Docs updated to match: the top live capture in `docs/reference/migration-history.md` and rows
931–934, the field-season paragraph in `docs/manual/CURRENT_STATE.md` (Codex review on #871), and
the field-season entry in `docs/manual/KNOWN_ISSUES.md`, now RESOLVED. The two field-season sections of
`docs/reference/rpc-functions.md` now say LIVE with their ledger versions (Codex review on #871).

Not verified: the on-screen error wording and the Documents tab need Mason's login, and the
schema registry is not yet regenerated.
