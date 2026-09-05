## 2026-09-05 — Browser MCP grant narrowed to read-only tools (Codex HIGH, PR #605 round 3)

The third exact-SHA Codex review of PR #605 returned `BLOCKERS` with two HIGH findings. This entry
records the fix for the first one and the comment corrections; the second finding (native
`Edit`/`Write` of the enforcement surfaces) is a policy question that goes back to Mason and is
recorded in whichever entry lands after his decision.

### Finding 1 — server-wide `mcp__Claude_Browser` grant

`mcp__Claude_Browser` as a whole was in `permissions.allow`, which under `dontAsk` admits the
interactive browser tools (`computer` click/type, `form_input`, `javascript_tool`,
`browser_batch`) with no prompt. A session on an authenticated Supabase, Vercel, GitHub or billing
page could submit a form. No Claude hook recognises those tools.

- **Removed** the server-wide grant.
- **Added** explicit `allow` entries for the read-only browser tools only: `navigate`,
  `read_page`, `get_page_text`, `find`, `read_console_messages`, `read_network_requests`,
  `tabs_context`, `tabs_create`, `tabs_select`, `tabs_close`, `preview_start`, `preview_list`,
  `preview_logs`, `preview_stop`, `resize_window`.
- `computer`, `form_input`, `javascript_tool` and `browser_batch` are deliberately unlisted: they
  prompt in a prompting mode and are refused under `dontAsk`, exactly as on `main` today.

### Comment corrections (no logic change)

- `.claude/hooks/mcp-tool-guard.mjs` header said `set_config_value` "is now allowed"; the second
  PR #605 commit had already moved it to `deny`. The comment now says so.
- `.claude/hooks/review-proof-guard.mjs` (deny message and the native-editor comment) no longer
  claims the `ask` tier is what gates native edits of the enforcement surfaces; it now points at
  the permission tiers in `.claude/settings.json` and the risky-path exact-SHA proof at merge.

### Verification

- `node scripts/check-agent-guidance.mjs`, `node scripts/check-agent-workflows.mjs`, and
  `node .claude/hooks/mcp-tool-guard.test.mjs` (30 assertions) pass on the corrected files.
- Not verified: no live probe of the browser tools in a CRX-rooted session; the effect is read
  from the permission-precedence rule.
