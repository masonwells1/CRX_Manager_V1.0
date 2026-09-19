## 2026-09-07 - Narrow the autopilot `rm`-alias PR back to the `rm` aliases

**Class:** a PR that grew a second, better-solved concern. **Outcome:** the binary-name
rewrite is reverted out of this branch; the `rm` recursive-alias fix it was commissioned
for is untouched.

## Why

This branch (`claude/autopilot-recursive-delete-alias-20260907`, PR #631) was commissioned
for one defect: `.claude/hooks/autopilot-lib.mjs` spelled the recursive flag as a literal
lowercase `r`, so `rm -Rf /` returned **allow** while `rm -rf /` returned **deny**. That
fix is correct and stays.

Commit `1729180f8` then went further and rewrote **binary-name matching for the whole deny
set**, adding an `EXE_SUFFIX` alternation (`.exe|.cmd|.bat|.com|.ps1`) and a `bin()` helper
applied to `git`, `gh`, `npx`, `supabase` and `vercel`. That is the same concern PR #607
(`claude/crx-manager-orchestrator-db6075`) already solves, and solves better: #607 models
the suffix by **shape**, so spellings nobody wrote into the patch are still denied.
Measured by calling the real `autopilotDecision` in each worktree:

| command | this branch at `1729180f8` | #607 at `96c7b3718` |
|---|---|---|
| `git.exe push origin HEAD` | deny | deny |
| `git.cmd push origin HEAD` | deny | deny |
| `git.wsf push origin HEAD` | **allow** | deny |
| `git.msc push origin HEAD` | **allow** | deny |
| `GIt.WhAtEvEr reset --hard origin/main` | **allow** | deny |
| `gh.vbs pr merge 630 --squash` | **allow** | deny |
| `git. push origin HEAD` | **allow** | deny |

Both PRs edit the same region of the same file. Whichever landed second would either
conflict or silently **downgrade** the other's protection — an enumerated suffix list
landing on top of a shape rule is a regression that reads as a merge. Narrowing this branch
removes that trap: the two PRs no longer overlap, and #607 remains the single owner of
binary-name spelling.

## What changed

`git revert` of `1729180f8` — an ordinary forward commit, no history rewrite, since the
branch is pushed and its PR is open. That removes `EXE_SUFFIX`, `bin()`, the `GIT`
constant, the 21 binary-name test assertions, and
`docs/changelog.d/2026-09-07-autopilot-binary-name-spelling.md`, and restores every non-`rm`
deny rule to its `origin/main` text.

`RM_HEAD` goes back to the rm-local expression the alias fix introduced —
`\b[rR][mM](?:\.(?:[eE][xX][eE]|[cC][mM][dD]|[bB][aA][tT]))?` — so `rm`, `RM`, `rm.exe` and
path-qualified forms still match, with no general binary-name rewrite behind it.

## Proof

Verdicts read from the real `autopilotDecision`, not from the regex source. Against
`origin/main` (`336f92e4d`) after the revert, every difference is `allow` → `deny`:

- **`rm` recursive spellings** (the commissioned fix): `rm -Rf build`, `rm -fR build`,
  `rm -RF build`, `rm -Rf /`, `rm -Rf ~/CRX_Manager`, `rm -r -f build`,
  `rm --recursive --force build`, `rm.exe -Rf build`, `RM -Rf build`, `/usr/bin/rm -Rf x`.
- **Sibling option-spelling sweep** from the same commissioned commit: `git commit -n`,
  `git clean --force`, `git clean --force -d`, `git branch -Df`, `git branch -d -f`,
  `del /f /s /q`, `rd /s`, `erase /q`, `Remove-Item -Recurse -Force`, `Remove-Item -r`,
  `ri -Recurse`.
- **Unchanged from `origin/main`**, i.e. the binary-name rewrite is gone: `git push`,
  `git.exe push`, `git.cmd push`, `git.ps1 push`, `gh pr merge`, `gh.cmd pr merge`,
  `git reset --hard`, `vercel deploy --prod`, `vercel.cmd deploy --prod`,
  `supabase db reset`, `supabase.cmd db reset`, `git worktree remove`,
  `git filter-branch`, `npx supabase db push`, `dropdb`, `.env` reads and writes.
- **Still allow**, unchanged: `rm file.txt`, `rm ./my-rf-dir`, `rm -F build`, `ls -la`,
  `npm run build`, `git status --short`, `git-crypt unlock`, `git commit -mn`,
  `Get-ChildItem -Recurse src`.

`npm run typecheck`, `npm run lint`, `npm run test:correction-guards` and `npm run build`
all pass.

## Files

- `.claude/hooks/autopilot-lib.mjs`
- `.claude/hooks/autopilot-lib.test.mjs`
- `docs/changelog.d/2026-09-07-autopilot-binary-name-spelling.md` (deleted — it documents
  work no longer on this branch)
