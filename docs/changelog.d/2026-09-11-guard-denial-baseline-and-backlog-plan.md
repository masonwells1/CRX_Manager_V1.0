## 2026-09-11 - Guard-denial baseline and the approved open-PR backlog plan are in the repository

The 2026-09-11 backlog plan (Astra round 2 APPROVE WITH CHANGES; Mason's rule "if it approves I agree
with it all") lived only in one session's scratch directory. It is now
`docs/plans/2026-09-11-open-pr-backlog-plan.md`, copied verbatim with a status header.

Section 6 of that plan requires a denial baseline at the start of the 2026-09-11 to 2026-09-25 guard
freeze. `docs/reports/2026-09-11-guard-denial-baseline.md` records it: the exact read-only command
(`scripts/claude-usage-report.mjs` at `a8656debb`, window 2026-09-04 to 2026-09-11), 1,199 attributed
denials out of 36,228 unique tool calls (3.31%) by category and tool, the read-looking share, repeated
identical refusals, session concentration, a measured time-lost proxy (median five seconds from a
denial to the next tool call, about four hours over the week), the fields that could not be measured,
and the exact command for the 2026-09-25 re-measure. No denied command text is quoted; the export
stays in scratch. Documentation only; no guard logic, source, or migration bytes changed.
