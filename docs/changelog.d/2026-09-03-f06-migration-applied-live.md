## 2026-09-03 — F06 migration `20260903150000_job_chemicals_persist_driver` applied live

**What changed.** The database half of the F06 fix (`docs/changelog.d/2026-09-03-f06-job-chemicals-driver.md`,
PR #582) is now live: `job_chemicals.driver` exists and `save_job` stores which field the operator
typed. Ledger version `20260903153402`, applied 2026-09-03 15:34 UTC under Mason's in-chat
"ok apply migration". The schema registry was regenerated from live introspection in the same
session; KNOWN_ISSUES F06 is RESOLVED; CURRENT_STATE and migration-history row 903 record the
post-apply boundary. No code changed.

**Proof observed.**
- Apply proofs minted this session by `node scripts/write-apply-proofs.mjs` (gpt-5.6-sol, high).
  Both charter captures were judged as genuinely completed runs before anything was transmitted:
  CLI completion footer present once, zero `404 Not Found` lines, and the
  `CODEX_PROOF_VERDICT: CLEAN` line positioned after the echoed prompt and immediately before the
  footer — `rls-security-reviewer` 0/0/0 (81,345 tokens), `migration-drift-reviewer` 0/0/0
  (110,726 tokens). This mattered because two earlier mint attempts the same day failed with
  transport 404s from the OpenAI backend and produced no review at all; the verdict token alone is
  spoofable because the CLI echoes the charter into the capture.
- Same-turn transmit checklist: live ledger re-read at 15:33:53 UTC (992 rows, `max(version)`
  `20260903124741`, no F06 row, no `driver` column, no `job_chemicals_driver_chk`, `save_job` md5
  `227ab7b6bc2023724adf6952a221d2a8`, one overload); migration blob
  `3c1b3d149826b0025bd15d0b6d38b6fbe68b9a30` verified identical to `main` via the GitHub contents
  API; `scripts/apply-migration-file.mjs … --confirm` → APPLY GATE PASSED, HTTP 201, queryHash
  `2dabfda1c1f74900fe7be500e0a2598ef4063e903768c90f5905f58e977b5ef7`.
- Judged by SELECT at 15:34:17 UTC, not by the exit code: 993 ledger rows; row
  `20260903150000_job_chemicals_persist_driver` @ `20260903153402`; `driver` = text, nullable, no
  default, not generated; `job_chemicals_driver_chk` =
  `CHECK (((driver IS NULL) OR (driver = ANY (ARRAY['rate'::text, 'qty'::text]))))`; `save_job`
  single overload, md5 `18d08d5f40aea91fe13ac3e5a686c549`, `chem_unit_invariant_v3` present,
  `chem_unit_invariant_v2` absent, `CHEM_DRIVER_INVALID` present; 4 live `job_chemicals` rows, all
  NULL driver (expected — rows saved before the apply stay unknown until re-typed).
- `.claude/schema-registry.json` regenerated with the real `--from-introspection` mode from six
  read-only queries: diff is 16 insertions / 2 deletions — `migrations_high_water`
  `20260903025854` → `20260903153402`, `applied_migration_names` + the F06 name,
  `job_chemicals.driver` CHECK value set `rate`/`qty`, and the `driver` column. Nothing removed;
  `status_enums` did not collapse.

**Reviewer note recorded, not hidden.** Alongside the Codex charters, the local
`rls-security-reviewer` subagent (run on Sonnet because the Opus/Fable tier returned 529s) reported
one HIGH: the migration lacks an "APPLY CHANNEL" header comment. It was assessed and dismissed on
content — the finding is comment-only, the file's header already names the guarded
`scripts/apply-migration-file.mjs` path, and the Codex `rls-security-reviewer` charter that gates
the apply reported 0 HIGH on the same file. That subagent run is therefore recorded as
"1 HIGH, dismissed", not as clean.

**Not verified.** No end-to-end save through the live app after the apply; the client behaviour was
verified against the real page in the stubbed harness and against the container prover before the
merge, and the live function body is byte-identical (md5) to the body those tests exercised. The
first real save that carries a `driver` value will be the first live exercise of the new column.
