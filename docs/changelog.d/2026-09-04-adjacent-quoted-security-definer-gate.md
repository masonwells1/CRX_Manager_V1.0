## 2026-09-04 - Adjacent quoted SECURITY DEFINER gate

- Made the SECURITY DEFINER ACL guard recognize PostgreSQL's legal `FUNCTION"quoted_name"` and `PROCEDURE"quoted_name"` syntax, so unusual whitespace cannot hide a routine that lacks its required anonymous-execution revokes.
