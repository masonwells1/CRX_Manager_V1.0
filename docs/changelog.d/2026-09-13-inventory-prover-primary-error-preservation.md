## 2026-09-13 - Preserve the inventory prover's original staging error

CodeRabbit's final PR #665 review found that a secondary temporary-file cleanup failure could replace the original SQL-staging or Docker-copy error. Staging now always attempts cleanup, reports a secondary cleanup failure, preserves the original failure, and still fails when cleanup is the only error. Missing temporary files remain harmless.

The actual-function fault-injection check reproduced the old error masking before this correction; corrected primary-plus-cleanup, cleanup-only, missing-file, write-failure and successful staging cases pass with LF bytes retained. The full network-disabled disposable PostgreSQL 17 prover also passed refusal, replay, concurrency, legacy-receipt refusal and rerun checks with the corrected script. Inventory frontend and parked migration executable inputs are unchanged from the candidate that passed 185 focused checks. No live database change is included.
