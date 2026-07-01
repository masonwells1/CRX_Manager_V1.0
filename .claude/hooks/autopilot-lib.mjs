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
const DENY_TOOLNAME_RE = /(apply_migration|deploy_edge_function|deploy_to_vercel|deploy_project|reset_branch|delete_branch|merge_branch|rebase_branch|pause_project|restore_project)/i;

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

export { DENY_TOOLNAME_RE, DENY_BASH_RES, DENY_PATH_RE };
