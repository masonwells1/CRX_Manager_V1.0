## 2026-08-27 — Production migration review and SQL escape closure

The production migration gate now fetches every page of GitHub pull-request reviews and fails
closed if pagination exceeds its safety limit. This prevents an older CodeRabbit approval from
hiding a later exact-commit changes-requested review beyond the first API page.

The immutable migration batch builder now rejects top-level `SELECT`, dynamic SQL `EXECUTE`, and
unquoted psql backslash commands wherever they occur in the top-level SQL skeleton. These checks
close paths where a reviewed migration could invoke a mutating function, assemble destructive SQL
dynamically, or run a client-side command after an ordinary statement on the same line.

Focused tests prove each rejection and the review-pagination behavior, including the fail-closed
page limit. The runbook also records that the one-account environment must preserve explicit false
values for self-review and administrator bypass rather than replacing them with permissive defaults.
