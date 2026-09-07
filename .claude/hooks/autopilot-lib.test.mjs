#!/usr/bin/env node
// Tests for the overnight autopilot decision + flag logic, plus a live check that
// the hook is INERT when the flag is absent (off by default).
// Run: node .claude/hooks/autopilot-lib.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { autopilotDecision, flagActive, intentFresh, overnightGateDecision } from "./autopilot-lib.mjs";

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }
function eq(a, b, msg) { assert.equal(a, b, msg); pass++; }

// ── SQL/migration: Mason-authorized to auto-run unattended (2026-07-10) ────
// apply_migration + execute_sql are intentionally NOT denied — Mason owns this live
// DB and does not want them to gate. The migration-apply-guard hook (reviewer proof)
// remains the real backstop for migrations.
eq(autopilotDecision("mcp__supabase__apply_migration", { query: "..." }), "allow", "apply_migration allowed (Mason 2026-07-10)");
eq(autopilotDecision("mcp__supabase__execute_sql", { query: "..." }), "allow", "execute_sql allowed (Mason 2026-07-10)");

// ── deny-set: prod-touching + destructive must NEVER be auto-approved ─────
eq(autopilotDecision("mcp__supabase__deploy_edge_function", {}), "deny", "deploy_edge_function denied");
eq(autopilotDecision("mcp__x__deploy_to_vercel", {}), "deny", "deploy_to_vercel denied");
eq(autopilotDecision("Bash", { command: "git push origin main" }), "deny", "git push denied");
eq(autopilotDecision("Bash", { command: "git push --force" }), "deny", "force push denied");
eq(autopilotDecision("Bash", { command: "git reset --hard HEAD~1" }), "deny", "hard reset denied");
eq(autopilotDecision("Bash", { command: "rm -rf build" }), "deny", "rm -rf denied");
eq(autopilotDecision("Bash", { command: "npm run test -- --no-verify" }), "deny", "--no-verify denied");
eq(autopilotDecision("Bash", { command: "npx supabase db reset" }), "deny", "supabase db reset denied");
eq(autopilotDecision("Bash", { command: "git worktree remove ../x" }), "deny", "worktree remove denied");
eq(autopilotDecision("Bash", { command: "echo SECRET >> .env" }), "deny", "write to .env denied");
eq(autopilotDecision("Write", { file_path: "C:/CRX_Manager/.env.local" }), "deny", "Write .env.local denied");
eq(autopilotDecision("Edit", { file_path: ".env" }), "deny", "Edit .env denied");

// ── deny-set additions (2026-07-04): CLI deploy, PR merge, MCP write/exec ─
eq(autopilotDecision("Bash", { command: "npx supabase functions deploy send-email" }), "deny", "CLI edge deploy denied");
eq(autopilotDecision("Bash", { command: "supabase functions deploy process-document" }), "deny", "bare CLI edge deploy denied");
eq(autopilotDecision("Bash", { command: "gh pr merge 42 --squash" }), "deny", "gh pr merge denied");
eq(autopilotDecision("mcp__github__push_files", {}), "deny", "GitHub MCP push_files denied");
eq(autopilotDecision("mcp__github__merge_pull_request", {}), "deny", "GitHub MCP merge PR denied");
eq(autopilotDecision("mcp__github__create_or_update_file", {}), "deny", "GitHub MCP file write denied");
eq(autopilotDecision("mcp__Desktop_Commander__start_process", {}), "deny", "Desktop Commander exec denied");
eq(autopilotDecision("mcp__Desktop_Commander__write_file", {}), "deny", "Desktop Commander write denied");

// ── global options between binary and subcommand (2026-09-05) ────────────
// `git`/`gh` accept global options BEFORE the subcommand, and the original
// `git\s+push` could not span them: `git -C <dir> push` and `gh -R <repo> pr
// merge` were AUTO-APPROVED while armed. Two real pushes went through this hole
// before it was found — by RUNNING the guard, not by reading the regex.
eq(autopilotDecision("Bash", { command: "git -C C:/CRX_Manager/wt push origin HEAD" }), "deny", "git -C push denied");
eq(autopilotDecision("Bash", { command: "git -c core.hooksPath=.husky push origin HEAD" }), "deny", "git -c push denied");
eq(autopilotDecision("Bash", { command: "git --git-dir=/repo/.git push origin HEAD" }), "deny", "git --git-dir push denied");
eq(autopilotDecision("Bash", { command: "git --no-pager -C /x push origin HEAD" }), "deny", "git with two globals push denied");
eq(autopilotDecision("Bash", { command: "git -C /repo push --force origin HEAD" }), "deny", "git -C force push denied");
eq(autopilotDecision("Bash", { command: "git -C /repo push --force-with-lease" }), "deny", "git -C force-with-lease denied");
eq(autopilotDecision("Bash", { command: "git -C /repo reset --hard HEAD~1" }), "deny", "git -C hard reset denied");
eq(autopilotDecision("Bash", { command: "git -C /repo clean -fd" }), "deny", "git -C clean -fd denied");
eq(autopilotDecision("Bash", { command: "git -C /repo worktree remove ../x" }), "deny", "git -C worktree remove denied");
eq(autopilotDecision("Bash", { command: "git -C /repo branch -D feature" }), "deny", "git -C branch -D denied");
eq(autopilotDecision("Bash", { command: "git -C /repo filter-branch --all" }), "deny", "git -C filter-branch denied");
eq(autopilotDecision("Bash", { command: "gh -R masonwells1/CRX_Manager_V1.0 pr merge 535 --squash" }), "deny", "gh -R pr merge denied");
eq(autopilotDecision("Bash", { command: "gh --repo masonwells1/CRX_Manager_V1.0 pr merge 535" }), "deny", "gh --repo pr merge denied");

// ── the ENUMERATED option list leaked, twice (2026-09-07) ────────────────
// The first fix above listed the option spellings it knew (`-[cC]\s+\S+|--\S+`,
// `-[RFf]\s+\S+|--repo\s+\S+`), so it inherited that list's omissions. Codex
// raised it; both cases below were then reproduced by RUNNING autopilotDecision
// against a corpus, not by re-reading the regex — the same way the hole above was
// found. Every one of these returned "allow" (i.e. armed mode would have pushed or
// merged) until the option region was rewritten by SHAPE.
//
// (1) `\S+` stops at the first space, so a QUOTED value defeated the git matcher.
//     CRX worktrees genuinely live under a path with a space, so this is an
//     ordinary command here, not a contrived one.
eq(autopilotDecision("Bash", { command: 'git -C "C:/CRX Manager/wt" push origin HEAD:feature' }), "deny", "PROVEN BYPASS: double-quoted -C path with a space");
eq(autopilotDecision("Bash", { command: "git -C 'C:/CRX Manager/wt' push origin HEAD:feature" }), "deny", "PROVEN BYPASS: single-quoted -C path with a space");
eq(autopilotDecision("Bash", { command: "git -C C:/CRX\\ Manager/wt push origin HEAD" }), "deny", "a backslash-escaped space is the same word");
eq(autopilotDecision("Bash", { command: 'git --git-dir="C:/CRX Manager/.git" push origin HEAD' }), "deny", "--opt=\"quoted value\" is one token");
eq(autopilotDecision("Bash", { command: 'gh -R "masonwells1/CRX Manager" pr merge 625' }), "deny", "a quoted gh -R value is one token");
// (2) `-[RFf]\s+` demanded a DETACHED value, so an ATTACHED short-option value
//     defeated the gh matcher. Attached short values are standard POSIX/gh usage.
eq(autopilotDecision("Bash", { command: "gh -Rmasonwells1/CRX_Manager_V1.0 pr merge 625" }), "deny", "PROVEN BYPASS: gh attached short-option value");
eq(autopilotDecision("Bash", { command: "git -CC:/CRX_Manager/wt push origin HEAD" }), "deny", "git attached short-option value");
eq(autopilotDecision("Bash", { command: 'git -C"C:/CRX Manager/wt" push origin HEAD' }), "deny", "attached AND quoted in one token");
eq(autopilotDecision("Bash", { command: "gh --repo=masonwells1/CRX_Manager_V1.0 pr merge 625" }), "deny", "gh --repo=value");
// The quoted/attached forms must reach every other git rule too, not just push —
// one option region feeds all of them.
eq(autopilotDecision("Bash", { command: 'git -c core.hooksPath=.husky -C "C:/CRX Manager/wt" push origin HEAD' }), "deny", "repeated globals, one of them quoted");
eq(autopilotDecision("Bash", { command: 'git -C "C:/CRX Manager/wt" push --force origin HEAD' }), "deny", "quoted -C + force push");
eq(autopilotDecision("Bash", { command: 'git -C "C:/CRX Manager/wt" reset --hard HEAD~1' }), "deny", "quoted -C + hard reset");
eq(autopilotDecision("Bash", { command: 'git -C "C:/CRX Manager/wt" clean -fd' }), "deny", "quoted -C + clean -fd");
eq(autopilotDecision("Bash", { command: 'git -C "C:/CRX Manager/wt" worktree remove ../x' }), "deny", "quoted -C + worktree remove");
eq(autopilotDecision("Bash", { command: 'git -C "C:/CRX Manager/wt" branch -D feature' }), "deny", "quoted -C + branch -D");
eq(autopilotDecision("Bash", { command: "git -c 'user.name=A B' push origin HEAD" }), "deny", "quoted -c key=value");
eq(autopilotDecision("Bash", { command: "gh -R owner/repo --json x pr merge 1" }), "deny", "a gh global after -R still reaches pr merge");

// The other direction, which is why the option region is a described SHAPE and
// not `.*`: a wildcard between binary and subcommand blocks ordinary work. Every
// line below MUST stay allowed — `git commit -m "fix the push bug"` above all.
// The region ends at the first word that is neither an option nor an option's
// value, and that word is the subcommand; a leading `-` is what opens it at all.
eq(autopilotDecision("Bash", { command: 'git commit -m "fix the push bug"' }), "allow", "commit message naming push still allowed");
eq(autopilotDecision("Bash", { command: 'git commit -m "do not push this yet"' }), "allow", "commit message about pushing still allowed");
eq(autopilotDecision("Bash", { command: "git -C /repo status --short" }), "allow", "git -C status allowed");
eq(autopilotDecision("Bash", { command: "git -C /repo log -3 --format=%H" }), "allow", "git -C log allowed");
eq(autopilotDecision("Bash", { command: "git -c core.pager=cat log --oneline" }), "allow", "git -c log allowed");
eq(autopilotDecision("Bash", { command: "git fetch origin" }), "allow", "fetch allowed");
eq(autopilotDecision("Bash", { command: "git --version" }), "allow", "git --version allowed");
eq(autopilotDecision("Bash", { command: "gh pr view 535 --json headRefOid" }), "allow", "gh pr view allowed");
eq(autopilotDecision("Bash", { command: "gh pr checks 603" }), "allow", "gh pr checks allowed");
eq(autopilotDecision("Bash", { command: "gh -R masonwells1/CRX_Manager_V1.0 pr list" }), "allow", "gh -R pr list allowed");
// The same quoted/attached spellings that must now be DENIED above must not drag
// ordinary work down with them. A quoted global option is a normal thing to type
// in this repo, so these are the commands the widened matcher could have broken.
eq(autopilotDecision("Bash", { command: 'git -C "C:/CRX Manager/wt" commit -m "fix the push bug"' }), "allow", "quoted -C + a commit message naming push stays allowed");
eq(autopilotDecision("Bash", { command: 'git -C "C:/CRX Manager/wt" status --short' }), "allow", "quoted -C + status allowed");
eq(autopilotDecision("Bash", { command: "git -C 'C:/CRX Manager/wt' log -3 --format=%H" }), "allow", "quoted -C + log allowed");
eq(autopilotDecision("Bash", { command: "git -C 'C:/CRX Manager/wt' rev-parse HEAD" }), "allow", "quoted -C + rev-parse allowed");
eq(autopilotDecision("Bash", { command: "git -c core.pager=cat -C 'a b' show --stat HEAD" }), "allow", "two globals + show allowed");
eq(autopilotDecision("Bash", { command: "git -C 'a b' branch --show-current" }), "allow", "quoted -C + branch --show-current allowed (only -D is denied)");
eq(autopilotDecision("Bash", { command: "git -C 'a b' stash push -m wip" }), "allow", "`stash push` is not `git push`");
eq(autopilotDecision("Bash", { command: "gh -Rmasonwells1/CRX_Manager_V1.0 pr list" }), "allow", "gh attached -R + pr list allowed");
eq(autopilotDecision("Bash", { command: "gh -R owner/repo pr view 1 --json mergeStateStatus" }), "allow", "gh -R pr view allowed");
eq(autopilotDecision("Bash", { command: 'gh pr comment 607 --body "ready to merge"' }), "allow", "a comment body naming merge stays allowed");
eq(autopilotDecision("Bash", { command: "gh workflow list -R owner/repo" }), "allow", "a gh option AFTER the subcommand is not a global");

// ── the over-denial class, measured and pinned ───────────────────────────
// When a global option does not consume a detached value, the SUBCOMMAND is the
// next bare word and gets consumed as that option's value instead, so a deny word
// two tokens later matches. 43 benign commands out of a 1,728-command sweep land
// here, against 188 dangerous shapes closed. Pinned so the boundary is visible:
// the COMMON spellings are on the allowed side, which is what makes the trade
// acceptable — an over-broad deny set gets disarmed by whoever it blocks.
eq(autopilotDecision("Bash", { command: "git -C /x stash push -m wip" }), "allow", "the COMMON detached form of `stash push` stays allowed");
eq(autopilotDecision("Bash", { command: "git log --grep push" }), "allow", "the COMMON form of a log search for the word stays allowed");
eq(autopilotDecision("Bash", { command: "git -C /x log --grep push" }), "allow", "…and with a detached global option in front of it");
eq(autopilotDecision("Bash", { command: "git --no-pager log --grep push" }), "deny", "ACCEPTED over-denial: a valueless global swallows `log`, so `push` matches");
eq(autopilotDecision("Bash", { command: "git -C/x stash push -m wip" }), "deny", "ACCEPTED over-denial: an ATTACHED value leaves `stash` to be swallowed");

// ── the ONE place the new region is NARROWER than the enumerated one ─────
// A differential sweep of 1,728 generated commands over the option grammar found
// 231 newly denied and 36 newly ALLOWED. All 36 are the same thing: an UNBALANCED
// quote inside the option region (`git -C "a push`, `git -c a'b push`). The old
// `\S+` swallowed the stray quote as an ordinary character; the new word model
// treats a quote as opening a run, so the token stops there and the region ends.
//
// This is not a hole, because those strings are not commands. Measured, not
// assumed: `bash -c` exits 2 with "unexpected EOF while looking for matching",
// and PowerShell exits 1 with "The string is missing the terminator" — the shell
// refuses to run them, so nothing is pushed. The balanced control runs in both.
//
// The rule underneath is that the guard models the SHELL'S word splitting: if
// `push` sits inside a quoted run, the shell does not see it as the subcommand
// either. Closing this last sliver would mean letting a lone quote also count as
// an ordinary character, which reintroduces the ambiguity it was added to remove
// and starts denying `git -C "a push" status`. Asserted here so it stays a
// deliberate, re-checkable property rather than a surprise in the next review.
eq(autopilotDecision("Bash", { command: 'git -c a"b push' }), "allow", "an unbalanced quote is not a runnable command (bash exits 2 before git runs)");
eq(autopilotDecision("Bash", { command: "git -C 'a push origin main" }), "allow", "same, single-quoted");
eq(autopilotDecision("Bash", { command: "git -C 'a b' push origin main" }), "deny", "the BALANCED counterpart — which shells DO run — is denied");

// ── the BINARY was the third axis, and the widest (2026-09-07, round two) ────
// `\bgit\b` / `\bgh\b` is followed by a required `\s`, so ANY spelling the shell
// still resolves to the same program — an extension, a closing quote — ended the
// match before the subcommand was read. Every line in this first block returned
// "allow" against the library shipped at e0bce4a82: armed mode would have pushed,
// force-pushed, merged and hard-reset. `.exe` is the NATIVE binary spelling on
// Windows, which is where this repo is developed, so this was not a residual —
// it defeated the deny-set outright. Reproduced by RUNNING the guard.
eq(autopilotDecision("Bash", { command: "git.exe push origin HEAD" }), "deny", "PROVEN BYPASS: git.exe push");
eq(autopilotDecision("Bash", { command: "git.exe push --force origin HEAD" }), "deny", "PROVEN BYPASS: git.exe force push");
eq(autopilotDecision("Bash", { command: "gh.exe pr merge 625 --squash" }), "deny", "PROVEN BYPASS: gh.exe pr merge");
eq(autopilotDecision("Bash", { command: "git.exe reset --hard origin/main" }), "deny", "PROVEN BYPASS: git.exe reset --hard");
eq(autopilotDecision("Bash", { command: "git.exe -C C:/CRX_pr607 push origin HEAD" }), "deny", "PROVEN BYPASS: git.exe with a global option");
// The extension is matched by SHAPE, so the rule does not depend on anyone having
// listed the right extensions. PATHEXT is user-configurable; `.com` and `.ps1` are
// on it out of the box, and the next one nobody has thought of is covered too.
eq(autopilotDecision("Bash", { command: "git.cmd push origin HEAD" }), "deny", "git.cmd push");
eq(autopilotDecision("Bash", { command: "git.bat push origin HEAD" }), "deny", "git.bat push");
eq(autopilotDecision("Bash", { command: "git.ps1 push origin HEAD" }), "deny", "git.ps1 push");
eq(autopilotDecision("Bash", { command: "git.com push origin HEAD" }), "deny", "git.com push");
eq(autopilotDecision("Bash", { command: "git.EXE push origin HEAD" }), "deny", "an UPPERCASE extension is the same file on Windows");
eq(autopilotDecision("Bash", { command: "git.anything-at-all push origin HEAD" }), "deny", "an extension nobody listed is still an extension");
// A PATH PREFIX is deliberately the same class. It needs no new syntax — a path
// separator is a non-word character, so `\b` already opens on the final segment,
// which is what the shell resolves too. The extensionless forms below denied
// BEFORE this change; they are pinned so that stays true, and the `.exe` forms
// are the ones this change adds.
eq(autopilotDecision("Bash", { command: "/usr/bin/git push origin HEAD" }), "deny", "an absolute POSIX path");
eq(autopilotDecision("Bash", { command: "/usr/bin/git.exe push origin HEAD" }), "deny", "…and with an extension");
eq(autopilotDecision("Bash", { command: "./git push origin HEAD" }), "deny", "a relative path");
eq(autopilotDecision("Bash", { command: "./git.exe push origin HEAD" }), "deny", "…and with an extension");
eq(autopilotDecision("Bash", { command: "C:\\Tools\\git.exe push origin HEAD" }), "deny", "a Windows backslash path");
eq(autopilotDecision("Bash", { command: 'gh.exe -R "o/r name" pr merge 625' }), "deny", "extension AND a quoted global option");
// A QUOTED command word is the other half of BIN_TAIL, and it is ordinary Windows
// usage: the real install path contains a space, so it gets quoted.
eq(autopilotDecision("Bash", { command: '"C:/Program Files/Git/bin/git.exe" push origin HEAD' }), "deny", "PROVEN BYPASS: the quoted Windows install path");
eq(autopilotDecision("Bash", { command: "'/opt/git/bin/git.exe' push origin HEAD" }), "deny", "single-quoted binary path");
eq(autopilotDecision("Bash", { command: '"git" push origin HEAD' }), "deny", "a quoted bare name is still the command word");
eq(autopilotDecision("Bash", { command: '"C:/Program Files/GitHub CLI/gh.exe" pr merge 625' }), "deny", "quoted gh.exe path + pr merge");

// The other direction. `\b` on both sides of the name, plus "an extension starts
// with a DOT", is what keeps this off the neighbours: `-` is not `.`, so BIN_TAIL
// never opens on `git-crypt`, and the required whitespace then lands on `-crypt`
// instead of on the subcommand. These are the commands a careless widening of the
// binary anchor would have swept in, so every one of them is pinned.
eq(autopilotDecision("Bash", { command: "git-crypt unlock" }), "allow", "git-crypt is a different program");
eq(autopilotDecision("Bash", { command: "git-crypt push origin" }), "allow", "…even when its own subcommand is a deny word");
eq(autopilotDecision("Bash", { command: "git-lfs push origin main" }), "allow", "git-lfs push is not git push");
eq(autopilotDecision("Bash", { command: "github-release push" }), "allow", "a longer name starting with the binary");
eq(autopilotDecision("Bash", { command: "gitfoo push" }), "allow", "a file literally named gitfoo");
eq(autopilotDecision("Bash", { command: "npm run gitpush" }), "allow", "an npm script named gitpush");
eq(autopilotDecision("Bash", { command: "npm run git-push" }), "allow", "an npm script named git-push");
eq(autopilotDecision("Bash", { command: "mygit push origin" }), "allow", "a longer name ENDING with the binary");
eq(autopilotDecision("Bash", { command: "gh-dash pr merge 1" }), "allow", "gh-dash is a different program");
eq(autopilotDecision("Bash", { command: "ghq push" }), "allow", "ghq is a different program");
eq(autopilotDecision("Bash", { command: "ghost pr merge 1" }), "allow", "a longer name starting with gh");
eq(autopilotDecision("Bash", { command: "cat .gitignore" }), "allow", "reading a dotfile whose name starts with the binary");

// The same shape rule, applied to every OTHER name-anchored rule in the deny set,
// because they had the identical hole for the identical reason. `npx.cmd` IS the
// Windows npx and `supabase.exe`/`vercel.cmd` are how those CLIs install there.
eq(autopilotDecision("Bash", { command: "supabase.exe db reset" }), "deny", "PROVEN BYPASS: supabase.exe db reset");
eq(autopilotDecision("Bash", { command: "supabase.cmd db push" }), "deny", "supabase.cmd db push");
eq(autopilotDecision("Bash", { command: "supabase.exe migration repair 20260101" }), "deny", "supabase.exe migration repair");
eq(autopilotDecision("Bash", { command: "supabase.exe functions deploy send-email" }), "deny", "PROVEN BYPASS: supabase.exe edge deploy");
eq(autopilotDecision("Bash", { command: '"C:/Program Files/supabase/supabase.exe" db reset' }), "deny", "quoted supabase path");
eq(autopilotDecision("Bash", { command: "vercel.cmd deploy" }), "deny", "PROVEN BYPASS: vercel.cmd deploy");
eq(autopilotDecision("Bash", { command: "vercel.exe --prod" }), "deny", "vercel.exe --prod");
eq(autopilotDecision("Bash", { command: "rm.exe -rf build" }), "deny", "PROVEN BYPASS: rm.exe -rf");
eq(autopilotDecision("Bash", { command: "/bin/rm.exe -rf build" }), "deny", "a full path to rm.exe");
eq(autopilotDecision("Bash", { command: "del.exe /s C:/x" }), "deny", "del.exe /s");
// `rmdir`, `dropdb` and `createdb` are bare-word rules with nothing required
// after them, so an extension never broke them and they were left alone. Pinned
// so a future round does not "fix" what was never broken, or break it.
eq(autopilotDecision("Bash", { command: "rmdir.exe /s x" }), "deny", "rmdir.exe was already covered by the bare-word rule");
eq(autopilotDecision("Bash", { command: "dropdb.exe crx" }), "deny", "dropdb.exe likewise");
eq(autopilotDecision("Bash", { command: "createdb.exe crx" }), "deny", "createdb.exe likewise");
// …and their benign neighbours must not be swept in either.
eq(autopilotDecision("Bash", { command: "supabase db diff" }), "allow", "supabase db diff is read-only");
eq(autopilotDecision("Bash", { command: "supabase.exe status" }), "allow", "supabase.exe status is read-only");
eq(autopilotDecision("Bash", { command: "supabase-py db reset" }), "allow", "a different program whose name starts with supabase");
eq(autopilotDecision("Bash", { command: "npx supabase gen types typescript" }), "allow", "type generation is not a db reset");
eq(autopilotDecision("Bash", { command: "vercel-cli deploy" }), "allow", "vercel-cli is a different name");
eq(autopilotDecision("Bash", { command: "vercel.exe whoami" }), "allow", "vercel.exe whoami is read-only");
eq(autopilotDecision("Bash", { command: "charm -rf x" }), "allow", "a name ENDING in rm");
eq(autopilotDecision("Bash", { command: "npm run rm-cache" }), "allow", "an npm script named rm-cache");
eq(autopilotDecision("Bash", { command: "model /s" }), "allow", "a name ending in del");

// The over-denial trade is UNCHANGED in kind, only reached by more spellings. A
// differential sweep of 11,016 generated commands (2 binaries x 18 binary
// spellings x 18 option regions x the subcommand tails) reports 4,125 dangerous
// shapes newly denied, 240 benign commands newly denied, and ZERO newly allowed.
// All 240 are the option-region class already accepted above, now reached through
// a non-plain binary spelling — machine-checked, not eyeballed: for every one of
// the 240 the plain-binary twin ALREADY denied before this change. The count of
// genuinely new over-denials is 0. The plain-binary slice of the sweep drifts by
// 0 in either direction, which is what shows the option grammar was not touched.
eq(autopilotDecision("Bash", { command: "git.exe --no-pager log --grep push" }), "deny", "INHERITED over-denial: `git --no-pager log --grep push` already denied");
eq(autopilotDecision("Bash", { command: "git.exe -C/x stash push -m wip" }), "deny", "INHERITED over-denial: the attached-value twin already denied");
eq(autopilotDecision("Bash", { command: "git.exe -C /x stash push -m wip" }), "allow", "the COMMON detached form stays allowed at every binary spelling");
eq(autopilotDecision("Bash", { command: "git.exe log --grep push" }), "allow", "…as does the common log search");
eq(autopilotDecision("Bash", { command: 'git.exe commit -m "fix the push bug"' }), "allow", "a commit message naming push stays allowed at every binary spelling");
eq(autopilotDecision("Bash", { command: "git.exe status --short" }), "allow", "ordinary work with the native binary spelling stays allowed");
eq(autopilotDecision("Bash", { command: "gh.exe pr view 625" }), "allow", "gh.exe pr view stays allowed");
eq(autopilotDecision("Bash", { command: "gh.exe pr list" }), "allow", "gh.exe pr list stays allowed");
// The one KNOWN new over-denial shape the closing quote buys, stated rather than
// discovered later: a quoted word ENDING in the binary name satisfies BIN_TAIL.
// Its unquoted twin already denied before this change, so the guard is now
// consistent rather than newly blunt — and for a deny set that is the safe side.
eq(autopilotDecision("Bash", { command: 'grep "git" push.log' }), "deny", "ACCEPTED over-denial: a quoted word ending in the binary name");
eq(autopilotDecision("Bash", { command: "grep git push.log" }), "deny", "…whose UNQUOTED twin already denied before this change");

// Linear, not exponential. The option region nests quantifiers, so prove it does
// not backtrack catastrophically on a long non-matching command rather than
// assuming it: each iteration's only real branch point ends the loop.
{
  const many = "git " + Array.from({ length: 400 }, (_, i) => `-c k${i}=v${i} --flag${i} val${i}`).join(" ") + " status";
  const t0 = Date.now();
  eq(autopilotDecision("Bash", { command: many }), "allow", "400 global options + a benign subcommand is allowed");
  ok(Date.now() - t0 < 1000, "the option region does not backtrack catastrophically");
}

// ── overnight-arm handshake ──────────────────────────────────────────────
ok(intentFresh(JSON.stringify({ created: new Date().toISOString() })), "fresh intent recognized");
ok(!intentFresh(JSON.stringify({ created: new Date(Date.now() - 2 * 3600e3).toISOString() })), "stale intent ignored");
ok(!intentFresh("not json"), "malformed intent ignored");
eq(overnightGateDecision("Edit", { file_path: "src/pages/Foo.tsx" }), "deny-until-armed", "edit blocked until armed");
eq(overnightGateDecision("Bash", { command: "git add -A && git commit -m x" }), "deny-until-armed", "commit blocked until armed");
eq(overnightGateDecision("mcp__supabase__execute_sql", { query: "SELECT 1" }), "allow-through", "sql passes even before arm (Mason 2026-07-10)");
eq(overnightGateDecision("mcp__x__deploy_edge_function", {}), "deny-until-armed", "deploy still blocked until armed");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --hours 8" }, { projectDir: "/repo", cwd: "/repo" }), "allow-through", "arm command passes");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --off" }, { projectDir: "/repo", cwd: "/repo" }), "allow-through", "disarm command passes");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs" }, { projectDir: "/repo", cwd: "/repo" }), "allow-through", "bare arm invocation passes");
// Codex (exact-SHA review 2026-09-01) caught that the first anchor BROKE two
// documented commands. Hardening that silently removes a working command is a
// regression, not a win. `--status` is read-only and is exactly what a paused
// agent should be able to run; `--hours` is clamped to [0.25, 24] in the CLI, so
// fractional values are legitimate.
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --status" }, { projectDir: "/repo", cwd: "/repo" }), "allow-through", "documented read-only --status must not be blocked");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --hours 0.5" }, { projectDir: "/repo", cwd: "/repo" }), "allow-through", "fractional --hours is a documented value");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --hours 0.25" }, { projectDir: "/repo", cwd: "/repo" }), "allow-through", "the CLI's minimum --hours passes");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --status && npm run build" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "--status still cannot carry a chained command");
// Forward slashes are the ONLY accepted spelling. CI (Linux) caught the earlier
// backslash support as a real cross-platform bug: `\` is not a separator there, so
// `.claude\hooks\autopilot-arm.mjs` is one filename that never resolves to the
// trusted path. Normalizing would be worse — on Linux that literal filename is
// creatable, so normalizing would match it against the trusted path while Node ran
// the wrong file. Node accepts forward slashes on Windows, and that is the spelling
// the deny message and autopilot-arm.mjs's own header document.
eq(overnightGateDecision("PowerShell", { command: "node .claude\\hooks\\autopilot-arm.mjs --hours 8" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "the Windows backslash spelling is not accepted (one canonical shape)");
eq(overnightGateDecision("PowerShell", { command: "node .claude/hooks/autopilot-arm.mjs --hours 8" }, { projectDir: "/repo", cwd: "/repo" }), "allow-through", "PowerShell uses the same forward-slash spelling");
// Horizontal whitespace only: `\s` matches CR/LF, which are shell separators.
// Not exploitable here (the end anchor blocks an appended command), but the same
// mistake produced a real bypass in review-proof-guard's cd scanner (Codex, Low).
eq(overnightGateDecision("Bash", { command: "node\n.claude/hooks/autopilot-arm.mjs --off" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "a newline between tokens is not the documented command");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs\n--off" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "a newline before the flag is not the documented command");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --off\nnpm run build" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "a newline-appended second command is refused");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --off\r\nnpm run build" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "CRLF-appended second command is refused");
// CodeRabbit (PR #548): a bare substring test let the arm allowance ride on a
// chained command, so the OTHER half ran during the pause. Anchored now.
eq(overnightGateDecision("Bash", { command: "npm run build && node .claude/hooks/autopilot-arm.mjs --hours 8" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "PROVEN BYPASS: a build BEFORE the arm command must not ride it");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --hours 8 && npm run build" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "a build AFTER the arm command must not ride it");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --hours 8; rm -rf src" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "a semicolon-chained command must not ride it");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --hours 8 | tee x" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "a pipe must not ride it");
eq(overnightGateDecision("Bash", { command: "echo autopilot-arm.mjs > x.txt" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "merely naming the arm script does not unlock");
eq(overnightGateDecision("Bash", { command: "node attacker/autopilot-arm.mjs --hours 8" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "a planted same-basename arm script does not unlock");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --hours 8 --sneaky" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "an unknown extra flag is not the documented form");
// THE cwd-BINDING CASE (Codex gpt-5.6-sol, exact-SHA review 2026-09-02, HIGH).
// The command text alone proves nothing about WHICH file runs: a relative path
// resolves against the shell's directory. From a directory containing a planted
// .claude/hooks/autopilot-arm.mjs, the byte-identical sanctioned command would
// execute attacker JavaScript during the pause, past every tool-call guard.
// The allowance is bound to the trusted project root, so the SAME command text
// is allowed from the repo and denied from anywhere else.
const ARM8 = "node .claude/hooks/autopilot-arm.mjs --hours 8";
eq(overnightGateDecision("Bash", { command: ARM8 }, { projectDir: "/repo", cwd: "/repo" }), "allow-through", "the arm command is allowed FROM the trusted root");
eq(overnightGateDecision("Bash", { command: ARM8 }, { projectDir: "/repo", cwd: "/tmp/attacker" }), "deny-until-armed", "PROVEN BYPASS: the identical command from a planted cwd must be denied");
eq(overnightGateDecision("Bash", { command: ARM8 }, { projectDir: "/repo", cwd: "/repo/subdir" }), "deny-until-armed", "even a repo SUBDIR resolves to a different file, so it is denied");
eq(overnightGateDecision("Bash", { command: ARM8 }, { projectDir: "/repo" }), "deny-until-armed", "fails closed when the cwd is unknown");
eq(overnightGateDecision("Bash", { command: ARM8 }, { cwd: "/repo" }), "deny-until-armed", "fails closed when the trusted root is unknown");
eq(overnightGateDecision("Bash", { command: ARM8 }), "deny-until-armed", "fails closed with no context at all");
// An ABSOLUTE path is not an accepted form at all — the documented spelling is
// repo-relative, and one accepted shape means one slot to reason about. Both of
// these are denied regardless of where they point.
eq(overnightGateDecision("Bash", { command: "node /repo/.claude/hooks/autopilot-arm.mjs --hours 8" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "an absolute path is not the documented form, even to the real script");
eq(overnightGateDecision("Bash", { command: "node /evil/.claude/hooks/autopilot-arm.mjs --hours 8" }, { projectDir: "/repo", cwd: "/repo" }), "deny-until-armed", "an absolute path to a DIFFERENT script is denied");
// Traversal that lands back on the trusted file is fine; traversal that escapes is not.
eq(overnightGateDecision("Bash", { command: ARM8 }, { projectDir: "/repo", cwd: "/repo/x/.." }), "allow-through", "a cwd that normalizes to the root is allowed");
// There is deliberately NO shell escape from the latch (Mason, 2026-09-01).
//
// This assertion used to say "allow-through" and passed for months while the real
// stack denied the command: this gate is one of seven PreToolUse hooks, and
// review-proof-guard (matcher "*") refuses any destructive shell command touching
// .claude/session-state. That false green is why the deny message advertised a
// remedy nobody could run. A sanctioned `node scripts/clear-overnight-intent.mjs`
// escape was then built and REMOVED: two rounds of exact-SHA gpt-5.6-sol review
// found four HIGH bypasses (basename-only matching, then an exact-string allowance
// still unbound to the project root, plus a helper editable before invocation).
// Every fix was another text rule over a command string — the shape this repo has
// proven does not converge. The 45-minute expiry is the remedy; see
// overnight-intent-clear.test.mjs, which holds the deny message to that contract.
eq(overnightGateDecision("Bash", { command: "rm .claude/session-state/OVERNIGHT-INTENT.flag" }), "deny-until-armed", "rm form is NOT an escape hatch (review-proof-guard denies it downstream too)");
eq(overnightGateDecision("Bash", { command: "node scripts/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "the removed clear-script escape must NOT be reintroduced");
eq(overnightGateDecision("Bash", { command: "node attacker/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "a planted same-basename script is gated like anything else");
// The arm command stays the one command allowance, and it is the ONLY one.
eq(overnightGateDecision("Bash", { command: "npm run build" }), "deny-until-armed", "ordinary building still waits for the arm");
eq(overnightGateDecision("Bash", { command: "git status" }), "allow-through", "git status passes");
// Codex 2026-07-05 P2: read-only leading token + write redirect must NOT pass
eq(overnightGateDecision("Bash", { command: "cat src/a.ts > src/b.ts" }), "deny-until-armed", "cat with redirect blocked until armed");
eq(overnightGateDecision("Bash", { command: "echo x >> supabase/migrations/x.sql" }), "deny-until-armed", "echo append blocked until armed");
eq(overnightGateDecision("Bash", { command: "git log | tee notes.txt" }), "deny-until-armed", "tee blocked until armed");
eq(overnightGateDecision("Read", { file_path: "x" }), "allow-through", "read passes");
eq(overnightGateDecision("Write", { file_path: ".claude/session-state/notes.md" }), "allow-through", "session-state write passes");

// ── allow-set: ordinary loop actions are auto-approved ───────────────────
eq(autopilotDecision("Edit", { file_path: "src/pages/Foo.tsx" }), "allow", "normal edit allowed");
eq(autopilotDecision("Write", { file_path: "supabase/migrations/x.sql" }), "allow", "write migration file allowed (apply is separately denied)");
eq(autopilotDecision("Bash", { command: "npm run build" }), "allow", "npm build allowed");
eq(autopilotDecision("Bash", { command: "git add -A && git commit -m x" }), "allow", "commit allowed");
eq(autopilotDecision("Bash", { command: "node scripts/foo.mjs" }), "allow", "node script allowed");
eq(autopilotDecision("mcp__supabase__execute_sql", { query: "SELECT 1" }), "allow", "read sql allowed");
eq(autopilotDecision("Read", { file_path: "anything" }), "allow", "read allowed");

// ── flag expiry (fail-safe) ──────────────────────────────────────────────
const future = new Date(Date.now() + 3600e3).toISOString();
const pastT = new Date(Date.now() - 3600e3).toISOString();
ok(flagActive(JSON.stringify({ expires: future })).active === true, "unexpired flag active");
ok(flagActive(JSON.stringify({ expires: pastT })).active === false, "expired flag inactive");
ok(flagActive("not json").active === false, "malformed flag inactive");
ok(flagActive(JSON.stringify({ armed_at: "x" })).active === false, "no-expiry flag inactive");
ok(flagActive("").active === false, "empty flag inactive");

// ── LIVE: the hook's arming decision must depend ONLY on the flag in its OWN
// project dir, never on whatever AUTOPILOT.on happens to be armed in the ambient
// session. The hook reads $CLAUDE_PROJECT_DIR/.claude/session-state/AUTOPILOT.on,
// so earlier versions of this test failed whenever real autopilot was armed while
// it ran (the spawned hook saw the ambient flag and denied). We now point
// CLAUDE_PROJECT_DIR at throwaway temp dirs — one without a flag, one with a fresh
// active flag — so both directions are proven deterministically regardless of
// whether real autopilot is armed. (This is why commits used to fail while armed.)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(__dirname, "unattended-autopilot.mjs");
const resolvedTempRoot = `${path.resolve(tmpdir())}${path.sep}`;

function safeTempDir(testDir) {
  const resolvedTestDir = path.resolve(testDir);
  if (!resolvedTestDir.startsWith(resolvedTempRoot)) {
    throw new Error(`Refusing to use non-temp test directory: ${resolvedTestDir}`);
  }
  return resolvedTestDir;
}

function runHook(projectDir) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

// (1) flag ABSENT → hook is inert (emits nothing, defers to normal flow).
const noFlagDir = mkdtempSync(path.join(tmpdir(), "autopilot-noflag-"));
const resolvedNoFlagDir = safeTempDir(noFlagDir);
try {
  const r = runHook(noFlagDir);
  eq(r.status, 0, "hook exits 0 when flag absent");
  eq(r.stdout.trim(), "", "hook emits NOTHING when flag absent (off by default — defers to normal flow)");
} finally {
  rmSync(resolvedNoFlagDir, { recursive: true, force: true });
}

// (2) flag PRESENT + active → hook DENIES a deny-set command (rm -rf /). This is
// the counterpart proof: the same isolation lets us assert the armed behavior too.
const armedDir = mkdtempSync(path.join(tmpdir(), "autopilot-armed-"));
const resolvedArmedDir = safeTempDir(armedDir);
try {
  const armedStateDir = path.join(armedDir, ".claude", "session-state");
  mkdirSync(armedStateDir, { recursive: true });
  writeFileSync(
    path.join(armedStateDir, "AUTOPILOT.on"),
    JSON.stringify({ expires: new Date(Date.now() + 3600e3).toISOString() })
  );
  const r = runHook(armedDir);
  eq(r.status, 0, "hook exits 0 when armed");
  ok(/"permissionDecision":\s*"deny"/.test(r.stdout), "hook DENIES a deny-set command (rm -rf /) when armed");
} finally {
  rmSync(resolvedArmedDir, { recursive: true, force: true });
}

console.log(`autopilot-lib: ${pass} assertions passed`);
