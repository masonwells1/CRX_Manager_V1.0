## 2026-09-05 - Find the checkout's state directory from any working directory

The Codex GitHub App reviewed PR #612 at 22e2be806 and reproduced a bypass: when
`.claude/session-state` is a junction and the hook payload's `cwd` sits below the
repository root (for example `<repo>/src`), the guard probed
`<cwd>/.claude/session-state`, found nothing, and membership rule 3 (the resolved
file's directory is the real location of this checkout's own state directory)
switched off. An unlisted proof such as `migration-review-*.json` read through the
junction target's external name then classified `clear` and the guard emitted an
empty allow response.

The guard now walks from each starting directory (the payload `cwd`, the process
working directory, and `CLAUDE_PROJECT_DIR`) up to the filesystem root and takes
the nearest ancestor that owns a state directory. `CLAUDE_PROJECT_DIR` is one
candidate rather than the only one because the harness pins it to the primary
checkout even inside a worktree. Regression cases read the evidence file and its
hard link by their external names with `cwd` set to `<repo>/src/pages` and expect
a deny; the flag file read the same way stays allowed. The new cases failed on the
prior implementation with an empty allow response before the fix was applied.
