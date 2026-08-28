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

export async function collectAllPages(fetchPage, pageSize = 100, maxPages = 100) {
  const rows = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const current = await fetchPage(page, pageSize);
    if (!Array.isArray(current)) throw new Error("paginated GitHub response must be an array");
    rows.push(...current);
    if (current.length < pageSize) return rows;
  }
  throw new Error("GitHub review pagination exceeded the fail-closed page limit");
}

export function selectExactMergedPr(pulls, { reviewedCommit }) {
  const matching = (Array.isArray(pulls) ? pulls : []).filter((pr) =>
    pr?.state === "closed" && pr?.merged_at != null && pr?.base?.ref === "main" &&
    pr?.head?.sha === reviewedCommit && SHA1_RE.test(String(pr?.merge_commit_sha)));
  if (matching.length !== 1) throw new Error("reviewed commit is not the unique head of one merged PR into main");
  return matching[0];
}

export function validateNewMigrationGitBinding({ baseEntry, reviewedEntry, mergedEntry, currentEntry }) {
  if (String(baseEntry || "").trim()) {
    throw new Error("migration must be newly added by the exact reviewed PR");
  }
  const parseRegularBlob = (entry) => {
    const match = /^100644 blob ([a-f0-9]{40})\t/.exec(String(entry || "").trim());
    if (!match) throw new Error("migration must be a regular 100644 Git blob at both reviewed and current commits");
    return match[1];
  };
  const reviewedBlob = parseRegularBlob(reviewedEntry);
  const mergedBlob = parseRegularBlob(mergedEntry);
  const currentBlob = parseRegularBlob(currentEntry);
  if (reviewedBlob !== mergedBlob || reviewedBlob !== currentBlob) {
    throw new Error("migration changed between its reviewed PR head, reviewed merge, and current main");
  }
  return reviewedBlob;
}
