## 2026-09-11 - Guard-denial baseline and the approved open-PR backlog plan are in the repository

The 2026-09-11 backlog plan (Astra round 2 APPROVE WITH CHANGES; Mason's rule "if it approves I agree
with it all") lived only in one session's scratch directory. It is now
`docs/plans/2026-09-11-open-pr-backlog-plan.md`, a frozen record of the approved text. The live queue
state (owner per PR, sequencing, open coordinator decisions) is not kept in the plan: it moved to
`docs/manual/CURRENT_STATE.md` under "Open-PR landing queue". Landing step 3 was amended on 2026-09-13 to
the repository contract: reviews are requested only through the `ready-for-coderabbit` label
workflow, a hand-posted request authorizes nothing, and a corrected head lands through a fresh
delivery PR or the candidate waits on PR #647.

Section 6 of that plan requires a denial baseline at the start of the 2026-09-11 to 2026-09-25 guard
freeze. `docs/reports/2026-09-11-guard-denial-baseline.md` records it: the exact read-only command
(`scripts/claude-usage-report.mjs` at `a8656debb`, window 2026-09-04 to 2026-09-11), 1,199 raw
classifier hits out of 36,228 unique tool calls (3.31%), at most 1,151 (3.18%) after removing known
false positives, by category and tool, the read-looking share, repeated identical refusals, session
concentration, a measured time-lost proxy (each denied call counted once: median five seconds from a
denial to the next tool call, about three and a half hours over the week), the fields that could not
be measured, and the exact re-measure command for 2026-09-25 pinned to the same script revision. No
denied command text is quoted; the export stays in scratch. Documentation only; no guard logic,
source, or migration bytes changed.
