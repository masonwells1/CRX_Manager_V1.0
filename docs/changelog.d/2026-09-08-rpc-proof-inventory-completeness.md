## 2026-09-08 - RPC proof inventory completeness

- Hardened the migration-proof RPC caller scanner so direct calls from every client receiver are inventoried with JavaScript-aware string, comment, regular-expression, and template handling.
- Added fail-closed coverage for dynamic and indirect RPC access plus a production-source inventory check that prevents caller omissions from silently minting migration proof.
