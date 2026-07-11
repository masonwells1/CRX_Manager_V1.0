// Pure helpers for codex-push-guard.mjs.

// Does the git command push (to main)? We fire on any `git push`; the hook then
// checks whether the push actually TARGETS main before doing anything.
// Tolerates git GLOBAL options between `git` and `push` — `git -C <dir> push`,
// `git --git-dir=... push`, `git -c k=v push` — which used to bypass the gate
// entirely (observed 2026-07-10: a `git -C` push slipped past this guard).
const GIT_ARG = `(?:"[^"]*"|'[^']*'|\\S+)`;
const GIT_GLOBAL_OPTS =
  `(?:\\s+(?:-C\\s+${GIT_ARG}|-c\\s+${GIT_ARG}|--git-dir(?:=${GIT_ARG}|\\s+${GIT_ARG})|--work-tree(?:=${GIT_ARG}|\\s+${GIT_ARG})|--no-pager|--literal-pathspecs|--exec-path(?:=${GIT_ARG})?))*`;
const GIT_PUSH_RE = new RegExp(`\\bgit${GIT_GLOBAL_OPTS}\\s+push\\b([^;&|]*)`);
export function isGitPush(cmd) {
  return GIT_PUSH_RE.test(String(cmd || ""));
}

// Which LOCAL ref is this push landing on main? Returns:
//   null      — the push does not target main (gate stands down)
//   "DELETE"  — `push origin :main` (deleting main!) — the guard denies outright
//   a ref     — the SOURCE being pushed to main ("HEAD", "main", a branch name).
// The guard must diff/bind its Codex proof against THIS ref, not blindly HEAD
// (Codex 2026-07-05: `git push origin release:main` from another branch used to
// be diffed/proofed against HEAD — the wrong content).
export function mainPushSource(cmd, currentBranch) {
  const c = String(cmd || "");
  const m = c.match(GIT_PUSH_RE);
  if (!m) return null;
  const args = m[1].trim().split(/\s+/).filter(Boolean).filter((a) => !a.startsWith("-"));
  const refspecs = args.slice(1); // args[0] = remote, if present
  if (refspecs.length === 0) return currentBranch === "main" ? "HEAD" : null;
  for (const rs of refspecs) {
    const hasColon = rs.includes(":");
    const src = hasColon ? rs.split(":")[0].replace(/^\+/, "") : rs;
    const dst = (hasColon ? rs.split(":").pop() : rs).replace(/^refs\/heads\//, "");
    if (dst === "main") {
      if (hasColon) return src ? src.replace(/^refs\/heads\//, "") : "DELETE";
      return "main"; // bare `git push origin main` pushes local main
    }
    if (!hasColon && dst === "HEAD" && currentBranch === "main") return "HEAD";
  }
  return null;
}

// Back-compat boolean used by tests/other callers.
export function pushTargetsMain(cmd, currentBranch) {
  return mainPushSource(cmd, currentBranch) !== null;
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
