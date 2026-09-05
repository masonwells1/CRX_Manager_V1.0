## 2026-09-03 - Fail closed on unprovable SECURITY DEFINER ACL syntax

The migration proof producer now recognizes quoted SECURITY DEFINER function
names and rejects every ACL form it cannot prove safe. This includes schema-wide
function grants, role/group syntax, grant options, malformed ACL statements, and
later grants that could restore `PUBLIC` or `anon` execution.
