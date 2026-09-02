## 2026-09-01 — Merge-gate flag parsing normalized; substituted merge commands refused

Round 4 of bypasses in the merge-gate hardening, all found by the Codex PR bot
reviewing the candidate. See `2026-09-01-merge-gate-p1-bypasses.md` for rounds
2–3 and `2026-09-01-github-manual-review-override.md` for what these guards
protect.

### `--auto=f` was still an exemption

Round 3 parsed the `--auto` value but listed the FALSE spellings
(`false`/`0`/`no`). gh uses Go's `strconv.ParseBool`, which accepts `f` and `F`
as false — and rejects `no` outright. So `--auto=f` performed an immediate merge
while the guard, seeing a value not on its false-list, still classified it as an
auto-merge and skipped both the approval and green-pipeline checks.

Inverted: only ParseBool TRUE spellings (`1`, `t`, `true`) count as an
auto-merge. Everything else — including values gh rejects — takes the full
checks, which costs nothing when the command was never going to merge anyway.
Enumerating the false spellings was the losing direction of the same trade this
codebase keeps relearning.

### Quote and backslash concatenation hid flags from the parser

The shell turns `--ad""min`, `--ad''min`, `"--admin"`, and `--ad\min` into
`--admin` before gh is invoked, but the guards compared the raw word and saw
none of them. Flag **names** are now normalized (quotes and backslashes
stripped, lowercased) before matching, on both guards. Flag **values** keep
their original case, so `--repo Owner/Repo` is unaffected.

### A merge command carrying a command substitution is refused

Round 3 counted merge *endpoints* per segment, which closed the raw-REST-in-a-
substitution shape. A substitution can equally carry a second `gh pr merge`:
`gh pr merge 1 --body "$(gh pr merge 2 --admin)"` runs the **inner** merge
first, while the parser records only the outer request and never sees the inner
flag.

Rather than counting merge invocations too, a merge segment containing `$(`,
a backtick, or `${` is now refused outright as unresolvable. This is the stance
`.codex/hooks/production-action-guard.mjs` already takes on interpreter
arguments: when part of a command is shell-expanded, what it will actually do is
not statically knowable. The cost is that a legitimate merge must be written as
a plain command, which the denial message says.

### Verification

- `.claude/hooks/pr-merge-guard.test.mjs` — 88 assertions, including every
  ParseBool spelling for `--auto`, four concatenation forms for `--admin`, the
  nested-merge and `${...}` substitution shapes, and a case proving the
  substitution rule stands down for an ordinary merge.
- `.codex/hooks/production-action-guard.test.mjs` — the nested-merge and
  quote-concatenation shapes on that side.
- Red-before / green-after confirmed for every new assertion.
- Both blob pins re-pinned; `npm run test:agent-workflows` green.

### What this round does not fix

The exact-SHA Codex proof demonstrated a bypass that none of this reaches: a
PowerShell command that builds the merge URL from separate strings. No
command-text guard can see that. Codex's verdict is unchanged and correct —
`more command-pattern matching cannot create a reliable authority boundary`.
The credential boundary tracked in `docs/manual/KNOWN_ISSUES.md` is the fix.
