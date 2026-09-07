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
import { autopilotDecision, flagActive, intentFresh, overnightGateDecision, DENY_BASH_RES } from "./autopilot-lib.mjs";

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

// ── recursive delete: the ALIASES rm actually has (2026-09-07) ────────────
// PROVEN BYPASS. The rule was `-[A-Za-z]*r[A-Za-z]*f`, a literal lowercase `r`.
// GNU coreutils and BSD both document `-R` as an EXACT synonym of `-r`, so every
// line below returned ALLOW from this module on origin/main — including
// `rm -Rf /`. Measured, not reasoned: the deny/allow table is in the PR body and
// in docs/changelog.d/2026-09-07-autopilot-recursive-delete-aliases.md.
//
// The fix accepts the aliases rm DOCUMENTS. It is NOT a general case-fold of
// options: option letters are case-significant to a program, so `-F` is not a
// force flag and is not treated as one (asserted below).
const denyBash = (cmd, why) => eq(autopilotDecision("Bash", { command: cmd }), "deny", why);
const allowBash = (cmd, why) => eq(autopilotDecision("Bash", { command: cmd }), "allow", why);

// (a) the -R case variant, every ordering
denyBash("rm -Rf build", "PROVEN BYPASS: -R is an exact synonym of -r");
denyBash("rm -fR build", "PROVEN BYPASS: -fR");
denyBash("rm -RF build", "PROVEN BYPASS: -RF");
denyBash("rm -Rf /", "PROVEN BYPASS: rm -Rf / deletes everything and returned allow");
denyBash("rm -Rf ~/CRX_Manager", "PROVEN BYPASS: -Rf on the repo itself");
// (b) separated flags — the lowercase canonical spelling ALSO bypassed
denyBash("rm -r -f build", "PROVEN BYPASS: separated -r -f");
denyBash("rm -R -f build", "PROVEN BYPASS: separated -R -f");
denyBash("rm -f -r build", "PROVEN BYPASS: separated -f -r");
denyBash("rm -f -R build", "PROVEN BYPASS: separated -f -R");
// (c) long forms, including GNU's unambiguous-prefix abbreviation
denyBash("rm --recursive --force build", "PROVEN BYPASS: long forms");
denyBash("rm --force --recursive build", "PROVEN BYPASS: long forms reversed");
denyBash("rm -r --force build", "PROVEN BYPASS: mixed short/long");
denyBash("rm -R --force build", "PROVEN BYPASS: mixed -R/long");
denyBash("rm --recursive -f build", "PROVEN BYPASS: long recursive + short force");
denyBash("rm --rec -f build", "GNU getopt accepts any unambiguous long-option prefix");
denyBash("rm --r build", "--r is unambiguous for --recursive among rm's long options");
// (d) clusters with unrelated letters mixed in
denyBash("rm -Rfv build", "PROVEN BYPASS: -R inside a cluster");
denyBash("rm -vRf build", "PROVEN BYPASS: -R mid-cluster");
denyBash("rm -dRf build", "PROVEN BYPASS: -d before -R");
denyBash("rm -fvR build", "the recursive letter need not be first or last in a cluster");
// (e) the binary spelling. A NAME is case-insensitive on Windows and the .exe
// suffix is optional — unlike an option letter, which is not.
denyBash("/bin/rm -Rf build", "PROVEN BYPASS: path-qualified binary");
denyBash("rm.exe -rf build", "PROVEN BYPASS: rm.exe never matched `rm` + whitespace at all");
denyBash("RM.EXE -rf build", "Windows resolves a binary NAME case-insensitively");
denyBash("C:/Program Files/Git/usr/bin/rm.exe -rf build", "absolute Windows path to rm.exe");
denyBash("sudo rm -Rf /var", "sudo prefix");
denyBash("xargs rm -Rf", "rm reached through xargs");
// (f) DELIBERATE WIDENING: recursive alone, with no -f. `-f` only suppresses
// prompts; in a non-interactive agent shell `rm -r dir` deletes the tree anyway,
// so requiring both letters was never what made the command safe.
denyBash("rm -r build", "recursive without force is still a recursive delete");
denyBash("rm -R build", "recursive without force, -R spelling");
denyBash("rm --recursive build", "recursive without force, long spelling");
// (g) over-denial controls — the fix must not case-fold options generally
allowBash("rm -F build", "-F is NOT an rm force flag; inventing that alias would over-deny");
allowBash("rm -f file.txt", "force without recursive is a single-file delete");
allowBash("rm --force file.txt", "long force without recursive stays allowed");
allowBash("rm file.txt", "an ordinary delete stays allowed");
allowBash("rm ./my-rf-dir", "a hyphen INSIDE a token is not an option");
allowBash("rm foo.txt && ls -r", "the option scan must not leak past a shell separator");
allowBash('git commit -m "remove -Rf from the docs"', "text that merely MENTIONS -Rf is not a delete");
allowBash("npm run build", "ordinary build");
allowBash("ls -la", "benign control");

// ── PowerShell recursive delete (the primary shell in this environment) ───
// `ri`, `rd`, `rmdir`, `del` and `erase` are all built-in ALIASES of Remove-Item,
// and PowerShell accepts any unambiguous parameter prefix, so `-Rec` is `-Recurse`.
denyBash("Remove-Item -Recurse -Force C:/build", "PowerShell recursive delete");
denyBash("Remove-Item -Force -Recurse C:/build", "PowerShell, parameters reversed");
denyBash("remove-item -recurse C:/build", "PowerShell cmdlet names are case-insensitive");
denyBash("ri -Recurse -Force C:/build", "the `ri` alias of Remove-Item");
denyBash("rd -Recurse C:/build", "the `rd` alias of Remove-Item");
denyBash("Remove-Item -Rec C:/build", "an unambiguous PowerShell parameter prefix");
allowBash("Get-ChildItem -Recurse C:/src", "-Recurse on a READ cmdlet must stay allowed");
allowBash("gci -Recurse", "the gci alias of Get-ChildItem is not a delete");

// ── cmd.exe aliases and switch ordering ──────────────────────────────────
denyBash("rd /s /q build", "`rd` is the documented cmd.exe alias of `rmdir`");
denyBash("RD /S /Q build", "cmd.exe switches are case-insensitive");
denyBash("erase /s build", "`erase` is the documented cmd.exe alias of `del`");
denyBash("del /f /s /q build", "PROVEN BYPASS: the old rule only read the token right after `del`");

// ── sibling rules with the same defect shape ─────────────────────────────
// Each of these knew ONE spelling of a destructive option and missed the
// documented equivalents.
denyBash("git clean --force -d", "PROVEN BYPASS: git clean long-form --force");
denyBash("git clean --force", "PROVEN BYPASS: git clean --force alone");
denyBash("git clean -fq", "the destructive letter need not be last in the cluster");
denyBash("git clean -X", "-X is a distinct destructive flag, not a case variant of -x");
allowBash("git clean -n", "a dry run stays allowed");
allowBash("git clean --dry-run", "a long-form dry run stays allowed");
denyBash("git branch -Df feature", "PROVEN BYPASS: -D inside a cluster");
denyBash("git branch -vD feature", "PROVEN BYPASS: -D after another letter");
denyBash("git branch -d -f feature", "PROVEN BYPASS: -d -f is what -D is shorthand FOR");
denyBash("git branch -f -d feature", "PROVEN BYPASS: reversed");
denyBash("git branch --force --delete feature", "PROVEN BYPASS: long forms reversed");
denyBash("git branch -d --force feature", "PROVEN BYPASS: mixed short/long");
denyBash("git branch --delete -f feature", "PROVEN BYPASS: mixed long/short");
allowBash("git branch --delete feature", "a NON-force delete keeps its prior verdict");
allowBash("git branch -a", "listing branches stays allowed");
allowBash("git branch -m old new", "renaming stays allowed");
denyBash("git commit -n -m x", "PROVEN BYPASS: -n is git-commit's own short form of --no-verify");
denyBash("git commit -m x -n", "PROVEN BYPASS: -n in trailing position");
allowBash("git commit -mn 'msg'", "`-mn` is the MESSAGE \"n\", not a flag — must not over-deny");
allowBash("git commit --amend --no-edit", "--no-edit is not --no-verify");
allowBash("git commit -m x", "an ordinary commit stays allowed");

// The old rule must be GONE from the live deny set, not merely supplemented: a
// leftover lowercase-r-then-f pattern would keep passing every assertion above
// while still describing how the command is TYPED rather than what it ACCEPTS.
// Asserted against the imported regexes, not the file text, so the explanatory
// comment that quotes the old pattern cannot satisfy it.
ok(
  !DENY_BASH_RES.some((re) => /\[A-Za-z\]\*r\[A-Za-z\]\*f/.test(re.source)),
  "the literal lowercase-r recursive-delete rule is gone from the live deny set"
);
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

function runHook(projectDir, command = "rm -rf /") {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
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
  // The SAME live proof for the spelling that bypassed. Asserting only against
  // the library would leave the whole hook process untested for this case, and a
  // library-only green is exactly how this file once certified a command the real
  // chain refused (see the overnight-intent note above).
  for (const bypass of ["rm -Rf /", "rm -R -f /", "rm --recursive --force /", "rm.exe -rf /"]) {
    const rb = runHook(armedDir, bypass);
    eq(rb.status, 0, `hook exits 0 for ${bypass}`);
    ok(/"permissionDecision":\s*"deny"/.test(rb.stdout), `LIVE HOOK denies the proven bypass: ${bypass}`);
  }
  // …and the live hook must still auto-approve ordinary work while armed.
  const rAllow = runHook(armedDir, "npm run build");
  ok(/"permissionDecision":\s*"allow"/.test(rAllow.stdout), "LIVE HOOK still auto-approves an ordinary build when armed");
} finally {
  rmSync(resolvedArmedDir, { recursive: true, force: true });
}

console.log(`autopilot-lib: ${pass} assertions passed`);
