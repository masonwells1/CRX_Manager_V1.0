## 2026-09-26 — refresh the schema registry from live Supabase

The session-staleness check reported `.claude/schema-registry.json` behind the migrations on disk.
Seven of the `20260914…` migrations had been applied live since the 2026-09-20 refresh (the last,
`20260914100700_customer_document_bytes_server_only`, at 2026-09-26 16:30 UTC).

Rebuilt with the real `--from-introspection` mode from the six read-only queries (Q1–Q6) in
`scripts/regenerate-schema-registry.mjs`, run through the Supabase MCP on project
`rhyzpcqhnizqbxphqdkr`:

- `migrations_high_water` 20260920052149 → 20260926163005; the seven applied names were added to
  `applied_migration_names`.
- `skipped_constraints` gains `customer_documents_storage_path_shape_check` (a regex CHECK the hooks
  cannot validate).
- No change to generated columns (11), status enums (38), parsed CHECK IN-lists (119), NOT NULL
  columns, column lists (160 tables), tables without `updated_at` (94), or sequences (7).

`20260914100800_bind_transfer_invoice_intent` and `20260914100900_repair_commission_history_label_snapshots`
are on disk but not applied live, so they correctly stay out of the name list.
