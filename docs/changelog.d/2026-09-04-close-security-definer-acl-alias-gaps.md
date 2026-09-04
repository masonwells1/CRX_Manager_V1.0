## 2026-09-04 - Close SECURITY DEFINER ACL identity gaps

The migration proof ACL scanner now normalizes PostgreSQL routine type aliases and refuses
unmatched `PUBLIC` or `anon` ACL events instead of silently ignoring them. It also rejects dynamic
ACL work inside transient helper routine bodies, closing a path where a helper could grant
execution and disappear before migration completion.

Grant-only changes to an existing routine now fail closed unless that routine is declared in the
same migration, and migrations that disable `standard_conforming_strings` are rejected until the
scanner can model their escape rules. Reviewer evidence now includes source-level CREATE, ALTER,
GRANT, and REVOKE history for every routine changed by a migration; it states explicitly that
source history is not a substitute for a verified live effective ACL.
