## 2026-09-03 - Analyze revised pending migrations in safety guards

- The deterministic migration hard-rule check now applies its existing new-table RLS and policy analysis
  to modified pending migrations, not only newly added files. Pending deletions remain an explicit warning
  because no HEAD source exists to inspect.
- The capped actor-binding hook now reconstructs the full post-Edit or MultiEdit migration with the shared
  CRLF-safe splice helper before running its unchanged best-effort analysis. This does not reopen the
  pattern-hardening program or promote the hook to a security boundary.
- Red-first repository scenarios and real-hook fixtures cover unsafe pending revisions, exemptions,
  pending deletion and renames, partial body edits, MultiEdit, benign edits, and existing file-level
  exemptions.
- No database migration, schema change, live apply, deployment, or production-data write is included.
