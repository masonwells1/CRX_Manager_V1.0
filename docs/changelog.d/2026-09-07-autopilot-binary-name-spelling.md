## 2026-09-07 - Every command head in the autopilot deny set was defeated by a .exe or .cmd suffix

**Class:** binary-spelling blindness — the same family as the recursive-delete alias bug
recorded alongside this entry. **Severity: latent, not live** — `autopilotDecision` runs only
while autopilot is ARMED, and all 26 `AUTOPILOT.on` flags on this machine (99 worktree roots
walked) were expired, 0 armed.

## What was wrong

Every rule in `DENY_BASH_RES` matched a bare command name. On Windows a binary NAME is
resolved case-insensitively and its executable suffix is optional, and an npm- or
winget-installed CLI is normally a `.cmd` shim — which is exactly how `gh.cmd` arises in
practice. Measured by calling the real `autopilotDecision` on `origin/main`:

| verdict | command |
|---|---|
| deny | `gh pr merge 123 --squash` |
| **allow** | `gh.cmd pr merge 123 --squash` |
| **allow** | `gh.exe pr merge 123` |
| deny | `git push origin main` |
| **allow** | `git.exe push origin main` — walks straight past "no unattended push" |
| **allow** | `git.cmd push origin main` |
| deny | `git reset --hard HEAD` |
| **allow** | `git.exe reset --hard HEAD` |
| **allow** | `git.exe clean -fd` |
| **allow** | `git.exe branch -D x` |
| **allow** | `git.exe worktree remove ../x` |
| **allow** | `git.exe filter-branch --all` |
| deny | `vercel deploy --prod` |
| **allow** | `vercel.cmd deploy --prod` — a production deploy |
| deny | `supabase db reset` |
| **allow** | `supabase.cmd db reset` |
| **allow** | `supabase.cmd functions deploy send-email` |
| **allow** | `supabase.cmd migration repair 123` |

`dropdb` / `createdb` were already safe, because their rule never required whitespace after
the name.

## The fix

A `bin(name)` helper builds each head as a case-folded name plus an optional
`.exe`/`.cmd`/`.bat`/`.com`/`.ps1` suffix, and every `git`, `gh`, `vercel`, `supabase` and
`npx` head now goes through it.

**Case-folding a NAME is correct precisely because it is a filename** — the filesystem
resolves it that way. This is the opposite of the option-letter rule recorded in the sibling
entry: option letters are case-*significant* to a program and are still matched exactly.

## Proof

- Every allow row above now denies; the unsuffixed spellings keep their prior verdicts;
  `git status`, `git.exe status`, `gh pr view 123` and `gh.cmd pr view 123` stay allowed.
- `GIT.EXE push origin main` denies (name case-folding, asserted).
- Strictly additive: the 18,131-command generated sweep still reports **0 de-denials**.
- `autopilot-lib.test.mjs`: 165 → 186 assertions.
- `npm run lint`, `npm run test:correction-guards` pass; `guards.test.mjs`'s hold-latch
  superset assertion still holds.

## Still open

`.codex/hooks/production-action-guard.mjs` and `.claude/hooks/codex-push-lib.mjs` were NOT
inspected or changed here — another lane (`fix/push-guard-binary-shape`) owns them. This entry
covers only the autopilot deny set.

**Files:** `.claude/hooks/autopilot-lib.mjs`, `.claude/hooks/autopilot-lib.test.mjs`.
