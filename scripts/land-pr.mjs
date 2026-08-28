#!/usr/bin/env node
// land-pr.mjs — babysit a PR to the finish line so it cannot stall on BEHIND.
//
// Why (2026-08-08, PR #345 incident): GitHub branch protection requires a PR
// branch to be up to date with main. When a sibling PR merges first, the PR
// goes mergeStateStatus=BEHIND and sits forever. Our watchers only polled
// checks, so a fully green PR stalled overnight.
// The un-stick is one command: `gh pr update-branch <n>`. This script watches
// STATE (not just checks) and runs that command whenever the PR falls behind,
// re-running it if main moves again mid-wait.
//
// DELIBERATELY NEVER MERGES. Merging stays with `gh pr merge`, which the
// pr-merge-guard PreToolUse hook gates (green pipeline + Codex proof on risky
// diffs). A script that shelled `gh pr merge` internally would bypass that
// hook, so this one is scoped to update-branch and polling. Its child GitHub
// calls use the fixed sanitized CLI, and update-branch repeats the protected-
// head and stacked-auto-merge checks that the outer guard cannot see. Do not add
// an immediate merge call here.
//
// Usage:
//   node scripts/land-pr.mjs <pr-number> [--timeout-mins N] [--once]
//
// Intended flow:
//   every diff:      node scripts/land-pr.mjs N → updates branch, waits for
//                    CLEAN+green, then prints the immediate guarded merge steps.
//   risky diff:      also mints a fresh exact-head proof before the merge.
// Auto-merge is deliberately not used: a later risky commit could otherwise
// land after the local exact-head gate has already returned.
//   --once:          single pass — report state, run update-branch if BEHIND,
//                    exit without polling.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { riskyFiles, contentIsRisky, trustedGitHubCliInvocation } from "../.claude/hooks/codex-push-lib.mjs";
import { assessLandPrUpdate } from "./land-pr-lib.mjs";

const REPO = "masonwells1/CRX_Manager_V1.0";
const POLL_SECONDS = 60;

const args = process.argv.slice(2);
const prNumber = args.find((a) => /^\d+$/.test(a));
const once = args.includes("--once");
const timeoutIdx = args.indexOf("--timeout-mins");
const timeoutMins = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 45;
if (!prNumber || !Number.isFinite(timeoutMins) || timeoutMins <= 0) {
  console.error("Usage: node scripts/land-pr.mjs <pr-number> [--timeout-mins N] [--once]");
  process.exit(1);
}

const projectDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function gh(ghArgs) {
  const invocation = trustedGitHubCliInvocation(ghArgs);
  return execFileSync(invocation.executable, invocation.args, {
    cwd: projectDir,
    env: invocation.env,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function view() {
  return JSON.parse(gh([
    "pr", "view", prNumber, "--repo", REPO,
    "--json", "state,mergeStateStatus,statusCheckRollup,autoMergeRequest,baseRefName,headRefName,headRefOid,mergeCommit,url",
  ]));
}

function checksSummary(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  let pending = 0, failed = 0, ok = 0;
  for (const c of checks) {
    if (c?.__typename === "StatusContext") {
      const s = String(c.state || "").toUpperCase();
      if (s === "SUCCESS") ok++; else if (s === "PENDING") pending++; else failed++;
    } else if (c?.__typename === "CheckRun") {
      const status = String(c.status || "").toUpperCase();
      const conclusion = String(c.conclusion || "").toUpperCase();
      if (status !== "COMPLETED") pending++;
      else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) ok++;
      else failed++;
    }
  }
  return { pending, failed, ok, total: checks.length };
}

function classifyRisky() {
  const files = gh(["pr", "diff", prNumber, "--repo", REPO, "--name-only"])
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const risky = riskyFiles(files);
  if (risky.length > 0) return { risky: true, why: `risky file(s): ${risky.slice(0, 4).join(", ")}${risky.length > 4 ? ", ..." : ""}` };
  if (contentIsRisky(gh(["pr", "diff", prNumber, "--repo", REPO]))) {
    return { risky: true, why: "diff content matches a money/financial pattern" };
  }
  return { risky: false, why: "" };
}

function updateBranch(pr) {
  try {
    const headRefName = String(pr?.headRefName || "").trim();
    if (!headRefName) throw new Error("GitHub did not report the PR head branch");
    const openPullRequests = JSON.parse(gh([
      "pr", "list", "--repo", REPO, "--state", "open", "--head", headRefName,
      "--json", "number,autoMergeRequest,baseRefName",
    ]));
    const safety = assessLandPrUpdate({ headRefName, openPullRequests });
    if (!safety.allowed) {
      console.error(`[land-pr] Refusing update-branch: ${safety.reason}. Disable auto-merge on every listed PR or use an ordinary non-protected head branch, then retry.`);
      process.exit(1);
    }
    gh(["pr", "update-branch", prNumber, "--repo", REPO]);
    console.log(`[land-pr] PR was BEHIND main — ran 'gh pr update-branch ${prNumber}'; checks will re-run.`);
    return true;
  } catch (error) {
    const msg = String(error?.stderr || error?.message || error);
    console.error(`[land-pr] 'gh pr update-branch ${prNumber}' FAILED — likely a merge conflict with main. Resolve it on the branch, then re-run. Details: ${msg.trim()}`);
    process.exit(1);
  }
}

let riskiness = null; // classified lazily, re-checked never (diff won't change under us except via update-branch merge commits, which add no new files)
const deadline = Date.now() + timeoutMins * 60_000;
let lastLine = "";
// GitHub's mergeStateStatus is recomputed asynchronously: for a minute or two
// after a push it can report a STALE value (observed 2026-08-08 on PR #347 —
// DIRTY reported right after the conflict-resolution push landed, flipping to
// BLOCKED on the next poll). Require 3 consecutive DIRTY reads before treating
// the conflict as real.
let dirtyStreak = 0;

for (;;) {
  const pr = view();
  const state = String(pr.state || "").toUpperCase();
  if (state === "MERGED") {
    console.log(`[land-pr] MERGED ${pr.mergeCommit?.oid || ""}`.trim());
    process.exit(0);
  }
  if (state === "CLOSED") {
    console.error(`[land-pr] PR #${prNumber} is CLOSED without merging — nothing to land.`);
    process.exit(1);
  }

  const mss = String(pr.mergeStateStatus || "").toUpperCase();
  const { pending, failed, ok, total } = checksSummary(pr.statusCheckRollup);
  const armed = Boolean(pr.autoMergeRequest);
  const line = `state=${state} mergeState=${mss} checks=${ok}/${total} ok, ${pending} pending, ${failed} failed, autoMerge=${armed ? "armed" : "OFF"}`;
  if (line !== lastLine) { console.log(`[land-pr] ${line}`); lastLine = line; }

  if (armed) {
    gh(["pr", "merge", prNumber, "--repo", REPO, "--disable-auto"]);
    console.log(`[land-pr] Disabled pre-existing auto-merge for PR #${prNumber}; the final merge must be immediate and exact-head guarded.`);
    continue;
  }

  if (mss !== "DIRTY") dirtyStreak = 0;
  if (mss === "BEHIND") updateBranch(pr);
  else if (mss === "DIRTY") {
    dirtyStreak += 1;
    if (dirtyStreak >= 3 || once) {
      console.error(`[land-pr] PR #${prNumber} has merge conflicts with main (mergeStateStatus=DIRTY on ${dirtyStreak} consecutive poll(s)). Resolve them on the branch, then re-run.`);
      process.exit(1);
    }
    console.log(`[land-pr] DIRTY reported (${dirtyStreak}/3) — may be a stale post-push recompute; confirming before giving up.`);
  } else if (failed > 0 && pending === 0) {
    console.error(`[land-pr] ${failed} check(s) FAILED — fix and push, then re-run. ${pr.url || ""}`.trim());
    process.exit(1);
  } else if (mss === "CLEAN" || (mss === "BLOCKED" && pending === 0 && failed === 0)) {
    if (riskiness === null) riskiness = classifyRisky();
    if (riskiness.risky) {
      console.log(
        `[land-pr] PR #${prNumber} is green and up to date, and the diff is RISKY (${riskiness.why}).\n` +
        `This script will not merge it (by design). Land it now, immediately, with a fresh proof:\n` +
        `  1. gh pr checkout ${prNumber} && git fetch origin\n` +
        `  2. node scripts/write-codex-push-proof.mjs\n` +
        `  3. gh pr merge ${prNumber} --repo ${REPO} --squash --delete-branch --match-head-commit ${pr.headRefOid}   (NO --auto — proof is bound to this exact head+base)\n` +
        `If main moves before you merge, re-run this script first.`
      );
      process.exit(2);
    }
    console.log(
      `[land-pr] PR #${prNumber} is green, up to date, and non-risky. Merge this exact head now through the normal guard:\n` +
      `  gh pr merge ${prNumber} --repo ${REPO} --squash --delete-branch --match-head-commit ${pr.headRefOid}   (NO --auto; no extra Mason approval required)`
    );
    process.exit(2);
  }

  if (once) {
    console.log("[land-pr] --once: single pass complete.");
    process.exit(mss === "BEHIND" ? 0 : 3);
  }
  if (Date.now() > deadline) {
    console.error(`[land-pr] Timed out after ${timeoutMins} minutes without reaching MERGED. Last state: ${line}`);
    process.exit(1);
  }
  execFileSync(process.execPath, ["-e", `setTimeout(()=>{}, ${POLL_SECONDS * 1000})`], { stdio: "ignore" });
}
