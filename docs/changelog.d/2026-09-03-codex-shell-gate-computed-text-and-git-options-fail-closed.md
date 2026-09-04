## 2026-09-03 - The Codex shell gate fails closed on computed text and holds read-only git to a safe grammar

**PR:** #563 (Codex round 13, exact-SHA `gpt-5.6-sol` proof of `5a9052934`) · **Files:** `.codex/hooks/production-action-guard.mjs`, its test, `scripts/apply-live-testdata-maintenance-20260812.mjs` (blob re-pin)

## What was wrong

Round 12 made a segment that NAMES a protected harness file fail closed unless
its command word is a known reader. Codex found two ways round that, both shown
by execution against the round-12 guard:

```
git diff --output=.codex/hooks/production-action-guard.mjs HEAD HEAD
$d=".codex/hooks/production-action-"; $f="guard.mjs"; Write-Output "" | Tee-Object -FilePath $d$f
```

The first is a "read-only" git subcommand whose `--output` option writes; the
guard accepted read-only git whatever its options. The second names no
protected file anywhere and uses a writer the verb list does not know, so
neither the computed-text rule (verb-scoped) nor the fail-closed rule
(name-scoped) fired. A third, found while fixing: `cd .codex/hooks; echo x |
tee production-action-guard.mjs` — the directory-change rule knew only the verb
list. All three also pass on `origin/main`'s guard today.

## What changed

- **Every command word is walked, not just the head.** An examined segment is
  tokenised and the word in each command position — the head, after `(`, `{`,
  a paired backtick, `&`, an assignment `=`, `in`, `-exec`, and after a wrapper's
  or executor's flags — must be a recognised read-only operation. A `$var` or
  quoted word in command position is an expression when an operator or nothing
  follows (`$_ -match "x"`) and an invocation otherwise (`$w $d$f`, `& $w`).
- **Computed text fails closed.** A segment carrying a `$`, `(`, paired
  backticks, a splat or `%VAR%` may contain only recognised read-only command
  words. Readers with computed arguments (`cat $f`, `git -C $repo diff`),
  pipeline stages (`| Where-Object { … }`, `| % { … }`), keywords
  (`if ($x) { exit 1 }`) and plain assignments stay allowed.
- **Read-only git has a grammar.** `--output`, `--ext-diff`, `--textconv`,
  `--exec`, grep's `-O`, a `-c`/`--config-env`/`--exec-path` override, a `GIT_*`
  environment assignment anywhere in the command, or an option VALUE naming a
  protected file all disqualify the invocation as a read.
- **Executors and basenames.** `xargs`/`parallel`/`find -exec` are examined when
  any segment names a protected file or is computed (the value reaches them
  through the pipe); after a `cd`/`Set-Location`/`pushd`, or under `find`, a
  protected basename counts as the protected file.

## Cost, stated plainly

Codex can no longer put a variable, subexpression or `%VAR%` under a command
word the guard does not recognise as a reader — `npm run x -- $flag`,
`node scripts/other.mjs $x`, `gh pr view $PR` are refused; spell the argument.
PowerShell's `"{0}" -f $x` formatting and `find … -name '*.mjs'` with
`-delete`/`-exec` are refused too. Pinned in the test so nobody "fixes" them
back open.

## Proof

Reproduced all three by execution before the fix; all deny after, through the
real hook entrypoint with Codex's own payloads. 67 deny payloads and 60 allow
canaries in a scratch matrix; ~90 new assertions in the suite (payloads, the
git grammar on its own, the walker on its own, the basename matcher, canaries,
pinned costs). Mutation-checked on a scratch copy one rule at a time. Guard blob
re-pinned from the protection test's printed candidate.
