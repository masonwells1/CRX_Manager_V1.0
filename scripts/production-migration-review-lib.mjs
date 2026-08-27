const STEM_RE = /^(\d{14})_((?![A-Za-z0-9_-]*\d{14})[A-Za-z0-9][A-Za-z0-9_-]*)$/;
const SHA1_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export function validateReviewInputs({ expectedCommit, reviewedCommit, migrationName, queryHash, commentId }) {
  if (!SHA1_RE.test(String(expectedCommit))) throw new Error("expected commit must be a full lowercase Git commit id");
  if (!SHA1_RE.test(String(reviewedCommit))) throw new Error("reviewed commit must be a full lowercase Git commit id");
  if (!STEM_RE.test(String(migrationName))) throw new Error("migration name must be an exact non-replayable timestamped stem");
  if (!SHA256_RE.test(String(queryHash))) throw new Error("query hash must be lowercase SHA-256");
  if (!/^[1-9][0-9]*$/.test(String(commentId))) throw new Error("review comment id must be a positive integer");
}

export function expectedAttestationBody({ reviewedCommit, migrationName, queryHash }) {
  return [
    "CRX_MIGRATION_REVIEW_ATTESTATION_V1",
    "reviewed_commit=" + reviewedCommit,
    "migration=" + migrationName,
    "query_sha256=" + queryHash,
    "model=gpt-5.6-sol",
    "reasoning_effort=high",
    "verdict=clean",
    "producer=trusted-migration-review-wrapper-v1",
  ].join("\n");
}

export function validateReviewComment(comment, expected) {
  if (comment?.user?.login !== expected.owner || comment?.author_association !== "OWNER") {
    throw new Error("review attestation comment must be authored by the repository owner");
  }
  if (comment?.body !== expected.body) throw new Error("review attestation comment body is not the exact canonical attestation");
  const issueNumber = String(comment?.issue_url || "").split("/").pop();
  if (issueNumber !== String(expected.prNumber)) throw new Error("review attestation comment is not attached to the merged migration PR");
}

export function selectExactMergedPr(pulls, { reviewedCommit, expectedCommit }) {
  const matching = (Array.isArray(pulls) ? pulls : []).filter((pr) =>
    pr?.state === "closed" && pr?.merged_at != null && pr?.base?.ref === "main" &&
    pr?.head?.sha === reviewedCommit && pr?.merge_commit_sha === expectedCommit);
  if (matching.length !== 1) throw new Error("reviewed commit is not the unique head of the PR merged as current main");
  return matching[0];
}
