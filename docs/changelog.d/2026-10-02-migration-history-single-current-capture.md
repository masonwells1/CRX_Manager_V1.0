## 2026-10-02 — migration-history: one current pre-apply capture, with live function identity

The migration-drift reviewer returned contradictory results on `20260914101000` across five runs on
2026-10-01. It passed four times, then raised two different findings:
- a BLOCKER that the preview function might have a surviving older overload;
- a HIGH that the newest ledger read was dated 2026-09-27, although the file opened with the
  2026-10-01 read.

The top of `docs/reference/migration-history.md` stacked four dated "boundary" captures
(2026-10-01, 09-27, 09-26, 09-21), with stale lines saying the field-season files were "not yet on
`main`". The reviewer could read an older block as the latest.

- The four captures are replaced by ONE current block from read-only live reads at 2026-10-02
  12:43 UTC:
  - the ledger: 1013 rows, `max(version)` `20260928025520`, effective high-water `20260914100900`;
  - the four field-season files, on `main` since PR #850 and not applied;
  - the live identity of `public.preview_field_app_invoice_split`: exactly one overload,
    `(jsonb,jsonb,uuid,uuid,date)`, md5 `83f6600412ced085d0876a3c7339ff12`, the pin
    `20260914101000` checks;
  - the commission cohort's stamp-to-version map.
- The field-season section heading now says those files are on `main` since PR #850 and not
  applied.
- The removed captures stay in git history and in the table rows.

Proof:
- Both live reads were run read-only against production.
- With this text in place, the `20260914101000` reviewer pair returned CLEAN (drift review:
  0 BLOCKER, 0 HIGH).
- `npm run check:docs`, `test:correction-guards` and `test:agent-workflows` pass.

Not verified: nothing was applied; documentation only.
