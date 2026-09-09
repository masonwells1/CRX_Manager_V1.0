## 2026-09-05 — `preview_start` prompts and `read_network_requests` is denied (GitHub Codex P1 x2 on PR #605 head `c82d29308`)

Two P1s from the GitHub Codex reviewer on `c82d29308`:

1. "Require approval before starting configured previews" — protecting `.claude/launch.json` from edits
   (`d6302e28b`) is not sufficient: `git switch <contributor-branch>` brings a modified `launch.json`, and
   `mcp__Claude_Browser__preview_start`, then in `allow`, executes that file's `runtimeExecutable` and
   `runtimeArgs`. Both steps pass every registered hook.
2. "Deny browser network capture until credentials are redacted" — moving `read_network_requests` to `ask`
   (`c82d29308`) changes who authorizes a capture, but an approved capture still puts the Supabase bearer
   token (`src/lib/emailService.ts`) and signed customer-document URLs (`CustomerDocuments.tsx`) into
   model context, and connector redaction is unproven.

### What changed

- `.claude/settings.json`: `mcp__Claude_Browser__preview_start` moves from `allow` to `ask`, so starting a
  configured dev-server preview prompts in every prompting mode. The twelve remaining read-only browser
  tools (`read_page`, `get_page_text`, `find`, `read_console_messages`, tabs, `preview_list`,
  `preview_logs`, `preview_stop`, `resize_window`) stay in `allow`.
- `.claude/settings.json`: `mcp__Claude_Browser__read_network_requests` moves from `ask` to `deny`. `deny`
  holds in every permission mode. On `main` the tool is unlisted and silently denied under `dontAsk`, so
  this restores main's effective behaviour. Re-opening it requires a proof that the connector redacts
  authorization headers, bodies, and access-bearing URLs (or a redacting guard in front of it); recorded
  as a follow-up.
- No hook, test, or other tier changed. The `.claude/launch.json` protections from `d6302e28b` stay.

### Verification

- `.claude/settings.json` parses; `preview_start` appears once, in `ask`; `read_network_requests` appears
  once, in `deny`; neither is in `allow`.
- `npm run check:docs`, `npm run test:agent-workflows`, and the guard suites pass.
