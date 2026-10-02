## 2026-10-02 - Documents tab: Remove calls soft_delete_customer_document

`20260921180000_soft_delete_customer_document_rpc` applied live on 2026-10-02 (ledger version
`20261002230949`) and PR #800 merged as `c78b73b67`. This change ships the page half: the
Documents tab's Remove button now calls `soft_delete_customer_document(p_document_id,
p_customer_id, p_idempotency_key)` instead of updating `customer_documents` directly, so a sales rep
can remove a document of a customer assigned to them (the direct UPDATE was refused for reps by
RLS). The page sends this page's customer id, keeps one idempotency key per attempt, logs the
removal only after the RPC confirms this document and customer, and classifies every refusal
through `hasRpcCode` / `rpcCodeDetail`.

The page commits were rebuilt on current `main` (branch `claude/customer-document-rep-remove-page-v4`,
replacing the never-opened `-v3`). `src/types/supabase.ts` now carries the entry exactly as live type
generation emits it, so `rpcContracts.test.ts` moves the function from
`MIGRATION_ONLY_RPCS_WITH_IDEMPOTENCY` to `MUTATING_RPCS_WITH_IDEMPOTENCY`, as that list's note
planned. Migration-history row 936, `KNOWN_ISSUES.md` and `CURRENT_STATE.md` now record the live
apply and its read-only post-apply check (one overload, SECURITY DEFINER, `search_path=public,
pg_temp`, owner `postgres`, EXECUTE for `postgres` and `authenticated` only).
