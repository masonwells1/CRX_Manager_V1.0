## 2026-09-04 - Close SECURITY DEFINER ACL identity gaps

The migration proof ACL scanner now normalizes PostgreSQL routine type aliases and refuses
unmatched `PUBLIC` or `anon` ACL events instead of silently ignoring them. It also rejects dynamic
ACL work inside transient helper routine bodies, closing a path where a helper could grant
execution and disappear before migration completion.
