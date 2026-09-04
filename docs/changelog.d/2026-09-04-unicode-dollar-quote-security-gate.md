## 2026-09-04 - Unicode dollar-quote security gate

- Made the SECURITY DEFINER migration lexer recognize Unicode PostgreSQL dollar-quote tags, so executable routine bodies cannot be mistaken for top-level SQL.
- Added a regression proving that a Unicode-tagged SECURITY DEFINER function must revoke execution from both `PUBLIC` and `anon`.
