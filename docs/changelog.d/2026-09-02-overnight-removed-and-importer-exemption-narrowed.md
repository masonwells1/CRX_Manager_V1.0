## 2026-09-02 - `overnight` is removed from the freeze list; the importer exemption is narrowed

**Class:** guard false positive (final) + three exemption holes. **Outcome:** the word no longer
latches in any grammatical role; the importer carve-out no longer covers tracked, previously
generated, or canonically owned paths.

Supersedes the "replace, don't delete" approach in
`docs/changelog.d/2026-09-02-overnight-is-a-topic-word.md` and
`docs/changelog.d/2026-09-02-overnight-follower-set-is-not-a-preposition-list.md`. Those entries
remain as the record of why the narrowing was attempted and how it failed.

## Why the narrowing was abandoned

Three successive attempts to keep `overnight` as a narrowed pattern were each defeated by a
phrasing the previous round had not considered:

| Round | Pattern | Defeated by |
|---|---|---|
| 1 | the bare word | `the overnight flag is ...` |
| 2 | adverbial-only, any punctuation as terminator | `investigate the overnight: flag behavior` |
| 3 | plus a determiner lookbehind | `overnight in the documentation is misspelled` |
| 4 | plus stripped preposition followers | `what is overnight?` · `overnight, my report is wrong` |

Round 4 is decisive. Codex raised it as P1 and CodeRabbit as Major, and both were confirmed by
running the real hook:

```text
FREEZES  <-- false positive  "can you explain overnight?"
FREEZES  <-- false positive  "what is overnight?"
FREEZES  <-- false positive  "the feature is called overnight."
FREEZES  <-- false positive  "overnight, my report is wrong"
FREEZES  <-- false positive  "overnight, tonight's deployment is delayed"
```

`what is overnight?` is the ORIGINAL defect — asking a question about the feature still froze the
session — not a marginal case. A guard written as a text pattern over free-form input does not
converge; this is the same shape as the `git clean` carve-out that closed after six rounds.

**Mason's decision (in chat, 2026-09-02):** drop the word entirely, which is what he asked for
before the narrowing was proposed. The recommendation to narrow instead was wrong.

## What changed

`.claude/hooks/autopilot-intent-reminder.mjs`

- `overnight` is absent from `strong` in every form. The four remaining patterns — `going to bed`,
  `hands-free`, `run it all night`, `while I'm asleep` — are first-person or imperative and cannot
  appear in a question about autopilot.
- **What is given up, stated plainly:** `run this overnight` on its own no longer latches the
  deterministic handshake. `triggers` still matches the bare word, so such a prompt still injects
  the arm-autopilot reminder — the pre-latch behaviour, not a silent loss. A missed latch costs a
  reminder; a false latch costs a 45-minute lockout whose only exit is arming autopilot, which is
  precisely what the handshake exists to prevent.

`scripts/sync-agent-workflows.mjs` — three holes Codex found in the importer exemption. It now
applies only to a directory that is:

1. **not previously generated** — if `generated-manifest.json` ever owned a file there, the
   directory is ours. Without this, deleting a canonical `.claude` command named `source-command-*`
   would drop its mirror out of `expected` and the orphan would be waved through as litter while
   its stale instructions survived;
2. **not canonically owned** — ownership is decided per DIRECTORY, so a hand-added sibling beside a
   generated `skills/source-command-demo/SKILL.md` stays drift;
3. **not tracked or staged in git** — the carve-out is for untracked working-tree litter only. Once
   `git add -A` stages the importer output it is becoming part of the repo, and mangled
   instructions must fail rather than ride in silently.

## Verification

Ran, not inferred.

**The hook chain, against the five confirmed false positives** — all now pass through, and the
handshake still latches on real requests (`hook-router.test.mjs` proves the router still writes the
flag end to end for `im going to bed, keep working`).

**The importer exemption, live:**

| Step | Result |
|---|---|
| Untracked `skills/source-command-ship/SKILL.md` present | warning naming it, then `PASS - 37 Codex workflow file(s) match` |
| `git add` that same file, re-run `--check` | `FAIL skills/source-command-ship/SKILL.md is not generated from .claude`, exit 1 |

`prompt-hooks.test.mjs` 214 assertions · `hook-router.test.mjs` 50 · `sync-agent-workflows.test.mjs`
extended with the three narrowing conditions · `npm run test:correction-guards` and
`npm run test:agent-workflows` both exit 0.

## Operative rule

Do not reintroduce `overnight` to `strong` in any form. Every phrasing the removed patterns once
accepted is pinned in `prompt-hooks.test.mjs` as non-latching, so an attempt to restore it turns
those red. A genuinely new class of failure — the latch firing from something other than prompt
text — is a different matter and worth acting on.

## Note

The 24 importer directories were deleted from `C:/CRX_Manager` by hand during this session, so the
commit blocker they caused is gone. The exemption still matters: the Codex CLI has no off-switch
and rewrites them on any future `/import`.
