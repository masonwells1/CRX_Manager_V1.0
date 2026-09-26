## 2026-09-26 — record the customer-document migration as applied, and close its known issue

`20260914100700_customer_document_bytes_server_only` applied live on 2026-09-26 (ledger version
`20260926163005`), and the schema-registry refresh in the same PR (#799) moved the registry's
effective high-water to that stamp. Two things then disagreed with the live database:

- `src/lib/rpcContracts.test.ts` failed in CI, because migration-history row 935 still said
  **LOCAL CANDIDATE — NOT APPLIED LIVE** for a stamp now at or below the registry high-water. Row 935
  now reads **APPLIED LIVE 2026-09-26**, with the post-apply evidence. The file defines no functions,
  so nothing is missing from the generated types.
- The Codex GitHub review (P2) flagged the boundary records. The top of
  `docs/reference/migration-history.md` gains a 2026-09-26 capture (1011 ledger rows / 1004 distinct
  names, `max(version)` `20260926163005`, effective high-water `20260914100700`; only `100800` and
  `100900` still wait). `CURRENT_STATE.md` records the apply, and the `KNOWN_ISSUES.md` entry on
  customer-document download links is marked **RESOLVED**.

**Proof observed (cloud session, read-only live reads):** no Storage policy on `storage.objects`
names the `customer-documents` bucket; `customer_documents_storage_path_shape_check` exists; the
bucket and `customer_documents` hold 0 rows; the checked-in SQL matches row 935's sha256 pin.
`npx vitest run` passed (380 files, 5411 tests); all 53 top-level hook and script tests and
`scripts/check-doc-drift.mjs` passed.
