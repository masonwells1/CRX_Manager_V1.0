## 2026-09-05 - Migration proof Unicode GUC and active-ledger binding

- Hardened the `SECURITY DEFINER` routine-body proof scanner against PostgreSQL Unicode-escaped configuration identifiers. It now recognizes default Unicode escapes, rejects alternate or malformed escapes, and refuses unparseable `SET`, `RESET`, and `set_config` forms rather than allowing a body to override `search_path` unseen.
- Made linked-worktree migration applies read the same session-owned applied-migrations ledger that the reviewer evidence hashes, preventing a proof for one ordering floor from authorizing an apply against another.
