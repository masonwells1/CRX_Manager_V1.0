// Pure helpers for the stop/pause/scope "hold latch" (hold-latch-*.mjs).
//
// Safety model: the latch only affects tool calls between Mason saying "stop"
// and his NEXT message. Any non-hold prompt clears it, so it can never get stuck
// across turns — it just halts the current runaway work until he speaks again.

// Mason wants to halt / pause / is only scoping a future session.
const HOLD_RE = /((?<!(don'?t|won'?t|never|not) )(?<!(don'?t|won'?t) ever )\bstop\b|(?<!(don'?t|won'?t|never|not) )(?<!(don'?t|won'?t) ever )\bpause\b|\bhold (on|up|off)\b|cancel (all |the )?background|good stopping point|not (working|building) on (it|this|that) yet|just (getting|scoping|scope|the framework|framing)|only (scoping|planning|framing)|don'?t (build|code|implement|write code|start) yet|for a (fresh|future|new) session)/i;

// An affirmative "carry on" — not required to clear (any non-hold prompt clears),
// but used to phrase the confirmation.
const RESUME_RE = /\b(resume|go ahead|continue|keep going|proceed|start (building|working|now)|do it now|carry on)\b/i;

export function isHoldPhrase(prompt) {
  return HOLD_RE.test(String(prompt || ""));
}
export function isResumePhrase(prompt) {
  return RESUME_RE.test(String(prompt || ""));
}

// Under a hold, which tool calls count as "building" and should be blocked?
// Reads, tests, builds, and writes to session-state/scratchpad/SCOPE.md stay
// allowed so Claude can still answer, checkpoint, and write a plan.
const ALLOW_WRITE_PATH_RE = /(\.claude[\\/]session-state|scratchpad|SCOPE\.md$|PROGRESS|\.md$)/i;
const BUILD_BASH_RE = /(git\s+(commit|push|merge|rebase|cherry-pick|tag)\b|supabase\s+db|apply_migration|deploy|npm\s+publish|vercel\s)/i;
const MUTATE_TOOLNAME_RE = /(apply_migration|deploy_edge_function|deploy_to_vercel|deploy_project|merge_branch|reset_branch)/i;

export function isBuildActionUnderHold(toolName, toolInput) {
  const name = String(toolName || "");
  if (MUTATE_TOOLNAME_RE.test(name)) return true;

  const input = toolInput || {};

  if (/^(Write|Edit|NotebookEdit|MultiEdit)$/i.test(name)) {
    const fp = String(input.file_path || input.path || input.filePath || "");
    if (fp && ALLOW_WRITE_PATH_RE.test(fp)) return false; // notes / plan / md are fine
    return true; // building source = blocked under hold
  }

  const cmd = typeof input.command === "string" ? input.command : "";
  if (cmd && BUILD_BASH_RE.test(cmd)) return true;

  // execute_sql that writes (not a read/smoke)
  if (/execute_sql/i.test(name)) {
    const q = String(input.query || "");
    if (/\b(insert|update|delete|create|alter|drop|truncate)\b/i.test(q)) return true;
  }
  return false;
}

export { HOLD_RE, RESUME_RE };
