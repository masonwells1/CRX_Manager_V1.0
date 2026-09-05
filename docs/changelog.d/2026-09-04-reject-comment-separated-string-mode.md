## 2026-09-04 - Reject unsafe string-mode changes in SECURITY DEFINER proof scans

The SECURITY DEFINER migration-proof lexer now detects executable comment-separated
`standard_conforming_strings` settings and dynamic `set_config()` calls. It refuses to issue ACL
proof when either form could change how quoted SQL is parsed.
