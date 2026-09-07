## 2026-09-05 — PR #619 review round: the by-name shell guard learns redirections, quoted separators, and quoted option values

**Why.** The Codex App's review of PR #619's first commit (`0d5823915`, the by-name rewrite of the
maintenance-producer check in `.claude/hooks/bash-safety-lib.mjs`) returned three P2 findings: one
bypass of the computed-script rule and two fresh false refusals of exactly the kind that rewrite
exists to remove. All three are fixed in the same PR.

**What changed** (`.claude/hooks/bash-safety-lib.mjs`, tests in `bash-safety.test.mjs`).

- **A redirection glued to the runtime's name is still a launch.** `node</dev/null "$F"` slipped
  past the computed-script rule because the runtime's name had to be followed by whitespace. `<`
  and `>` now end the name, a leading redirection (`</dev/null node "$F"`, `2>&1 node "$F"`) no
  longer hides the head word, and a bare operator's target (`node > out "$F"`) is not mistaken for
  the script.
- **A separator inside quotes is data.** The old raw split on `;`, `&`, `|`, and newline opened a
  new segment inside a quoted string, so `rg -n 'foo | node "$F"' docs` was refused as a launch.
  Segments are now split by a quote-aware scanner (`splitShellSegments`): a quoted separator does
  not split, a backslash escapes the next character outside single quotes, `>&2` / `2>&1` / `&>`
  are redirections rather than separators, and an unterminated quote swallows the rest of the line
  (which the shell would refuse to run anyway). `bash -c 'echo a; node "$F"'` therefore stays one
  segment headed by `bash` and is still denied.
- **A literal, non-loader option with a QUOTED computed value keeps the parser moving.**
  `node --title="$TITLE" scripts/safe.mjs` was classed as a computed script before the parser
  reached the literal script. It is now read through to the script — but only while the computed
  value is quoted: an unquoted expansion (`--title=$X`, `--title=%X%`) can word-split into a script
  argument the rule never read, a computed option name (`--$OPT`) may be anything at run time, and
  the loader options (`-r`, `--require`, `--import`, `--loader`, …) keep their denial.

**Mutation proof.** The 29 new pinned cases were run against the pre-fix library, which got 16 of
them wrong (8 redirection launches allowed, 8 quoted-data or quoted-option commands refused); the
fixed library passes all 29. The 13 it already got right are the regression pins that stop the
relaxations from over-relaxing (`bash -c 'echo a; node "$F"'`, `node --title=$TITLE …`,
`node --require="$P" …`).

**Proof observed.** `node .claude/hooks/bash-safety.test.mjs`: 458 assertions, including the live
hook allowing `rg -n 'foo | node "$F"' docs` and `TITLE=worker node --title="$TITLE" scripts/safe.mjs`
and denying `F=x; node</dev/null "$F"`. `node .claude/hooks/mcp-tool-guard.test.mjs`: 30. Not
verified here: the generated Codex production guard (`.codex/hooks/production-action-guard.mjs`)
keeps the full classifier and is untouched by this change.
