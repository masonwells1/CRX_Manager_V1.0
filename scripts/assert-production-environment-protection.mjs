import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;

export function assertProductionEnvironmentProtection(environment, owner) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(owner))) throw new Error("repository owner login is invalid");
  const reviewerRules = (Array.isArray(environment?.protection_rules) ? environment.protection_rules : [])
    .filter((rule) => rule?.type === "required_reviewers");
  const reviewers = reviewerRules.length === 1 && Array.isArray(reviewerRules[0]?.reviewers)
    ? reviewerRules[0].reviewers.map((entry) => ({ type: entry?.type, login: entry?.reviewer?.login }))
    : [];
  const exactReviewer = reviewers.length === 1
    && reviewers[0].type === "User"
    && reviewers[0].login === owner;
  const oneAccountCanApprove = reviewerRules[0]?.prevent_self_review === false;
  const noAdminBypass = environment?.can_admins_bypass === false;
  const protectedBranchesOnly = environment?.deployment_branch_policy?.protected_branches === true
    && environment?.deployment_branch_policy?.custom_branch_policies === false;
  if (!exactReviewer || !oneAccountCanApprove || !noAdminBypass || !protectedBranchesOnly) {
    throw new Error("production-database must require only the repository owner, allow that one account to review, disallow admin bypass, and accept protected branches only");
  }
}

async function main() {
  const token = process.env.GH_TOKEN;
  const repository = String(process.env.GITHUB_REPOSITORY || "");
  const owner = String(process.env.GITHUB_REPOSITORY_OWNER || "");
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GH_TOKEN and an exact GITHUB_REPOSITORY are required");
  }
  const response = await fetch("https://api.github.com/repos/" + repository + "/environments/production-database", {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "crx-production-environment-gate",
    },
  });
  if (!response.ok) throw new Error("GitHub environment lookup failed with HTTP " + response.status);
  assertProductionEnvironmentProtection(await response.json(), owner);
  process.stdout.write("production-database environment protection is exact\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(String(error?.message || error) + "\n");
    process.exitCode = 1;
  });
}
