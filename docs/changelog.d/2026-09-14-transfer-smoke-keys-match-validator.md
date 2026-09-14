## 2026-09-14 - Every transfer smoke key now passes the parked wrapper's key format

The parked, unapplied migration `20260908130800_bind_transfer_invoice_intent.sql` accepts
only idempotency keys matching `^[!-~]{1,200}$`, so a key containing a space raises
`IDEMPOTENCY_KEY_REQUIRED`. The machine-fee chain was corrected earlier, but Codex App's
review of delivery PR #698 found that other registered rollback chains still passed
`[SMOKE] …` keys to `transfer_job_to_invoice`. Once the wrapper applies they would abort in
setup instead of testing what they cover.

A sweep of every `transfer_job_to_invoice` call under `scripts/` (literal and variable keys)
found seven such keys in four files, one more than the review named:

- `smoke-billed-job-immutability.sql`: `im-fwd`, `im-fwd2`, `im-L1`
- `smoke-transfer-invoice-to-job.sql`: `rt-fwd`, `rt-fwd2`
- `smoke-field-invoice-loop.sql`: `tji`
- `smoke-transfer_job_invoice_column_fixes.sql`: `tji` (held in `v_idem`, used for both the
  first call and its replay)

Each now uses a `SMOKE-<name>-<suffix>` key with no space. Only the key text changed; no
assertion, fixture or SQL statement in a migration changed. These chains need a database and
were not run here. No SQL is applied and no production behaviour changes.

- **2026-09-14, CodeRabbit on delivery PR #698 at `39af0526b`:** `src/lib/db.test.ts` now also covers `assertTransferResultForJob()` refusing a result whose `job_id` is not a string. The repeated finding asking to revert the comment-only edit in never-applied `20260905200200` stays unchanged (owner decision 2026-09-13).
