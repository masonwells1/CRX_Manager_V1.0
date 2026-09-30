## 2026-09-28 — push guards: slow parses could outlast the hook limit (a killed hook allows)

**What was wrong.** The push guards read every shell command for a hidden push to `main`. A hook
killed at its 15-second limit ALLOWS the command, so any input that made the parse slow was a way
through. Measured on `main` at `fcfab3a2a`, running the real hook processes:

| Input | Claude push guard | Codex production guard |
|---|---|---|
| `git push …` + 200K `;` | 55 s | 32 s |
| `git push …` + 50K `'a'\|` | 13 s | 11 s |
| `git -c "x"` × 16 then `--bogus push …` (116 chars) | > 60 s | > 60 s |
| `git push …` + 200K newlines | 15 s | 0.2 s |
| `node --a` × 20 (86 chars) | — | 26 s (one regex alone) |

A whole-guard fuzz of 432 runs (54 repeated-piece shapes, short and 100K, through both guards)
killed 13 runs at the limit on `main`.

**Causes and fixes.**
- `codex-push-lib.mjs`: the `git`/`gh` path prefix `\S*` ran to the end of the command from every
  `;`/`|`/space and backtracked (quadratic). It now stops at `;`, `&`, `|` — a match that spanned a
  separator has one starting at that separator, so detection is unchanged.
- `codex-push-lib.mjs`: the git global-option run was exponential (`-C`/`-c` both match under `/i`,
  and a space-free quoted value matches two alternatives). Each option is now read atomically; the
  push-arguments capture became the named group `args`, and every consumer was moved to it.
- `codex-push-lib.mjs`: `reviewStateDirectoryMentioned` dropped a nested-quantifier regex that hung
  on long `/` runs and could never add a match the plain `.claude/session-state` test missed; the
  `GIT_DIR` check no longer re-reads newline runs.
- `production-action-guard.mjs`: the `node` eval check had both faults (exponential option list,
  quadratic pipe prefix); both fixed the same way.
- Both push guards refuse, before any command parser runs, a command whose `git`-word count ×
  length exceeds 32,000,000 — the one remaining super-linear shape (`git -C git -C …`). The count
  stops at the first word over the limit, so a command with millions of `git` words is refused
  without first collecting them all. Documented in `docs/reference/agent-guardrails.md`.

**Proof.** After the fix the same 432-run fuzz killed 0 runs; worst 1.3 s. The table's inputs,
Claude / Codex guard: 0.38 s / 0.20 s (200K `;`), 0.39 s / 0.86 s (`'a'|`), 41 ms / 50 ms (the
116-char exponential case), 0.40 s / 0.17 s (newlines). New timing tests in
`codex-push-lib.test.mjs` run both real hook processes. Existing suites unchanged and passing:
`test:correction-guards`, `production-action-guard.test.mjs`, `test:agent-workflows`, doc drift,
eslint.

**Reviewed.** Plan and prototype reviewed by Codex Luna (xhigh): no detection counterexample found;
its four findings were measured — two not reproducible (extension tail, dense tokens: both ~ms,
now pinned by tests), two adopted (cap scope and a narrower cap than a flat 16 KB size limit).
Luna on the committed diff, round 2: again no detection counterexample; fixed its three findings
(early-exit count, "before any parsing" wording, looser whole-hook timing bound for slow CI).
CodeRabbit (#840): the whole-hook timing test now also requires each guard to exit cleanly, so a
guard that crashes instead of deciding fails the test.
Codex GitHub review (#840, P1): with one `git`, 31.6 MB of `'a'|` passed the budget and still
outran the Codex hook — linear work adds up on that much text. Both guards now also refuse any
command over 256 KiB (`MAX_INSPECTABLE_COMMAND_LENGTH`); measured, the slowest single-push shapes
take up to ~5.8 s per MB in the Codex guard, ~1.5 s at the ceiling. A just-under-256 KiB `$(` run
(the slowest shape) is now a real-hook timing test.

**Not verified.** Separate and pre-existing, not changed here: the Codex guard does not refuse an
unrecognised git global option before `push` the way the Claude guard does.
