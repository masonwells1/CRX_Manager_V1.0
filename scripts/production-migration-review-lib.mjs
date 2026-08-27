const STEM_RE = /^(\d{14})_((?![A-Za-z0-9_-]*\d{14})[A-Za-z0-9][A-Za-z0-9_-]*)$/;
const SHA1_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export function validateReviewInputs({ expectedCommit, reviewedCommit, migrationName, queryHash }) {
  if (!SHA1_RE.test(String(expectedCommit))) throw new Error("expected commit must be a full lowercase Git commit id");
  if (!SHA1_RE.test(String(reviewedCommit))) throw new Error("reviewed commit must be a full lowercase Git commit id");
  if (!STEM_RE.test(String(migrationName))) throw new Error("migration name must be an exact non-replayable timestamped stem");
  if (!SHA256_RE.test(String(queryHash))) throw new Error("query hash must be lowercase SHA-256");
}

export function validateTrustedDispatch({ actor, owner, eventName }) {
  if (eventName !== "workflow_dispatch" || !owner || actor !== owner) {
    throw new Error("migration release must be manually dispatched by the repository owner");
  }
}

export function selectTrustedCodeRabbitApproval(reviews, { reviewedCommit }) {
  const matching = (Array.isArray(reviews) ? reviews : []).filter((review) =>
    review?.user?.login === "coderabbitai[bot]" && review?.user?.type === "Bot" &&
    review?.commit_id === reviewedCommit && Number.isInteger(review?.id) &&
    Number.isFinite(Date.parse(review?.submitted_at)))
    .sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at) || left.id - right.id);
  const latest = matching.at(-1);
  if (!latest || latest.state !== "APPROVED") throw new Error("exact reviewed commit lacks a latest authenticated CodeRabbit approval");
  return latest;
}

export function selectExactMergedPr(pulls, { reviewedCommit, expectedCommit }) {
  const matching = (Array.isArray(pulls) ? pulls : []).filter((pr) =>
    pr?.state === "closed" && pr?.merged_at != null && pr?.base?.ref === "main" &&
    pr?.head?.sha === reviewedCommit && pr?.merge_commit_sha === expectedCommit);
  if (matching.length !== 1) throw new Error("reviewed commit is not the unique head of the PR merged as current main");
  return matching[0];
}
