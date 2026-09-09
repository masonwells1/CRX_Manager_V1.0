## 2026-09-07 - Merge main into #592 and reconcile the migration-history record by content

`main` moved to `629e5b1f6` (PR #625, "record that migration 916 is applied live, and correct two
stale #614 claims") while #592 was mid-review. Both branches had edited
`docs/reference/migration-history.md`, which left #592 `mergeStateStatus: DIRTY`. That is not a
cosmetic state: GitHub cannot build a trial merge commit for a conflicting PR, so the
`pull_request`-triggered CI workflow was never queued at all. The head still showed a green tick,
earned entirely by the two `pull_request_target` workflows plus CodeQL and Vercel, which run against
the base rather than the merge. The PR read green while its tests had not run.

`main` was merged in and the single conflicted file resolved **by content, not by side**. Taking
"ours" wholesale would have silently reverted #625's live-ledger correction; taking "theirs"
wholesale would have dropped the six parked commission rows #592 owns. Every row #592 carries is
preserved, and for the two rows `main` had rewritten from live evidence — 916 and 917 — `main`'s text
wins.

**Row 916 was registering as a parked candidate it is not.** #592's wording opened
`LOCAL CANDIDATE header — NOT APPLIED per the file's own header, which is now STALE…`. That is
accurate prose, but `localCandidateMigrationPathsFromHistory` matches
`LOCAL CANDIDATE … NOT APPLIED` by adjacency across the whole row, so the row registered
`20260904185900_refuse_null_job_field_acres.sql` as parked — a migration that has been applied live
since 2026-09-05 (PR #606, ledger version `20260905185938`). `main`'s corrected row opens
`APPLIED LIVE` and does not match.

Proven by running the real parser over both trees rather than reading it: the pre-merge head reported
`state: known`, empty reason, 8 candidates; the merged file reports `state: known`, empty reason, 7.
The single dropped path is `20260904185900_refuse_null_job_field_acres.sql`, and nothing was added.
The seven that remain are the six parked commission candidates (rows 914, 918, 919, 920, 922, 915)
plus row 917's separate `20260905090000` next-invoice-number candidate.

The merge was checked for the failure mode that matters here: a merged table naming one migration
twice returns `{ state: "unknown", paths: new Set() }` with reason
`duplicate LOCAL CANDIDATE history rows name the same migration`, which empties the candidate set and
disarms the ordering guard without failing anything. The merged file returns `known` with an empty
reason, so that did not happen.

At this merge checkpoint, no migration was applied, no live data changed, no migration SQL was
edited, and the replay-guard finding on
`20260905200000_commission_history_report_replay_guard.sql:59` remained open and unmodified. It was
addressed later under a fresh migration proof gate; see
`docs/changelog.d/2026-09-07-pr592-replay-guard-successor-contract.md`.

Verified on the merged tree: `tsc --noEmit` exit 0; full vitest suite 359 files / 5116 passed, 123
skipped; `scripts/check-doc-drift.mjs` PASS; `scripts/check-ledger-update.mjs` exit 0;
`npm run test:agent-workflows` PASS.
