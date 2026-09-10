## 2026-09-04 - Reject quoted string-mode settings in SECURITY DEFINER proof scans

The SECURITY DEFINER migration-proof lexer now recognizes quoted
`standard_conforming_strings` configuration names, so that spelling cannot bypass the parser-mode
safety check.
