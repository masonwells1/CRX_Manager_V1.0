## 2026-09-04 - Preserve ACL scanner tokens around dollar-sign identifiers

The SECURITY DEFINER migration-proof lexer now recognizes dollar-quoted strings only at a valid
token boundary. PostgreSQL identifiers containing `$` can no longer conceal a later execute grant
or revoke from the static ACL scanner.
