## 2026-09-07 - Reconcile the commission-candidate records and bound the Chicago-date provers

CodeRabbit review 5128058746 on PR #592 raised eight inline findings against `4cb4cb674`. Seven are
addressed here. No migration was applied, no live data changed, and no migration SQL was edited.

**`docs/reference/migration-history.md` — the candidate summary contradicted its own table.** The
summary called rows 914, 915, 917-919 and 921 the six parked commission candidates. Checked against
the table, which is the authority: the real six are rows 914 (`20260905200000`), 918 (`200200`),
919 (`200300`), 920 (`200400`), 922 (`200600`) and 915 (`210000`). Row 921 (`200500`) is SUPERSEDED
BEFORE APPLY and is not a parked file; row 922 was missing from the summary entirely; and row 917 is
the unrelated `20260905090000` next-invoice-number candidate from its own lane, still stamped below
the live high-water and needing its own restamp. The summary now lists each row with its current
version and defers to the table. The imprecise "five of which were stamped…" sub-count was dropped
rather than restated, because only row 915 records its pre-restamp stamp in the table.

Row 921's own detail also said the superseded file was folded into "row 919's" `20260905200400`
migration. `20260905200400` is row 920; corrected.

Only prose changed. No table row was touched, so
`localCandidateMigrationPathsFromHistory` — which reads only lines beginning with `|` — is
unaffected; re-running the real parser against the edited file still reports `state: known`, an empty
reason and 8 candidates.

**`docs/manual/KNOWN_ISSUES.md` — removed a second copy of the live ordering boundary.** The file's
own header declares `docs/reference/migration-history.md` the single source for the boundary, then
restated ledger row `20260905185938` anyway. That copy goes stale the moment another migration
applies, which is exactly the trap the header documents being hit for real on 2026-09-05. The
restamp history stays; the boundary is now a pointer.

**`docs/reference/rpc-functions.md` — the Reporting heading claimed 14 RPCs over a list of 12.** The
two implied by the section's notes, `get_monthly_summary()` and `get_customer_year_end_summary()`,
are already documented under Financial and AR & Statements. Rather than adding second copies that can
drift apart, the heading is corrected to 12 and points at the sections that own them.

**`docs/changelog.d/2026-09-05-commission-set-restamped-above-applied-high-water.md` — a seven-file
order sat above a six-file plan.** The emitted order ending `…200400, 200500, 200600, 210000` was
genuine prover output, and the same paragraph twice describes the proof as running "the seven
renumbered names", so deleting `200500` from the list alone would have left a seven-name claim over a
six-name list. The order is now labelled as historical pre-consolidation output, preserved as
evidence, with the current six-file pending set called out.

**`docs/changelog.d/2026-09-05-quick-delivery-argument-default-chicago.md` — "live exposure today is
nil" was too broad.** The same section already explains that a caller omitting `p_scheduled_date`
reaches the wrapper's UTC `CURRENT_DATE` default. The claim is now scoped to known application
callers, and states that direct RPC callers remain exposed.

**`scripts/smoke/prove-commission-dates-chicago.mjs` and `prove-document-dates-chicago.mjs` — the
`docker` wrappers called `spawnSync` with no timeout.** Both provers apply the candidate while other
sessions may hold table locks, so a holder that never releases would block the prover forever, keep
the container alive and hang CI until the outer job limit. Both wrappers now pass a default
`timeout`, with `...options` still last so a phase can raise it for a long apply or drain. A timed-out
call surfaces its error text instead of an otherwise blank failure.

**`src/pages/Reports.commissionHistory.test.tsx` — a timing-dependent spy.** The rolling-preset test
installed its `todayInBusinessTz` spy before the initial commission request settled, so that
request's rerender could consume `mockReturnValueOnce('2026-09-30')` and leave the preset deriving
from `2026-10-01`. It now awaits `CP-2026-0042` first, matching the neighbouring test.

**Not addressed — left open deliberately.** The eighth finding, on
`supabase/migrations/20260905200000_commission_history_report_replay_guard.sql:59`, asks for the
balance-report child contract to accept both known bodies. The mechanism is real: `20260905200600`
replaces `get_commission_balance_report`, and that file's own preflight, plus `20260905200200` and
`20260905210000`, all use two-value `md5(prosrc) IN (...)` pins for exactly this reason, making
`20260905200000` the cohort's only single-value pin on a child a sibling replaces. It is not fixed
here because changing a migration's pin re-opens the migration proof gates on a money PR
mid-landing, and widening a guard as a review response is the wrong way to make that call. Tracked
for a deliberate decision with its own proof.
