// Pure helpers for codex-push-guard.mjs.

// Does the git command push (to main)? We fire on any `git push`; the hook then
// checks that HEAD is actually on main before doing anything.
export function isGitPush(cmd) {
  return /\bgit\s+push\b/.test(String(cmd || ""));
}

// A changed file is "risky" (needs an independent Codex verdict) when it touches
// migrations, edge functions, or obviously money/RLS-shaped code.
const RISKY_PATH_RES = [
  /(^|\/)supabase\/migrations\//i,
  /(^|\/)supabase\/functions\//i,
  /(^|\/)rls[_-]/i,
  /policy|grant/i,
];
export function riskyFiles(files) {
  return (files || []).filter((f) => RISKY_PATH_RES.some((re) => re.test(String(f || ""))));
}

// Validate a Codex-review proof object against the current HEAD and clock.
// Requires codex_ran===true, a clean/blockers-fixed verdict, head_sha === current
// HEAD (so a proof can't be reused after new commits), and a timestamp within 30min.
export function proofValid(data, headSha, nowMs) {
  if (!data || data.codex_ran !== true) return false;
  const v = String(data.verdict || "");
  if (v !== "clean" && v !== "blockers-fixed") return false;
  if (headSha && data.head_sha && data.head_sha !== headSha) return false;
  const t = data.timestamp ? Date.parse(data.timestamp) : NaN;
  if (!Number.isFinite(t)) return false;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  if (now - t > 30 * 60 * 1000) return false;
  return true;
}

export { RISKY_PATH_RES };
