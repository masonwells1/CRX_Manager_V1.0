## 2026-09-22 - soft_delete_customer_document: PR #767 review fixes

- **CodeRabbit (minor, CHANGES_REQUESTED):**
  - The original changelog entry and migration-history row 931 still listed `20260914100500` and
    `100600` as prerequisites, but both applied live on 2026-09-21.
  - They now name only `20260914100450` (PR #761), `100800` and `100900`.
  - They record the prover's replay as 95 applied post-baseline migrations with 2 skipped.
- **Codex connector (P2):** `CUSTOMER_DOCUMENT_NOT_FOUND` now lands in `src/lib/db.ts`
  `RpcErrorCodes` with the migration that raises it. Before, it lived only in the follow-up page PR.
