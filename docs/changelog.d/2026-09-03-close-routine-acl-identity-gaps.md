## 2026-09-03 - Close migration ACL parser identity gaps

- The migration proof gate now recognizes `ALTER ROUTINE ... SECURITY DEFINER`, requires explicit `public` schema targets, and treats search-path-sensitive or malformed ACL syntax as unverified.
- Its required correction test path now includes the dedicated SECURITY DEFINER parser regression tests, including quoted role identities.
