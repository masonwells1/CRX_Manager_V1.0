## 2026-09-04 - Shared migration-apply transaction control

- Made the shared migration apply gate reject top-level transaction control, so the direct MCP apply path cannot accept an anonymous-execution revoke that a later savepoint rollback undoes.
- Made the SECURITY DEFINER SQL lexer fail closed for quoted `set_config` calls, including schema-qualified calls, because they can change string-literal parsing assumptions.
- Added regression tests for both bypass shapes.
