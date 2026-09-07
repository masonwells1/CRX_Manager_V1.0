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

// ── OPTION-SCAN IDIOM (2026-09-07) ──────────────────────────────────────────
// Several rules below need "this command carries option X somewhere in its
// argument list". Spelling ONE ordering by hand is the defect this file was
// caught by: the recursive-delete rule was literally `-[A-Za-z]*r[A-Za-z]*f`,
// which encodes how `rm -rf` is USUALLY TYPED, not what `rm` ACCEPTS. Measured
// against this module on origin/main immediately before this change:
//
//   deny   rm -rf /            allow  rm -Rf /                 <- catastrophic
//   deny   rm -rf build        allow  rm -r -f build           <- separated
//   deny   rm -rfv build       allow  rm --recursive --force build
//   deny   /usr/bin/rm -rf x   allow  /bin/rm -Rf x
//   deny   rm -vrf build       allow  rm -vRf build
//
// The idiom is `<head>(?:<ws><token>)*?<ws><option>`: walk whole whitespace-
// delimited tokens forward from the command head and require the option to sit
// at a token START. Tokens exclude the shell separators `;`, `&`, `|`, `)`, so
// the scan cannot leak into the NEXT command (`rm foo && ls -r` does not match),
// and every step ends on whitespace, so a hyphen INSIDE a token is not read as
// an option (`rm ./my-rf-dir` stays allow).
//
// This is deliberately NOT a general case-fold of options. Option letters are
// case-SIGNIFICANT to a program — `-f` and `-F` are different flags to many
// tools — so only aliases the program itself documents are accepted:
//
//   * `rm` documents `-r`, `-R` and `--recursive` as exact synonyms (GNU
//     coreutils and BSD/macOS alike). That synonym is the whole bug.
//   * GNU getopt (and git's parse-options) accept any UNAMBIGUOUS PREFIX of a
//     long option, so `rm --rec` really is `--recursive`.
//   * `rm --recursive -F` therefore stays ALLOW: `-F` is not an `rm` flag at all,
//     and inventing one would over-deny.
//
// Binary NAMES are the one thing that IS case-insensitive, because Windows
// resolves them that way and the executable suffix is optional — `rm`, `RM` and
// `rm.exe` are the same program, so the head accepts all three.
const WS = String.raw`[^\S\r\n]+`;
const OPT_SCAN = String.raw`(?:${WS}[^\s;&|)]+)*?${WS}`;

// A short-option CLUSTER carrying any of `letters` anywhere in it (`-r`, `-rf`,
// `-vrf`). The trailing `[A-Za-z]*` matters: without it the letter would have to
// be LAST, and `git clean -fq` would slip through.
const cluster = (letters) => String.raw`-[A-Za-z]*[${letters}][A-Za-z]*(?=$|\s)`;

// A long option written in full or as any unambiguous prefix: prefixChain("recursive")
// accepts --r, --re, --rec … --recursive, and nothing longer or different.
// `--format` does NOT match prefixChain("force"), because the chain must end at a
// token boundary.
function prefixChain(word) {
  let inner = "";
  for (let i = word.length - 1; i >= 1; i--) inner = `(?:${word[i]}${inner})?`;
  return `--${word[0]}${inner}(?=$|[\\s=])`;
}

// `rm` / `RM` / `rm.exe`, path-qualified or not.
const RM_HEAD = String.raw`\b[rR][mM](?:\.(?:[eE][xX][eE]|[cC][mM][dD]|[bB][aA][tT]))?`;

// A recursive `rm` in ANY spelling. Note this denies a recursive delete whether
// or not `-f` is also present: `-f` only suppresses prompts, and in a
// non-interactive agent shell `rm -r dir` deletes the tree with no prompt at all,
// so requiring BOTH letters was never what made the command safe. That is a
// deliberate widening beyond the old rule, and it applies only while autopilot is
// ARMED — an unarmed session is unaffected by this module.
const RM_RECURSIVE_RE = new RegExp(
  RM_HEAD + OPT_SCAN + `(?:${prefixChain("recursive")}|${cluster("rR")})`
);

// PowerShell is the primary shell in this environment and `Remove-Item -Recurse`
// is its recursive delete; `ri`, `rd`, `rmdir`, `del` and `erase` are all built-in
// ALIASES of Remove-Item, and PowerShell accepts any unambiguous parameter prefix,
// so `-r` is `-Recurse`. Scoped to the removal cmdlet, so `Get-ChildItem -Recurse`
// stays allow.
const PS_RECURSIVE_REMOVE_RE = new RegExp(
  String.raw`\b(?:Remove-Item|ri|rd|rmdir|del|erase)\b` + OPT_SCAN +
    String.raw`-[Rr](?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?=$|[\s:])`,
  "i"
);

// cmd.exe: `rd` is the documented alias of `rmdir` and `erase` of `del`, and the
// switches may appear in any order — `del /f /s /q` bypassed the old rule, which
// only inspected the token immediately after `del`. Switches are case-insensitive
// in cmd.exe, and `\b` keeps a POSIX path operand (`del /srv/x`) from matching.
const CMD_RECURSIVE_DELETE_RE = new RegExp(
  String.raw`\b(?:rmdir|rd|del|erase)\b` + OPT_SCAN + String.raw`\/[sq]\b`,
  "i"
);

// Bash command shapes that must never be auto-approved: history rewrites,
// destructive deletes, pushes/deploys, DB resets, secret writes, hook bypass.
const DENY_BASH_RES = [
  /git\s+push\b/,                                  // no unattended push — Mason reviews in the morning
  /git\s+(?:push\s+)?(?:--force\b|-f\b|--force-with-lease\b)/,
  /git\s+reset\s+--hard\b/,
  // `git clean --force` (and `--force -d`) bypassed the old fixed-position rule,
  // which only looked at the FIRST token after `clean`. `-X` is a distinct flag
  // from `-x`, not a case variant, and is destructive in its own right.
  new RegExp(String.raw`git\s+clean\b` + OPT_SCAN + `(?:${prefixChain("force")}|${cluster("fdxX")})`),
  /--no-verify\b/,
  // `-n` is git-commit's own documented short form of `--no-verify`. Matched only
  // as a STANDALONE token: inside a cluster a preceding value-taking option
  // swallows the rest (`git commit -mn` is the message "n", not a flag), so a
  // naive cluster match would deny an ordinary commit.
  new RegExp(String.raw`git\s+commit\b` + OPT_SCAN + String.raw`-n(?=$|\s)`),
  RM_RECURSIVE_RE,
  PS_RECURSIVE_REMOVE_RE,
  CMD_RECURSIVE_DELETE_RE,
  // Kept verbatim from the pre-2026-09-07 rule so this change is strictly
  // ADDITIVE. CMD_RECURSIVE_DELETE_RE's `\b` deliberately spares a POSIX path
  // operand (`del /srv/foo`), which the old rule denied as a side effect of
  // matching `/s` inside `/srv`. Narrowing an existing deny is not this change's
  // job, so both run and the union is what the caller sees.
  /\brmdir\b|\bdel\s+\/[sq]/i,
  /git\s+worktree\s+remove\b/,
  // Force-delete of a branch. `-D` is the documented shorthand for
  // `--delete --force`, but the equivalents `-Df`, `-d -f`, `-f -d`,
  // `--force --delete` and `--delete -f` all reach the same place, and the old
  // rule knew only two of them.
  new RegExp(String.raw`git\s+branch\b` + OPT_SCAN + cluster("D")),
  new RegExp(
    String.raw`git\s+branch\b` +
      `(?=${OPT_SCAN}(?:${prefixChain("delete")}|${cluster("d")}))` +
      `(?=${OPT_SCAN}(?:${prefixChain("force")}|${cluster("f")}))`
  ),
  /git\s+filter-(?:branch|repo)\b/,
  /(?:npx\s+)?supabase\s+db\s+(?:push|reset)\b/,
  /(?:npx\s+)?supabase\s+migration\s+repair\b/,
  /(?:npx\s+)?supabase\s+functions\s+deploy\b/,    // CLI edge deploy = same gate as the MCP tool
  /\bgh\s+pr\s+merge\b/,                           // lands on main around the push guard
  /\b(?:dropdb|createdb)\b/,
  /\bvercel\s+(?:deploy|--prod|promote)\b/,
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
