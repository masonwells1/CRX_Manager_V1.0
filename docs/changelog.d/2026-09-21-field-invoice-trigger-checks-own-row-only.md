## 2026-09-21 — field-invoice date guard: the row trigger checks only the invoice being edited

Lap 9 of the field-season delivery (replaces PR #758). Fixes the two CodeRabbit findings on #758.
Both migrations remain **local candidates, not applied**; nothing here touches the live database.

- **Mixed-season groups (CodeRabbit Major).** `guard_field_app_invoice_season_date()` in both
  `20260914101000` and `20260914101100` called the group-wide
  `_assert_field_app_invoice_date_in_filed_season`, so editing ONE invoice in a historical group whose
  members sit in different seasons was refused whenever any other member's season differed — even
  when the new date stayed inside that invoice's own filed season. That is stricter than the
  2026-09-08/13 DECISION_LOG rule (dates stay inside the invoice's OWN filed season; mixed historical
  groups are not unified). The trigger now validates only the written row. The public preview keeps
  the group-wide assertion, because its one date is written to every member; the field-app group
  save is still refused for any member whose own season cannot take the date, since it writes each
  member through the same trigger. Fail-closed before and after; no money or pricing change.
  Trigger body pins and the two ledger sha256 pins (rows 931 and 934) were re-pinned. The
  APPLY-WINDOW RULE for `20260914101000` + `20260914101100` still stands (see migration-history.md).
- **Smoke spec live-safety (CodeRabbit Minor).** `save_field_app_invoice` in
  `scripts/smoke/smoke-specs.json` now carries `container_only: true` and
  `container_prover: prove-preview-field-app-season.mjs` (which already runs that chain in PHASE 9),
  so `run-smoke.mjs` refuses it by name and skips it under `--all` instead of printing it for a live run.

**Proof:** `run-smoke.mjs --spec save_field_app_invoice` now refuses ("container-only and cannot run
against a live database"); on the previous file it printed the chain for live execution. `--all`
reports it SKIPPED. `prove-preview-field-app-season.mjs` (Docker PG17) gained a mixed-season-group
probe run under `20260914101000` alone and again after `20260914101100`: own-season direct and
public `save_invoice` edits and unchanged-date restore are allowed; a cross-season edit, the
group-wide preview and the field-app group save are refused and roll back. Its mutant reinstalls
the exact pre-fix trigger (md5-pinned to the old body) and is caught refusing the legitimate edit.
A static check also fails if either trigger body calls the group-wide helper again.
