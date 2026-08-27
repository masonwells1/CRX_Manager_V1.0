const STEM_RE = /^(\d{14})_((?![A-Za-z0-9_-]*\d{14})[A-Za-z0-9][A-Za-z0-9_-]*)$/;
const SHA1_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REQUIRED_REVIEWERS = ["rls-security-reviewer", "migration-drift-reviewer"];
const CLEAN_TOKEN_RE = /^CODEX_PROOF_VERDICT:\s*CLEAN\s*$/gm;

export function validateReviewInputs({ expectedCommit, reviewedCommit, migrationName, queryHash }) {
  if (!SHA1_RE.test(String(expectedCommit))) throw new Error("expected commit must be a full lowercase Git commit id");
  if (!SHA1_RE.test(String(reviewedCommit))) throw new Error("reviewed commit must be a full lowercase Git commit id");
  if (!STEM_RE.test(String(migrationName))) throw new Error("migration name must be an exact non-replayable timestamped stem");
  if (!SHA256_RE.test(String(queryHash))) throw new Error("query hash must be lowercase SHA-256");
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value || {}).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has an unexpected shape`);
}

export function parseReviewEvidence(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 48_000) {
    throw new Error("review evidence must be a non-empty JSON artifact no larger than 48 KB");
  }
  let evidence;
  try { evidence = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("review evidence must be strict UTF-8 JSON"); }
  exactKeys(evidence, ["schemaVersion", "migrationName", "reviewedCommit", "querySha256", "model", "reasoningEffort", "generatedAt", "reviews"], "review evidence");
  if (evidence.schemaVersion !== 1 || evidence.model !== "gpt-5.6-sol" || evidence.reasoningEffort !== "high") {
    throw new Error("review evidence must come from the required Sol/high reviewer");
  }
  if (evidence.migrationName !== expected.migrationName || evidence.reviewedCommit !== expected.reviewedCommit || evidence.querySha256 !== expected.queryHash) {
    throw new Error("review evidence is not bound to the requested commit and migration bytes");
  }
  const generatedAt = Date.parse(evidence.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt > Date.now() + 5_000 || Date.now() - generatedAt > 24 * 60 * 60 * 1000) {
    throw new Error("review evidence must be no more than 24 hours old and not future-dated");
  }
  if (!Array.isArray(evidence.reviews) || evidence.reviews.length !== REQUIRED_REVIEWERS.length) {
    throw new Error("review evidence must contain exactly the two required reviewer charters");
  }
  for (let index = 0; index < REQUIRED_REVIEWERS.length; index += 1) {
    const review = evidence.reviews[index];
    exactKeys(review, ["reviewer", "exitCode", "stdout"], "review entry");
    if (review.reviewer !== REQUIRED_REVIEWERS[index] || review.exitCode !== 0 || typeof review.stdout !== "string") {
      throw new Error("review evidence contains an invalid reviewer entry");
    }
    const tokens = [...review.stdout.matchAll(CLEAN_TOKEN_RE)];
    const terminalLine = review.stdout.trimEnd().split(/\r?\n/).at(-1);
    if (tokens.length !== 1 || terminalLine !== "CODEX_PROOF_VERDICT: CLEAN") {
      throw new Error(`${review.reviewer} did not return exactly one terminal clean verdict`);
    }
  }
  return evidence;
}

export function decodeReviewEvidenceBase64(value) {
  const encoded = String(value || "");
  if (!encoded || encoded.length > 64_000 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("review evidence must be canonical base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("review evidence must be canonical base64");
  return bytes;
}

export function validateTrustedDispatch({ actor, owner, eventName }) {
  if (eventName !== "workflow_dispatch" || !owner || actor !== owner) {
    throw new Error("migration release must be manually dispatched by the repository owner");
  }
}

export function selectExactMergedPr(pulls, { reviewedCommit, expectedCommit }) {
  const matching = (Array.isArray(pulls) ? pulls : []).filter((pr) =>
    pr?.state === "closed" && pr?.merged_at != null && pr?.base?.ref === "main" &&
    pr?.head?.sha === reviewedCommit && pr?.merge_commit_sha === expectedCommit);
  if (matching.length !== 1) throw new Error("reviewed commit is not the unique head of the PR merged as current main");
  return matching[0];
}
