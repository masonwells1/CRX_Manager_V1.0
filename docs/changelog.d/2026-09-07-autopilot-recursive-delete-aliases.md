## 2026-09-07 - Autopilot's recursive-delete guard knew one spelling of a recursive delete

**Class:** guard that describes how a command is TYPED, not what the program ACCEPTS.
**Outcome:** the recursive-delete rule and four sibling rules now match the real option
surface; latent-only, strictly additive, 165 assertions.

**Latent, not live.** `autopilotDecision` only runs while autopilot is ARMED. Every
`.claude/session-state/AUTOPILOT.on` flag on this machine was walked before the fix
(99 worktree roots, 26 flag files) and **all 26 were expired — 0 armed**, the newest
having expired 2026-09-05T13:23Z. No armed run could have used these bypasses in the
window they existed. They were nonetheless the most dangerous kind of hole, because
the thing they let through deletes data.

## What was wrong

`.claude/hooks/autopilot-lib.mjs` spelled the recursive flag as a literal lowercase
`r`:

```js
/\brm\s+-[A-Za-z]*r[A-Za-z]*f|\brm\s+-[A-Za-z]*f[A-Za-z]*r/  // rm -rf / -fr
```

That describes how `rm -rf` is **usually typed**, not what `rm` **accepts**. GNU
coreutils and BSD both document `-R` as an exact synonym of `-r`. Measured by calling
the real `autopilotDecision` on `origin/main` (`336f92e4d`):

| verdict | command |
|---|---|
| deny | `rm -rf build` |
| deny | `rm -fr build` |
| deny | `rm -rf node_modules` |
| **allow** | `rm -Rf build` |
| **allow** | `rm -fR build` |
| **allow** | `rm -RF build` |
| **allow** | `rm -Rf /` |
| **allow** | `rm -Rf ~/CRX_Manager` |
| allow | `ls -la` (benign control, correct) |

Establishing the real option surface first — rather than patching the reported
spelling — found that `-R` was the smallest part of it. Every one of these also
returned **allow** before the fix:

- **separated flags**, including the canonical lowercase pair: `rm -r -f build`,
  `rm -f -r build`, `rm -R -f build`, `rm -f -R build`
- **long forms**: `rm --recursive --force`, `rm --force --recursive`,
  `rm -r --force`, `rm --recursive -f`, and GNU's unambiguous long-option
  abbreviations `rm --rec -f`, `rm --r`
- **clusters** carrying `-R`: `rm -Rfv`, `rm -vRf`, `rm -dRf`, `rm -fvR`
- **binary spelling**: `/bin/rm -Rf`, and — regardless of flag case — `rm.exe -rf`,
  `RM.EXE -rf`, `C:/Program Files/Git/usr/bin/rm.exe -rf`. The old rule required
  whitespace immediately after `rm`, so *no* `rm.exe` invocation matched it at all.
- **recursive with no force at all**: `rm -r build`, `rm -R build`,
  `rm --recursive build`. `-f` only suppresses prompts; in a non-interactive agent
  shell `rm -r dir` deletes the tree with no prompt, so requiring both letters was
  never what made the command safe.

## Sibling sweep

The defect shape is "an option has a case-variant, long-form, or alias spelling the
rule does not know". Every other rule in the deny set was probed for it. Also fixed:

| rule | bypassed before |
|---|---|
| `git clean` | `git clean --force`, `git clean --force -d` (only the FIRST token after `clean` was read), `git clean -fq` (the destructive letter had to be last), `git clean -X` |
| `git branch` force-delete | `-Df`, `-vD`, `-d -f`, `-f -d`, `--force --delete`, `--delete -f`, `-d --force` — the rule knew only `-D` and `--delete --force` |
| `--no-verify` | `git commit -n`, git-commit's own documented short form |
| `del` / `rmdir` | `rd /s /q` and `erase /s` (documented cmd.exe aliases of `rmdir` and `del`), and `del /f /s /q` — the switch had to be the token immediately after `del` |
| *(new)* PowerShell | `Remove-Item -Recurse -Force`, and its `ri` / `rd` / `del` / `erase` aliases, in any parameter order. PowerShell is the primary shell in this environment and nothing in the deny set covered it. |

## The fix

An option-scan idiom — `<head>(?:<ws><token>)*?<ws><option>` — walks whole
whitespace-delimited tokens forward from the command head and requires the option to
sit at a token **start**. It stops at a shell separator, so `rm foo.txt && ls -r`
does not match, and a hyphen inside a token (`rm ./my-rf-dir`) is not read as an
option.

**It is not a general case-fold of options, and must not become one.** Option letters
are case-*significant* to a program — `-f` and `-F` are different flags to many tools
— so only aliases the program documents are accepted: `rm`'s `-r`/`-R`/`--recursive`,
GNU/parse-options unambiguous long-option prefixes, cmd.exe's `rd` and `erase`,
PowerShell's Remove-Item aliases. `rm -F build` stays **allow**, and there is a test
saying so. A binary *name* is the one thing that genuinely is case-insensitive
(Windows resolves it that way, and the `.exe` suffix is optional), so the head accepts
`rm`, `RM` and `rm.exe`.

## Proof

- Every bypass above now denies; `ls -la`, `rm file.txt`, `npm run build` and
  `git commit -m "remove -Rf from the docs"` still allow.
- **Strictly additive.** An 18,131-command generated sweep (27 command heads × 62
  flag sets × 11 operands, plus hand-written shapes) compared old and new decisions:
  **0 de-denials**, 2,478 newly denied. The one narrowing the new cmd.exe rule would
  have introduced — `del /srv/foo` no longer matching `/s` inside `/srv` — was
  reverted by keeping the original `del` regex alongside the new one.
- Nine spellings written nowhere in the source or its tests were checked afterwards
  and all behave correctly, including `rm -RvF node_modules`, `RM.CMD -Rf C:/data`,
  `rm --recurs --forc /var/lib`, `git branch -Dv topic`, `rd /Q /S C:/data` and
  `Remove-Item -Recur -Force C:/data`.
- `autopilot-lib.test.mjs` grew from 53 to 165 assertions. Its LIVE block now spawns
  the real `unattended-autopilot.mjs` process against an armed throwaway project dir
  and asserts a `deny` for `rm -Rf /`, `rm -R -f /`, `rm --recursive --force /` and
  `rm.exe -rf /`, plus an `allow` for `npm run build` — a library-only green is
  exactly how this file once certified a command the real hook chain refused.
- A structural assertion holds the old pattern out of the live deny set, checked
  against the imported regexes rather than the file text so the comment that quotes
  the old rule cannot satisfy it.
- `npm run typecheck`, `npm run lint`, `npm run test:correction-guards` and
  `npm run build` all pass.

## Reported, not fixed

- `gh.cmd pr merge …` and `gh.exe pr merge …` return **allow** while `gh pr merge`
  denies. Same binary-spelling family, but the `gh` merge rule is owned by another
  lane (`fix/push-guard-binary-shape`) and is deliberately untouched here.
- `git commit -n` is now caught only as a standalone token. A clustered `-vn` style
  spelling is not, because a cluster containing a value-taking short option swallows
  the rest (`git commit -mn` is the message `"n"`), and a naive cluster match would
  deny ordinary commits.
- `git branch -f name commit` (force-reset a branch pointer) is destructive and is
  still allowed. It is not a delete, the old rule never covered it, and widening to
  it was out of scope.

## Files

- `.claude/hooks/autopilot-lib.mjs`
- `.claude/hooks/autopilot-lib.test.mjs`
- `docs/reference/agent-guardrails.md` (deny-set description; also corrects a
  long-stale "99 assertions" claim that was already past 400 before this change)
