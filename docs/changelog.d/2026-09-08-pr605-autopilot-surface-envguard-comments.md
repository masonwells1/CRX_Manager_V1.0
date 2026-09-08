## 2026-09-08 — PR #605: armed autopilot refuses enforcement-surface edits; env-guard stops obeying comments

Codex (`gpt-5.6-sol`, high effort) reviewed `28bba740b` for the exact-SHA push proof and returned
BLOCKERS with two Highs. Both probe-confirmed before the fix.

### High — armed autopilot auto-approved a native Edit/Write of the enforcement surface

`autopilotDecision("Edit", { file_path: ".claude/hooks/x.mjs" })` and `Write package.json` returned
`allow`. The native editors are exempt from `review-proof-guard.mjs` by design (their gate is the
settings `ask` prompt), and a hook `allow` cannot disarm a settings `ask` (measured 2026-09-06), so the
prompt still fired — but autopilot exists so nobody is at the keyboard, and the honest armed-mode
answer to a prompt is a refusal. Fix: `autopilot-lib.mjs` carries `PROTECTED_SURFACE_RE`, the same
literal as review-proof-guard's path-field regex, and `autopilotDecision` denies any native-editor or
MCP path field that matches it (backslashes folded, absolute Windows paths judged the same as relative
ones). `protected-surface-parity.test.mjs` now holds FOUR lists equal over every tracked path: every
settings-protected path must be denied by armed autopilot, and every path armed autopilot refuses must
carry a settings ask entry (`.env*` excepted — settings carries it under `deny`). `apply_migration`
remains outside this set by the settled 2026-07-13 policy; migration-apply-guard gates it separately.

### High — env-guard let a comment suppress the real scan

The key scan was suppressed whenever the file contained a "// never … service_role" comment: one
comment reading `// never use service_role here` anywhere in the file, and a real
`import.meta.env.SUPABASE_SERVICE_ROLE_KEY` on the next line was allowed for Edit, MultiEdit and Write.
Fix: the two service_role scans run on comment-stripped code (a small state machine that tracks string
literals, so a URL or `/* */` inside quotes is never a comment, and opens a `//` comment only after
start-of-line, whitespace or `;{}),` so a regex literal cannot swallow its line); both suppressions are
deleted. The JWT-literal scan stays on the raw content — a commented-out key is still a key in source.

### Proof

- `content-guards-multiedit.test.mjs`: the exact regression Codex named (MultiEdit and Write with the
  warning comment plus the key lookup) plus block-comment, URL, regex-literal and comment-only cases;
  the previous hook returned `allow` for the MultiEdit payload above by direct probe; the new one denies it.
- `autopilot-lib.test.mjs`: thirteen new armed-mode cases (`autopilot-lib.test.mjs` fails against the previous lib at `armed Edit of a hook denied`); `protected-surface-parity.test.mjs` fails
  against the previous `autopilot-lib.mjs` for every protected path.
- `docs/reference/agent-guardrails.md` names the new deny class in both autopilot rows.
