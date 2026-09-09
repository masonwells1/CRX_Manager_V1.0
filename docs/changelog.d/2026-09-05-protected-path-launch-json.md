## 2026-09-05 — Protect `.claude/launch.json`, the command `preview_start` executes (GitHub Codex P1 on PR #605 head `8179ae989`)

The GitHub Codex reviewer's P1 on `8179ae989` ("Gate the preview launcher configuration"):
`mcp__Claude_Browser__preview_start` is newly in `allow`, and it launches the `runtimeExecutable` and
`runtimeArgs` from the tracked `.claude/launch.json`. That file was in no protected-path `ask` entry, not in
`review-proof-guard.mjs`, and not in `RISKY_PATH_RES`. Under `acceptEdits` a session could auto-edit it to
any command and run that command through `preview_start`, outside every Bash hook (bash-safety,
production-action-guard, review-proof-guard). On `main` `preview_start` is unlisted and therefore silently
denied under `dontAsk`, so this route is introduced by the PR.

### What changed

- `.claude/settings.json`: `Edit`/`Write`/`MultiEdit`/`NotebookEdit` `ask` entries for `.claude/launch.json`
  — 20 protected patterns, 80 entries. `preview_start` itself stays in `allow`: a dev-server preview is
  reversible and is what Mason opened; the file is the attack surface.
- `.claude/hooks/review-proof-guard.mjs`: `.claude/launch.json` added to the shell and path-field
  enforcement-surface patterns; both deny messages name it. Reads stay allowed.
- `.claude/hooks/codex-push-lib.mjs`: `.claude/launch.json` added to `RISKY_PATH_RES`.
- Tests: five shell deny cases, two path-field deny cases, two allow cases in `review-proof-guard.test.mjs`;
  a `riskyFiles` pin in `codex-push-lib.test.mjs`.
- The three lists that name protected surfaces (settings `ask`, `review-proof-guard.mjs` patterns,
  `RISKY_PATH_RES`) agree on this path.

### Verification

- The guard suites, agent checks, `npm run check:docs`, and `npm run test:agent-workflows` pass; the real
  hook was probed directly with shell and path-field writes (deny) and reads (silent).
