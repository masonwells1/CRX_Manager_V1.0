// MIGRATION LANDING GATE (Mason's autonomous-landing rule, 2026-09-26).
//
// The rule lets an agent apply a NON-destructive migration live with no in-chat
// ask — but only "under the same conditions" as an agent merge: CodeRabbit
// APPROVED the frozen final head, the exact-SHA Sol review of that head is clean,
// and every check is green. The migration's own reviewer + Sol proofs (the rest
// of migration-apply-lib.mjs) prove the SQL was reviewed; they say nothing about
// the pull request carrying it. Sol's exact-SHA review of the introducing PR
// (HIGH, 2026-09-26) found exactly that gap: a migration could reach production
// before the PR's final reviews. This binds the apply to them.
//
// The apply must come from a checkout of the PR's branch where:
//   * the migration file is committed at HEAD and unchanged in the worktree, so
//     the SQL being applied is the SQL in the reviewed commit;
//   * HEAD is the open PR's headRefOid, and the PR targets main;
//   * CodeRabbit's latest verdict is APPROVED on that exact head, nothing is
//     CHANGES_REQUESTED, and the newest run of every check is green (CLEAN);
//   * a fresh gpt-6-sol/high merge proof is bound to that head and to GitHub's
//     real base — the same proof the merge gates require.
// Anything unreadable fails CLOSED. The same predicates as the merge gates are
// imported, never re-derived.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  coderabbitApprovedHead,
  proofSearchDirs,
  proofValid,
  pullRequestChecksGreen,
  pullRequestReviewBlocked,
} from "./codex-push-lib.mjs";

const PROTECTED_BRANCH_RE = /^(?:main|master|production)$/i;

function refuse(why) {
  return {
    ok: false,
    reason:
      `MIGRATION LANDING GATE: ${why}\n\n` +
      `Under Mason's autonomous-landing rule (2026-09-26) a live apply happens only after the pull request ` +
      `that carries the migration is ready to merge: CodeRabbit APPROVED its exact head, every check is ` +
      `green, and a fresh exact-SHA gpt-6-sol proof (node scripts/write-codex-push-proof.mjs) is bound to that ` +
      `head. Apply from a clean checkout of the PR's branch with the migration committed, then merge right ` +
      `after. A destructive migration additionally needs Mason's in-chat yes.`,
  };
}

export function evaluateLandingGate({
  checkoutDir,
  migName,
  // sha256 of the EXACT SQL being transmitted. The committed migration at the
  // PR's head must hash to the same value (Sol HIGH, round 2): checking only that
  // a same-named file is committed let different SQL — e.g. a same-named file the
  // source resolver found in another checkout — ride on this PR's approvals.
  queryHash,
  now = Date.now(),
  runGit,
  runGh,
  listWorktrees,
} = {}) {
  const dir = String(checkoutDir || "");
  if (!dir) return refuse("the checkout the apply runs from is unknown (fail closed).");
  if (!/^[0-9a-f]{64}$/i.test(String(queryHash || ""))) {
    return refuse("the SQL being applied has no content hash to bind to the reviewed commit (fail closed).");
  }
  // Raw output: `git show` content must not be trimmed before it is hashed.
  const git = runGit || ((args) => execFileSync("git", args, {
    cwd: dir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  }));
  const gh = runGh || ((args) => execFileSync("gh", args, {
    cwd: dir, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024,
  }));

  const stem = path.basename(String(migName || "")).replace(/\.sql$/i, "");
  if (!stem) return refuse("the migration name is missing (fail closed).");
  const rel = `supabase/migrations/${stem}.sql`;

  let head;
  let branch;
  try {
    head = String(git(["rev-parse", "HEAD"])).trim();
    branch = String(git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch (error) {
    return refuse(`could not read this checkout's HEAD (${error?.message || error}).`);
  }
  if (!/^[0-9a-f]{40}$/i.test(head)) return refuse("this checkout's HEAD is not a commit.");
  if (!branch || branch === "HEAD" || PROTECTED_BRANCH_RE.test(branch)) {
    return refuse(`the apply runs from ${!branch || branch === "HEAD" ? "a detached HEAD" : `"${branch}"`}, not from the pull request's own branch.`);
  }

  let committed;
  try {
    committed = git(["show", `HEAD:${rel}`]);
  } catch {
    return refuse(`${rel} is not committed at HEAD ${head.slice(0, 12)}, so the SQL cannot be the reviewed SQL.`);
  }
  // The same normalization scripts/apply-migration-file.mjs applies before hashing
  // and transmitting (CRLF → LF), so equal bytes on disk always compare equal.
  const committedHash = createHash("sha256").update(String(committed).replace(/\r\n/g, "\n")).digest("hex");
  if (committedHash !== String(queryHash).toLowerCase()) {
    return refuse(`the SQL being applied is not byte-identical to ${rel} in the reviewed commit ${head.slice(0, 12)} (committed ${committedHash.slice(0, 12)}, transmitted ${String(queryHash).slice(0, 12)}).`);
  }
  let dirty;
  try {
    dirty = String(git(["status", "--porcelain", "--untracked-files=all", "--", rel])).trim();
  } catch (error) {
    return refuse(`could not confirm ${rel} is unchanged since HEAD (${error?.message || error}).`);
  }
  if (dirty) return refuse(`${rel} has uncommitted changes, so the SQL being applied is not the reviewed commit.`);

  let pr;
  try {
    pr = JSON.parse(gh(["pr", "view", branch, "--json",
      "number,state,baseRefName,baseRefOid,headRefOid,mergeStateStatus,reviewDecision,reviews,statusCheckRollup"]));
  } catch (error) {
    return refuse(`could not find or read the open pull request for branch "${branch}" (${error?.message || error}).`);
  }
  const number = pr?.number ? `#${pr.number}` : "the pull request";
  if (String(pr?.state || "").toUpperCase() !== "OPEN") return refuse(`${number} is not open.`);
  if (String(pr?.baseRefName || "").toLowerCase() !== "main") return refuse(`${number} does not target main.`);
  if (String(pr?.headRefOid || "").toLowerCase() !== head.toLowerCase()) {
    return refuse(`${number}'s head on GitHub (${String(pr?.headRefOid || "?").slice(0, 12)}) is not this checkout's HEAD (${head.slice(0, 12)}) — push, or pull, so the reviewed commit is the one applied.`);
  }
  if (pullRequestReviewBlocked(pr)) return refuse(`${number} has an unresolved CHANGES_REQUESTED review.`);
  if (!coderabbitApprovedHead(pr)) return refuse(`CodeRabbit has not APPROVED ${number}'s exact head ${head.slice(0, 12)}.`);
  if (!pullRequestChecksGreen(pr)) {
    return refuse(`${number} is not merge-ready: mergeStateStatus must be CLEAN and the newest run of every check green.`);
  }

  const baseSha = String(pr?.baseRefOid || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) return refuse(`GitHub returned an unusable base for ${number} (fail closed).`);
  let proven = false;
  for (const stateDir of proofSearchDirs(dir, listWorktrees || (() => git(["worktree", "list", "--porcelain"])))) {
    try {
      if (!existsSync(stateDir)) continue;
      for (const file of readdirSync(stateDir)) {
        if (!/^codex-review-[A-Za-z0-9_.-]+\.json$/.test(file)) continue;
        let data;
        try { data = JSON.parse(readFileSync(path.join(stateDir, file), "utf8")); } catch { continue; }
        if (proofValid(data, head, now, baseSha)) { proven = true; break; }
      }
    } catch { /* an unreadable directory holds no proof — keep looking */ }
    if (proven) break;
  }
  if (!proven) {
    return refuse(`no fresh gpt-6-sol/high proof is bound to ${number}'s head ${head.slice(0, 12)} and base ${baseSha.slice(0, 12)}.`);
  }
  return { ok: true, pullRequest: pr.number, head };
}
