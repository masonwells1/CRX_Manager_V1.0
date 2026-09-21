## 2026-09-21 - Customer-document files move behind a server-only Edge Function (PR #635 successor, PARKED)

- **Why:** Codex's P1 on PR #635. Anyone with Storage read access to a customer document could mint
  a signed download URL with any expiry, and that URL kept working after the document was
  soft-deleted. PR #635's page-only change could be bypassed by calling Storage directly.
- **New Edge Function `customer-document-files`** (`supabase/functions/customer-document-files/`):
  `prepare_upload` returns a single-path upload token for a server-chosen path in an authorized
  customer's folder; `download` re-reads the document row and refuses removed or unauthorized
  documents, and any path not in the server-issued shape, before sending the bytes. Admins reach
  every customer; sales reps only their assigned customers; other roles, inactive profiles, and
  signed-out callers are refused. A missing file answers 404; any other Storage failure reaches
  Sentry as a 500.
- **New migration `20260914100450_customer_document_bytes_server_only.sql` (history row 935):** drops
  all five browser Storage policies on the `customer-documents` bucket and adds
  `customer_documents_storage_path_shape_check`, so no document row can name a look-alike (`#`, `?`,
  `%` variant) of a removed document's path. Stamped between the live high-water `20260914100400`
  and the waiting `20260914100500` so it strands nothing; apply it promptly after merge. Its
  preflight refuses a non-empty bucket, since a link minted under the old rules before the apply
  could not be revoked (proven locally: refused with a file present, applied once emptied). It locks
  `storage.objects` before that check, so no upload can slip in between the check and the drops. Supersedes
  the never-applied `20260908054649` candidate on PR #635's branch, which never reached `main`.
- **Documents tab** (`CustomerDocuments.tsx`, new `src/lib/customerDocumentFiles.ts`) uploads and
  downloads only through the function, and refreshes its list after a refused download or a failed
  save.
- **Review:** the security reviewer found the look-alike-path route (HIGH), fixed by the shape CHECK
  plus a matching check in the function; a discard action was removed rather than giving browsers a
  delete power with a check-then-delete race. The migration reviewer's lock-timeout, postflight and
  merge-coupling findings and the compliance reviewer's four MED findings are fixed.
- **Proof observed:** `scripts/smoke/prove-customer-document-bytes-server-only.mjs` against a real
  local Supabase stack whose bucket policies matched live's md5s. Before the migration, 5/5: a rep's
  one-year signed URL still returned the bytes after soft delete. After it, 29/29, and the same attack
  fails at every step. The real `customerDocumentFiles.ts` helper also ran end to end against that
  stack. Deno unit tests cover the request and path rules; Vitest covers the helper.
- **Not verified:** a browser click-through of the Documents tab (the page needs the full schema,
  which the local stack does not have); that happens on live after deploy. The function is not
  deployed and the migration is not applied. The order is deploy, then merge, then apply, each with
  Mason's explicit approval.
- **Found and recorded separately, not fixed here:** a sales rep's soft delete of a customer document
  is refused by RLS on live (admins can remove documents); see `docs/manual/KNOWN_ISSUES.md`.
