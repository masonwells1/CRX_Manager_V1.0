## 2026-09-07 - Harden migration-proof trust boundaries

Migration-proof evidence now enumerates tracked inputs through a fixed Git binary with a scrubbed environment, bounded execution, and strict UTF-8 path validation. RPC call-site analysis uses the TypeScript AST and rejects dynamic or indirect calls; routine analysis preserves UTF-16 offsets and refuses schema-wide routine ACLs that cannot be safely attributed.
