## 2026-09-08 - Second round on the same gates: the gh spellings the first fix left, and the ordinary push it over-blocked

Companion to `2026-09-08-guard-word-splitting-is-shell-aware.md`. That entry made the
push and merge gates read the argv a shell produces. This one is what an independent
review of that fix found wrong with it, plus one defect the review did not find.

### What an independent Sol review found on the fix itself

A `gpt-5.6-sol` high-effort review of the first commit (`8e77595a6`) against its parent
returned BLOCKERS with fourteen findings. Every claim was re-measured through the guards
before anything was changed, and several were narrower than reported. What that produced:

| # | finding | measured | done |
| --- | --- | --- | --- |
| 1 | `gh api` short options: `-X=DELETE`, `-iXDELETE`, `-iFbody=x` | confirmed (3 of the 6 spellings listed — `-F body=x`, `-f body=x`, `--field body=x` were already denied) | **fixed** — one pflag-shaped cluster walk |
| 2 | `--disable-auto` stood the merge gate down from a VALUE position, exempting an `--admin` merge | confirmed, and also via `-t` | **fixed** — value positions resolved first |
| 3 | PowerShell backtick / cmd caret hide a gh command entirely | confirmed | **fixed** — `ghHiddenByShellComposition`, wired on both guards |
| 4 | a single `&` was not a segment separator | confirmed for pushes and `gh api` (`gh pr merge 1 & gh pr merge 2` was already denied) | **fixed** — both guards |
| 5 | `g""h` splices the BINARY | confirmed | **fixed** — the binary shape is tested against the argv reading too |
| 8 | the argv reader consumes backslashes PowerShell would not | 1 of 3 confirmed; `--method="P\OST"` and `gh pr "me\rge"` do not move | kept, and stated as the POSIX reading it is |
| 9 | ordinary Windows local-repo pushes newly refused | confirmed | **fixed** — see below |
| 13, 14 | the first changelog overstated what the tests prove and what stays raw | correct on both | corrected in that entry |
| 6, 7, and part of 5 | gh aliases; glob/expansion spellings; gh nested inside `cmd /c` / `bash -c` | confirmed, all pre-existing | **not done** — named below |

### What changed

- **`ghApiShortCluster` (new) resolves a short option the four ways pflag accepts one** —
  separate (`-X PUT`), attached (`-XPUT`), equals-attached (`-X=PUT`) and bundled behind
  boolean flags (`-iXPUT`). Only the first two were recognised, so a DELETE and a
  field-bearing POST both read as plain GETs. Both `gh api` parsers use the one walk.
- **`ghMergeRequest` resolves option POSITIONS before reading any keyword.** Every
  value-taking flag (`--repo`, `--subject`, `--body`, `--body-file` and their short
  forms) marks the word after it as data, so `--disable-auto` inside a PR body no longer
  stands the merge gate down, and a body word can no longer be mistaken for the PR
  number.
- **`ghHiddenByShellComposition` (new) refuses what the argv reader deliberately does not
  model**, wired into BOTH `.codex/hooks/production-action-guard.mjs` and
  `.claude/hooks/pr-merge-guard.mjs`. A PowerShell backtick and a cmd.exe caret are
  consumed before gh ever sees the word, and PowerShell is the shell this fleet runs. It
  removes only those two characters — never a quote, because erasing a quote is the
  blanket normalization CodeRabbit objected to, and `--method='P"OST'` really does pass
  `P"OST` — and it refuses only when that reading produces a merge or a mutation the
  literal text does not.
- **A single `&` now separates command segments** in both of those guards. POSIX
  backgrounds the left side and cmd.exe runs it first; either way both halves execute.
  One rolling HTTP method was being carried across the unsplit text, so a trailing GET
  erased a leading POST, and only the first of two pushes was gated.
- **The binary itself can carry the splice**, so the gh binary shape is now tested
  against the argv reading as well as the raw text (`g""h pr merge 1`).

`.claude/hooks/pr-merge-guard.mjs` is in this diff for the composition refusal and the
segment separator only. Leaving the Claude side without them would recreate exactly the
Claude/Codex asymmetry this work exists to remove — the Claude merge gate is the one that
runs in Mason's own sessions.

### Finding 9 was mine, and it was an over-block

`pushHiddenByShellComposition` compared the executed reading against the literal one by
re-splitting a copy of the whole command with every quote deleted — which MANUFACTURES a
word boundary that was never there. `git push "C:/scratch repo/repo.git"` is one
destination word to every shell and read back as two, so an ordinary push to a local
repository was refused as a hidden one. The helper has read them that way since
2026-07-30, so the Claude guard refused them too; importing it into the Codex guard only
made the existing defect visible on both. The comparison is now word-wise from the SAME
split, with drive-qualified paths exempt — no shell rewriting of `C:\…` can produce a
push to `main`, since a local repository is not a GitHub branch and no refspec starts
with a drive letter.

Narrowing that comparison silently dropped a second signal it had been carrying
incidentally: `git push $(cat ref) HEAD:main` has no quote or escape in any word, so
every word read back identically and the refusal stopped firing. **The review did not
find this; a differential sweep of this file's other consumers did** — 50 commands
against 16 predicates, pre-fix versus post-fix, reporting every verdict that moved in
either direction. Run-time substitution in a push's arguments is now named as its own
signal, with its own assertions.

### Still open after the second round, named rather than half-covered

- **gh invoked inside another program's quoted argument** — `cmd /c "gh pr merge 1"`,
  `bash -c 'gh pr merge 1'`. The whole nested command is one argv word, so `pr` and
  `merge` are not separate words to any parser. Closing it means re-splitting a nested
  command, which is a larger change than this one.
- **gh aliases** — `gh alias set land 'pr merge --admin' && gh land 123`. The definition
  is one value and the invocation names no known subcommand.
- **Expansion spellings** — `gh pr "$verb" 123`, `gh pr m* 123`. On the Codex guard the
  `$` forms are already refused by the generic computed-command check; a glob is not
  computed input to it, and the Claude merge guard runs its computed-text check only
  after a merge has been parsed.
- **`echo gh pr me""rge 123` is now refused.** `GH_BIN_RE` deliberately matches a `gh`
  token anywhere after a separator — documented as fail-safe over-matching since PR #541
  — and the argv reading gives it one more spelling to match. Refusing an `echo` is the
  harmless direction; narrowing it would mean anchoring the binary to a command position,
  which is the change the bullets above are already deferring.

### Proof

- Of the 23 assertions added in this round, **21 fail against `8e77595a6`**, this round's
  own parent, run in a detached worktree. The 2 that pass are controls for behaviour that
  was already correct (`--disable-auto=false` does not stand the gate down; the word
  after `--body` is not the PR selector) and are there to keep the fix from breaking
  them.
- The three ordinary Windows local-repo pushes that finding 9 named are asserted
  `blocked === false` through `evaluateProductionAction` with a throwing `runGh`, so an
  accidental trip into any other gate fails loudly rather than passing quietly.
- Both hooks were run again as real `PreToolUse` SUBPROCESSES with a real payload, on the
  pre-fix checkout and this one, not only through the in-process entry points.
- The differential sweep reports **no verdict moved** across the corpus for any push
  predicate other than the two intended `pushHiddenByShellComposition` rows, and none at
  all for `mainPushSource` with `currentBranch=main`.
- Backtracking re-measured for the new helpers: 40k-character runs of `` ` ``, `^`, `\`
  and `"` through both composition readings and all three gh parsers stay linear, under
  the same 250 ms ceiling the tests pin. Sol's own independent timing run agreed: linear
  to 1,000,000-character inputs, no termination or catastrophic-backtracking defect.
- `node .claude/hooks/codex-push-lib.test.mjs`,
  `node .codex/hooks/production-action-guard.test.mjs`,
  `node .claude/hooks/pr-merge-guard.test.mjs` (131 assertions),
  `node .claude/hooks/guards.test.mjs` (168 assertions),
  `npm run test:agent-workflows`, and the full `npm test` suite (356 files, 5064 passed)
  — all pass. Parity is unaffected: no hook added or removed on either side.
