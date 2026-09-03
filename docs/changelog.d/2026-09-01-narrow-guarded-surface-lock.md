## 2026-09-01 — the guarded-surface lock is narrowed, reads are allowed, and it fails open on its own syntax error

Amends the 2026-08-31 guarded-surface lock (PR #530) after it broke real work.

**Narrowed the guarded set.** Dropped `package.json`, `package-lock.json`,
`scripts/(check|validate|verify)-*`, and the proof/review runners
(`write-codex-push-proof.mjs`, `remove-applied-ledger-entry.mjs`, `run-claude-review.mjs`,
`agent-manifest-parity.mjs`, `sync-agent-workflows.mjs`). Each was reachable a second way, so
guarding the file was never a boundary — and the cost was real: `npm install` died, and a
`package.json` merge conflict could not be resolved because git's `>>>>>>>` markers parse as a
shell redirect into the guarded file. The npm-subcommand branch of
`commandImplicitlyMutatesGuarded()` went with them. Still guarded: hook files, hook registration
and the permission manifests, `.husky/`, CI workflows, `.coderabbit.yaml`, and the lock's own
unlock switch and record. Native `Edit`/`Write` on `package.json` remains gated by the `ask` tier.

**Reads of guarded files are allowed.** Added `READ_ONLY_TOOL_NAMES`
(`Read`/`Glob`/`Grep`/`NotebookRead`). The path scan judged any tool carrying a `file_path`, so a
plain `Read` of a hook was denied by a guard whose refusal text promised reading was always fine.

**Corrected a false claim in the refusal text.** It said the unlock "requires an interactive
terminal and a typed phrase, so an agent shell cannot run it" — disproved 2026-08-31. It now says
plainly that this is friction, not a boundary, and that the `ask` tier is the real gate.

**Documented, not patched: the lock fails OPEN on a `SyntaxError` in its own rule book.** The
static `import` precedes the `try`/`catch`, so the process dies before `deny()` exists and emits
nothing; a PreToolUse hook that emits no decision is not a denial. Reproduced in isolation (exit 1,
empty stdout). It fails *closed* on a runtime error, denying every tool call in the session
including the ones needed to repair it — which bricked this session twice and needed a shell
command from Mason to recover. See `KNOWN_ISSUES.md` and `DECISION_LOG.md` (both 2026-09-01);
whether the lock survives at all is an open owner decision.

Test suite updated to match and re-run with the surface **locked**: 212 assertions pass, including
new assertions pinning the narrowing so it cannot silently re-widen. Verified live against the real
hook: `Read` of a guarded hook allowed, `npm pkg get` allowed, a write to `scripts/verify-*.tmp`
allowed, and `echo test > .husky/…` refused by this lock specifically.
