# PR #530 — guarded-surface lock: state, findings, and what remains

Written 2026-08-31 for Mason's morning. Branch `claude/permission-grants-claude-codex-9f7108`.
**Not merged, and not to be merged without reading the "What this does not deliver" section.**

## One-paragraph summary

Mason asked to stop being prompted for approval on file edits. That request is **not solved**, and
the reason is worth knowing: the `ask` entries everyone assumed were prompting him are, under this
repo's `defaultMode: "dontAsk"`, silent DENIALS — never prompts. What the PR became instead is a
fix for a real, pre-existing security hole that CodeRabbit found while reviewing the first attempt:
blanket `Bash` was never gated on the enforcement files at all, so an in-place stream edit of a hook
was always open. That hole is closed. Net effect on the repo is additive; nothing ends up weaker.

## What the branch now contains

- `.claude/hooks/guarded-surface-lock.mjs` + `guarded-surface-lib.mjs` — a PreToolUse guard that
  denies WRITES to the enforcement surface across Bash, native `Write`/`Edit`, MCP path fields,
  `apply_patch` destinations, and process `input`/`stdin`, while always allowing READS.
- `scripts/guard-unlock.mjs` — `--minutes N` / `--status` / `--lock`.
- 206 mutation assertions, including end-to-end hook spawns.
- The `ask` tier **restored in full** (see below), plus a new `ask` entry for `guard-unlock.mjs`.
- Honest records in `docs/manual/DECISION_LOG.md` and three `docs/changelog.d/` entries.

**The only `ask` entries removed versus `main` are `AGENTS.md` and `CLAUDE.md`** — prose contracts
that advise rather than enforce. Everything protective is intact.

## What this does NOT deliver — read before relying on it

**The lock is a speed bump, not a boundary.** Proven directly, not inferred: with the surface
**locked and verified locked via `--status`**, a five-line script writing through node's `fs`
created a file inside `.claude/hooks/` and the hook never fired. A PreToolUse guard inspects the
ARGUMENTS OF TOOL CALLS; code an agent writes and then runs performs its writes inside its own
process, where no tool call exists to inspect.

**The TTY unlock is not a human-only gate.** A PTY-capable agent satisfies `isTTY` and can supply
stdin, and the confirmation phrase is a literal in the source.

This is the same residual gap `review-proof-guard.mjs` already documents about itself. The durable
boundary remains GitHub branch protection plus review. **Do not remove the `ask` tier on this
guard's strength** — that swap was attempted and reverted for exactly this reason.

## Defects found in this PR (8 real, across 4 review rounds)

| # | Finding | Source | Status |
|---|---|---|---|
| 1 | Removing `ask` entries opened a two-step silent path: rewrite a guard, then run the auto-allowed migration/SQL/push | Codex r1 (HIGH) | fixed |
| 2 | Blanket `Bash` never gated on enforcement paths — **pre-existing, predates this PR** | CodeRabbit (Major) | fixed by the lock |
| 3 | Unlock RECORD forgeable — guarded the script but not the JSON it writes; `Write` is blanket-allowed | Codex r2 (HIGH) | fixed |
| 4 | Mixed-case paths bypass on case-insensitive Windows (`.CLAUDE/hooks/x.mjs`) | Codex r2 (HIGH) | fixed |
| 5 | Lone `&` defeats the read/write split — only `&&` was split | Codex r2 (HIGH) | fixed |
| 6 | `..` path traversal not resolved (`.claude/session-state/../hooks/x.mjs`) | Codex r3 (HIGH) | fixed, **proven live** |
| 7 | Process `input`/`stdin` channel never inspected | Codex r3 (HIGH) | fixed |
| 8 | A script an agent writes and runs bypasses the hook entirely | Codex r3 (HIGH) | **not fixable at this layer** — recorded, `ask` tier kept instead |

**Six of the eight were in code that already had a green test suite.** The lock had 166 passing
assertions and had been observed blocking its own author when finding 3 was found. Self-written
tests encode the author's model of the threat.

## What remains

1. **CodeRabbit** shows `CHANGES_REQUESTED` against an older commit and needs a fresh review at the
   final head. The review allowance was exhausted overnight and is being sequenced centrally by the
   merge-queue session — do not spend one unilaterally. Standing mechanic: a stale
   `CHANGES_REQUESTED` does not clear on its own; `@coderabbitai resolve` has cleared it twice
   before (2 data points, not proven causation).
2. **Codex round 4 proof** at the final head. Round 3 returned BLOCKERS; rounds are ~10 minutes.
3. **Merge** — Mason's call. Deliberately not done.

## Known follow-ups (not blocking)

- **The refusal message still says "an agent shell cannot run it"** — the claim disproved above. It
  lives in `lockedReason()` in a now-locked file; needs an unlock to correct. User-facing and
  currently misleading.
- **The unlock is only reachable from the worktree containing it.** Requiring a `cd` into a
  hash-named folder cost Mason three failed attempts. It should be repo-root reachable, or at least
  name the folder it just unlocked.
- **The confirmation prompt invites the wrong paste.** Mason pasted the invocation at the
  "type the phrase" prompt and it cancelled — reasonable behaviour, bad affordance.
- **24 untracked `.agents/skills/source-command-*` directories** appeared across six worktrees at
  19:46:47 from an unidentified writer. The repo's own `sync-agent-workflows.mjs --check` rejects
  all 24, and every one duplicates an already-tracked adapter. Quarantined (NOT deleted) to the
  session scratchpad; five sibling worktrees still hold copies. **Do not run
  `sync-agent-workflows.mjs --write` as a cleanup** — it would destroy the evidence and mutate
  tracked files repo-wide in an unreviewed change.
- **Mason's original complaint is unresolved.** The prompt source is still unidentified. The next
  step is to capture what he was doing when it happens, rather than infer it from the manifest —
  inferring it from the manifest is what produced the wrong first diagnosis.

## Verification performed

Real-path, not only tests:

- Live `Write` with `..` traversal → **denied by the live hook**, refusal naming the resolved target.
- The live hook **blocked the authoring agent** from editing `.claude/settings.json` mid-task.
- `guard-unlock.mjs` run by the agent → **refused**, exit 1.
- A script wrote into `.claude/hooks/` **while locked** → succeeded, which is finding 8.
- 206 assertions; `agent-manifest-parity.mjs` and `test:agent-workflows` pass; branch 0 behind
  `origin/main` at time of writing.
