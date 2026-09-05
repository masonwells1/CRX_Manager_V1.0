## 2026-09-05 - Cover Supabase aliases and replacement connector SQL

Resolve the remaining GitHub Codex findings on PR #605: recognize Supabase anywhere
in the server name, including `supabase_prod` and `my_supabase_connector`. Unknown
mutations and lifecycle operations on those aliases now reach the same guard.

SQL on a replacement UUID or renamed Supabase server requires an exact ask/deny
entry. A read-only tool registration or an allow entry cannot establish SQL-write
authority. Established server identities retain their existing downstream guards.
Tests exercise aliased reads and mutations, a profile-write payload on a replacement
UUID, allow-only rejection, and delegation to explicit ask/deny rules. No SQL is
executed: these are synthetic inputs to the guard process.
