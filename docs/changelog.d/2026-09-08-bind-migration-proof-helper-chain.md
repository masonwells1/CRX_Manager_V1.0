## 2026-09-08 - Bind the migration-proof helper chain

Every direct helper used to create or validate migration-review proof is now
protected by the Codex production-action boundary. The proof producer refuses
to run if any of those helper files differs from its committed candidate bytes,
and the proof-evidence hash includes the proof-state helper that controls
authorization-file revocation. Per-migration exclusive locks now prevent
overlapping reviews from leaving an earlier clean proof usable after a failed
re-review. RPC exposure detection also follows direct aliases of the Supabase
client before rejecting dynamic property access.
