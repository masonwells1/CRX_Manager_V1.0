## 2026-09-07 — PR #605: a launcher no longer hides a package-manager manifest write; connector tier registration is case-exact

Codex (`gpt-5.6-sol`, high effort) reviewed `8ac85002d` for the exact-SHA push proof and returned
BLOCKERS with one High and one Medium finding. Both were probe-confirmed against the committed hooks
before the fix.

### High — the package-manager rule only saw the manager at the command head

`cmd /c npm install left-pad`, `npx npm install left-pad`, `powershell -Command npm install left-pad`,
`sh -c 'npm install left-pad'`, `env npm install left-pad`, `command npm install left-pad` and
`nice npm install left-pad` all passed `.claude/hooks/review-proof-guard.mjs` silently while the bare
command was denied.

Fix: quotes are dropped and the segment re-split, and the manager is the FIRST token anywhere in the
segment that names npm/pnpm/yarn/bun. No launcher list is kept (a list inherits its own omissions).
Known over-block, accepted on this file's standing rule that a false refusal is the cheaper failure:
text that merely quotes such a command (`git commit -m "npm install x"`, `grep "npm add x"`) is refused
too; reword it. A launcher in front of a from-manifest or non-manifest command stays silent
(`cmd /c npm ci`, `sh -c 'npm run build'`, `powershell -Command npm test`).

### Medium — connector tier registration was case-folded

`.claude/hooks/mcp-tool-guard.mjs` lower-cased both settings entries and tool names before deciding
whether a leaf was "settled" by an exact `ask`/`deny` entry, so `Pause_Project` would have been
treated as registered by a `pause_project` entry even though Claude's own settings matching is
case-sensitive and the variant has no entry. The tier map is now keyed by the exact entry text and
looked up by the exact tool name. Supabase leaf identification and the read allowlist keep their
case-insensitive matching (that is what catches `Execute_SQL` on an unregistered UUID).

### Proof

- `review-proof-guard.test.mjs`: nine launcher deny cases and five launcher allow cases; the new deny
  cases fail against the previous hook at `must deny: cmd /c npm install left-pad`.
- `mcp-tool-guard.test.mjs`: exact-case registered leaf defers to its `ask` entry; `Pause_Project` and
  `PAUSE_PROJECT` variants are denied; the variant assertions fail against the previous hook.
