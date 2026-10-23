## 2026-10-23 - ordinary native source edits no longer refused by the Codex production guard

**Problem.** Codex's native patch tool (`apply_patch`) reached `.codex/hooks/production-action-guard.mjs`
with the patch text in `tool_input.command`. The guard read that text as a shell command, saw the
`***` of `*** Begin Patch` as a wildcard command word, and refused every edit, even a one-line
new file in `src/`. The refusal came from the guard's shell inspection, not from any path rule.
(Reproduced first on the unchanged guard with the exact observed event; the refusal text matched
the one Codex logged. Proof of the shape: only a `command`/`cmd` string can reach that code; the
older bare-string shape was already allowed.)

**Fix.** A patch leaves the shell route only when all of these hold: the tool name is exactly
`apply_patch`; the patch is in exactly one of `command`/`cmd`, as text; no second payload field is
present; and the whole text parses under the patch grammar. Every file it touches (add, update,
delete, and both ends of a move) is then checked against the protected-harness and review-proof
rules, from the event working directory and any nested `workdir`. A malformed, trailing-text,
duplicated or conflicting envelope is denied. Shell tools and `mcp__...__apply_patch` carrying
patch-looking text are still inspected as shell commands. No hook was disabled or loosened for
any path: the protected-destination, proof-file, push, merge and live-write checks are unchanged.

**Proof.** The guard suite gained cases for add/update/delete/move patches, protected and proof
destinations (including `..`, backslash and case spellings, and moves onto or away from them),
prose that only mentions protected paths, event-cwd and `workdir` resolution, malformed and
conflicting envelopes, shell tools carrying patch text, and the real JSON-on-stdin entry point.
Each new safeguard was disabled in a scratch copy in turn and the suite failed every time.
The full configured hook chain (`.codex/hooks.json`, each hook as its own process) allowed the
probe patch where the unchanged guard denied it.

**Not repaired (separate decision).** A read-only `rg`/`Select-String` of a protected file with a
quoted pattern containing `|` or a word such as `apply_patch`/`move`/`copy` is still refused;
`docs/reference/agent-guardrails.md` records the mechanism and a workaround.
