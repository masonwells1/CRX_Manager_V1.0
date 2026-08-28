import {
  activeProtectedAutoMergePrNumbers,
  branchNameIsProtected,
  pullRequestHeadMatchesRepository,
} from "../.claude/hooks/codex-push-lib.mjs";

// Pure safety decision shared with land-pr's child-process update path. The
// outer hook sees only `node scripts/land-pr.mjs`, so the script must prove the
// destination branch is neither protected nor feeding any armed protected-base
// PR before it launches `gh pr update-branch` itself.
export function assessLandPrUpdate({ headRefName, headRepositoryOwner, autoMergeRequest, repository, openPullRequests }) {
  const destinationBranch = String(headRefName || "").trim();
  if (!destinationBranch) {
    return { allowed: false, reason: "GitHub did not report the PR head branch" };
  }
  if (branchNameIsProtected(destinationBranch)) {
    return { allowed: false, reason: `protected head branch ${destinationBranch}` };
  }
  if (autoMergeRequest !== null) {
    return { allowed: false, reason: "auto-merge is armed on the target PR" };
  }
  if (!pullRequestHeadMatchesRepository({ headRepositoryOwner }, repository)) {
    return { allowed: false, reason: "the target PR head belongs to a fork or its owner is unavailable" };
  }
  const armed = activeProtectedAutoMergePrNumbers(openPullRequests);
  if (armed.length > 0) {
    return { allowed: false, reason: `head branch ${destinationBranch} feeds armed protected-branch PR(s): ${armed.join(", ")}`, armed };
  }
  return { allowed: true, destinationBranch, armed: [] };
}
