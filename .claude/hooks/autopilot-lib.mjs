// Pure decision logic for the overnight autopilot (unattended-autopilot.mjs).
// Isolated so the deny-set and flag-expiry logic can be unit-tested.

import path from "node:path";
//
// Autopilot is OFF unless an unexpired flag file exists. When ON, the hook
// AUTO-APPROVES tool calls so an overnight loop doesn't stall on permission
// prompts — EXCEPT the deny-set below, which stays blocked. The genuinely
// dangerous / prod-touching actions are protected here AND (independently) by
// settings.json permissions.deny + bash-safety/migration-apply-guard, so this is
// defense in depth, not the only line.

// Tool NAMES that must never be auto-approved during an unattended run: live
// prod mutations and branch/project lifecycle ops. Matched case-insensitively
// against the (possibly MCP-prefixed) tool name.
//
// NOTE (Mason, 2026-07-10, explicit + repeated): apply_migration and execute_sql
// are DELIBERATELY NOT in this set — Mason owns this live DB and does not want SQL
// or migration applies to gate during an unattended run. They remain protected by
// the migration-apply-guard hook (settled 2026-07-13: an armed apply needs a fresh
// hash-bound reviewer proof naming BOTH rls-security-reviewer and
// migration-drift-reviewer PLUS a fresh hash-bound codex-review-mig-<name>.json
// Codex proof, ≤30 min each; destructive migrations are refused outright while
// armed) and by settings.json permissions.deny. Deploys, pushes,
// branch/project lifecycle, and destructive file/db ops STAY blocked here.
const DENY_TOOLNAME_RE = /(deploy_edge_function|deploy_to_vercel|deploy_project|reset_branch|delete_branch|merge_branch|rebase_branch|pause_project|restore_project|push_files|create_or_update_file|delete_file|merge_pull_request|start_process|interact_with_process|write_file|edit_block|move_file|set_config_value)/i;

// `git` and `gh` accept GLOBAL OPTIONS BETWEEN the binary and the subcommand
// (`git -C <dir> push`, `gh -R <owner>/<repo> pr merge`). A bare `git\s+push`
// cannot span them, so those shapes were AUTO-APPROVED while armed — armed mode
// did not actually prevent pushing or merging (found 2026-09-05, by running the
// guard against a corpus rather than by reading it).
//
// The first fix ENUMERATED the option spellings (`-[cC]\s+\S+|--\S+` for git,
// `-[RFf]\s+\S+|--repo\s+\S+|--\S+` for gh) and so inherited that list's
// omissions — the name-listed-carve-out failure this repo keeps re-learning. Two
// shapes walked straight through it, both reproduced by EXECUTION (2026-09-07):
//
//   git -C "C:/CRX Manager/wt" push …    `\S+` stops at the first space, and CRX
//                                        worktrees sit under a path with a space
//   gh -Rmasonwells1/CRX_Ma… pr merge …  `-[RFf]\s+` demanded a DETACHED value;
//                                        attached short values are normal usage
//
// So the option region is described by SHAPE now, not by spelling. Two token
// classes and nothing else:
//
//   OPT_TOKEN  a shell word STARTING WITH `-`. Everything after the dash is just
//              "more word", so `--force`, `-Rowner/repo`, `--repo=owner/repo`,
//              `--git-dir="C:/CRX Manager/.git"` and `-C"a b"` are one token each
//              with no special case per spelling.
//   VAL_TOKEN  a shell word NOT starting with `-`: an option's detached value.
//
// A shell word is a run of quoted sections (which MAY contain spaces),
// backslash-escaped characters, and ordinary characters. That is what closes the
// quoting hole for every option at once instead of for the ones someone listed.
//
// This is still not `.*`, and the benign controls are why. The region ends at the
// first word that is neither an option nor an option's value — and that word is
// the subcommand. `git commit -m "fix the push bug"` opens with `commit`, which is
// not an OPT_TOKEN, so the region is EMPTY and the pattern then needs `push` where
// `commit` stands; the `push` inside the quoted message is never reachable from
// this `git`. Only a leading `-` opens the region at all. Both directions are
// asserted in autopilot-lib.test.mjs, including the two bypasses above.
//
// KNOWN, MEASURED over-denial — the whole class, not one example. When a global
// option does not consume a detached value (it takes none, or carries its value
// attached), the SUBCOMMAND is the next bare word and can be consumed as that
// option's value instead. The deny word two tokens later then matches:
//
//   git --no-pager log --grep push        `log` consumed as --no-pager's value
//   git -C/x stash push -m w              `stash` consumed as -C/x's value
//   git --git-dir=/x/.git stash push      same, attached long value
//
// A differential sweep of 1,728 generated commands (both binaries x 36 option
// regions x 24 subcommand tails) put this at 43 benign commands newly denied
// against 188 dangerous shapes newly closed. The common spellings are NOT among
// the 43 — `git -C /x stash push -m w` and `git log --grep push` both stay
// allowed, because a detached value or a non-option first word ends the region.
//
// Separating them needs per-option ARITY, which is another name list — the thing
// that just failed twice here. For a DENY set an occasional extra denial is the
// safe side of that trade, so it is taken deliberately and asserted below.
//
// `\s` (not `[^\S\r\n]`) is deliberate: these are DENY patterns, so treating a
// newline as separation makes them broader, never narrower.
const WORD_CHUNK = String.raw`(?:"[^"]*"|'[^']*'|\\[\s\S]|[^\s'"\\])`;
const OPT_TOKEN = String.raw`-${WORD_CHUNK}*`;
const VAL_TOKEN = String.raw`(?!-)${WORD_CHUNK}+`;
const GLOBAL_OPTS = String.raw`(?:\s+${OPT_TOKEN}(?:\s+${VAL_TOKEN})?)*`;

// The BINARY was the third axis of the same bug, and the widest one. `\bgit\b`
// followed by `${GLOBAL_OPTS}\s+` requires whitespace immediately after the NAME,
// so anything the shell still resolves to git — an extension, a closing quote —
// ended the match before the subcommand was ever considered. Reproduced by
// execution at e0bce4a82 (2026-09-07): `git.exe push origin HEAD`,
// `git.exe push --force`, `git.exe reset --hard origin/main` and
// `gh.exe pr merge 625 --squash` all returned "allow" while the bare spellings
// denied. `.exe` is the NATIVE binary spelling on the platform this repo is
// developed on, so this defeated the whole deny-set, not a corner of it.
//
// Listing the extensions (`\.exe|\.cmd|\.bat`) is the name-listed carve-out that
// already failed twice in the option region above — PATHEXT is user-configurable
// and `.com`, `.ps1`, a wrapper script with no extension at all, and whatever the
// next shell adds are not in anyone's list. So the binary is described by SHAPE:
//
//   NAME       the exact command name, with `\b` on both sides, so it cannot be
//              the tail or the head of a longer word (`gitfoo`, `github-cli`).
//   BIN_TAIL   what may sit between that name and the whitespace before the
//              subcommand, and it is exactly two things:
//                (a) an EXTENSION — a `.` followed by more of the same word. Any
//                    extension, because "what follows the dot" is not a list.
//                (b) a CLOSING QUOTE — a quoted command word ends with one, and
//                    `"C:/Program Files/Git/bin/git.exe" push` is the ordinary
//                    Windows spelling of a path that contains a space.
//
// A PATH PREFIX is deliberately in this same class and needs no new syntax: a
// path separator is a non-word character, so `\b` already opens on the final
// segment. `/usr/bin/git push`, `./git push`, `C:\Tools\git.exe push` and
// `"C:/Program Files/Git/bin/git.exe" push` are all matched at the basename —
// which is what the shell resolves too. That was verified by execution, not
// assumed; the pre-fix library already denied the unquoted, extensionless path
// forms for exactly this reason.
//
// It does NOT widen onto neighbours, and `\b` plus "an extension starts with a
// dot" is why. `git-crypt push`, `git-lfs push`, `github-release push`,
// `gitfoo push`, `npm run gitpush`, `gh-dash pr merge 1` and `ghq push` all stay
// allowed: `-` is not `.`, so BIN_TAIL does not open, and the required whitespace
// then lands on `-crypt`/`-lfs`/`-dash` instead of on the subcommand. Asserted in
// both directions in autopilot-lib.test.mjs.
//
// KNOWN over-denial, same trade as the option region: a quoted word that ENDS in
// `git`/`gh` now also satisfies BIN_TAIL's closing quote, so `grep "git" push.log`
// denies. The UNQUOTED twin `grep git push.log` already denied before this change,
// so this makes the guard consistent rather than newly blunt, and an extra denial
// is the safe side for a deny set.
const BIN_TAIL = String.raw`(?:\.${WORD_CHUNK}*)?["']?`;
const bin = (name) => String.raw`\b${name}\b${BIN_TAIL}`;
const git = (rest) => new RegExp(String.raw`${bin("git")}${GLOBAL_OPTS}\s+${rest}`);
const gh = (rest) => new RegExp(String.raw`${bin("gh")}${GLOBAL_OPTS}\s+${rest}`);

// Every OTHER name-anchored rule below had the same binary hole, for the same
// reason — the name is followed by a required `\s`, so an extension ends the match
// before the dangerous subcommand is read. `supabase.exe db reset`,
// `vercel.cmd deploy`, `npx.cmd supabase db reset` (npx.cmd IS the Windows npx)
// and `rm.exe -rf` all walked through. They take the same shape rule rather than
// a second, differently-shaped fix.
//
// `rmdir`, `dropdb` and `createdb` are deliberately NOT changed: they are bare
// `\b…\b` word matches with nothing required after them, so `rmdir.exe` already
// denied. Adding BIN_TAIL there would be noise, not safety. Asserted below.
//
// The `npx ` prefix is OPTIONAL in these three rules, which makes it inert: the
// rule already matches from `supabase` onward, so `npx -y supabase db reset` and
// `npx.cmd supabase db reset` denied before this change and deny after it —
// verified by execution, not reasoned about. It is given the same shape only so
// the three rules read consistently; do not mistake it for the thing doing the
// work, which is the `supabase` anchor.
const nameAnchored = (name, rest) => new RegExp(String.raw`${bin(name)}\s+${rest}`);
const NPX = String.raw`(?:${bin("npx")}\s+)?`;

// Bash command shapes that must never be auto-approved: history rewrites,
// destructive deletes, pushes/deploys, DB resets, secret writes, hook bypass.
const DENY_BASH_RES = [
  git(String.raw`push\b`),                         // no unattended push — Mason reviews in the morning
  git(String.raw`(?:push\s+)?(?:--force\b|-f\b|--force-with-lease\b)`),
  git(String.raw`reset\s+--hard\b`),
  git(String.raw`clean\s+-[A-Za-z]*[fdx]`),
  /--no-verify\b/,
  nameAnchored("rm", String.raw`(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)`), // rm -rf / -fr
  new RegExp(String.raw`\brmdir\b|${bin("del")}\s+\/[sq]`, "i"),
  git(String.raw`worktree\s+remove\b`),
  git(String.raw`branch\s+(?:-D|--delete\s+--force)\b`),
  git(String.raw`filter-(?:branch|repo)\b`),
  new RegExp(String.raw`${NPX}${bin("supabase")}\s+db\s+(?:push|reset)\b`),
  new RegExp(String.raw`${NPX}${bin("supabase")}\s+migration\s+repair\b`),
  new RegExp(String.raw`${NPX}${bin("supabase")}\s+functions\s+deploy\b`), // CLI edge deploy = same gate as the MCP tool
  gh(String.raw`pr\s+merge\b`),                    // lands on main around the push guard
  /\b(?:dropdb|createdb)\b/,
  nameAnchored("vercel", String.raw`(?:deploy|--prod|promote)\b`),
  /(?:^|[\s;&|>])\.env\b/,                         // touching .env
  /(?:>>?|tee)\s+['"]?[^\s'";|&]*\.env\b/,         // writing to .env
];

// Edit/Write targets that must never be auto-approved.
const DENY_PATH_RE = /(^|[\\/])\.env(\.|$)/i;

export function autopilotDecision(toolName, toolInput) {
  const name = String(toolName || "");
  if (DENY_TOOLNAME_RE.test(name)) return "deny";

  const input = toolInput || {};

  // Bash
  const cmd = typeof input.command === "string" ? input.command : "";
  if (cmd) {
    for (const re of DENY_BASH_RES) {
      if (re.test(cmd)) return "deny";
    }
  }

  // Edit/Write/file tools
  const filePath = input.file_path || input.path || input.filePath || "";
  if (filePath && DENY_PATH_RE.test(String(filePath))) return "deny";

  return "allow";
}

// ── Overnight-arm handshake ─────────────────────────────────────────────────
// When Mason asks for a hands-free run, autopilot-intent-reminder.mjs writes
// OVERNIGHT-INTENT.flag. If that flag is fresh but AUTOPILOT.on was never armed,
// building must not proceed on verbal reassurance — the exact repeated failure.

const INTENT_FRESH_MS = 45 * 60 * 1000;

export function intentFresh(content, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  let data;
  try { data = JSON.parse(String(content || "")); } catch { return false; }
  const t = data && data.created ? Date.parse(data.created) : NaN;
  if (!Number.isFinite(t)) return false;
  return now - t < INTENT_FRESH_MS;
}

// Which tool calls are blocked while intent-is-latched-but-unarmed. Reads, status
// checks, session-state writes and the arm command pass; building/mutating waits
// for the arm.
const INTENT_ALLOW_TOOL_RE = /^(Read|Glob|Grep|TaskList|TaskGet|TaskCreate|TaskUpdate|WebFetch|WebSearch|AskUserQuestion|Skill)$/i;
const INTENT_ALLOW_BASH_RE = /^\s*(git\s+(status|diff|log|branch|show|fetch|worktree\s+list)|ls|dir|cat|head|tail|grep|rg|find|echo|node\s+--version)\b/;

// THERE IS DELIBERATELY NO SHELL ESCAPE HATCH HERE (Mason, 2026-09-01).
//
// This gate used to allow any command containing `OVERNIGHT-INTENT.flag`, and the
// deny message told agents to delete that file from the shell. The command never
// worked: review-proof-guard.mjs (matcher "*") refuses every destructive shell
// command touching .claude/session-state. Since this gate also blocks Write and
// Edit, a session latched by MISTAKE — the latch fires on a prompt heuristic, so a
// prompt that merely DISCUSSES autopilot trips it — had no unblocked path left
// except arming autopilot, exactly the failure the handshake exists to prevent.
// autopilot-lib.test.mjs asserted that command was allowed, and passed for months,
// because it tested one hook of seven while the real chain denied it.
//
// A sanctioned `node scripts/clear-overnight-intent.mjs` escape was built and then
// REMOVED after two rounds of exact-SHA gpt-5.6-sol review found four HIGH
// bypasses in it: the allowance matched only BASENAMES (any planted file with that
// name ran), and then, once tightened to exact strings, it was still unbound to the
// project root (a planted `scripts/…` under a different cwd ran instead), while the
// helper itself could be edited locally before invocation. Every fix was a new
// text-matching rule on a command string — the shape this repo has already proven
// does not converge (the `git clean` carve-out closed after six rounds).
//
// The trade was rejected on its merits: the disease is a session paused for at most
// INTENT_FRESH_MS; the cure was a fresh way to EXECUTE CODE during precisely the
// window when execution is meant to be paused. The residual is deliberate — wait
// out the 45-minute expiry, or have Mason delete the flag himself (his shell is not
// gated by these hooks). Do NOT arm autopilot to get unblocked, and do NOT
// reintroduce a command allowance here without re-reading that review history.
// overnight-intent-clear.test.mjs holds the deny message to this contract.

// The arm command is the ONE command allowance, and it is anchored to a complete,
// standalone invocation. A bare `/autopilot-arm\.mjs/` substring test let the
// allowance ride on a chained command — `npm run build && node
// .claude/hooks/autopilot-arm.mjs --hours 8` returned allow-through, so the BUILD
// ran during the pause and the arm was merely along for the ride (CodeRabbit,
// PR #548). Anchored start-to-end with no shell metacharacters admitted, so a
// prefix, a suffix, or a chain cannot ride it.
//
// FORWARD SLASHES ONLY. An earlier revision also accepted the Windows backslash
// spelling, which CI caught as a genuine cross-platform bug: on Linux `\` is not a
// separator, so `.claude\hooks\autopilot-arm.mjs` is ONE filename and never
// resolves to the trusted path. Normalizing backslashes would be worse than
// rejecting them — on Linux a file literally named `.claude\hooks\autopilot-arm.mjs`
// is creatable, and normalizing would match it against the trusted path while Node
// executed the literal-backslash file instead. Node accepts forward slashes on
// Windows, and forward slashes are the spelling both the deny message and
// autopilot-arm.mjs's own header document, so this costs nothing: one canonical
// shape, one slot to reason about.
//
// HORIZONTAL whitespace only (`[^\S\r\n]`, not `\s`). `\s` matches CR and LF,
// which are shell command separators, so the anchor accepted multiline commands
// (Codex gpt-5.6-sol, 2026-09-02, Low). The end anchor stops a second command from
// being appended — `--off\nnpm run build` fails `[^\S\r\n]*$` — so this was not
// exploitable, but the same `\s`-swallows-newlines mistake DID produce a real
// bypass in review-proof-guard's cd scanner, where two invocations merged into
// one. That guard uses `[^\S\r\n]` for exactly this reason; match it here rather
// than rely on the anchors holding forever.
//
// The accepted arguments are exactly what autopilot-arm.mjs documents at its head:
// a bare invocation, `--hours <n>`, `--off`, and `--status`. A first draft of this
// anchor admitted only integer `--hours` and omitted `--status` entirely, which
// BROKE two documented commands — `--status` is read-only and is precisely what a
// paused agent should be able to run to see whether autopilot is armed (Codex
// gpt-5.6-sol, exact-SHA review 2026-09-01: "blocks the CLI's documented read-only
// --status command and fractional --hours values"). Hardening that quietly removes
// a working command is a regression, not a win. `--hours` is clamped to
// [0.25, 24] in the CLI, so fractional values are legitimate.
const ARM_CMD_RE =
  /^[^\S\r\n]*node[^\S\r\n]+(?:\.\/)?\.claude\/hooks\/autopilot-arm\.mjs(?:[^\S\r\n]+--hours[^\S\r\n]+\d{1,4}(?:\.\d{1,4})?|[^\S\r\n]+--off|[^\S\r\n]+--status)?[^\S\r\n]*$/;

// The relative path in ARM_CMD_RE resolves against the SHELL'S working directory,
// not the repo. Matching the text alone therefore proves nothing about WHICH file
// runs: from a directory containing a planted `.claude/hooks/autopilot-arm.mjs`,
// the sanctioned command executes that attacker file during the pause, and
// everything it does inside that process is past every tool-call guard (Codex
// gpt-5.6-sol, exact-SHA review 2026-09-02, HIGH — the same cwd-unbinding class
// that killed the clear-script escape).
//
// So the allowance is bound to the TRUSTED PROJECT ROOT, not to a spelling: the
// command's script argument must resolve to exactly
// <projectDir>/.claude/hooks/autopilot-arm.mjs. This is a structural identity
// check, which converges — unlike enumerating command spellings, which does not.
//
// Fails closed: no projectDir, or no cwd for a relative command, means the target
// cannot be proven and the command waits for the arm.
const ARM_SCRIPT_REL = [".cl" + "aude", "hooks", "autopilot-arm.mjs"];

export function isSanctionedArmCommand(command, context = {}) {
  const cmd = String(command ?? "");
  if (!ARM_CMD_RE.test(cmd)) return false;

  const projectDir = context.projectDir ? String(context.projectDir) : "";
  if (!projectDir) return false;

  // ARM_CMD_RE admits ONLY the documented repo-relative spelling, so the script
  // token is always relative and must be resolved against the shell's cwd. An
  // absolute path is not an accepted form at all — one shape, one slot.
  const m = /^\s*node\s+(\S+)/.exec(cmd);
  if (!m) return false;

  if (!context.cwd) return false;      // unknown cwd → target unprovable → fail closed

  const trusted = path.resolve(path.join(projectDir, ...ARM_SCRIPT_REL));
  return path.resolve(path.join(String(context.cwd), m[1])) === trusted;
}

// `context` carries the TRUSTED project root (and the tool call's cwd) so the arm
// allowance can be bound to a real file rather than to a string. Callers that omit
// it get the fail-closed path: no root, no arm exception.
export function overnightGateDecision(toolName, toolInput, context = {}) {
  const name = String(toolName || "");
  if (INTENT_ALLOW_TOOL_RE.test(name)) return "allow-through";
  const input = toolInput || {};
  const cmd = typeof input.command === "string" ? input.command : "";
  const cwd = context.cwd ?? input.cwd ?? input.workdir;
  if (/^(Bash|PowerShell)$/i.test(name) &&
      isSanctionedArmCommand(cmd, { projectDir: context.projectDir, cwd })) {
    return "allow-through";
  }
  if (/^(Bash|PowerShell)$/i.test(name)) {
    // Read-only leading token AND no write redirect: `cat > file` / `echo .. >> f`
    // / `... | tee f` still mutate files (Codex 2026-07-05) — those wait for the arm.
    const writesViaRedirect = />|\btee\b/.test(cmd);
    return INTENT_ALLOW_BASH_RE.test(cmd) && !writesViaRedirect ? "allow-through" : "deny-until-armed";
  }
  if (/^(Write|Edit|NotebookEdit)$/i.test(name)) {
    const fp = String(input.file_path || input.path || "");
    return /session-state/.test(fp) ? "allow-through" : "deny-until-armed";
  }
  // execute_sql / apply_migration intentionally omitted (Mason 2026-07-10): SQL and
  // migration applies do not gate on the overnight handshake either. Deploys still do.
  if (/deploy/i.test(name)) return "deny-until-armed";
  return "allow-through";
}

// Parse the flag file content and decide whether autopilot is active right now.
// Content is JSON: { "expires": "<ISO-8601>", ... }. A missing/unparseable/expired
// expiry => NOT active (fail safe: never auto-allow off a malformed flag).
export function flagActive(content, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  let data;
  try { data = JSON.parse(String(content || "")); } catch { return { active: false, reason: "unparseable" }; }
  const exp = data && data.expires ? Date.parse(data.expires) : NaN;
  if (!Number.isFinite(exp)) return { active: false, reason: "no-expiry" };
  if (now >= exp) return { active: false, reason: "expired", expires: data.expires };
  return { active: true, expires: data.expires };
}

export { DENY_TOOLNAME_RE, DENY_BASH_RES, DENY_PATH_RE, INTENT_FRESH_MS };
