## 2026-09-03 — Independent Claude review of Codex's ignored-PR-comment audit (docs only)

Codex audited all 458 merged PRs and concluded Codex review comments were not being read,
fixed, and closed before merge. Mason asked for an independent Claude review of that audit
before any remediation started. This change records both halves of that exchange.

Added:

- `docs/audits/2026-09-03-codex-to-claude-pr-comment-audit-handoff.md` — Codex's audit packet
  and its questions for Claude. Previously untracked in the main checkout; committed here so
  the question half of the record survives.
- `docs/audits/2026-09-03-claude-review-of-pr-comment-audit.md` — Claude's verdict.

Verdict: **PARTIALLY CONFIRMED** against `origin/main` `212f417bf` — 0 BLOCKER / 4 HIGH /
6 MED / 4 LOW / 1 REFUTED. Of the 21 findings Codex called still-broken: 13 confirmed,
1 refuted (`#124` offline actor restamping is blocked at `src/lib/offlineSync.ts:104-109`),
6 unverified (`#564`'s eight claimed paths, where this repo's own audit records two), and
1 real but mis-described (`#581`'s migration sources are on another branch, not lost).

The systemic conclusion holds — 6 human replies across 1,437 threads — but is mis-framed:
75 of 97 high-priority findings were fixed later, so the true current-defect rate is roughly
14 of 97 and the missing step is closing threads out, not reading them.

One finding Codex missed, recorded as the second remediation priority: `#336` and `#575` are
the same hole from two sides. Both migration gates go soft on *pending* unapplied migrations,
so a reviewed migration can be edited afterward to add an unprotected table with a forgeable
actor and both gates report pass. A pending migration
(`20260903150000_job_chemicals_persist_driver.sql`) is live on `main` as of this date.

Recommended order: `#198` invoice due dates first — it is live, customer-facing, and
contradicts the approved spec at `docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`.

No code, migration, GitHub, or production state changed. No finding is closed by this change,
so it carries no executable check; each confirmed finding must ship its own during remediation.
