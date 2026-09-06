## 2026-09-05 — PR #619 review round 2: a quoted redirection target with whitespace is one word to the by-name shell guard

**Why.** The Codex App's review of PR #619's merged head (`939c2d3cf`) returned one P2 finding:
`node > "out file" "$F"` slipped past the computed-script rule in `.claude/hooks/bash-safety-lib.mjs`.
The token walk after the runtime's name split on plain whitespace, so the quoted target became
`"out` and `file"`; the redirect branch skipped only `"out`, then read `file"` as a literal script
and stopped before reaching `"$F"`. Bash runs the script named by `$F`. The head-word scan had the
same split, so `> "out file" node "$F"` also read `file"` as the head and skipped the segment.

**What changed** (`.claude/hooks/bash-safety-lib.mjs`, tests in `bash-safety.test.mjs`).

- A new quote-aware word splitter (`splitShellWords`) replaces both whitespace splits: quotes stay in
  the word, a backslash outside single quotes keeps its next character in the word, and an
  unterminated quote swallows the rest of the line. A bare redirection operator now skips the next
  whole word, in the token walk and in the head-word scan alike.
- Pinned in both directions in section (g)4 of the test file: `node > "out file" "$F"`,
  `node >"out file" "$F"`, `node 2> 'err log' "$F"`, `> "out file" node "$F"`, `2>"err log" node "$F"`
  are denied (the first through the live hook too); `node > "out file" scripts/safe.mjs`,
  `node "out file.js"`, and `echo "a b" > "out file"` stay allowed.

**Mutation proof.** The 11 new pinned cases were run against the pre-fix library (`939c2d3cf`),
which got 7 of them wrong (every quoted-target launch allowed) and the 4 allowed cases right; the
fixed library gets all 11 right.

**Proof observed.** `node .claude/hooks/bash-safety.test.mjs`: 486 assertions, including the live
hook denying `node > "out file" "$F"`. `node .claude/hooks/mcp-tool-guard.test.mjs`: 30. The
generated Codex production guard (`.codex/hooks/production-action-guard.mjs`) is untouched.
