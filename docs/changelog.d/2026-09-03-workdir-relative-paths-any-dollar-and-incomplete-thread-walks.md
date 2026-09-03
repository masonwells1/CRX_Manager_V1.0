## 2026-09-03 — a working directory is part of the path; any `$` is computed text; an unfinished thread walk is not a clean one

Codex round 11 on PR #563 — two Highs and one Medium on the exact-SHA `gpt-5.6-sol` proof of
head `008f300fc`. Follows round 10
(`2026-09-03-cmd-expansion-counts-as-computed-text-and-cmd-write-verbs.md`).

**Files:** `.codex/hooks/production-action-guard.mjs`, `.codex/hooks/production-action-guard.test.mjs`,
`.claude/hooks/codex-bot-review-lib.mjs`, `.claude/hooks/codex-bot-review-lib.test.mjs`,
`.claude/hooks/pr-merge-guard.mjs`, `scripts/apply-live-testdata-maintenance-20260812.mjs` (guard blob re-pin only)

### HIGH 1 — the working directory was ignored (predates this PR; same file)

The Codex guard resolves the tool's `workdir`/`cwd` into `actionRepoDir` and then compared every
protected-path candidate as spelled. So a tool told to run **in** the protected directory could
name the module by its bare basename:

```
workdir: ".claude/hooks"   +   Set-Content codex-bot-review-lib.mjs
workdir: ".codex/hooks"    +   Set-Content production-action-guard.mjs
(and the equivalent Write / Edit / apply_patch inputs)
```

All returned `blocked:false`. This hole is on `main` today; it is fixed here because the reviewer
found it in this file and both merge guards import the module it exposes.

**Fix.** Every candidate — file-tool paths, patch destinations, and every shell token — is tested
both as spelled and joined onto the resolved working directory, then canonicalized. The
protected matcher is suffix-anchored, so the absolute form still matches, and an unrelated file
under an unrelated working directory still does not. A directory change **inside** the command
(`cd`, `Set-Location`, `pushd`) followed by a write is refused as unbindable — the same stance
the push gate already takes on a directory-changing push — because it moves the working
directory out from under the join; `cd` with a read stays allowed. Six working-directory pairs
asserted on three file tools and two shell forms, four near-miss canaries, four `cd`-then-write
denials, one `cd`-then-read allow.

### HIGH 2 — `$1`, `$@` and friends are computed text too

Round 9's pattern matched `$name`, `$(` and `${` and missed the positional and special
parameters, so `sh -c 'cp src "$1$2"' _ .claude/hooks/codex-bot-review- lib.mjs` assembled the
protected name from two harmless arguments. A bare `$` in a mutating segment has no honest
literal reading; **any** `$` now counts. Four payloads asserted, each also confirmed by the
classifier on its own.

### MEDIUM — a thread walk that stops early is not a clean walk

`collectCodexThreads` returned whatever it had read when a later page came back null, the
server claimed more pages with no usable cursor, or the page cap was reached. A resolved
thread on page one plus an unresolved one on page four therefore read as `clean-at-head`, and
the guards printed nothing — silence being the good case.

**Fix.** The walk result now carries `incomplete: true` on every such path (page one failing
outright stays "could not read", which the callers already handle by the empty head).
`evaluateCodexBotReview` checks for a standing finding **first** — one that was read still
blocks — and otherwise reports a fifth status, `incomplete`, which both guards print as a notice
saying a partial read is NOT a clean reading. Pinned: a capped walk of resolved threads, a
cursor-stuck walk, and a failed-page-two walk are all `incomplete`, never `clean-at-head`; the
standing-finding-then-failure case still blocks; both guards carry the fourth notice.

### Mutation check

With the join disabled, the `cd` rule disabled, the `$` pattern narrowed back, and `incomplete`
forced false: the working-directory Write and shell writes, the `cd`-then-write, and the `$1$2`
payload all return `blocked:false`, and the partial walk reads `clean-at-head`. Restored, every
case holds.
