// Pure decision logic for the overnight autopilot (unattended-autopilot.mjs).
// Isolated so the deny-set and flag-expiry logic can be unit-tested.
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

// Bash command shapes that must never be auto-approved: history rewrites,
// destructive deletes, pushes/deploys, DB resets, secret writes, hook bypass.
const DENY_BASH_RES = [
  /git\s+push\b/,                                  // no unattended push — Mason reviews in the morning
  /git\s+(?:push\s+)?(?:--force\b|-f\b|--force-with-lease\b)/,
  /git\s+reset\s+--hard\b/,
  /git\s+clean\s+-[A-Za-z]*[fdx]/,
  /--no-verify\b/,
  /\brm\s+-[A-Za-z]*r[A-Za-z]*f|\brm\s+-[A-Za-z]*f[A-Za-z]*r/, // rm -rf / -fr
  /\brmdir\b|\bdel\s+\/[sq]/i,
  /git\s+worktree\s+remove\b/,
  /git\s+branch\s+(?:-D|--delete\s+--force)\b/,
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
// checks, session-state writes, the arm command itself, and clearing the intent
// flag all pass; building/mutating waits for the arm.
const INTENT_ALLOW_TOOL_RE = /^(Read|Glob|Grep|TaskList|TaskGet|TaskCreate|TaskUpdate|WebFetch|WebSearch|AskUserQuestion|Skill)$/i;
const INTENT_ALLOW_BASH_RE = /^\s*(git\s+(status|diff|log|branch|show|fetch|worktree\s+list)|ls|dir|cat|head|tail|grep|rg|find|echo|node\s+--version)\b/;

// The ONLY sanctioned way out of a false-positive latch: scripts/clear-overnight-intent.mjs.
//
// The escape this hook's own deny message used to advertise — deleting the flag
// from the shell — never worked: review-proof-guard.mjs (matcher "*") refuses every
// destructive shell command touching .claude/session-state, and this gate blocks
// Write/Edit, so a session latched by mistake had no unblocked path left except
// arming autopilot — the exact failure the handshake exists to prevent. The old
// `/OVERNIGHT-INTENT\.flag/` substring allowance below was pure false assurance: it
// returned allow-through here while the real stack denied (proven live 2026-09-01,
// and asserted green by autopilot-lib.test.mjs the whole time).
//
// An EXACT-STRING allowlist, not a regex grammar — the same shape
// bash-safety-lib.mjs uses for MAINTENANCE_PRODUCER_ALLOWED_COMMANDS.
//
// The first draft of this allowance was an anchored regex over the command SHAPE:
// `<node><ws><anything>clear-overnight-intent.mjs`. Codex (gpt-5.6-sol, exact-SHA
// review 2026-09-01) proved it a HIGH bypass — it validated only the two BASENAMES,
// never the script's identity, so both of these returned allow-through:
//     node attacker/clear-overnight-intent.mjs --not-a-hands-free-run
//     "C:\attacker\node.exe" "C:\attacker\clear-overnight-intent.mjs" --not-a-hands-free-run
// Bash is globally allowed in settings.json and the other hooks inspect the visible
// command, not the JavaScript it executes, so any pre-existing attacker-controlled
// file with that basename became arbitrary code execution during the very pause the
// latch exists to enforce. The comment claimed "the allowlist is ONE FILE, not a
// command grammar" while the code implemented exactly such a grammar.
//
// A Set of exact strings has no slots to smuggle anything through: no directory
// prefix, no alternate interpreter, no quoting variant, no traversal, no glob, no
// chaining. Both canonical spellings of the one repo-root script are listed; the
// argument-free form is allowed so the script itself can print its refusal and the
// usage hint. Anything else waits for the arm. Deliberately NOT case-insensitive
// and NOT whitespace-normalized: the sanctioned command is a fixed literal, and
// every loosening is a slot.
const CLEAR_INTENT_ALLOWED_COMMANDS = new Set([
  "node scripts/clear-overnight-intent.mjs",
  "node scripts/clear-overnight-intent.mjs --not-a-hands-free-run",
  "node ./scripts/clear-overnight-intent.mjs",
  "node ./scripts/clear-overnight-intent.mjs --not-a-hands-free-run",
]);

export function isSanctionedClearIntentCommand(command) {
  return CLEAR_INTENT_ALLOWED_COMMANDS.has(String(command ?? "").trim());
}

export function overnightGateDecision(toolName, toolInput) {
  const name = String(toolName || "");
  if (INTENT_ALLOW_TOOL_RE.test(name)) return "allow-through";
  const input = toolInput || {};
  const cmd = typeof input.command === "string" ? input.command : "";
  if (cmd && (/autopilot-arm\.mjs/.test(cmd) || isSanctionedClearIntentCommand(cmd))) return "allow-through";
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

export { DENY_TOOLNAME_RE, DENY_BASH_RES, DENY_PATH_RE, CLEAR_INTENT_ALLOWED_COMMANDS };
