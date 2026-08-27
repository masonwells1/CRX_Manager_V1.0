import { spawnSync } from "node:child_process";

import {
  selectExactMergedPr,
  selectTrustedCodeRabbitApproval,
  validateReviewInputs,
  validateTrustedDispatch,
} from "./production-migration-review-lib.mjs";

function git(args) {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8", shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error("git " + args[0] + " failed: " + (result.stderr || result.stdout || "unknown error").trim());
  return (result.stdout || "").trim();
}

async function githubJson(pathname) {
  const token = String(process.env.GH_TOKEN || "");
  const repository = String(process.env.GITHUB_REPOSITORY || "");
  if (!token || !repository) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
  const response = await fetch("https://api.github.com/repos/" + repository + pathname, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "crx-production-migration-review-gate",
    },
  });
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
  const reviews = await githubJson("/pulls/" + mergedPr.number + "/reviews?per_page=100");
  const codeRabbitApproval = selectTrustedCodeRabbitApproval(reviews, input);

  git(["fetch", "--no-tags", "origin", input.reviewedCommit]);
  const relativeMigration = "supabase/migrations/" + input.migrationName + ".sql";
  const reviewedEntry = git(["ls-tree", input.reviewedCommit, "--", relativeMigration]).split(/\s+/);
  const currentEntry = git(["ls-tree", input.expectedCommit, "--", relativeMigration]).split(/\s+/);
  if (reviewedEntry[0] !== "100644" || reviewedEntry[1] !== "blob" || currentEntry[0] !== "100644" || currentEntry[1] !== "blob") {
    throw new Error("migration must be a regular 100644 Git blob at both reviewed and current commits");
  }
  const reviewedBlob = git(["rev-parse", input.reviewedCommit + ":" + relativeMigration]);
  const currentBlob = git(["rev-parse", input.expectedCommit + ":" + relativeMigration]);
  if (reviewedBlob !== currentBlob) throw new Error("migration changed after its exact reviewed PR head");
  process.stdout.write(JSON.stringify({
    verified: true,
    pullRequest: mergedPr.number,
    reviewedBlob,
    codeRabbitReviewId: codeRabbitApproval.id,
    codeRabbitSubmittedAt: codeRabbitApproval.submitted_at,
  }) + "\n");
} catch (error) {
  process.stderr.write(String(error?.message || error) + "\n");
  process.exitCode = 1;
}
