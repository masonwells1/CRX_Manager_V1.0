## 2026-09-07 - the armed-mode deny-set now matches the BINARY by shape, closing `git.exe push`

Third and last axis of the same bug on PR #607, after `2026-09-05-autopilot-guard-global-options.md`
(the option region existed at all) and `2026-09-07-autopilot-guard-option-shape.md` (it was described
by a list of spellings instead of a shape). That second entry closed with a residual: *"the binary is
still matched as `\bgit\b` / `\bgh\b`, so the Windows spellings `git.exe push` and `gh.exe pr merge 1`
are still not seen."* It was flagged as a candidate for its own PR. That call was reversed after the
residual was measured, and it is fixed here.

## Why it was not a residual

Run against the library shipped at `e0bce4a82`, every one of these returned **allow** — meaning armed
mode would have pushed, force-pushed, merged and hard-reset:

| Command | Old verdict |
|---|---|
| `git.exe push origin HEAD` | **allow** |
| `git.exe push --force origin HEAD` | **allow** |
| `gh.exe pr merge 625 --squash` | **allow** |
| `git.exe reset --hard origin/main` | **allow** |
| `git.exe -C C:/CRX_pr607 push origin HEAD` | **allow** |
| `git push origin HEAD` *(control)* | deny |
| `gh pr merge 625 --squash` *(control)* | deny |
| `git reset --hard origin/main` *(control)* | deny |

That is the whole deny-set, not a corner of it, and `.exe` is the native binary spelling on the
platform this repo is developed on. The two earlier bypasses each needed an unusual shape; this one
needed typing the executable's actual name. Shipping a hardened guard whose own PR body documents a
total bypass is worse than shipping a slightly larger PR — footnotes do not stop pushes.

## The mechanism

`\bgit\b` was followed by a **required `\s`** before the subcommand. So anything the shell still
resolves to git — an extension, a closing quote — ended the match before the subcommand was ever
read. Same defect, same reason, in every other name-anchored rule in the set: `supabase.exe db reset`,
`vercel.cmd deploy` and `rm.exe -rf` all walked through too.

## What changed — a shape, not a list

Listing extensions (`\.exe|\.cmd|\.bat`) is the name-listed carve-out that already failed twice in
the option region. `PATHEXT` is user-configurable; `.com` and `.ps1` ship on it, and the next entry
nobody has thought of would not be on anyone's list either. So `.claude/hooks/autopilot-lib.mjs` now
describes the binary the way it describes the option region — by what a shell resolves as the command
word:

- **the NAME**, with `\b` on both sides, so it can be neither the head nor the tail of a longer word;
- **`BIN_TAIL`**, exactly two things that may sit between that name and the whitespace before the
  subcommand: an **extension** (a `.` followed by more of the same word — *any* extension, because
  "what follows the dot" is not a list), and a **closing quote** (a quoted command word ends with one,
  and `"C:/Program Files/Git/bin/git.exe" push` is the ordinary Windows spelling of a path containing
  a space).

**A path prefix is deliberately in the same class and needed no new syntax.** A path separator is a
non-word character, so `\b` already opens on the final segment — which is what the shell resolves too.
`/usr/bin/git push`, `./git push` and `C:\Tools\git.exe push` are matched at the basename. The
extensionless forms of those already denied before this change; that was checked by execution rather
than assumed, and they are now pinned in the test file so it stays true.

The same shape was applied to `supabase`, `vercel`, `rm` and `del`. `rmdir`, `dropdb` and `createdb`
were **left alone on purpose**: they are bare `\b…\b` word matches with nothing required after them,
so an extension never broke them (`rmdir.exe` already denied). The optional `npx ` prefix on the three
supabase rules is inert — the rule already matches from `supabase` onward — and the comment now says
so rather than implying it does work.

## It does not widen onto neighbours

`\b` on both sides plus "an extension starts with a dot" is what holds the boundary: `-` is not `.`,
so `BIN_TAIL` never opens on `git-crypt`, and the required whitespace then lands on `-crypt` instead
of on the subcommand. `git-crypt push`, `git-lfs push origin main`, `github-release push`,
`gitfoo push`, `npm run gitpush`, `npm run git-push`, `mygit push`, `gh-dash pr merge 1`, `ghq push`,
`ghost pr merge 1`, `supabase-py db reset`, `vercel-cli deploy`, `charm -rf x` and `model /s` are all
asserted to stay allowed.

## Proof — the differential sweep, in both directions

The 1,728-command sweep from the previous round was extended with a binary-spelling axis: 2 binaries
× 18 binary spellings × 18 option regions × the subcommand tails = **11,016 generated commands**, each
decided by the pre-fix and post-fix libraries.

| | dangerous tails | benign tails |
|---|---|---|
| **newly DENIED** | 4,125 | 240 |
| **newly ALLOWED** | 0 | 0 |

- **Nothing became allowed**, in either category. Unlike the previous round, this change only narrows.
- **The plain-binary slice drifts by 0** in either direction. That is the check that shows the option
  grammar was not disturbed while the binary anchor was replaced.
- **All 240 benign denials are the over-denial class already accepted in the previous entry** (a
  valueless or attached-value global swallows the subcommand), now merely reached through a non-plain
  binary spelling. That is machine-checked, not eyeballed: for each of the 240, the plain-binary twin
  **already denied before this change**. Genuinely new over-denial classes from the extension rule: **0**.
- One genuinely new over-denial shape comes from the closing quote and is stated rather than left to
  be discovered: a quoted word *ending* in the binary name satisfies `BIN_TAIL`, so `grep "git" push.log`
  denies. Its unquoted twin `grep git push.log` already denied before this change, so the guard became
  consistent rather than newly blunt. Both are asserted.

## Proof — before/after on the test file

`.claude/hooks/autopilot-lib.test.mjs` gains **65 assertions** in both directions. Run against the
**pre-fix** library with its assertion helpers turned into collectors (so every failure is reported,
not just the first): **174 passed, 32 FAILED** — every failure a deny-side case, and not one
previously-passing assertion broken. The other 33 new assertions are the benign-boundary pins, which
passed before and after by design. Against the **new** library,
`node .claude/hooks/autopilot-lib.test.mjs` reports **210 assertions passed**; the committed test file
run against the committed library at `e0bce4a82` reports **145**.

`guards.test.mjs` (168), `hook-router.test.mjs` (52), `overnight-intent-clear.test.mjs`,
`bash-safety.test.mjs` (536), `npm run typecheck` and `npm run lint` all pass.

## Arm state at the time of the fix

`INTENT_ALLOW_BASH_RE` — the read-only allow-list used while intent is latched but unarmed — was left
matching the plain `git` spelling. It is an allow-list, so an unrecognised spelling fails to the safe
side: `git.exe status` waits for the arm rather than passing.

All three bypasses on this PR were **latent, never live**. The autopilot flag is per worktree, so that
was verified across every checkout rather than for one: **42 roots scanned** (`C:/CRX_Manager`, its 33
worktrees, and 8 sibling `CRX*` checkouts) — **0 armed**. Eight expired `AUTOPILOT.on` flags remain on
disk; the most recent expired 39 hours before this fix and the oldest 280 hours before it. One stale
`OVERNIGHT-INTENT.flag` (2026-09-05) is well outside its 45-minute window.
