## 2026-09-05 - Let the review-proof guard allow a native single-file Read inside the state directory; record two over-blocks it will keep

**Why.** A timestamp-bounded read of the last 14 days of Claude transcripts (2026-08-21 to
2026-09-04) attributed 460 refusals to `review-proof-guard.mjs`. Adjudicated against the guard's
code, three classes were reads it was never meant to stop:

| class | count | example |
|---|---|---|
| native `Read`/`Grep`/`Glob` aimed at `.claude/session-state` or at `.claude` itself | 33 | `Read .claude/session-state/OVERNIGHT-INTENT.flag`, `Grep path=.claude` |
| a `find … -exec <reader>` under the user's HOME `.claude` (transcripts, plugins) | 22 | `find ~/.claude/projects -name '*.jsonl' -exec du -m {} +` |
| the word "function" inside a quoted search pattern read as a shell function definition | 8 | `grep -rn "export function" .claude/hooks/x.mjs` |

Each refusal costs a full-context model call plus a retry, and the guard's own messages tell an
agent to do exactly these reads. The independent gpt-6-astra review of the audit (2026-09-04)
required that any narrowing be "proven non-mutating command forms" with adversarial tests.

**What changed** (`.claude/hooks/review-proof-guard.mjs`, tests in `review-proof-guard.test.mjs`).

The whole-directory rule for the review state directory no longer applies to a NATIVE single-file
read (`Read`, `NotebookRead`) whose target resolves, through the operating system, to a regular
file whose REAL name the proof-file rule clears. Reading `OVERNIGHT-INTENT.flag`, `AUTOPILOT.on`,
or the `codex-review-latest.txt` capture that the codex-review skill itself says to read back now
works. The resolution step exists because the fourth exact-SHA `gpt-5.6-sol` round opened a proof
through its Windows 8.3 short alias (`CODEX-~1.JSO` is `codex-review-<sha>.json` to the
filesystem, and the basename rule never sees the long name): the guard now canonicalizes with
`realpathSync.native`, which expands short names and follows symlinks, and re-runs the proof-file
rule on the result. That alias check runs for every native single-file read, not only inside the
state directory, so an aliased directory component (`.claude/SESSIO~1/…`) or a symlink placed
elsewhere cannot reach a proof either. Inside the state directory a target that does not resolve
to a regular file (missing file, the directory itself, an unresolvable alias) fails closed, and so
does a file with more than one hard link, since a hard link has no real name to resolve to. The
SHELL branch is unchanged and still reads names from command text, so `cat …/CODEX-~1.JSO` remains
allowed on `main` as it was before this change; that pre-existing hole and its owner-side fix (turn
off 8.3 name generation on the volume) are recorded in `docs/manual/KNOWN_ISSUES.md` under
"OPEN 2026-09-05".
`Grep` and `Glob` are deliberately NOT exempt: a directory-level search selects files by pattern,
so `Grep(path=session-state, pattern=verdict)` would read proof JSON line by line while naming no
proof basename. Proof JSON and the applied-source ledger stay unreadable through file tools, a
native writer into the directory still denies, and an MCP reader keeps the deny because its name
proves nothing. `notebook_path` also joined the path candidates: round 4 noticed the NotebookRead
test cases had never reached the guard.

**What was tried and withdrawn.** The other two classes were narrowed in the first cut, and three
exact-SHA `gpt-5.6-sol` rounds found a real bypass in each successive version:

- home `.claude` mask: `rm -rf ~/.claude/projects/../worktrees/x` climbed back into a protected
  worktree (round 1); `find ~/.claude/worktrees -exec cat {} +` with a space after the name,
  `~/.claude/./worktrees`, and `~/.claude/worktr*` all reached the worktrees (round 2);
  `find ~/.claude/history.jsonl -exec cat {} + > ~/.claude/history.jsonl` truncated the file
  before the read (round 3);
- `function` word: requiring `(`/`{` after the name missed `function Get-Content # comment\n{`
  (round 1), then `function global:Get-Content <#note#> {` (round 2); reading a quotes-removed
  view missed `x="a\""; function cat {` (round 3).

That is the "command-text guard never converges" pattern this repository has recorded before, so
both narrowings were withdrawn rather than taken to a fourth round. The ALLOW side of those two
classes is the base behaviour: no command the base guard refused is allowed now. One deny-side
hardening from round 2 is retained on purpose: the redefinition pattern (`REDEFINES_COMMANDS_RE`)
now accepts a scope prefix in a function name (`[\w.:-]+` instead of `[\w.-]+`), so
`function global:Get-Content { … }` is recognised as a redefinition and refused where the base
guard let it through; the test corpus pins it. Every reproduced bypass is a pinned deny case, and
each over-block is pinned as a recorded choice with its workaround: a pipeline with no `-exec`
(`find … -name x | xargs du -m`) for the home data directory, and a bracket class
(`"export [f]unction"`) for the word.

**Proof.** `node .claude/hooks/review-proof-guard.test.mjs` — the new allow cases are paired with
the deny cases that differ by one token; the pre-existing deny corpus is unchanged. Exact-SHA Codex
proof via `scripts/write-codex-push-proof.mjs` recorded in the PR.
