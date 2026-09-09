## 2026-09-05 — `read_network_requests` moves from `allow` to `ask` (Codex HIGH on PR #605 head `d6302e28b`)

The exact-SHA `gpt-5.6-sol` review of `d6302e28b` returned `CODEX_PROOF_VERDICT: BLOCKERS` with one HIGH:
`.claude/settings.json` newly placed `mcp__Claude_Browser__read_network_requests` in `allow`. CRX page traffic
carries Supabase bearer session tokens (`src/lib/emailService.ts`) and temporary signed links to private
customer documents (`src/components/customers/CustomerDocuments.tsx`), and nothing in the repo proves the
browser connector strips authorization headers, request bodies, or access-bearing URLs before returning
them. An agent, or a prompt-injected page, could therefore put credentials into model context with no
prompt. On `main` the tool is unlisted and silently denied under `dontAsk`, so the exposure was introduced
by this PR.

### What changed

- `.claude/settings.json`: `mcp__Claude_Browser__read_network_requests` removed from `permissions.allow`
  and added to `permissions.ask`, beside the five interactive browser tools. An `ask` rule forces a prompt
  in every prompting mode. The other thirteen read-only browser tools (`read_page`, `get_page_text`, `find`,
  `read_console_messages`, tabs, preview, `resize_window`, …) stay in `allow`.
- `docs/reference/agent-guardrails.md`: the `review-proof-guard.mjs` row now says 80 entries across 20
  patterns including `.claude/launch.json` (the review's Low follow-up).
- No hook, test, or other tier changed.

### Verification

- `.claude/settings.json` parses; the tool appears once, in `ask`, and not in `allow`.
- `npm run check:docs`, `npm run test:agent-workflows`, and the guard suites pass.
