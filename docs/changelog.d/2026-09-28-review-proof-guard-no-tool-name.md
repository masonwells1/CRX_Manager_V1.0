## 2026-09-28 — PR #823: review-proof-guard also warns on input with no tool name

The first Luna review of PR #823 found a HIGH gap: the new loud fail-open covered malformed JSON and
non-object payloads, but not a parseable object with no tool name (for example `{}`). Every check in
the guard keys off the tool name, so that input was just as uninspectable, and the guard still said
nothing.

`review-proof-guard.mjs` now treats a missing `tool_name`/`toolName` like unreadable input: it fails
open with the same `systemMessage` warning and no permission decision. The guard test adds `{}` and
a payload with `tool_input` but no tool name to the unreadable-input cases.

Luna round 2 found two more silent cases, fixed the same way: a non-string tool name
(`{"tool_name":{}}`) and a tool name with no tool input at all (`{"tool_name":"Bash"}`). A
parameterless tool that sends `tool_input: {}` is still a readable call and stays silent (tested).
Luna round 2 also flagged "do not re-open that" in `agent-guardrails.md` as prompt injection. That
was refuted: it is an unchanged context line from `8cfd349db` recording Mason's decision to decline
a separate agent credential, not text this PR added.

Luna round 3 (MED) found two more: a tool input that is neither an object nor apply_patch's raw
string (`42`, `[]`), and a whitespace-only tool name. Both now warn too. Its other findings: the
"Do not open round seven" line it read as a reviewer instruction is git hunk-header context from
`main` (#530), not this PR, and the one added line it cited was reworded to a neutral note; the LOW
about `process.exit` truncating the warning is refuted, since the guard's existing `deny()` uses the
same write-then-exit pattern and Node writes to pipes synchronously on Windows and Linux.

CodeRabbit (Major) and the Codex GitHub App (P2) then both flagged the same gap on `edae1db`: a raw
string tool input was accepted from any tool, though only apply_patch sends one; a string from
`Bash` or `Write` left the guard nothing to inspect. A raw string is now accepted only when the tool
name ends in `apply_patch` (including `mcp__…__apply_patch`); any other string, empty included,
warns. A raw apply_patch aimed at a protected CI file is still denied (observed).

The final `gpt-6-sol` review of `14d9c4e` then found a HIGH regression in these follow-ups: the new
"no tool name / no usable input" warnings exited BEFORE the checks that do not need a tool name
(proof-file paths, the review-state directory, patch destinations). `main`'s guard still ran those,
so a nameless event naming a proof file would have gone from denied to warned. The guard now only
records the reason up front, runs every check as before, and emits the SKIPPED warning at the final
allow — a protected target still denies. Regression tests cover a proof path with no, an object, or
a blank tool name, and a nameless raw patch to a proof file; all deny.

`main` (#834) was also merged into the branch; no conflicts.

**Proof observed (local session):** `{}` piped to the real hook prints the SKIPPED warning (exit 0);
a readable `Bash ls` call stays silent. `test:correction-guards` and `test:agent-workflows` pass.

**Deferred (Luna MED):** whether the Codex desktop app visibly shows a stderr warning from an
exit-0 hook is still unobserved. The adapter uses the same stderr channel the schema-registry hooks
already use for their loud fail-open, so this change adds no new risk there.
