## 2026-09-09 - The segmenter reads both shells, because either reading can hide a command

Fifth round on the same gates. A `gpt-5.6-sol` high-effort review of `388bba01f` returned
BLOCKERS with three findings, all against `splitCommandSegments` — the function round
three introduced and round four widened. Two of the three were REGRESSIONS AGAINST
`main`: commands the shipped guard blocks today, this branch had started allowing.
Companion to `2026-09-08-guard-word-splitting-is-shell-aware.md` (round one),
`2026-09-08-guard-gh-spellings-second-round.md` (two),
`2026-09-08-guard-quoted-separators-and-escaped-admin.md` (three) and
`2026-09-08-guard-escaped-ampersand-fourth-round.md` (four).

### The reasoning error that produced two of the three

Round four widened the escape set and justified it like this:

> Consuming one can only JOIN segments, never divide them, so a shell that treats the
> character literally still leaves the parsers reading more text, not less — the fail-safe
> direction.

**That is false, and it is the root cause of finding 2.** The parsers read the FIRST
command of a segment. Joining two commands therefore hides the SECOND one exactly as
surely as splitting hides the tail of the first. A longer segment is not a safer segment.

```
git push origin HEAD:feature \| git push origin HEAD:main
```

PowerShell does not treat `\` as an escape, so that is a real pipeline whose second half
pushes `main`. Honouring the escape produced one segment whose first command is a harmless
feature push.

Splitting can hide a command and joining can hide a command, so **no single reading is
safe**. `splitCommandSegments` now returns the UNION of two readings: the shell-accurate
walk, and a naive walk in which every separator character splits regardless of quotes or
escapes. Where the shells agree the two are identical and de-duplicate to one; where they
disagree, both meanings get inspected. Both call sites are `for (const segment of ...)`
loops hunting for an offence, so an extra reading can only add inspection.

A third reading — the whole command, unsplit — was tried and REMOVED. It was load-bearing
for nothing, and it cost a real duplicate: it re-parsed a chained merge as one more merge
and fired the Codex advisory a third time for
`gh pr merge 123 --squash && gh pr merge 456 --squash`, which the guard's own suite
caught.

### Finding 1 - a redirection is not a command separator

`2>&1`, `>&2` and `&>file` are redirections. Round two made a bare `&` a separator without
excluding them, so:

```
gh pr merge 123 --squash 2>&1 --admin
```

split into a merge carrying no `--admin` and a segment `1 --admin` carrying no `gh`. Same
for `gh api repos/o/r/issues/comments/1 2>&1 -X DELETE`, which hid the DELETE verb. An `&`
that sits against a redirection arrow is now literal. An `&` merely NEAR one
(`gh pr view 1 > log & gh pr merge 2 --admin`) still separates, and that is pinned.

### Finding 3 - an escaped quote does not close a quoted string

Inside double quotes, `\"` is a literal quote and the string continues. The walk closed
the quote there, so `--body "note\"&more" --admin` split at the literal `&` and carried
`--admin` into an uninspected segment. Backslash now escapes the closing double quote.
Single quotes still have no escapes, which is correct for every shell here.

### Measured, against the shipped guard

Through `evaluateProductionAction` on the merge-ready fixture the guard's own suite uses
(APPROVED, CLEAN, green, valid Sol proof on disk — so a plain `gh pr merge 123 --squash`
is allowed and the `--admin` refusal is the only thing left standing):

| command | `main` | this branch BEFORE | now |
| --- | --- | --- | --- |
| `gh pr merge 123 --squash` (control) | allowed | allowed | allowed |
| `gh pr merge 123 --admin --squash` (control) | blocked | blocked | blocked |
| `gh pr merge 123 --squash 2>&1 --admin` | blocked | **ALLOWED** | blocked |
| `gh api repos/o/r/issues/comments/1 2>&1 -X DELETE` | blocked | **ALLOWED** | blocked |
| `gh pr merge 123 --body "note\"&more" --admin --squash` | blocked | **ALLOWED** | blocked |

The two `ALLOWED` classes were regressions this branch introduced; they are the reason the
round-four commit must not have shipped as it stood.

Finding 2 was measured too, and **its stated premise is wrong**: Sol wrote that the
approved base blocks `git push origin HEAD:feature \| git push origin HEAD:main`. It does
not — `main` allows it, so that spelling is a PRE-EXISTING hole, not a regression. The
defect underneath is real and is now closed. Judged through gates that can actually answer:

- The merge analogue `gh pr view 1 \| gh pr merge 2 --admin --squash`, and its `^|` and
  `` `| `` spellings, are refused by the PR merge guard.
- Run as real `PreToolUse` subprocesses against this checkout, where a push to `main`
  genuinely needs a proof this HEAD does not have, all four spellings — plain, `\|`, `^|`
  and a bare `|` — are refused, and `git push origin HEAD:feature/x` and `npm run build`
  are still allowed.

### Both directions

- The 50-command × 16-predicate differential sweep reports **no verdict moved** against
  the round-four commit. Against `main` exactly two move, both deliberate and both from
  round two: `pushHiddenByShellComposition` stops firing on a Windows local-repo path
  (`git push "C:\some\local repo" HEAD:main`), which was an over-block. Those paths are
  must-ALLOW controls in the subprocess probe and pass there.
- Every earlier round re-measured and still holding: the round-two chain, the round-three
  quoted separators and escaped `--admin`, the round-four escaped `&`.
- The exact-list assertions from rounds three and four were rewritten. They pinned one
  segmentation, which would forbid the second reading that closes finding 2; they now
  assert the property that actually protects the gate — that some inspected segment still
  carries the `--admin` — which is what they were always for.
- Linearity: two walks, still pinned under the same 250 ms ceiling on 40k-character runs.

### Proof

- `node .claude/hooks/codex-push-lib.test.mjs`,
  `node .codex/hooks/production-action-guard.test.mjs`,
  `node .claude/hooks/pr-merge-guard.test.mjs`,
  `node .claude/hooks/guards.test.mjs`,
  `npm run test:correction-guards`, `npm run check-doc-drift`,
  `npm run test:agent-workflows`, `npm test`, `npm run typecheck`, `npm run lint`,
  `npm run build` — all pass.
