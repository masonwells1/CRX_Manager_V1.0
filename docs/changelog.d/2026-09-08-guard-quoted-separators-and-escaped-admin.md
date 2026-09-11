## 2026-09-08 - A quoted `&` is not a separator, and an escaped `--admin` is still `--admin`

Third round on the same gates, and the first one where the review found a hole the
previous round had OPENED. Companion to
`2026-09-08-guard-word-splitting-is-shell-aware.md` (round one) and
`2026-09-08-guard-gh-spellings-second-round.md` (round two).

A `gpt-5.6-sol` high-effort review of `223bdf0d5` returned BLOCKERS with two HIGH
findings. Both were re-measured through the guards before anything changed, and both
were real.

### SEC-001 - splitting on a quoted `&` carried `--admin` out of the inspected segment

Round two made a single `&` a segment separator, correctly: POSIX backgrounds the left
side, cmd.exe runs it first, and either way both halves execute. But it did it with a
bare regex, and a regex does not know a quote from a separator.

```
gh pr merge 123 --body 'note&more' --admin --squash
```

is ONE command to every shell. The regex split produced:

```
["gh pr merge 123 --body 'note", "more' --admin --squash"]
```

Segment one is a merge with **no `--admin`**, so it went to the ordinary merge gate.
Segment two carries the override but contains no `gh`, so no parser looked at it. On a
pull request that is otherwise mergeable, the ordinary gate passes and an administrator
merge — the thing this guard exists to refuse — is authorized.

**The fix is a shared, quote-aware `splitCommandSegments`**, exported from
`.claude/hooks/codex-push-lib.mjs` and used by both guards. It is a character walk:
only an UNQUOTED `&&`, `&`, `||`, `|`, `;` or newline separates. An unterminated quote
runs to the end of the input, which yields a LONGER segment — the parsers see more text,
never less, so that direction cannot hide a command.

### SEC-002 - the composition refusal compared the command TYPE, not what it does

`ghHiddenByShellComposition` asked only whether each reading parses as a merge:

```js
Boolean(ghMergeRequest(unwrapped)) && !ghMergeRequest(text)
```

``gh pr merge 123 --ad`min --squash`` parses as a merge BOTH ways. The raw reading simply
records `admin: false` while PowerShell consumes the backtick and gh receives `--admin`.
Same for `--re`po`, which would have the guard verify one repository while gh operates on
another.

**The whole parse is now compared, field by field** — selector, repo, auto, admin — and
any security-relevant difference is refused. `ghApiMutates` is compared the same way, by
equality rather than by "the unwrapped one mutates".

### Measured, with the filter that HID it removed

The first probe of these findings looked SAFE: every case came back denied. That was an
accident — the fixture PR was not merge-ready, so the guard refused for a reason that had
nothing to do with either defect. A test that cannot distinguish the two is not evidence.

Re-measured through `evaluateProductionAction` against the fixture the guard's own suite
uses — APPROVED, CLEAN, green checks, valid Sol proof on disk, so a plain
`gh pr merge 123 --squash` is **allowed** and the `--admin` refusal is the only thing left
standing:

| command | at `223bdf0d5` | now |
| --- | --- | --- |
| `gh pr merge 123 --squash` (control) | `blocked: false` | false |
| `gh pr merge 123 --admin --squash` (control) | true | true |
| `gh pr merge 123 --body 'note&more' --admin --squash` | **`false`** | true |
| `gh pr merge 123 --body "note&more" --admin --squash` | **false** | true |
| `gh pr merge 123 --subject 'a&b' --admin` | **false** | true |
| `gh pr merge 123 --body 'a;b' --admin` | **false** | true |
| `gh pr merge 123 --body 'a\|b' --admin` | **false** | true |
| ``gh pr merge 123 --ad`min --squash`` | true | true |
| `gh pr merge 123 --ad^min --squash` | **false** | true |
| `gh pr view 1 & gh pr merge 2 --admin --squash` | true | true |

Each `true` was checked for its REASON, not just its value: the five SEC-001 rows and the
caret row now fire the `--admin` refusal and the composition refusal respectively, not
some incidental gate.

The `;` and `|` rows were broken BEFORE this branch — that split has never been
quote-aware — so the quote-aware segmenter closes a pre-existing hole as well as the one
round two opened. The backtick row was already denied, but by the generic computed-text
rule rather than by this helper; a compensator is not a fix, and the caret spelling proves
it, because nothing compensated for that one.

### Scope: two splitters deliberately NOT converted

`shellSegments` and `mutatingSegmentWithComputedText` in
`.codex/hooks/production-action-guard.mjs` keep their regex split. Converting them
regressed a behaviour an earlier round pinned on purpose: with a quote-aware split,
`cmd /c "set a=… && echo x > %a%lib.mjs"` becomes one segment and the classifier names the
wrapper instead of the mutating half. Neither splits on a single `&`, so SEC-001 does not
reach them, and their quoted-`;`/`|` splits produce SHORTER segments, which is the
fail-safe direction here. Named rather than half-fixed.
`.claude/hooks/review-proof-guard.mjs` has its own non-quote-aware split; it is a
different guard with a different blast radius and is out of scope for this branch.

### Proof

- The table above is a differential run of `evaluateProductionAction` in a detached
  worktree at `223bdf0d5` versus this commit — six rows moved from `false` to `true`, and
  the two controls did not move.
- New assertions run inside the guard's own merge-ready fixture, and assert the DENIAL
  REASON, so a refusal from an unrelated gate cannot satisfy them.
- Both directions pinned: an ordinary quoted body (`--body 'ships the thing'`) is still
  allowed; a plainly spelled `--admin` still reaches the `--admin` refusal rather than the
  composition one; `npm run build` is untouched. Every UNQUOTED separator still splits —
  `a && b || c | d ; e\nf` yields six segments — or round two would have been undone.
- The 50-command × 16-predicate differential sweep reports **no verdict moved** for any
  push predicate, and none for `mainPushSource` with `currentBranch=main`.
- Both hooks were run again as real `PreToolUse` SUBPROCESSES: 16 commands each, every
  attack refused by the correct gate and every benign command still allowed.
- Backtracking: the segmenter is a character walk and is pinned linear under the same
  250 ms ceiling on 40k-character runs of `'`, `"a`, `\&` and `&`.
- `node .claude/hooks/codex-push-lib.test.mjs`,
  `node .codex/hooks/production-action-guard.test.mjs`,
  `node .claude/hooks/pr-merge-guard.test.mjs` (132 assertions),
  `node .claude/hooks/guards.test.mjs` (168 assertions),
  `npm run test:agent-workflows` — all pass.
