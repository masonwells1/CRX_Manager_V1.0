## 2026-08-27 — Preserve production guard reachability for native edits

Final exact-head review found that narrowing the Codex production-action guard to shell and MCP
tools would exclude native `Write`, `Edit`, and `apply_patch` calls. That guard protects its own
configuration and other release-harness files from being rewritten, so the narrowed matcher would
have weakened an existing safety boundary.

Restored the production-action guard matcher to `*` and added a manifest regression assertion that
keeps it reachable for native edits. The separate migration-apply, MCP-tool, and live-testdata
guards remain correctly narrowed to MCP tools. No business rule, product code, database object, or
branch-protection setting changed.
