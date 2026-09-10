## 2026-09-04 - Reject dynamic string-mode settings in SECURITY DEFINER proof scans

The SECURITY DEFINER migration-proof lexer now requires `set_config()` to use a complete literal
configuration-name argument followed by a comma. Concatenated or otherwise dynamic names fail
closed rather than changing quoted-SQL parsing assumptions.
