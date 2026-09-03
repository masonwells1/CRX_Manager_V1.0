## 2026-09-03 - Close migration ACL parser identity gaps

- The migration proof gate now recognizes `ALTER ROUTINE ... SECURITY DEFINER`, requires explicit `public` schema targets, and treats search-path-sensitive or malformed ACL syntax as unverified.
- It also rejects quoted-identifier lookalikes, tracks DROP/re-create privilege resets, includes procedures, and runs those regression tests through the required correction path.
- Migration-review packets now include edge-function RPC callers and hash their source, while Git-free reviewer children receive the required launch flag.
