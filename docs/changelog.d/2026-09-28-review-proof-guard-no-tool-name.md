## 2026-09-28 — PR #823: review-proof-guard also warns on input with no tool name

The first Luna review of PR #823 found a HIGH gap: the new loud fail-open covered malformed JSON and
non-object payloads, but not a parseable object with no tool name (for example `{}`). Every check in
the guard keys off the tool name, so that input was just as uninspectable, and the guard still said
nothing.

`review-proof-guard.mjs` now treats a missing `tool_name`/`toolName` like unreadable input: it fails
open with the same `systemMessage` warning and no permission decision. The guard test adds `{}` and
a payload with `tool_input` but no tool name to the unreadable-input cases.

`main` (#834) was also merged into the branch; no conflicts.

**Proof observed (local session):** `{}` piped to the real hook prints the SKIPPED warning (exit 0);
a readable `Bash ls` call stays silent. `test:correction-guards` and `test:agent-workflows` pass.

**Deferred (Luna MED):** whether the Codex desktop app visibly shows a stderr warning from an
exit-0 hook is still unobserved. The adapter uses the same stderr channel the schema-registry hooks
already use for their loud fail-open, so this change adds no new risk there.
