import {
  activeProtectedAutoMergePrNumbers,
  branchNameIsProtected,
} from "../.claude/hooks/codex-push-lib.mjs";

// Pure safety decision shared with land-pr's child-process update path. The
// outer hook sees only `node scripts/land-pr.mjs`, so the script must prove the
// destination branch is neither protected nor feeding any armed protected-base
// PR before it launches `gh pr update-branch` itself.
export function assessLandPrUpdate({ headRefName, openPullRequests }) {
  const destinationBranch = String(headRefName || "").trim();
  if (!destinationBranch) {
    return { allowed: false, reason: "GitHub did not report the PR head branch" };
  }
  if (branchNameIsProtected(destinationBranch)) {
    return { allowed: false, reason: `protected head branch ${destinationBranch}` };
  }
  const armed = activeProtectedAutoMergePrNumbers(openPullRequests);
  if (armed.length > 0) {
    return { allowed: false, reason: `head branch ${destinationBranch} feeds armed protected-branch PR(s): ${armed.join(", ")}`, armed };
  }
  return { allowed: true, destinationBranch, armed: [] };
}
