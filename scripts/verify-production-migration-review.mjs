import { spawnSync } from "node:child_process";

import {
  collectAllPages,
  selectExactMergedPr,
  selectTrustedCodeRabbitApproval,
  validateNewMigrationGitBinding,
  validateReviewInputs,
  validateTrustedDispatch,
} from "./production-migration-review-lib.mjs";

function git(args) {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8", shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error("git " + args[0] + " failed: " + (result.stderr || result.stdout || "unknown error").trim());
  return (result.stdout || "").trim();
}

function gitSucceeds(args) {
  return spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8", shell: false, windowsHide: true }).status === 0;
}

async function githubJson(pathname) {
  const token = String(process.env.GH_TOKEN || "");
  const repository = String(process.env.GITHUB_REPOSITORY || "");
  if (!token || !repository) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch("https://api.github.com/repos/" + repository + pathname, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "crx-production-migration-review-gate",
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error("GitHub API request failed with HTTP " + response.status);
  return response.json();
}

try {
  const input = {
    expectedCommit: process.env.EXPECTED_COMMIT,
    reviewedCommit: process.env.REVIEWED_COMMIT,
    migrationName: process.env.MIGRATION_NAME,
    queryHash: process.env.QUERY_SHA256,
  };
  validateReviewInputs(input);
  validateTrustedDispatch({
    actor: process.env.GITHUB_ACTOR,
    owner: process.env.GITHUB_REPOSITORY_OWNER,
    eventName: process.env.GITHUB_EVENT_NAME,
  });
  if (git(["rev-parse", "HEAD"]) !== input.expectedCommit) throw new Error("checked-out HEAD is not the expected current-main commit");

  const pulls = await githubJson("/commits/" + input.reviewedCommit + "/pulls");
  const mergedPr = selectExactMergedPr(pulls, input);
  const reviews = await collectAllPages((page, pageSize) =>
    githubJson("/pulls/" + mergedPr.number + "/reviews?per_page=" + pageSize + "&page=" + page));
  const codeRabbitApproval = selectTrustedCodeRabbitApproval(reviews, input);

  git(["fetch", "--no-tags", "origin", input.reviewedCommit]);
  if (!gitSucceeds(["merge-base", "--is-ancestor", mergedPr.merge_commit_sha, input.expectedCommit])) {
    throw new Error("reviewed PR merge is not an ancestor of current main");
  }
  const relativeMigration = "supabase/migrations/" + input.migrationName + ".sql";
  const mergeBaseCommit = git(["rev-parse", mergedPr.merge_commit_sha + "^1"]);
  const baseEntry = git(["ls-tree", mergeBaseCommit, "--", relativeMigration]);
  const reviewedEntry = git(["ls-tree", input.reviewedCommit, "--", relativeMigration]);
  const mergedEntry = git(["ls-tree", mergedPr.merge_commit_sha, "--", relativeMigration]);
  const currentEntry = git(["ls-tree", input.expectedCommit, "--", relativeMigration]);
  const reviewedBlob = validateNewMigrationGitBinding({ baseEntry, reviewedEntry, mergedEntry, currentEntry });
  process.stdout.write(JSON.stringify({
    verified: true,
    pullRequest: mergedPr.number,
    reviewedMergeCommit: mergedPr.merge_commit_sha,
    reviewedBlob,
    codeRabbitReviewId: codeRabbitApproval.id,
    codeRabbitSubmittedAt: codeRabbitApproval.submitted_at,
  }) + "\n");
} catch (error) {
  process.stderr.write(String(error?.message || error) + "\n");
  process.exitCode = 1;
}
