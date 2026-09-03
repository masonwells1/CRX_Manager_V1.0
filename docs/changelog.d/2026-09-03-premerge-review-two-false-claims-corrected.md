## 2026-09-03 - pre-merge review: two FALSE claims corrected, thirteen limitations recorded

**Class:** a claim that outran its code, twice. Mason's call, in chat: fix what was false, record
the rest, then merge.

`.claude/hooks/autopilot-intent-reminder.mjs`, `.claude/hooks/prompt-hooks.test.mjs`,
`scripts/sync-agent-workflows.mjs`, `docs/manual/KNOWN_ISSUES.md`.

## How this was found

A final pre-merge review of the WHOLE branch (`origin/main...HEAD`, 27 commits) by
`gpt-5.6-sol` at high reasoning effort, read-only, in an isolated workspace holding only the
diff and post-image sources. It returned `FINDINGS`: one BLOCKER, five HIGH, nine more. The
charter explicitly invited it to say if an already-accepted gap had been described to the owner
as smaller than it is — and it took that invitation, which is where the second correction below
comes from.

The formal `write-codex-push-proof.mjs` wrapper could not be used: it requires a spotless
worktree, and the 24 untracked importer directories this PR exists to exempt are deliberately
kept in place (Mason, 2026-09-02). Same model, same effort, same isolation, different harness —
so no exact-SHA proof artifact exists for this head, and none was required: no migration, edge
function, RLS policy, `src/lib/db.ts`, `src/lib/sentry`, or money path is in the diff, which the
push guard confirmed behaviourally by admitting all seven pushes without demanding one.

## Correction 1 — `hands-free` was latching questions ABOUT autopilot

`.claude/hooks/autopilot-intent-reminder.mjs` documents an ADMISSION RULE: a pattern joins the
`strong` list only if it is a phrase Mason can be USING but not NAMING, and the comment claimed
"Every entry below is first-person or imperative, so it **cannot** appear in a question ABOUT
autopilot."

That was false. `/hands.?free/` is the feature's NAME. Measured against the shipped patterns,
**seven of seven** question and negation probes latched:

```
LATCHES | /hands.?free/        | What does hands-free mode do?
LATCHES | /hands.?free/        | is hands-free mode documented anywhere
LATCHES | /hands.?free/        | Do not run this hands-free
LATCHES | /hands.?free/        | never run this hands free
LATCHES | /going\s+to\s+bed/   | Does saying "going to bed" arm autopilot?
LATCHES | /going\s+to\s+bed/   | the going to bed phrase is in the strong list, right?
LATCHES | /run (it|this) (all )?night/ | why does run it all night latch but overnight does not
```

This is the exact defect that got `overnight` removed after four narrowing rounds, still live
under a different word — and the cost is the one that made it matter: the latch blocks
Bash/Write/Edit for 45 minutes, `review-proof-guard.mjs` refuses every command that would clear
the flag, so the only unblocked exit is arming autopilot, which is what the handshake exists to
prevent. Asking an innocent question about the feature triggered it.

**Fixed the same way Mason fixed `overnight`:** `/hands.?free/` is removed from `strong` and
stays in `triggers`, so a genuine `run this hands-free` still reminds without freezing the
session. Given up knowingly: that phrase alone no longer latches.

**The residual is now pinned instead of denied.** The three surviving entries are plain
substring patterns with no notion of quoting, so a prompt that quotes one while discussing this
guard still latches. New case (2c) asserts that CURRENT behaviour, so nobody reads the comment
as a stronger promise than the code makes. Not narrowed a fifth time — settled rule: a pattern
is either a usage phrase or it is removed.

Proof: `prompt-hooks: 233 assertions passed` via `npm run test:correction-guards`. Mutation —
put `/hands.?free/` back in `strong` and case (2b) goes RED on
`hands-free must never latch, in any role: "What does hands-free mode do?"`. The hook was NOT
executed with a latching prompt outside the test harness, because doing so writes the real
45-minute flag; the seven probes above were measured against copies of the shipped patterns in
isolation.

## Correction 2 — the index-only gap was described to Mason as smaller than it is

The entry accepting that gap said the cost was "one stale mangled instruction file … not wrong
behavior in the app", and Mason approved accepting it on that description. Whatever is staged is
what lands, so the honest statement is that **arbitrary content can enter `.agents/skills/`** —
the namespace that exists to be read as Codex agent instructions — unseen by the parity gate.
The scope is also broader than the importer region: any `.agents/` path in the index and absent
from disk escapes the sweep, not only `source-command-*` ones.

It is still not an escalation — it takes an actor who can already stage and commit, and such an
actor can already write any file directly — but "an unreferenced stale file" was the wrong
frame. `KNOWN_ISSUES.md` now carries the correction in place, marked as a correction rather than
quietly edited, because a decision was made on the old wording.

A third over-claim was corrected in passing: the prune-loop comment said an entry that "does not
resolve to a path strictly inside targetRoot is skipped", which implies realpath resolution. The
check is LEXICAL and does not follow links. The comment now says so, and the changelog entry
whose "layer isolation" proof came from a manual run rather than a committed test now says that
too.

## Thirteen limitations recorded, not fixed

Full list in `docs/manual/KNOWN_ISSUES.md`: lexical containment defeated by junctions/symlinks
(the reported BLOCKER), symlinks evading `walkFiles()`, an out-of-repo `GIT_INDEX_FILE` yielding
a confident answer from the wrong index, Windows case-rename defeating the staged-path check, a
shape-valid manifest naming files the generator never owned, case/Unicode path collisions,
directory-to-file transitions breaking `--write`, and four test-strength gaps.

Recorded rather than patched because this is internal build tooling with no customer, money,
inventory or database path; because every finding needs an actor who can already write the
repository; and because eleven consecutive rounds on this one file each shipped a narrow fix
that created a new edge. The operative rule is written down: no round 13 of narrow patches — if
this file is revisited, resolve real paths before writing or deleting and compare paths
case-insensitively on Windows, with tests for each.
