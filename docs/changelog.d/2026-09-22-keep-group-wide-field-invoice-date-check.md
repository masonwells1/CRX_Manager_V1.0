## 2026-09-22 — the field-app date guard keeps checking the whole invoice group; CodeRabbit's Major is refuted with evidence

Lap 10 of the field-season delivery (replaces PR #762). Both migrations remain **local candidates,
not applied**; nothing here touches the live database.

- **CodeRabbit Major (#758) — REFUTED, not implemented.** It asked for
  `guard_field_app_invoice_season_date()` to validate only the written row, so a single-invoice date
  edit inside a mixed-season group would be allowed whenever the new date fits that invoice's own
  filed season. That was built in lap 9 and passed Luna, Sol and CodeRabbit; an adversarial review
  caught it before merge, and the defect was then reproduced in PostgreSQL 17. In the production
  mixed-group shape (one application, one group, one shared date, the pre-existing member filed in
  the earlier season) the relaxation permits an edit that leaves the group holding two dates. The
  field-app save writes ONE date to every member, so afterwards **no date saves the group**, the
  preview fails, and **neither member's date can be moved back** — void-and-reissue is the only exit,
  from one ordinary admin edit. Reverted: both `20260914101000` and `20260914101100` are back to
  their reviewed bytes and original sha256 pins (`826a67e2…`, `aa56d74d…`). Mason's decision is
  recorded in `docs/manual/DECISION_LOG.md` (2026-09-22). The group-wide check is deliberately
  stricter than the per-invoice date rule: fail-closed, never wrong money, group stays recoverable.
- **New regression guard.** `prove-preview-field-app-season.mjs` PHASE 8h-mixed / 8i-mixed now build
  the production-shaped mixed group and assert both directions. The group still **saves** at its own
  shared date in both phases, because the trigger only validates a row whose date actually changes,
  so re-saving the stored date is not a date edit. Its **preview** is the one thing that differs:
  under `20260914101000` alone the preview of that unchanged stored date is refused — the
  pre-existing defect `20260914101100` corrects, which is why the apply-window rule keeps the two
  files in ONE window — and it succeeds once `101100` is installed. In both phases a single-row edit
  that would split that date is refused through the public generic entry AND a raw admin UPDATE with
  the row unchanged, whole-group moves across the boundary stay refused, and A still restores at its
  stored date once the correction is in. The
  mutant installs the **exact rejected per-row body** (md5-pinned `d8c4bbd4…` / `0005b29c…`),
  observes the edit being permitted, then proves the group unsaveable at three dates with both
  convergence attempts and the preview refused. A static check fails if either trigger body drops
  the group-wide call again.
- **CodeRabbit Minor (#758) — fixed.** `save_field_app_invoice` in `scripts/smoke/smoke-specs.json`
  is now `container_only` with `container_prover: prove-preview-field-app-season.mjs`, which runs
  that chain in PHASE 9, so `run-smoke.mjs` refuses it by name and skips it under `--all` instead of
  printing it for a live run.
- **Coverage mislabel found while checking that fix.** `post_invoice_group` was declared in the
  `adversarial_money_inventory_closeout` spec, whose chain never calls it (0 occurrences), so once
  the field-app chain became container-only, `--spec post_invoice_group` returned a pass from a chain
  that does not exercise it. The false entry is removed and `post_invoice_group` is declared on the
  `unpost_invoice_group` spec, whose chain really does call it (14 occurrences). Verified: that spec
  is now what `--spec post_invoice_group` selects.
- **Doc correction.** A spec description claimed `run-smoke.mjs` "only EXECUTES a container_prover on
  the container-only skip path". It never executes one — it prints the prover name and checks the
  file exists at startup. Corrected, because that sentence is what a reader would rely on to conclude
  `container_only` does not drop coverage. Known limitation, unchanged: no CI job runs the container
  prover; it is a manual 8-minute Docker run.

**Proof:** `prove-preview-field-app-season.mjs` → `PREVIEW_SEASON_PROOF_PASS` with both new phases
and both mutants caught. `run-smoke.mjs --spec save_field_app_invoice` refuses the live path;
`--spec post_invoice_group` now selects `unpost_invoice_group`. typecheck 0, lint 0, vitest
5,444 passed / 123 skipped, build 0, test:correction-guards 0, test:agent-workflows 0,
check:docs PASS. Both migration sha256 pins re-verified from the committed blobs against ledger
rows 931 and 934.
