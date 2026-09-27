'use strict';

const READY_LABEL = 'ready-for-coderabbit';
const REQUESTED_LABEL = 'coderabbit-review-requested';
const DISPATCH_LABEL = 'coderabbit-review-dispatch';
const NATIVE_RECEIPT_PREFIX = '<!-- crx-coderabbit-native-dispatch:v1 ';
const CANDIDATE_BIRTH_PREFIX = '<!-- crx-coderabbit-candidate-birth:v1 ';
// A later candidate on the SAME pull request (autonomous landing, 2026-09-26):
// recorded by the trusted run for the push/reopen/retarget that created it.
const CANDIDATE_EPOCH_PREFIX = '<!-- crx-coderabbit-candidate-epoch:v1 ';
const EPOCH_ACTIONS = new Set(['synchronize', 'reopened', 'edited']);
const REVIEW_COMMAND = '@coderabbitai review';
const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const CODERABBIT_BOT_LOGIN = 'coderabbitai[bot]';
const GITHUB_ACTIONS_APP_ID = 15368;
const GATE_CHECK_NAME = 'final-review-gate';
// Policy since #706: closing keeps the superseded PR's branch, commits, comments
// and findings; leaving it open buried real work under stale copies.
const FRESH_PR_GUIDANCE = 'open a fresh delivery PR at the corrected head and close this one with a "Replaced by #N" comment';
// The ordinary case since 2026-09-26: a fix pushed to the same PR becomes a new
// candidate epoch and earns one review through the ready label.
const NEW_EPOCH_GUIDANCE = 'wait for this PR\'s own trusted synchronize run to record the current head, then re-apply the ready label once its checks pass';
// Keep the old display name for completed trusted runs created before activation.
const TRUSTED_GATE_CHECK_NAMES = new Set([GATE_CHECK_NAME, 'coderabbit candidate snapshot', 'coderabbit candidate lifecycle']);
const RESET_ACTIONS = new Set([
  'synchronize',
  'closed',
  'reopened',
  'converted_to_draft',
  'ready_for_review',
  'auto_merge_enabled',
  'auto_merge_disabled',
]);
const ALLOWED_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const ACCEPTABLE_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const DEFAULT_QUIET_PERIOD_MS = 30_000;
const DEFAULT_MERGEABILITY_POLL_ATTEMPTS = 4;
const DEFAULT_MERGEABILITY_POLL_MS = 2_000;
// Waiting out running checks is OFF unless the workflow sets checkSettleAttempts;
// see awaitSettledChecks. The trusted workflow sets 80 x 15s = 20 minutes, which
// covers ci.yml's ~11-minute "Lint, Type Check, Test, Build" with room to spare.
const DEFAULT_CHECK_SETTLE_POLL_MS = 15_000;
// How long to wait for CodeRabbit to acknowledge the posted command before
// declaring the request unheard. Sized from measured behaviour on this repo, not
// guessed: acknowledged requests replied in 6s and 11s, while unacknowledged ones
// were still silent after 24 and 62 minutes. There is no useful middle — a 30s
// window separates the two populations with room to spare, and waiting longer
// only delays a failure the operator needs to see.
//
// The wait comes BEFORE each lookup, including the first, so the window really is
// attempts x interval. An earlier revision polled first and waited between
// attempts, which made six attempts five intervals — 25s of a documented 30s
// window, and an immediate first read that could not possibly have seen a reply.
const DEFAULT_ACK_POLL_ATTEMPTS = 6;
const DEFAULT_ACK_POLL_MS = 5_000;

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function pullRequestLabelNames(pullRequest) {
  return new Set((pullRequest.labels || []).map((label) => normalize(label.name)));
}

function newestByIdentity(items, identityFor, dateKeys) {
  const newest = new Map();

  for (const item of items) {
    const identity = normalize(identityFor(item));
    if (!identity) continue;

    const timestamp = dateKeys
      .map((key) => item[key])
      .find(Boolean) || '';
    const id = Number(item.id || 0);
    const existing = newest.get(identity);
    const newer = !existing || (
      id > 0 && existing.id > 0
        ? id > existing.id
        : timestamp > existing.timestamp
    );
    if (newer) {
      newest.set(identity, { item, timestamp, id });
    }
  }

  return new Map([...newest].map(([name, entry]) => [name, entry.item]));
}

function newestByName(items, nameKey, dateKeys) {
  return newestByIdentity(items, (item) => item[nameKey], dateKeys);
}

function requiredCheckConfigBlocker(required) {
  if (!required || typeof required !== 'object' || !isNonBlankString(required.name)) {
    return 'required-check configuration is missing a named provenance policy';
  }
  if (
    required.source === 'check_run'
    && isPositiveSafeInteger(required.appId)
    && isPositiveSafeInteger(required.workflowId)
    && isNonBlankString(required.workflowPath)
  ) return null;
  if (required.source === 'status' && isNonBlankString(required.creator)) return null;
  return `${required.name}: required-check configuration is not provenance-bound`;
}

function checkRunMatchesProvenance(check, required) {
  return Number(check.app?.id) === Number(required.appId)
    && Number(check.workflow_id) === Number(required.workflowId)
    && String(check.workflow_path || '') === String(required.workflowPath);
}

function statusMatchesProvenance(status, required) {
  return normalize(status.creator?.login) === normalize(required.creator);
}

function ignoredCheckConfigBlocker(ignored) {
  if (!ignored || typeof ignored !== 'object' || !isNonBlankString(ignored.name)) {
    return 'ignored-check configuration is missing a named provenance policy';
  }
  if (
    ignored.source === 'check_run'
    && isPositiveSafeInteger(ignored.appId)
  ) return null;
  if (ignored.source === 'status' && isNonBlankString(ignored.creator)) return null;
  return `${ignored.name}: ignored-check configuration is not provenance-bound`;
}

function checkRunMatchesIgnoredPolicy(check, ignored) {
  return ignored.source === 'check_run'
    && normalize(check.name) === normalize(ignored.name)
    && Number(check.app?.id) === Number(ignored.appId);
}

function statusMatchesIgnoredPolicy(status, ignored) {
  return ignored.source === 'status'
    && normalize(status.context) === normalize(ignored.name)
    && normalize(status.creator?.login) === normalize(ignored.creator);
}

// A list entry that is not an object cannot be evaluated, and it must never be
// silently dropped. A discarded row is a row that cannot BLOCK, so filtering one
// away could let the gate conclude "every required check is green" while a
// required check was never actually seen — a fail-OPEN on the paid-review gate.
// Reporting it as a blocker fails CLOSED and, unlike a TypeError, says what
// happened.
function malformedEntryBlockers(entries, kind) {
  if (!Array.isArray(entries)) {
    return [`${kind} listing did not return an array (received ${typeof entries})`];
  }
  const malformed = entries.filter((entry) => !entry || typeof entry !== 'object').length;
  return malformed > 0
    ? [`${kind} listing returned ${malformed} unreadable entr${malformed === 1 ? 'y' : 'ies'}`]
    : [];
}

function evaluateChecks({ checkRuns, statuses, requiredChecks, ignoredChecks = [] }) {
  // Before anything reads a field off an entry. Every loop below assumes an
  // object, and the 2026-09-03 gate crash was that assumption meeting a list
  // holding `undefined`. The cause is fixed in collectCheckBlockers; this is the
  // rule that keeps the NEXT malformed list a readable blocker instead of an
  // opaque "Cannot read properties of undefined" that takes the gate down
  // repo-wide. One place, not two, so the two cannot drift.
  const shapeBlockers = [
    ...malformedEntryBlockers(checkRuns, 'check-run'),
    ...malformedEntryBlockers(statuses, 'commit-status'),
  ];
  if (shapeBlockers.length > 0) return shapeBlockers;

  const ignoredConfigBlockers = ignoredChecks
    .map(ignoredCheckConfigBlocker)
    .filter(Boolean);
  const trustedIgnoredChecks = ignoredChecks.filter(
    (ignored) => !ignoredCheckConfigBlocker(ignored),
  );
  const checksByIdentity = newestByIdentity(checkRuns, (check) => (
    `${check.name}|app:${check.app?.id || 'unknown'}`
    + `${check.workflow_id || check.workflow_path ? `|workflow:${check.workflow_id || 'unknown'}|path:${check.workflow_path || 'unknown'}` : ''}`
  ), [
    'started_at',
    'completed_at',
  ]);
  const statusesByIdentity = newestByIdentity(statuses, (status) => (
    `${status.context}|creator:${status.creator?.login || 'unknown'}`
  ), [
    'created_at',
    'updated_at',
  ]);
  const blockers = [...ignoredConfigBlockers];

  for (const check of checksByIdentity.values()) {
    if (trustedIgnoredChecks.some((ignored) => checkRunMatchesIgnoredPolicy(check, ignored))) {
      continue;
    }
    if (check.workflow_provenance_error) {
      blockers.push(`${check.name}: workflow provenance could not be verified (${check.workflow_provenance_error})`);
      continue;
    }
    if (check.status !== 'completed' || !ACCEPTABLE_CHECK_CONCLUSIONS.has(check.conclusion)) {
      blockers.push(`${check.name}: ${check.status}/${check.conclusion || 'no conclusion'}`);
    }
  }

  for (const status of statusesByIdentity.values()) {
    if (trustedIgnoredChecks.some((ignored) => statusMatchesIgnoredPolicy(status, ignored))) {
      continue;
    }
    if (status.state !== 'success') {
      blockers.push(`${status.context}: ${status.state}`);
    }
  }

  for (const required of requiredChecks) {
    const configBlocker = requiredCheckConfigBlocker(required);
    if (configBlocker) {
      blockers.push(configBlocker);
      continue;
    }

    const name = normalize(required.name);
    const sameNameChecks = checkRuns.filter((check) => normalize(check.name) === name);
    const sameNameStatuses = statuses.filter((status) => normalize(status.context) === name);

    if (required.source === 'check_run') {
      const trusted = sameNameChecks.filter((check) => checkRunMatchesProvenance(check, required));
      const untrusted = sameNameChecks.filter((check) => !checkRunMatchesProvenance(check, required));
      if (sameNameStatuses.length > 0 || untrusted.length > 0) {
        blockers.push(`${required.name}: duplicate or untrusted same-name check provenance`);
      }
      const latest = newestByName(trusted, 'name', ['started_at', 'completed_at']).get(name);
      if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
        blockers.push(`${required.name}: trusted required check is missing or not successful`);
      }
    } else {
      const trusted = sameNameStatuses.filter((status) => statusMatchesProvenance(status, required));
      const untrusted = sameNameStatuses.filter((status) => !statusMatchesProvenance(status, required));
      if (sameNameChecks.length > 0 || untrusted.length > 0) {
        blockers.push(`${required.name}: duplicate or untrusted same-name status provenance`);
      }
      const latest = newestByName(trusted, 'context', ['created_at', 'updated_at']).get(name);
      if (!latest || latest.state !== 'success') {
        blockers.push(`${required.name}: trusted required status is missing or not successful`);
      }
    }
  }

  return [...new Set(blockers)];
}

async function removeLabelIfPresent(github, owner, repo, issueNumber, label) {
  try {
    await github.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: label,
    });
  } catch (error) {
    if (error && error.status === 404) return;
    throw error;
  }
}

// Recovery cleanup must never let one failed removal strand another label. Leaving
// READY_LABEL attached wedges the gate: the label is already present, so no further
// `labeled` event can fire and the run cannot be retried. Attempt every removal
// independently and hand the failures back so the caller can report them.
async function removeLabelsIndependently(github, owner, repo, issueNumber, labels) {
  const failures = [];
  for (const label of labels) {
    try {
      await removeLabelIfPresent(github, owner, repo, issueNumber, label);
    } catch (error) {
      failures.push(`${label} (${error && error.message ? error.message : String(error)})`);
    }
  }
  return failures;
}

async function resetLabels({ github, owner, repo, pullNumber, core, reason }) {
  // Same rule as the recovery path: a reset must ATTEMPT both removals. A
  // transient failure on the first used to skip the second, so a push, reopen,
  // draft conversion, base edit or auto-merge change could leave a stale
  // `coderabbit-review-requested` marker attached to a candidate the gate had
  // just invalidated — and the outer recovery then preserves that marker.
  const failures = await removeLabelsIndependently(
    github, owner, repo, pullNumber, [READY_LABEL, REQUESTED_LABEL, DISPATCH_LABEL],
  );
  if (failures.length > 0) {
    // Surface it and re-throw: a half-cleared reset is stale gate state, and the
    // caller's recovery path must not treat it as a clean reset.
    core.warning(`CodeRabbit final-review state reset could not clear ${failures.join('; ')}`);
    throw new Error(`workflow label reset failed for ${failures.join('; ')}`);
  }
  core.notice(`CodeRabbit final-review state reset: ${reason}`);
  return { status: 'reset', reason };
}

// Take the provider label back as soon as a review of this head is observed
// (autonomous landing, 2026-09-26). `.coderabbit.yaml` now sets
// auto_incremental_review: true so a fix on the SAME PR can earn a follow-up
// review; CodeRabbit only acts while the positive `coderabbit-review-dispatch`
// label is attached, so leaving it on after delivery would let every later
// work-in-progress push buy an unvalidated review. Dedupe no longer rests on the
// labels once a review exists: the head's native receipt stays on the PR, a
// relabel of this head reconciles against that receipt (reconcileDeliveredReceipt)
// and never dispatches again, and a new head gets its own candidate epoch.
//
// A failed removal is a warning, not a failure: the labels then linger until the
// next push resets them, which is the old behaviour.
async function releaseDeliveredDispatch({ github, owner, repo, pullNumber, core, headSha }) {
  const failures = await removeLabelsIndependently(github, owner, repo, pullNumber,
    [DISPATCH_LABEL, REQUESTED_LABEL, READY_LABEL]);
  if (failures.length > 0) {
    core.warning(`CodeRabbit reviewed ${headSha}, but the provider label could not be released (${failures.join('; ')}); a later push may be reviewed before it is validated.`);
  }
}

async function resetCandidate({
  github, owner, repo, pullNumber, core, reason,
}) {
  // Delete the posted command BEFORE the labels. If the deletion is going to
  // fail it fails while the gate state still says "requested", which is the
  // safer order: a stale command with its marker intact is deduped, a stale
  // command with the marker already cleared can be re-reviewed.
  //
  // Unconditional — a reset means the candidate is invalid, whether or not the
  // head moved. See deleteReviewCommands for why gating on the head was wrong.
  const cleanup = await deleteReviewCommands({ github, owner, repo, pullNumber, core });
  if (!cleanup.verified) {
    // A command may still be live and we cannot prove otherwise. Clearing the
    // dedupe marker here would let the next ready label post a SECOND paid
    // command beside it. Drop only the ready label, keep the marker, and fail
    // loudly so an operator resolves it rather than a queued run papering over it.
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    core.setFailed(
      `CodeRabbit final-review state could not be fully reset (${reason}): ${cleanup.reason}; `
      + `${REQUESTED_LABEL} was preserved so a relabel cannot buy a second review.`,
    );
    return { status: 'blocked', reason: `${reason}; ${cleanup.reason}` };
  }
  return resetLabels({ github, owner, repo, pullNumber, core, reason });
}

async function blockCandidate({ github, owner, repo, pullNumber, core, reason }) {
  await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
  core.setFailed(`CodeRabbit final review was not requested: ${reason}`);
  return { status: 'blocked', reason };
}

// Composed from validateAuthorizationState, deliberately: the two gate the same
// security decision, and when the six shared conditions were written out twice
// a change to either copy would silently let one path accept a candidate state
// the other rejects. This adds ONLY the two checks specific to a ready-label
// candidate — the label is still attached, and the head has not moved.
function validatePullRequest(pullRequest, defaultBranch, expectedHeadSha) {
  const labels = pullRequestLabelNames(pullRequest);
  const reasons = validateAuthorizationState(pullRequest, defaultBranch);

  if (!labels.has(READY_LABEL)) reasons.push(`${READY_LABEL} is no longer attached`);
  if (pullRequest.head.sha !== expectedHeadSha) {
    reasons.push('pull request head changed after the ready label was applied');
  }

  return reasons;
}

// Only meaningful AFTER the requested marker has been recorded — the two final
// validations, which run between recording the marker and crediting the command.
function requestedMarkerStillAttached(pullRequest) {
  return pullRequestLabelNames(pullRequest).has(REQUESTED_LABEL)
    ? []
    : [`${REQUESTED_LABEL} was removed while the request was in flight`];
}

// The shared live-state gate. Every caller that must decide whether a pull
// request is still a valid candidate reads it from here.
function validateAuthorizationState(pullRequest, defaultBranch) {
  const reasons = [];

  if (pullRequest.state !== 'open') reasons.push('pull request is not open');
  if (pullRequest.draft) reasons.push('pull request is still a draft');
  if (pullRequest.base.ref !== defaultBranch) {
    reasons.push(`base branch is ${pullRequest.base.ref}, not ${defaultBranch}`);
  }
  if (pullRequest.auto_merge) reasons.push('auto-merge is enabled');
  if (pullRequest.mergeable !== true || pullRequest.mergeable_state === 'unknown') {
    reasons.push('GitHub has not confirmed that the pull request is mergeable');
  }
  if (pullRequest.mergeable_state === 'dirty') reasons.push('pull request has merge conflicts');
  if (pullRequest.mergeable_state === 'behind') reasons.push('pull request branch is behind the base branch');

  return reasons;
}

// POSTING IS NOT REQUESTING. The gate used to report success the moment GitHub
// accepted the comment, which is only evidence that a comment exists — not that
// CodeRabbit heard it. Measured on this repository, same PR, same head, same
// command text, minutes apart, with the comment AUTHOR as the only variable:
//
//   github-actions[bot]  #535 16:09:16Z -> no acknowledgement, 62 min
//   github-actions[bot]  #449 16:48:40Z -> no acknowledgement, 24 min+
//   masonwells1 (User)   #535 02:19:49Z -> acknowledged in 11 s
//   masonwells1 (User)   #535 17:11:38Z -> acknowledged in  6 s
//
// So every "requested" this gate has ever reported for a bot-authored command was
// a false positive, and `coderabbit-review-requested` was never evidence of a
// request.
//
// WHY THIS VERIFIES RATHER THAN ENCODES A RULE. CodeRabbit's current documentation
// does not state which identities may issue commands — checked 2026-09-05 against
// the commands guide, the configuration reference and the "why reviews might not
// trigger" knowledge-base article. `auto_review.ignore_usernames` is the closest
// thing and it governs PR AUTHORS ("Skip reviews for PRs authored by these
// usernames"), not comment authors. The bot-filtering above is therefore an
// OBSERVED behaviour with no documented contract, which is exactly the kind of
// thing that must not be hard-coded as an assumption: it could change in either
// direction without notice. Hence no allowlist of "identities that work" — the
// gate posts, then checks whether CodeRabbit actually answered.
//
// Returns one of three states, deliberately distinct:
//   { acknowledged: true }                    CodeRabbit replied.
//   { acknowledged: false, verified: true }   it demonstrably did not.
//   { acknowledged: false, verified: false }  we could not find out.
// The third must never be collapsed into the second: treating an unverifiable
// lookup as a confirmed absence would clear the dedupe marker on a request that
// may well be live, and invite a relabel that buys a SECOND paid review.
// CodeRabbit's own auto-generated summary. It posts this WITHOUT being asked, even
// with automatic reviews disabled, and it quotes `@coderabbitai review` inside its
// tips block. A delayed one landing after our command would otherwise read as an
// acknowledgement of a command it knows nothing about.
const CODERABBIT_SUMMARY_MARKER = 'auto-generated comment: summarize by coderabbit.ai';
// The measured tell for a command CodeRabbit REFUSED. This is not the same as
// silence: a refusal means it heard the command and still costed the attempt, so a
// retry is not free and the state must not be cleared as if nothing happened.
const CODERABBIT_REFUSAL_MARKER = 'action not completed';
// The measured tells for a command CodeRabbit ACCEPTED, observed on this
// repository at 6s and 11s on #535.
const CODERABBIT_ACCEPTANCE_MARKERS = ['action performed', 'review triggered'];

// POLARITY MATTERS MORE THAN THE PATTERNS. An earlier revision recognised the two
// KNOWN comment shapes and treated everything else as an acknowledgement, which
// fails OPEN: any unrelated or delayed bot comment — a walkthrough, a status note,
// an answer to somebody else's chat — would have greened the gate for a command
// CodeRabbit never accepted. So the acceptance tells are matched POSITIVELY and
// anything unrecognised is 'other', which is not an acknowledgement.
//
// The cost of that choice, stated rather than hidden: if CodeRabbit changes its
// acceptance wording, this gate stops recognising real acknowledgements and starts
// reporting "never acknowledged". That is noisy, and it is the safe direction — it
// refuses to certify a review it can no longer see, instead of certifying one that
// never happened. Fix it by updating these markers against observed replies, never
// by widening the default back to "anything counts".
function classifyCodeRabbitComment(body) {
  const text = normalize(body);
  if (text.includes(CODERABBIT_SUMMARY_MARKER)) return 'summary';
  if (text.includes(CODERABBIT_REFUSAL_MARKER)) return 'refusal';
  if (CODERABBIT_ACCEPTANCE_MARKERS.some((marker) => text.includes(marker))) {
    return 'acknowledgement';
  }
  return 'other';
}

async function awaitCodeRabbitAcknowledgement({
  github, owner, repo, pullNumber, sinceCommentId, attempts, pollMs, settle, core,
}) {
  let lastError = null;
  let lastLookupSucceeded = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (pollMs > 0) await settle(pollMs);
    try {
      const comments = await github.paginate(
        github.rest.issues.listComments,
        { owner, repo, issue_number: pullNumber, per_page: 100 },
      );
      lastLookupSucceeded = true;
      // Strictly AFTER our command. Compare by comment id, which is monotonic per
      // repository and, unlike created_at, cannot tie at one-second resolution.
      // Only the FIRST CodeRabbit comment after our command is treated as a reply
      // to it. Scanning the whole tail for any matching phrase would let an
      // unrelated later action ("Action performed" for something else entirely)
      // answer a command CodeRabbit ignored. This is a proximity binding, not a
      // causal one — see the residual note at the call site.
      const reply = comments
        .filter((comment) => (
          normalize(comment?.user?.login) === CODERABBIT_BOT_LOGIN
          && Number(comment?.id || 0) > Number(sinceCommentId || 0)
        ))
        .sort((left, right) => Number(left.id || 0) - Number(right.id || 0))[0];
      const kind = reply ? classifyCodeRabbitComment(reply.body) : null;
      if (kind === 'refusal') {
        return { acknowledged: false, verified: true, refused: true, commentId: reply.id };
      }
      if (kind === 'acknowledgement') {
        return { acknowledged: true, verified: true, commentId: reply.id };
      }
    } catch (error) {
      lastLookupSucceeded = false;
      lastError = error;
      core.warning(`Acknowledgement lookup attempt ${attempt + 1} failed: ${error.message}`);
    }
  }

  // Absence is only CONFIRMED when the FINAL lookup — the one after the whole wait
  // — succeeded. An early empty read followed by outages is not evidence of
  // absence: CodeRabbit may have answered during the interval nobody could see,
  // and treating that as confirmed would delete a command and clear a dedupe
  // marker for a request that is actually live, letting a retry buy a second paid
  // review. `lastLookupSucceeded` is therefore reset on every failure rather than
  // latched once.
  return lastLookupSucceeded
    ? { acknowledged: false, verified: true }
    : { acknowledged: false, verified: false, error: lastError };
}

// A candidate carrying CHANGES_REQUESTED provably cannot merge: BOTH merge gates
// (.claude/hooks/pr-merge-guard.mjs and the MCP merge path) hard-deny that verdict.
// Requesting a review for it spends one of a small number of shared hourly
// CodeRabbit slots on work that cannot land. Observed on #449 — BLOCKED solely on a
// standing objection, every check green, so every other validation here passed and
// the gate posted, directly ahead of a candidate that needed the slot.
//
// Read the SAME field the merge gates read, through GraphQL, rather than
// re-deriving it from listReviews. A local re-derivation would have to model
// dismissed reviews, COMMENTED reviews, staleness and CODEOWNERS, and any
// divergence would surface as this gate refusing candidates the merge gate allows
// — or, worse, allowing ones it denies. One source, one answer.
// ONE deliberate exception to "read the same field the merge gates read"
// (Mason's autonomous-landing rule, 2026-09-26). When the only outstanding
// objection is CodeRabbit's own, recorded against an OLDER commit, the whole point
// of the requested review is to re-examine the fix for it on this same PR — that
// is how a fix earns its follow-up review without a replacement PR. Refusing it
// deadlocked: CodeRabbit's CHANGES_REQUESTED only clears when CodeRabbit reviews
// again, and the gate would not let it. A human reviewer's objection, or
// CodeRabbit's objection AT this head, still refuses, and the merge gates still
// deny any merge while reviewDecision is CHANGES_REQUESTED.
function staleCodeRabbitObjectionOnly(reviews, headSha) {
  const latestVerdict = new Map();
  for (const review of [...reviews].sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0))) {
    const state = normalize(review?.state);
    if (!['approved', 'changes_requested', 'dismissed'].includes(state)) continue;
    const login = normalize(review?.user?.login);
    if (!login) return false;
    latestVerdict.set(login, review);
  }
  const objections = [...latestVerdict.values()].filter((review) => normalize(review.state) === 'changes_requested');
  return objections.length > 0 && objections.every((review) => normalize(review.user?.login) === CODERABBIT_BOT_LOGIN
    && normalize(review.user?.type) === 'bot'
    && /^[a-f0-9]{40}$/.test(String(review.commit_id || ''))
    && String(review.commit_id) !== String(headSha));
}

async function collectReviewDecisionBlockers({
  github, owner, repo, pullNumber, core, headSha = null,
}) {
  let decision;
  try {
    const response = await github.graphql(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) { reviewDecision }
        }
      }`,
      { owner, repo, number: pullNumber },
    );
    decision = response?.repository?.pullRequest?.reviewDecision;
  } catch (error) {
    // Fail CLOSED, consistently with every other snapshot in this gate: an
    // unreadable pull request, an unreadable check list and an unreadable
    // mergeability state all block here too. Refusing costs a relabel; posting
    // blind can spend a paid slot on a pull request that cannot merge.
    //
    // A refusal leaves a red `final-review-gate` check run on this head. The
    // retry path below recognizes a completed historical result from this exact
    // trusted gate, so the transient failure remains fail-closed without forcing
    // an unrelated candidate commit merely to request the review again.
    core.warning(`Could not read the review decision: ${error.message}`);
    return [`could not read the pull request review decision (${error.message})`];
  }

  if (normalize(decision) === 'changes_requested') {
    if (/^[a-f0-9]{40}$/.test(String(headSha || ''))) {
      try {
        const reviews = await github.paginate(github.rest.pulls.listReviews,
          { owner, repo, pull_number: pullNumber, per_page: 100 });
        if (Array.isArray(reviews) && staleCodeRabbitObjectionOnly(reviews, headSha)) {
          core.notice(`The only outstanding objection is CodeRabbit's, on a commit older than ${headSha}; the requested review re-examines the fix on this same PR.`);
          return [];
        }
      } catch (error) {
        core.warning(`Could not read the reviews behind CHANGES_REQUESTED: ${error.message}`);
      }
    }
    return ['a reviewer has requested changes (reviewDecision=CHANGES_REQUESTED), so this pull request cannot merge and a review request would be spent on it'];
  }
  return [];
}

function actionRunId(detailsUrl) {
  const match = String(detailsUrl || '').match(/\/actions\/runs\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

async function attachRequiredWorkflowProvenance({
  github, owner, repo, checkRuns, requiredChecks, core,
}) {
  const workflowAppIds = new Set(requiredChecks
    .filter((required) => required?.source === 'check_run' && required.appId)
    .map((required) => Number(required.appId)));
  // Every check from the GitHub Actions app needs workflow provenance, not
  // only required checks. Otherwise a passing job in another workflow can
  // collapse a same-name failed optional security check.
  // `check?.app`, not `check.app?` — the optional chain has to start at the
  // ELEMENT. `check.app?.id` guards a nullish `app` on an object that EXISTS; an
  // undefined element throws before the `?.` is ever reached. That is the literal
  // line the gate died on. This runs BEFORE evaluateChecks, so it is what carries
  // an unreadable list far enough for evaluateChecks to block it with a readable
  // reason instead of the gate dying here. Load-bearing, not decorative:
  // reverting it to `check.app?.id` turns `an unreadable check-run entry blocks
  // the candidate instead of crashing the gate` red (measured — that one test,
  // not the whole set; the commit-status case never reaches this line).
  const candidates = checkRuns.filter((check) => workflowAppIds.has(Number(check?.app?.id)));

  await Promise.all(candidates.map(async (check) => {
    if (check.workflow_id && check.workflow_path) return;
    const runId = actionRunId(check.details_url);
    if (!runId) {
      check.workflow_provenance_error = 'check details did not identify a GitHub Actions run';
      core.warning(`Could not resolve workflow provenance for ${check.name}: ${check.workflow_provenance_error}`);
      return;
    }
    try {
      const response = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
      check.workflow_id = response.data.workflow_id;
      check.workflow_path = response.data.path;
    } catch (error) {
      check.workflow_provenance_error = error.message;
      core.warning(`Could not resolve workflow provenance for ${check.name}: ${error.message}`);
    }
  }));
}

// A failed earlier invocation of this gate leaves a completed check run on the
// candidate SHA. Retrying the ready label starts a NEW invocation, so treating
// that old gate result as an ordinary failed check wedges every retry forever.
//
// Do not identify it by job name: another workflow can call a job
// `final-review-gate`. Instead ask Actions for THIS invocation's immutable
// workflow identity, then only discount *completed* checks from that exact
// workflow AND this exact gate job from the official GitHub Actions app. A
// concurrent invocation remains in_progress and therefore blocks; so does a
// same-name job from any other workflow, or a different job in this workflow.
async function resolveTrustedGateWorkflowProvenance({
  github, owner, repo, selfRunId, core,
}) {
  if (!isPositiveSafeInteger(selfRunId)) {
    return { error: 'this workflow run id is missing or invalid' };
  }

  try {
    const response = await github.rest.actions.getWorkflowRun({
      owner, repo, run_id: Number(selfRunId),
    });
    const workflowId = response?.data?.workflow_id;
    const workflowPath = response?.data?.path;
    if (!isPositiveSafeInteger(workflowId) || !isNonBlankString(workflowPath)) {
      return { error: 'this workflow run did not identify a trusted workflow' };
    }
    return { workflowId, workflowPath };
  } catch (error) {
    core.warning(`Could not resolve this gate workflow provenance: ${error.message}`);
    return { error: error.message };
  }
}

function isCompletedTrustedGateCheck(check, trustedGateWorkflow) {
  // The checks/jobs APIs expose per-invocation database IDs, not a stable YAML
  // job-key field. The workflow test therefore pins this trusted workflow to its
  // sole job key; this runtime check binds the resulting check run to Actions,
  // the exact workflow identity, and a current or legacy display name of that single job.
  return check
    && typeof check === 'object'
    && check.status === 'completed'
    && Number(check.app?.id) === GITHUB_ACTIONS_APP_ID
    && TRUSTED_GATE_CHECK_NAMES.has(normalize(check.name))
    && Number(check.workflow_id) === Number(trustedGateWorkflow.workflowId)
    && String(check.workflow_path || '') === String(trustedGateWorkflow.workflowPath);
}

function mergeabilityIsPending(pullRequest) {
  return pullRequest.mergeable === null || pullRequest.mergeable_state === 'unknown';
}

async function getPullRequestWithResolvedMergeability({
  github,
  owner,
  repo,
  pullNumber,
  attempts,
  pollMs,
  settle,
}) {
  const boundedAttempts = Number.isFinite(attempts) ? Math.max(1, Math.trunc(attempts)) : 1;

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    const response = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    if (!mergeabilityIsPending(response.data) || attempt === boundedAttempts) {
      return response.data;
    }
    if (pollMs > 0) await settle(pollMs);
  }

  throw new Error('mergeability polling exhausted without a pull-request response');
}

function reviewCommandBody(headSha) {
  return `${REVIEW_COMMAND}\n<!-- coderabbit-final-review-head:${headSha} -->`;
}

function isActionsReviewComment(comment, headSha) {
  return normalize(comment.user?.login) === normalize(ACTIONS_BOT_LOGIN)
    && String(comment.body || '').trim() === reviewCommandBody(headSha);
}

// An Actions-authored review command for ANY head, not one specific head. Used
// only to find SUPERSEDED commands during a reset — never to credit one.
function actionsReviewCommandHead(comment) {
  if (normalize(comment.user?.login) !== normalize(ACTIONS_BOT_LOGIN)) return null;
  const body = String(comment.body || '').trim();
  const match = body.match(/<!-- coderabbit-final-review-head:([0-9a-f]{40}) -->$/i);
  if (!match) return null;
  // Exact-equality re-check against the canonical body: the marker alone must
  // never be enough to identify a command we will delete.
  return body === reviewCommandBody(match[1]) ? match[1] : null;
}

// A reset invalidates the candidate, but a command already posted for the OLD
// head stays on the PR and CodeRabbit can still spend a review on it. Clearing
// the labels is not enough — the superseded command has to go too.
//
// EVERY Actions-authored command is deleted, not only ones for a superseded
// head. The first version of this gated on `head !== currentHeadSha`, which was
// wrong: a base edit, draft conversion, reopen, or auto-merge change invalidates
// the candidate with the head UNCHANGED, so that guard preserved exactly the
// commands it most needed to remove — and a relabel then posted a second paid
// command while the first could still spend a review on the invalidated
// candidate. Reaching this function means the candidate is invalid; a confirmed
// duplicate returns `duplicate` from reconcileLabelEvent and never resets.
//
// Reports `verified` so the caller can tell "there was nothing to delete" from
// "I could not find out". Those are different states and must not share a
// branch — the same distinction the comment-post recovery path draws. An
// unverified cleanup that then cleared the dedupe marker would let the next
// relabel post a SECOND paid command alongside a command that may still be live.
async function deleteReviewCommands({
  github, owner, repo, pullNumber, core,
}) {
  let comments;
  try {
    comments = await github.paginate(
      github.rest.issues.listComments,
      { owner, repo, issue_number: pullNumber, per_page: 100 },
    );
  } catch (error) {
    core.warning(`Could not look for posted review commands: ${error.message}`);
    return { verified: false, deleted: 0, reason: `command lookup failed (${error.message})` };
  }

  let deleted = 0;
  let failed = null;
  for (const comment of comments) {
    const head = actionsReviewCommandHead(comment);
    if (!head) continue;
    try {
      await github.rest.issues.deleteComment({ owner, repo, comment_id: comment.id });
      deleted += 1;
      core.notice(`Deleted the posted CodeRabbit review command for ${head}.`);
    } catch (error) {
      // A command we found but could not remove is exactly as dangerous as one
      // we never saw: it survives, and clearing the marker would let a relabel
      // add a second one beside it.
      failed = `could not delete the posted review command for ${head} (${error.message})`;
      core.warning(failed);
    }
  }
  return failed
    ? { verified: false, deleted, reason: failed }
    : { verified: true, deleted };
}

async function requestedMarkerHasCommand({ github, owner, repo, pullNumber, headSha }) {
  const comments = await github.paginate(
    github.rest.issues.listComments,
    { owner, repo, issue_number: pullNumber, per_page: 100 },
  );
  return comments.some((comment) => isActionsReviewComment(comment, headSha));
}

// Marker + command is DEDUPE state, not proof that a review was requested. The
// label event this gate raises by adding REQUESTED_LABEL queues another run, and
// that run used to see marker + command and report a "confirmed" duplicate — so an
// unverifiable (or unheard) request was laundered into a confirmed one by the very
// next event, defeating the acknowledgement check entirely. This re-derives the
// answer from the comments themselves: find the command for this head, then look
// for a CodeRabbit reply newer than it.
async function inspectExistingRequest({ github, owner, repo, pullNumber, headSha }) {
  let comments;
  try {
    comments = await github.paginate(
      github.rest.issues.listComments,
      { owner, repo, issue_number: pullNumber, per_page: 100 },
    );
  } catch (error) {
    return { verified: false, acknowledged: false, error };
  }

  const command = comments
    .filter((comment) => isActionsReviewComment(comment, headSha))
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0];
  if (!command) return { verified: true, acknowledged: false, commandMissing: true };

  // Same first-reply rule as the live poll, so the two cannot disagree about what
  // counts as an answer to a command.
  const reply = comments
    .filter((comment) => (
      normalize(comment?.user?.login) === CODERABBIT_BOT_LOGIN
      && Number(comment?.id || 0) > Number(command.id || 0)
    ))
    .sort((left, right) => Number(left.id || 0) - Number(right.id || 0))[0];
  const kind = reply ? classifyCodeRabbitComment(reply.body) : null;
  if (kind === 'refusal') {
    return { verified: true, acknowledged: false, refused: true, commandId: command.id };
  }
  return {
    verified: true,
    acknowledged: kind === 'acknowledgement',
    commandId: command.id,
  };
}

// The dispatch label only asks CodeRabbit to start work. A green CodeRabbit
// status is emitted even for "Review skipped", so it is not evidence that an
// exact-head review occurred. Require a submitted CodeRabbit review attached to
// this head before reporting the request as reviewed.
async function inspectExactHeadCodeRabbitReview({ github, owner, repo, pullNumber, headSha, requestedAfter = null }) {
  try {
    const reviews = await github.paginate(
      github.rest.pulls.listReviews,
      { owner, repo, pull_number: pullNumber, per_page: 100 },
    );
    if (!Array.isArray(reviews)) throw new Error('CodeRabbit review listing was not an array');
    const review = [...reviews].sort((left, right) => Number(right?.id || 0) - Number(left?.id || 0)).find((candidate) => {
      if (
        normalize(candidate?.user?.login) !== CODERABBIT_BOT_LOGIN
        || String(candidate?.commit_id || '') !== String(headSha)
      ) return false;
      if (['approved', 'changes_requested'].includes(normalize(candidate?.state))) return true;
      // Outside-diff-only reports omit the actionable-comments summary. Require
      // their unquoted run metadata, exact reviewed head and terminal stamp.
      // Empty COMMENTED records are bot reply artifacts, not review evidence.
      const body = String(candidate?.body || '').trim();
      const reviewedRange = body.match(/^Reviewing files that changed from the base of the PR and between [a-f0-9]{40} and ([a-f0-9]{40})\.$/m);
      const outsideDiffReport = /^\*\*Run ID\*\*: `[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}`$/m.test(body)
        && reviewedRange?.[1] === headSha
        && body.endsWith('<!-- This is an auto-generated comment by CodeRabbit for review status -->');
      return normalize(candidate?.state) === 'commented'
        && (/^\*\*actionable comments posted:\s*\d+\*\*/.test(normalize(body)) || outsideDiffReport);
    });
    if (review) {
      const reviewId = Number(review.id);
      const submittedAt = Date.parse(String(review.submitted_at || ''));
      if (!Number.isSafeInteger(reviewId) || reviewId <= 0 || !Number.isFinite(submittedAt)
        || normalize(review.user?.type) !== 'bot') {
        return {
          verified: false,
          reviewed: false,
          error: new Error('CodeRabbit exact-head review record was missing its authenticated review identity or submission time'),
        };
      }
      if (requestedAfter !== null && submittedAt <= requestedAfter) {
        return { verified: true, reviewed: false, changesRequested: false };
      }
    }
    return { verified: true, reviewed: Boolean(review), changesRequested: normalize(review?.state) === 'changes_requested', review };
  } catch (error) {
    return { verified: false, reviewed: false, error };
  }
}

function nativeDispatchReceiptBody({ headSha, baseSha, runId }) {
  return `${NATIVE_RECEIPT_PREFIX}${JSON.stringify({ headSha, baseSha, runId })} -->`;
}

function parseNativeDispatchReceipt(comment) {
  if (normalize(comment?.user?.login) !== ACTIONS_BOT_LOGIN
    || normalize(comment?.user?.type) !== 'bot'
    || !String(comment.body || '').startsWith(NATIVE_RECEIPT_PREFIX)) return null;
  try {
    const receipt = JSON.parse(comment.body.slice(NATIVE_RECEIPT_PREFIX.length, -4));
    if (comment.body !== nativeDispatchReceiptBody(receipt)
      || !/^[a-f0-9]{40}$/.test(receipt.headSha || '')
      || !/^[a-f0-9]{40}$/.test(receipt.baseSha || '')
      || !isPositiveSafeInteger(receipt.runId)
      || !isPositiveSafeInteger(Number(comment.id))
      || !Number.isFinite(Date.parse(comment.created_at))) return null;
    return { ...receipt, requestedAfter: Date.parse(comment.created_at) };
  } catch { return null; }
}

function candidateBirthBody({ headSha, baseSha, executionSha, runId, repoId, repoFullName, pullNumber, creatorId, prCreatedAt }) {
  return `${CANDIDATE_BIRTH_PREFIX}${JSON.stringify({ headSha, baseSha, executionSha, runId, repoId, repoFullName, pullNumber, creatorId, prCreatedAt })} -->`;
}

function parseCandidateBirth(comment) {
  if (normalize(comment?.user?.login) !== ACTIONS_BOT_LOGIN
    || normalize(comment?.user?.type) !== 'bot'
    || !String(comment.body || '').startsWith(CANDIDATE_BIRTH_PREFIX)) return null;
  try {
    const birth = JSON.parse(comment.body.slice(CANDIDATE_BIRTH_PREFIX.length, -4));
    if (comment.body !== candidateBirthBody(birth)
      || !/^[a-f0-9]{40}$/.test(birth.headSha || '')
      || !/^[a-f0-9]{40}$/.test(birth.baseSha || '')
      || !/^[a-f0-9]{40}$/.test(birth.executionSha || '')
      || ![birth.runId, birth.repoId, birth.pullNumber, birth.creatorId].every(isPositiveSafeInteger)
      || !isNonBlankString(birth.repoFullName)
      || !isPositiveSafeInteger(Number(comment.id))
      || !Number.isFinite(Date.parse(birth.prCreatedAt))
      || !Number.isFinite(Date.parse(comment.created_at))
      || Date.parse(birth.prCreatedAt) > Date.parse(comment.created_at)
      || comment.updated_at !== comment.created_at) return null;
    return { ...birth, recordedAt: Date.parse(comment.created_at) };
  } catch { return null; }
}

// Capture the ORIGINAL opened webhook, never a later REST PR/event response.
// GitHub's activity-event payloads can expose current head/base values. This
// snapshot is context evidence only; it never grants dispatch or merge authority.
async function recordCandidateBirth({ github, context, core }) {
  const pull = context.payload.pull_request;
  const repository = context.payload.repository;
  if (isNonBlankString(repository.default_branch) && isNonBlankString(pull.base?.ref)
    && pull.base.ref !== repository.default_branch) {
    core.notice('Non-default-base PR does not require a production review candidate snapshot.');
    return { status: 'ignored', reason: 'non_default_base' };
  }
  const snapshot = {
    headSha: pull.head?.sha, baseSha: pull.base?.sha, executionSha: context.sha,
    runId: context.runId, repoId: repository.id,
    repoFullName: `${context.repo.owner}/${context.repo.repo}`,
    pullNumber: pull.number, creatorId: pull.user?.id, prCreatedAt: pull.created_at,
  };
  const body = candidateBirthBody(snapshot);
  const recordedAt = new Date().toISOString();
  if (pull.base?.ref !== repository.default_branch
    || repository.default_branch !== 'main'
    || !parseCandidateBirth({ id: 1, body, created_at: recordedAt,
      updated_at: recordedAt, user: { login: ACTIONS_BOT_LOGIN, type: 'Bot' } })) {
    throw new Error('the original opened webhook did not identify a valid candidate birth');
  }
  const { owner, repo } = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments,
    { owner, repo, issue_number: pull.number, per_page: 100 });
  if (!Array.isArray(comments)) throw new Error('candidate birth listing could not be verified');
  const existing = comments.filter((comment) => normalize(comment.user?.login) === ACTIONS_BOT_LOGIN
    && String(comment.body || '').startsWith(CANDIDATE_BIRTH_PREFIX));
  if (existing.length > 0) {
    const birth = existing.length === 1 ? parseCandidateBirth(existing[0]) : null;
    if (!birth || birth.headSha !== snapshot.headSha || birth.baseSha !== snapshot.baseSha
      || birth.prCreatedAt !== snapshot.prCreatedAt || birth.creatorId !== snapshot.creatorId
      || birth.repoId !== snapshot.repoId || birth.repoFullName !== snapshot.repoFullName
      || birth.pullNumber !== snapshot.pullNumber) throw new Error(`candidate birth is conflicting or unverifiable; ${FRESH_PR_GUIDANCE}`);
    core.notice('Original candidate birth already recorded; no duplicate snapshot was posted.');
    return { status: 'birth_recorded', duplicate: true };
  }
  const response = await github.rest.issues.createComment({ owner, repo, issue_number: pull.number, body });
  if (!parseCandidateBirth(response.data)) throw new Error('candidate birth post could not be verified; do not overwrite uncertain state');
  return { status: 'birth_recorded', duplicate: false };
}

function candidateEpochBody({ action, headSha, baseSha, executionSha, runId, repoId, repoFullName, pullNumber, prCreatedAt }) {
  return `${CANDIDATE_EPOCH_PREFIX}${JSON.stringify({ action, headSha, baseSha, executionSha, runId, repoId, repoFullName, pullNumber, prCreatedAt })} -->`;
}

function parseCandidateEpoch(comment) {
  if (normalize(comment?.user?.login) !== ACTIONS_BOT_LOGIN
    || normalize(comment?.user?.type) !== 'bot'
    || !String(comment.body || '').startsWith(CANDIDATE_EPOCH_PREFIX)) return null;
  try {
    const epoch = JSON.parse(comment.body.slice(CANDIDATE_EPOCH_PREFIX.length, -4));
    if (comment.body !== candidateEpochBody(epoch)
      || !EPOCH_ACTIONS.has(epoch.action)
      || !/^[a-f0-9]{40}$/.test(epoch.headSha || '')
      || !/^[a-f0-9]{40}$/.test(epoch.baseSha || '')
      || !/^[a-f0-9]{40}$/.test(epoch.executionSha || '')
      || ![epoch.runId, epoch.repoId, epoch.pullNumber].every(isPositiveSafeInteger)
      || !isNonBlankString(epoch.repoFullName)
      || !isPositiveSafeInteger(Number(comment.id))
      || !Number.isFinite(Date.parse(epoch.prCreatedAt))
      || !Number.isFinite(Date.parse(comment.created_at))
      || Date.parse(epoch.prCreatedAt) > Date.parse(comment.created_at)
      || comment.updated_at !== comment.created_at) return null;
    return { ...epoch, recordedAt: Date.parse(comment.created_at), commentId: Number(comment.id) };
  } catch { return null; }
}

// SAME-PR FOLLOW-UP REVIEWS (autonomous landing, 2026-09-26). The native design
// bound every review to the head/base the `opened` webhook captured, for the
// whole life of the PR, so each fix round needed a replacement PR — the
// field-invoice fix went through about fourteen. The reason was attribution: a
// late review of an OLD candidate must never be credited to a new request.
//
// That reason is kept; only its unit shrinks from "the PR" to "the candidate
// epoch". The trusted run for the event that created a new candidate — a push
// (`synchronize`), a `reopened`, or a base retarget (`edited` with a base change)
// — records that event's own head and base, exactly as `opened` records the
// birth: taken from the webhook, never re-read from the REST API, and checked
// later against the immutable run name. Receipts, provider-label events and
// history edits before the current epoch belong to earlier candidates and are
// ignored; inside the epoch the old one-candidate rules apply unchanged. A review
// is still credited only for its exact head, after this epoch's own receipt.
async function recordCandidateEpoch({ github, context, core }) {
  const pull = context.payload.pull_request;
  const repository = context.payload.repository;
  const action = context.payload.action;
  if (!EPOCH_ACTIONS.has(action) || pull.state !== 'open' || pull.base?.ref !== repository.default_branch
    || repository.default_branch !== 'main') {
    return { status: 'ignored', reason: 'no_production_candidate_epoch' };
  }
  const epoch = {
    action, headSha: pull.head?.sha, baseSha: pull.base?.sha, executionSha: context.sha,
    runId: context.runId, repoId: repository.id, repoFullName: `${context.repo.owner}/${context.repo.repo}`,
    pullNumber: pull.number, prCreatedAt: pull.created_at,
  };
  const body = candidateEpochBody(epoch);
  const probeAt = new Date().toISOString();
  if (!parseCandidateEpoch({ id: 1, body, created_at: probeAt, updated_at: probeAt,
    user: { login: ACTIONS_BOT_LOGIN, type: 'Bot' } })) {
    throw new Error(`the ${action} webhook did not identify a valid candidate epoch`);
  }
  const { owner, repo } = context.repo;
  const response = await github.rest.issues.createComment({ owner, repo, issue_number: pull.number, body });
  if (!parseCandidateEpoch(response.data)) throw new Error('candidate epoch post could not be verified');
  core.notice(`Recorded candidate epoch ${action} for head ${epoch.headSha}; a ready label on this head can request one review.`);
  return { status: 'epoch_recorded' };
}

// The CURRENT candidate context: the newest trusted birth or epoch record. It
// must describe exactly the live head and base, and it is verified against the
// immutable name of the trusted run that wrote it.
async function inspectCandidateBirth({ github, owner, repo, pullNumber, headSha, baseSha, selfRunId, core, comments }) {
  const births = comments.filter((comment) => normalize(comment.user?.login) === ACTIONS_BOT_LOGIN
    && String(comment.body || '').startsWith(CANDIDATE_BIRTH_PREFIX));
  const birth = births.length === 1 ? parseCandidateBirth(births[0]) : null;
  if (!birth || birth.pullNumber !== pullNumber || birth.repoFullName !== `${owner}/${repo}`) {
    throw new Error(`immutable original candidate birth is missing or unverifiable; after the trusted opened workflow is available, ${FRESH_PR_GUIDANCE}`);
  }
  // Every Actions-authored epoch-shaped comment must parse; a malformed or edited
  // one is refused rather than skipped, the same fail-closed rule as the birth.
  const epochComments = comments.filter((comment) => normalize(comment.user?.login) === ACTIONS_BOT_LOGIN
    && String(comment.body || '').startsWith(CANDIDATE_EPOCH_PREFIX));
  const epochs = epochComments.map(parseCandidateEpoch);
  if (epochs.some((epoch) => !epoch || epoch.pullNumber !== pullNumber || epoch.repoFullName !== `${owner}/${repo}`
    || epoch.repoId !== birth.repoId || epoch.prCreatedAt !== birth.prCreatedAt)) {
    throw new Error(`a candidate epoch record is malformed or belongs to another pull request; ${FRESH_PR_GUIDANCE}`);
  }
  const birthCommentId = Number(births[0].id);
  const newestEpoch = epochs.filter((epoch) => epoch.commentId > birthCommentId)
    .sort((left, right) => right.commentId - left.commentId)[0] || null;
  if (epochs.length > 0 && !newestEpoch) {
    throw new Error(`a candidate epoch predates the PR's own birth record; ${FRESH_PR_GUIDANCE}`);
  }
  const current = newestEpoch || birth;
  if (current.headSha !== headSha || current.baseSha !== baseSha) {
    throw new Error(newestEpoch || epochs.length
      ? `the newest recorded candidate is not the live head/base; ${NEW_EPOCH_GUIDANCE}`
      : `candidate head or base changed since PR creation and no trusted epoch records it yet; ${NEW_EPOCH_GUIDANCE}`);
  }
  const action = newestEpoch ? newestEpoch.action : 'opened';
  const [response, trusted] = await Promise.all([
    github.rest.actions.getWorkflowRun({ owner, repo, run_id: current.runId }),
    resolveTrustedGateWorkflowProvenance({ github, owner, repo, selfRunId, core }),
  ]);
  const origin = response.data;
  const originalPull = origin.pull_requests?.find((pull) => Number(pull.number) === pullNumber);
  if (trusted.error || origin.id !== current.runId || origin.workflow_id !== trusted.workflowId
    || origin.path !== '.github/workflows/coderabbit-final-review.yml' || origin.path !== trusted.workflowPath
    || origin.display_title !== `CodeRabbit gate ${action} PR ${pullNumber} head ${headSha} base ${baseSha} execution ${current.executionSha}`
    || origin.event !== 'pull_request_target' || ![headSha, baseSha, current.executionSha].includes(origin.head_sha)
    || originalPull?.head?.sha !== headSha || originalPull?.base?.sha !== baseSha
    || origin.repository?.id !== birth.repoId || origin.repository?.full_name !== birth.repoFullName
    || (!newestEpoch && origin.actor?.id !== birth.creatorId)
    || origin.status !== 'completed' || origin.conclusion !== 'success'
    || !Number.isFinite(Date.parse(origin.created_at)) || !Number.isFinite(Date.parse(origin.updated_at))
    || Date.parse(birth.prCreatedAt) > Date.parse(origin.created_at)
    || current.recordedAt < Date.parse(origin.created_at) || current.recordedAt > Date.parse(origin.updated_at)) {
    throw new Error(newestEpoch
      ? 'candidate epoch did not match its trusted workflow run'
      : 'candidate birth did not match its trusted original workflow candidate');
  }
  // `epochStart` is where THIS candidate's history begins. The opened birth keeps
  // the whole-PR scope it always had; an epoch starts at its own record, on the
  // second-precision clock GitHub's timeline events use.
  return { ...current, action, epochStart: newestEpoch ? Math.floor(newestEpoch.recordedAt / 1000) * 1000 : -Infinity };
}

// A receipt records an attempt, never merge authorization. Independently check
// its Actions run and original candidate; labels and an Actions login alone
// cannot bind an old review to a new base. Keep receipts across resets so a
// potentially late review cannot be credited to another dispatch of this head.
async function inspectNativeDispatchReceipt({ github, owner, repo, pullNumber, headSha, baseSha, selfRunId, core }) {
  try {
    const comments = await github.paginate(github.rest.issues.listComments,
      { owner, repo, issue_number: pullNumber, per_page: 100 });
    if (!Array.isArray(comments)) throw new Error('native receipt listing was not an array');
    const receipts = comments.map(parseNativeDispatchReceipt).filter((receipt) => receipt?.headSha === headSha);
    if (receipts.length !== 1) throw new Error('native dispatch requires exactly one head/base receipt');
    const receipt = receipts[0];
    if (receipt.baseSha !== baseSha) throw new Error(`native dispatch base changed; ${FRESH_PR_GUIDANCE}`);
    const [response, trusted] = await Promise.all([
      github.rest.actions.getWorkflowRun({ owner, repo, run_id: receipt.runId }),
      resolveTrustedGateWorkflowProvenance({ github, owner, repo, selfRunId, core }),
    ]);
    const origin = response.data;
    const originalPull = origin.pull_requests?.find((pull) => Number(pull.number) === Number(pullNumber));
    if (trusted.error || origin.id !== receipt.runId || origin.workflow_id !== trusted.workflowId
      || origin.path !== '.github/workflows/coderabbit-final-review.yml' || origin.path !== trusted.workflowPath
      // The Actions REST run head_sha is not the execution GITHUB_SHA. Actual
      // run 34699373055 exposes the PR head; target-event execution uses main.
      // Bind both candidate commits through the associated pull-request record.
      || origin.event !== 'pull_request_target' || ![headSha, baseSha].includes(origin.head_sha)
      || originalPull?.head?.sha !== headSha || originalPull?.base?.sha !== baseSha
      || !Number.isFinite(Date.parse(origin.created_at))
      || receipt.requestedAfter < Date.parse(origin.created_at)
      || receipt.requestedAfter > Date.now()
      || (origin.status === 'completed' && (!Number.isFinite(Date.parse(origin.updated_at))
        || receipt.requestedAfter > Date.parse(origin.updated_at)))) throw new Error('native receipt did not match its trusted original workflow candidate');
    if (!isNonBlankString(origin.actor?.login)) throw new Error('native receipt original actor was missing');
    const permission = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: origin.actor.login });
    if (!ALLOWED_PERMISSIONS.has(normalize(permission.data.permission))) throw new Error('native receipt original actor was not authorized');
    return { verified: true, receipt, origin };
  } catch (error) { return { verified: false, error }; }
}

// GitHub reviews attest the head, but not the PR base. Before trusting a
// response, exclude older provider-label requests that might still finish on
// this head. Retained receipts alone cannot settle an earlier attempt.
async function inspectNativeAttemptHistory({ github, owner, repo, pullNumber, headSha, selfRunId, core, activeReceipt = null, baseSha = activeReceipt?.baseSha }) {
  try {
    const [events, comments] = await Promise.all([
      github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number: pullNumber, per_page: 100 }),
      github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pullNumber, per_page: 100 }),
    ]);
    if (!Array.isArray(events) || !Array.isArray(comments)) throw new Error('native attempt history could not be verified');
    // Permissions now cannot prove permissions when an old command was posted.
    // Instead require one head/base tuple for the WHOLE PR lifetime. Any manual
    // or late request on this unchanged candidate has the same review context;
    // no comment is used as authorization, and no provider permission rule is assumed.
    const birth = await inspectCandidateBirth({ github, owner, repo, pullNumber, headSha, baseSha,
      selfRunId, core, comments });
    // Scope everything to the CURRENT candidate epoch (see recordCandidateEpoch).
    // Anything earlier belongs to a previous candidate of this PR. An event whose
    // timestamp cannot be read is never excluded — it stays in scope and fails
    // closed below.
    const beforeEpoch = (value) => {
      const at = Date.parse(String(value || ''));
      return Number.isFinite(at) && at < birth.epochStart;
    };
    const epochEvents = events.filter((event) => !beforeEpoch(event.created_at));
    const dispatches = epochEvents.filter((event) => event.event === 'labeled' && event.label?.name === DISPATCH_LABEL);
    const receipts = comments.map(parseNativeDispatchReceipt).filter(Boolean)
      .filter((receipt) => receipt.requestedAfter >= birth.epochStart);
    if (epochEvents.some((event) => ['base_ref_changed', 'base_ref_force_pushed', 'head_ref_force_pushed'].includes(event.event))
      || receipts.some((receipt) => receipt.headSha !== birth.headSha || receipt.baseSha !== birth.baseSha)) {
      throw new Error(`the PR candidate was retargeted, rewritten or changed within the current candidate; ${NEW_EPOCH_GUIDANCE}`);
    }
    let activeEvents = 0;
    for (const event of dispatches) {
      const dispatchedAt = Date.parse(event.created_at);
      if (!Number.isFinite(dispatchedAt) || dispatchedAt > Date.now() + 999) throw new Error('native dispatch history has no trustworthy timestamp');
      // GitHub issue-event timestamps have second precision. A native request
      // must have exactly one Actions label event after its receipt.
      if (activeReceipt && dispatchedAt >= Math.floor(activeReceipt.requestedAfter / 1000) * 1000) {
        if (normalize(event.actor?.login) !== ACTIONS_BOT_LOGIN || ++activeEvents > 1) {
          throw new Error(`an out-of-band or duplicate native request overlaps this receipt; ${FRESH_PR_GUIDANCE}`);
        }
        continue;
      }
      throw new Error(`an untracked native review attempt cannot be attributed to this unchanged candidate; ${FRESH_PR_GUIDANCE}`);
    }
    if (activeReceipt && activeEvents !== 1) throw new Error('the active native receipt has no unique provider-label event');
    return { verified: true };
  } catch (error) { return { verified: false, error }; }
}

// The single reconciliation routine. Every event that must re-derive gate state
// from the LIVE pull request goes through here — label events and metadata
// edits alike. `reasonPrefix` is the only thing that varied between the former
// copies, and the copies had already diverged: the `edited` one omitted the
// post-lookup confirmation re-read below, so a head change or marker removal
// racing the lookup was reported as a confirmed duplicate instead of a reset.
async function reconcileLabelEvent({
  github, owner, repo, pullNumber, core, defaultBranch, action, label, config, selfRunId,
  authorizedReadyHeadSha = null,
  authorizedReadyBaseSha = null,
  reasonPrefix: prefixOverride,
}) {
  const reasonPrefix = prefixOverride
    || `pull_request_target.${action}.${normalize(label) || 'unknown_label'}`;
  const pullRequest = (await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  })).data;
  const headSha = pullRequest.head.sha;
  const labels = pullRequestLabelNames(pullRequest);

  if (labels.has(DISPATCH_LABEL) && !labels.has(REQUESTED_LABEL)) {
    core.setFailed(`CodeRabbit dispatch state is incomplete for ${headSha}; the provider label was preserved because a review may be in flight.`);
    return { status: 'blocked', headSha, reason: 'orphan_native_dispatch' };
  }

  if (labels.has(REQUESTED_LABEL)) {
    const stateReasons = validateAuthorizationState(pullRequest, defaultBranch);
    if (stateReasons.length > 0) {
      return resetCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: `${reasonPrefix}.invalid_live_state: ${stateReasons.join('; ')}`,
      });
    }

    if (labels.has(DISPATCH_LABEL)) {
      // Labels can be managed by triage collaborators. They record dedupe state,
      // not who authorized this review. Only the ready-event route below supplies
      // this head after verifying its actor and live candidate.
      if (!authorizedReadyHeadSha) {
        // NOT a failure since 2026-09-26. A metadata edit or an unrelated label
        // event cannot reconcile a dispatch, and it still changes nothing here —
        // the dispatch state is preserved exactly as before. But reporting it red
        // left a FAILED lifecycle row on the frozen head that no rerun could clear
        // (it replays the same stale event), and that row was what stranded every
        // agent merge (PR #726/#794). A green lifecycle row never attests review
        // delivery; the merge gates read CodeRabbit's exact-head approval directly.
        core.notice(`A CodeRabbit dispatch for ${headSha} is still in flight; this event cannot reconcile it and changed nothing. Re-apply ${READY_LABEL} to reconcile once the review lands.`);
        return { status: 'pending', headSha, reason: 'native_reconciliation_requires_authorized_ready' };
      }
      if (authorizedReadyHeadSha !== headSha || authorizedReadyBaseSha !== pullRequest.base.sha) {
        // A READY event whose own head/base no longer matches the live PR is a
        // genuine refusal: the authorization it carries was for another candidate.
        core.setFailed(`Native review reconciliation requires a fresh authorized ${READY_LABEL} action for head ${headSha}; dispatch state was preserved.`);
        return { status: 'blocked', headSha, reason: 'native_reconciliation_requires_authorized_ready' };
      }
      const baseSha = pullRequest.base.sha;
      const dispatch = await inspectNativeDispatchReceipt({
        github, owner, repo, pullNumber, headSha, baseSha, selfRunId, core,
      });
      if (!dispatch.verified) {
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
        core.setFailed(`Native review receipt could not be verified (${dispatch.error.message}); dispatch state was preserved.`);
        return { status: 'blocked', headSha, reason: 'unverified_native_receipt' };
      }
      const reviewed = await inspectExactHeadCodeRabbitReview({
        github, owner, repo, pullNumber, headSha, requestedAfter: dispatch.receipt.requestedAfter,
      });
      const history = await inspectNativeAttemptHistory({ github, owner, repo, pullNumber, headSha, selfRunId, core,
        activeReceipt: dispatch.receipt });
      if (!history.verified) {
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
        core.setFailed(`Native review history is ambiguous (${history.error.message}); dispatch state was preserved.`);
        return { status: 'blocked', headSha, reason: 'ambiguous_native_history' };
      }
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      if (reviewed.changesRequested) {
        await releaseDeliveredDispatch({ github, owner, repo, pullNumber, core, headSha });
        core.setFailed(`CodeRabbit delivered a review for ${headSha} and requested changes. Fix the findings and push; the new head can earn one follow-up review through ${READY_LABEL} on this same PR.`);
        return { status: 'blocked', headSha, reviewed: true };
      }
      if (reviewed.reviewed) {
        await awaitSettledChecks({ github, owner, repo, pullNumber, headSha, config, core, selfRunId });
        // Re-read the candidate and its provenance-bound checks before
        // accepting the review; a push or label removal can race this event.
        const [confirmationPullRequest, checkBlockers, reviewDecisionBlockers] = await Promise.all([
          getPullRequestWithResolvedMergeability({
            github, owner, repo, pullNumber,
            attempts: config.mergeabilityPollAttempts ?? DEFAULT_MERGEABILITY_POLL_ATTEMPTS,
            pollMs: config.mergeabilityPollMs ?? DEFAULT_MERGEABILITY_POLL_MS,
            settle: config.settle || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
          }),
          collectCheckBlockers({ github, owner, repo, headSha, config, core, selfRunId }),
          collectReviewDecisionBlockers({ github, owner, repo, pullNumber, core, headSha }),
        ]);
        const confirmationLabels = pullRequestLabelNames(confirmationPullRequest);
        const confirmationReasons = validateAuthorizationState(confirmationPullRequest, defaultBranch);
        if (confirmationPullRequest.head.sha !== headSha) {
          confirmationReasons.push('pull request head changed while reconciling the CodeRabbit review');
        }
        if (confirmationPullRequest.base.sha !== baseSha) {
          confirmationReasons.push('pull request base changed while reconciling the CodeRabbit review');
        }
        if (!confirmationLabels.has(REQUESTED_LABEL) || !confirmationLabels.has(DISPATCH_LABEL)) {
          confirmationReasons.push('native dispatch state changed while reconciling the CodeRabbit review');
        }
        confirmationReasons.push(...checkBlockers, ...reviewDecisionBlockers);
        const finalHistory = await inspectNativeAttemptHistory({ github, owner, repo, pullNumber, headSha, selfRunId, core,
          activeReceipt: dispatch.receipt });
        if (!finalHistory.verified) confirmationReasons.push(finalHistory.error.message);
        const candidateMoved = confirmationPullRequest.head.sha !== headSha || confirmationPullRequest.base.sha !== baseSha;
        if (finalHistory.verified && !candidateMoved) {
          await releaseDeliveredDispatch({ github, owner, repo, pullNumber, core, headSha });
        }
        if (confirmationReasons.length > 0) {
          core.setFailed(`CodeRabbit reviewed dispatched head ${headSha}, but ${confirmationReasons.join('; ')}. The receipt was kept and no second review will be posted for this head.`);
          return { status: 'blocked', headSha, reviewed: true };
        }
        core.notice(`CodeRabbit reviewed dispatched frozen head ${headSha}; duplicate event ignored.`);
        return { status: 'reviewed', headSha };
      }
      if (!reviewed.verified) {
        core.setFailed(`Could not verify whether CodeRabbit reviewed dispatched head ${headSha}: ${reviewed.error.message}. The native dispatch state was preserved and no second review will be posted.`);
        return { status: 'blocked', headSha, reviewed: false, reason: reviewed.error.message };
      }
      core.setFailed(`CodeRabbit dispatch remains pending for frozen head ${headSha}; no exact-head review has been observed and no second dispatch will be posted.`);
      return { status: 'pending', headSha, reviewed: false };
    }

    if (config.nativeDispatch === true) {
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      core.setFailed(`CodeRabbit request state is incomplete for ${headSha}; ${REQUESTED_LABEL} was preserved because a prior native dispatch may have been observed.`);
      return { status: 'blocked', headSha, reason: 'incomplete_native_dispatch_state' };
    }

    let markerConfirmed = false;
    try {
      markerConfirmed = await requestedMarkerHasCommand({
        github,
        owner,
        repo,
        pullNumber,
        headSha,
      });
      const confirmationPullRequest = (await github.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      })).data;
      const confirmationLabels = pullRequestLabelNames(confirmationPullRequest);
      const confirmationReasons = validateAuthorizationState(
        confirmationPullRequest,
        defaultBranch,
      );
      if (confirmationPullRequest.head.sha !== headSha) {
        confirmationReasons.push('pull request head changed during label-event reconciliation');
      }
      if (!confirmationLabels.has(REQUESTED_LABEL)) {
        confirmationReasons.push(`${REQUESTED_LABEL} is no longer attached`);
      }
      if (confirmationReasons.length > 0) {
        return resetCandidate({
          github,
          owner,
          repo,
          pullNumber,
          core,
          reason: `${reasonPrefix}.changed_live_state: ${confirmationReasons.join('; ')}`,
        });
      }
    } catch (error) {
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      core.setFailed(`Could not reconcile requested state after a label event (${error.message}); merge authorization was invalidated and the requested marker was preserved for deduplication.`);
      return { status: 'blocked', headSha, reason: error.message };
    }

    if (markerConfirmed) {
      // Marker + command is not proof. Ask the comments whether CodeRabbit
      // actually answered before calling this request confirmed — otherwise this
      // path launders an unheard or unverifiable request into a success on the
      // very next label event, which is the event this gate raises itself.
      const existing = await inspectExistingRequest({
        github, owner, repo, pullNumber, headSha,
      });
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);

      if (existing.acknowledged) {
        core.notice(`Preserved the acknowledged CodeRabbit request for ${headSha} after a label event.`);
        return { status: 'duplicate', headSha, acknowledged: true };
      }

      if (existing.refused) {
        // Heard and declined. The attempt was spent, so the command and marker
        // stay: presenting this as untried would invite another paid attempt.
        core.setFailed(`CodeRabbit refused the review command for ${headSha}; the spent attempt's command and marker were preserved.`);
        return { status: 'blocked', headSha, acknowledged: false, refused: true };
      }

      if (!existing.verified) {
        core.setFailed(`Could not confirm whether CodeRabbit acknowledged the request for ${headSha} (${existing.error?.message || 'lookup failed'}); the command and marker were preserved so a retry cannot buy a second review.`);
        return { status: 'blocked', headSha, acknowledged: false };
      }

      // Confirmed unheard. Same treatment as the request path: clear the pairing
      // so a deliberate retry is possible, and never clear the marker while the
      // command it dedupes still stands.
      let cleared = false;
      try {
        if (existing.commandId) {
          await github.rest.issues.deleteComment({
            owner, repo, comment_id: existing.commandId,
          });
        }
        await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
        cleared = true;
      } catch (cleanupError) {
        core.warning(`Could not clear the unacknowledged request: ${cleanupError.message}`);
      }
      core.setFailed(`CodeRabbit never acknowledged the review command for ${headSha}, so no review was requested${cleared ? '; the command and marker were cleared for a deliberate retry' : ' and the command could not be removed, so the marker was preserved'}.`);
      return { status: 'blocked', headSha, acknowledged: false };
    }
    // A requested marker without a current-head command can be an ambiguous
    // native dispatch. An old, authenticated Actions command is different: it
    // proves this is stale legacy state and can be reset without a new request.
    const legacyCleanup = await deleteReviewCommands({
      github, owner, repo, pullNumber, core,
    });
    if (!legacyCleanup.verified) {
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      core.setFailed(`Could not verify incomplete CodeRabbit request state for ${headSha} (${legacyCleanup.reason}); ${REQUESTED_LABEL} was preserved so a retry cannot buy a second review.`);
      return { status: 'blocked', headSha, reason: legacyCleanup.reason };
    }
    if (legacyCleanup.deleted > 0) {
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
      return resetCandidate({
        github, owner, repo, pullNumber, core, reason: `${reasonPrefix}.stale_state`,
      });
    }
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    core.setFailed(`CodeRabbit request state is incomplete for ${headSha}; ${REQUESTED_LABEL} was preserved because a prior native dispatch may have been observed. Do not relabel until an owner deliberately resets this state.`);
    return { status: 'blocked', headSha, reason: `${reasonPrefix}.incomplete_requested_state` };
  }

  if (labels.has(READY_LABEL)) {
    return resetCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `${reasonPrefix}.unconfirmed_ready_state`,
    });
  }

  return { status: 'ignored', reason: `${reasonPrefix}.no_gate_state` };
}

// `selfRunId` is THIS workflow run. Its own check run is `in_progress` for as
// long as it is doing the evaluating, and evaluateChecks() blocks on any check
// that is not completed — so without this the gate blocks on itself, every time,
// and the ready-label path can never succeed:
//
//   CodeRabbit final review was not requested: final-review-gate: in_progress/no conclusion
//
// Observed on PR #563, run 33716013321, 2026-09-03 — the first candidate ever to
// reach this code (the crash fixed in #573 was standing in front of it). The
// exclusion is by RUN ID, not by name: a run id identifies exactly one run, so
// this can never quietly excuse a different workflow that happens to share a job
// name. A concurrent second run of this same workflow keeps its own id and is
// still treated as a blocker, which is correct — that one really is a pending
// check that has not finished.
async function collectCheckBlockers({ github, owner, repo, headSha, config, core, selfRunId = null }) {
  const [checkRuns, statuses] = await Promise.all([
    // NO mapFn. `checks.listForRef` returns a NAMESPACED list envelope
    // (`{ total_count, check_runs }`), and Octokit's paginate normalizes that
    // before the mapFn ever sees it: `normalizePaginatedListResponse` replaces
    // `response.data` with the inner array itself. So the obvious-looking
    // `(response) => response.data.check_runs` reads a property off an ARRAY,
    // yields `undefined` for every page, and paginate concatenates those into
    // `[undefined, ...]`.
    //
    // The first thing to touch an element is `check.app?.id` in
    // attachRequiredWorkflowProvenance, so the whole gate died with
    // "Cannot read properties of undefined (reading 'app')" — observed on PR
    // #563, run 33707346152, 2026-09-03. Nothing before that had reached this
    // code: it is only called on the ready-label path, and no candidate had
    // ever gotten far enough to request a review, so the CodeRabbit policy had
    // never actually run end to end since #516.
    github.paginate(
      github.rest.checks.listForRef,
      { owner, repo, ref: headSha, filter: 'latest', per_page: 100 },
    ),
    github.paginate(
      github.rest.repos.listCommitStatusesForRef,
      { owner, repo, ref: headSha, per_page: 100 },
    ),
  ]);
  // Drop THIS run's own check before anything evaluates it. Done here rather
  // than in evaluateChecks so the shape guard there still sees the raw list and
  // a malformed entry is still reported, not silently filtered away.
  const observedCheckRuns = Array.isArray(checkRuns) && selfRunId !== null
    ? checkRuns.filter((check) => !(
      check && typeof check === 'object' && actionRunId(check.details_url) === Number(selfRunId)
    ))
    : checkRuns;
  await attachRequiredWorkflowProvenance({
    github,
    owner,
    repo,
    checkRuns: observedCheckRuns,
    requiredChecks: config.requiredChecks,
    core,
  });
  const trustedGateWorkflow = await resolveTrustedGateWorkflowProvenance({
    github,
    owner,
    repo,
    selfRunId,
    core,
  });
  if (trustedGateWorkflow.error) {
    return [`final-review-gate: workflow provenance could not be verified (${trustedGateWorkflow.error})`];
  }
  const retrySafeCheckRuns = Array.isArray(observedCheckRuns)
    ? observedCheckRuns.filter((check) => !isCompletedTrustedGateCheck(check, trustedGateWorkflow))
    : observedCheckRuns;
  return evaluateChecks({
    checkRuns: retrySafeCheckRuns,
    statuses,
    requiredChecks: config.requiredChecks,
    ignoredChecks: config.ignoredChecks,
  });
}

// Checks still running on `headSha`, named. Nothing here DECIDES anything — an
// empty answer only ends the wait in awaitSettledChecks, and the ordinary
// collectCheckBlockers validation still judges every result afterwards. A
// required check that has not reported at all yet counts as running.
async function pendingCheckNames({ github, owner, repo, headSha, config, selfRunId }) {
  const [checkRuns, statuses] = await Promise.all([
    github.paginate(github.rest.checks.listForRef, { owner, repo, ref: headSha, filter: 'latest', per_page: 100 }),
    github.paginate(github.rest.repos.listCommitStatusesForRef, { owner, repo, ref: headSha, per_page: 100 }),
  ]);
  if (!Array.isArray(checkRuns) || !Array.isArray(statuses)) return [];
  const ignored = (config.ignoredChecks || []).filter((policy) => !ignoredCheckConfigBlocker(policy));
  const runs = checkRuns.filter((check) => check && typeof check === 'object'
    && actionRunId(check.details_url) !== Number(selfRunId)
    && !ignored.some((policy) => checkRunMatchesIgnoredPolicy(check, policy)));
  const newestStatuses = [...newestByIdentity(statuses.filter((status) => status && typeof status === 'object'),
    (status) => `${status.context}|creator:${status.creator?.login || 'unknown'}`, ['created_at', 'updated_at']).values()]
    .filter((status) => !ignored.some((policy) => statusMatchesIgnoredPolicy(status, policy)));
  const pending = [
    ...runs.filter((check) => check.status !== 'completed').map((check) => check.name),
    ...newestStatuses.filter((status) => normalize(status.state) === 'pending').map((status) => status.context),
  ];
  for (const required of config.requiredChecks || []) {
    const name = normalize(required?.name);
    const reported = required?.source === 'status'
      ? newestStatuses.some((status) => normalize(status.context) === name)
      : runs.some((check) => normalize(check.name) === name);
    if (name && !reported) pending.push(required.name);
  }
  return [...new Set(pending)];
}

// WAIT for running checks instead of failing on them (autonomous landing,
// 2026-09-26). The lifecycle check used to fail the moment it saw any check in
// progress — and CodeRabbit writing its summary into the PR description was an
// `edited` event that re-ran ci.yml's ~11-minute required jobs, so the review it
// had just delivered was judged against checks that could not have finished
// (PR #794, runs 36091053453 and 36091203653). Fixed at the source in
// .coderabbit.yaml (summary goes in the walkthrough comment), and made robust
// here: any legitimate rerun is now waited out, up to the configured budget.
//
// This only DELAYS. It returns nothing and grants nothing; the caller's ordinary
// validation runs afterwards exactly as before and still blocks on anything that
// is not green. A head change or an unreadable snapshot ends the wait early so
// that validation can report it. Disabled unless the workflow configures
// `checkSettleAttempts`, so a caller that never asked for waiting keeps the old,
// immediate behaviour.
async function awaitSettledChecks({ github, owner, repo, pullNumber, headSha, config, core, selfRunId, settle }) {
  const attempts = Number.isSafeInteger(config.checkSettleAttempts) && config.checkSettleAttempts > 0
    ? config.checkSettleAttempts : 0;
  const pollMs = config.checkSettlePollMs ?? DEFAULT_CHECK_SETTLE_POLL_MS;
  const wait = settle || config.settle || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let pending;
    try {
      const live = (await github.rest.pulls.get({ owner, repo, pull_number: pullNumber })).data;
      if (live.head.sha !== headSha) return;
      pending = await pendingCheckNames({ github, owner, repo, headSha, config, selfRunId });
    } catch (error) {
      core.warning(`Stopped waiting for running checks on ${headSha}: ${error.message}`);
      return;
    }
    if (pending.length === 0) return;
    if (attempt === 0) core.notice(`Waiting for ${pending.join(', ')} to finish on ${headSha} before judging the candidate.`);
    if (pollMs > 0) await wait(pollMs);
  }
}

async function nativeCandidateReasons({ github, context, core, config, headSha, baseSha, dispatched }) {
  const { owner, repo } = context.repo;
  const pullNumber = context.payload.pull_request.number;
  const [pullRequest, checkBlockers, reviewBlockers] = await Promise.all([
    getPullRequestWithResolvedMergeability({
      github, owner, repo, pullNumber,
      attempts: config.mergeabilityPollAttempts ?? DEFAULT_MERGEABILITY_POLL_ATTEMPTS,
      pollMs: config.mergeabilityPollMs ?? DEFAULT_MERGEABILITY_POLL_MS,
      settle: config.settle || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    }),
    collectCheckBlockers({ github, owner, repo, headSha, config, core, selfRunId: context.runId }),
    collectReviewDecisionBlockers({ github, owner, repo, pullNumber, core, headSha }),
  ]);
  const reasons = validateAuthorizationState(pullRequest, context.payload.repository.default_branch);
  const labels = pullRequestLabelNames(pullRequest);
  if (pullRequest.head.sha !== headSha) reasons.push('pull request head changed during native review validation');
  if (!/^[a-f0-9]{40}$/.test(baseSha || '') || pullRequest.base.sha !== baseSha) reasons.push('pull request base changed during native review validation');
  const invalidCandidate = reasons.length > 0;
  if (!labels.has(REQUESTED_LABEL)) reasons.push('requested marker was removed');
  if (dispatched) {
    if (!labels.has(DISPATCH_LABEL)) reasons.push('dispatch label was removed');
  } else {
    if (!labels.has(READY_LABEL)) reasons.push('ready label was removed');
    if (labels.has(DISPATCH_LABEL)) reasons.push('another native dispatch is already present');
  }
  return { reasons: [...reasons, ...checkBlockers, ...reviewBlockers],
    invalidCandidate: invalidCandidate || (dispatched && (!labels.has(REQUESTED_LABEL) || !labels.has(DISPATCH_LABEL))) };
}

async function recoverUndispatchedNativeReceipt({ github, context, core, attemptState, reason }) {
  const { owner, repo } = context.repo;
  const pullNumber = context.payload.pull_request.number;
  const headSha = context.payload.pull_request.head.sha;
  let receipts = [];
  let cleanupStarted = false;
  const confirmProviderAbsent = async () => {
    const live = (await github.rest.pulls.get({ owner, repo, pull_number: pullNumber })).data;
    if (pullRequestLabelNames(live).has(DISPATCH_LABEL)) throw new Error('a provider dispatch label is present');
  };
  try {
    const comments = attemptState.nativeReceiptBody ? await github.paginate(github.rest.issues.listComments,
      { owner, repo, issue_number: pullNumber, per_page: 100 }) : [];
    if (!Array.isArray(comments)) throw new Error('receipt recovery listing was not an array');
    receipts = comments.filter((comment) => parseNativeDispatchReceipt(comment)?.headSha === headSha);
    if (receipts.length > 1 || receipts.some((comment) => comment.body !== attemptState.nativeReceiptBody
      || attemptState.nativePreexistingCommentIds.has(comment.id))) throw new Error('receipt ownership was ambiguous');
    await confirmProviderAbsent();
    for (const receipt of receipts) {
      cleanupStarted = true;
      try { await github.rest.issues.deleteComment({ owner, repo, comment_id: receipt.id }); }
      catch (error) { core.warning(`Receipt removal response failed; verifying absence: ${error.message}`); }
    }
    const remaining = attemptState.nativeReceiptBody ? await github.paginate(github.rest.issues.listComments,
      { owner, repo, issue_number: pullNumber, per_page: 100 }) : [];
    if (!Array.isArray(remaining) || remaining.some((comment) => parseNativeDispatchReceipt(comment)?.headSha === headSha)) {
      throw new Error('receipt removal could not be confirmed');
    }
    await confirmProviderAbsent();
    cleanupStarted = true;
    const failures = await removeLabelsIndependently(github, owner, repo, pullNumber, [REQUESTED_LABEL, READY_LABEL]);
    if (failures.length) throw new Error(`label cleanup failed: ${failures.join('; ')}`);
    await confirmProviderAbsent();
    // Relabelling a PR whose candidate can never be revalidated only repeats this block.
    const nextStep = String(reason).includes(FRESH_PR_GUIDANCE)
      ? `Apply ${READY_LABEL} on the fresh PR once its checks pass; a new commit is unnecessary`
      : String(reason).includes(NEW_EPOCH_GUIDANCE)
        ? `No replacement PR is needed. If this PR predates candidate epochs or its synchronize run failed, push a new commit so the trusted run records it`
        : `Re-apply ${READY_LABEL} after correcting the blocker; a new commit is unnecessary`;
    core.setFailed(`CodeRabbit was not dispatched (${reason}); unspent state was cleared after verified cleanup. ${nextStep}.`);
    return { status: 'blocked', headSha, reason };
  } catch (error) {
    if (cleanupStarted) {
      // A provider write can race either cleanup. Keep a spent/unknown marker
      // and the original receipt evidence. This comment is deliberately NOT a
      // dispatch receipt: recreating its server timestamp could credit a late
      // response to a different request. Ambiguous history remains blocked.
      try { await github.rest.issues.addLabels({ owner, repo, issue_number: pullNumber, labels: [REQUESTED_LABEL] }); }
      catch (restoreError) { core.warning(`Could not restore requested state: ${restoreError.message}`); }
      if (receipts.length) {
        try { await github.rest.issues.createComment({ owner, repo, issue_number: pullNumber,
          body: `Native recovery evidence (not a dispatch receipt or review authorization):\n${JSON.stringify({ headSha, runId: context.runId,
            receipts: receipts.map(({ id, created_at, body }) => ({ id, created_at, body })) })}` }); }
        catch (evidenceError) { core.warning(`Could not preserve recovery evidence: ${evidenceError.message}`); }
      }
    }
    try { await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL); }
    catch (cleanupError) { core.warning(`Could not clear ready state: ${cleanupError.message}`); }
    core.setFailed(`Undispatched native receipt recovery could not be confirmed (${error.message}); remaining deduplication state was preserved. No provider call was attempted.`);
    return { status: 'blocked', headSha, reason: error.message };
  }
}

// A relabel of a head that ALREADY has this epoch's native receipt. Since
// releaseDeliveredDispatch takes the labels back once a review is observed, this
// is the ordinary way to re-check a delivered review — for example after a
// required check that was still running at delivery has gone green. It never
// dispatches: the receipt is the dedupe record, and every attribution rule of the
// label-driven reconciliation applies unchanged (verified receipt, one provider
// label event after it inside this epoch, a review of this exact head submitted
// after the receipt).
async function reconcileDeliveredReceipt({ github, context, core, config, attemptState, headSha, baseSha, settle }) {
  const { owner, repo } = context.repo;
  const pullNumber = context.payload.pull_request.number;
  const dispatch = await inspectNativeDispatchReceipt({
    github, owner, repo, pullNumber, headSha, baseSha, selfRunId: context.runId, core,
  });
  if (!dispatch.verified) {
    return recoverUndispatchedNativeReceipt({ github, context, core, attemptState,
      reason: `this head already has a native attempt that cannot be verified (${dispatch.error.message}); ${FRESH_PR_GUIDANCE}` });
  }
  const history = await inspectNativeAttemptHistory({ github, owner, repo, pullNumber, headSha, selfRunId: context.runId,
    core, activeReceipt: dispatch.receipt });
  if (!history.verified) {
    return recoverUndispatchedNativeReceipt({ github, context, core, attemptState,
      reason: `this head already has a native attempt whose history is ambiguous (${history.error.message})` });
  }
  const reviewed = await inspectExactHeadCodeRabbitReview({
    github, owner, repo, pullNumber, headSha, requestedAfter: dispatch.receipt.requestedAfter,
  });
  if (!reviewed.verified) {
    return recoverUndispatchedNativeReceipt({ github, context, core, attemptState,
      reason: `could not verify whether CodeRabbit reviewed ${headSha} (${reviewed.error.message})` });
  }
  if (!reviewed.reviewed) {
    const failures = await removeLabelsIndependently(github, owner, repo, pullNumber, [READY_LABEL, REQUESTED_LABEL]);
    if (failures.length) core.warning(`Could not clear the ready state: ${failures.join('; ')}`);
    core.setFailed(`CodeRabbit was already asked to review ${headSha} and no review of it has been observed yet; no second review will be requested for this head. Re-apply ${READY_LABEL} once the review lands.`);
    return { status: 'pending', headSha, reviewed: false };
  }
  await awaitSettledChecks({ github, owner, repo, pullNumber, headSha, config, core, selfRunId: context.runId, settle });
  const [live, checkBlockers, reviewDecisionBlockers] = await Promise.all([
    getPullRequestWithResolvedMergeability({
      github, owner, repo, pullNumber,
      attempts: config.mergeabilityPollAttempts ?? DEFAULT_MERGEABILITY_POLL_ATTEMPTS,
      pollMs: config.mergeabilityPollMs ?? DEFAULT_MERGEABILITY_POLL_MS,
      settle,
    }),
    collectCheckBlockers({ github, owner, repo, headSha, config, core, selfRunId: context.runId }),
    collectReviewDecisionBlockers({ github, owner, repo, pullNumber, core, headSha }),
  ]);
  const reasons = validateAuthorizationState(live, context.payload.repository.default_branch);
  if (live.head.sha !== headSha) reasons.push('pull request head changed while reconciling the CodeRabbit review');
  if (live.base.sha !== baseSha) reasons.push('pull request base changed while reconciling the CodeRabbit review');
  if (reviewed.changesRequested) reasons.push('CodeRabbit requested changes on this exact head');
  reasons.push(...checkBlockers, ...reviewDecisionBlockers);
  const failures = await removeLabelsIndependently(github, owner, repo, pullNumber, [READY_LABEL, REQUESTED_LABEL]);
  if (failures.length) core.warning(`Could not clear the ready state: ${failures.join('; ')}`);
  if (reasons.length) {
    core.setFailed(`CodeRabbit reviewed ${headSha}, but ${reasons.join('; ')}. No second review will be requested for this head.`);
    return { status: 'blocked', headSha, reviewed: true };
  }
  core.notice(`CodeRabbit's review of frozen head ${headSha} was reconciled from its receipt; no review was requested. Findings still require disposition; this is not merge clearance.`);
  return { status: 'reviewed', headSha, reviewed: true };
}

async function dispatchNativeReview({ github, context, core, config, attemptState, expectedHeadSha, settle }) {
  attemptState.nativeDispatchStarted = true;
  const { owner, repo } = context.repo;
  const pullNumber = context.payload.pull_request.number;
  const baseSha = context.payload.pull_request.base.sha;
  const candidateArgs = { github, context, core, config, headSha: expectedHeadSha, baseSha };
  // A head that already carries a native receipt is RECONCILED, never dispatched
  // again. This used to be refused outright ("potentially spent native attempt;
  // open a fresh delivery PR") further down.
  const priorComments = await github.paginate(github.rest.issues.listComments,
    { owner, repo, issue_number: pullNumber, per_page: 100 });
  if (!Array.isArray(priorComments)) {
    return recoverUndispatchedNativeReceipt({ github, context, core, attemptState,
      reason: 'the pull request comments could not be listed before dispatch' });
  }
  if (priorComments.some((comment) => parseNativeDispatchReceipt(comment)?.headSha === expectedHeadSha)) {
    return reconcileDeliveredReceipt({ github, context, core, config, attemptState, headSha: expectedHeadSha, baseSha, settle });
  }
  // A prior same-head review lacks attribution to this new head/base request.
  // Require a fresh head instead of laundering it through a new ready event.
  const existing = await inspectExactHeadCodeRabbitReview({ github, owner, repo, pullNumber, headSha: expectedHeadSha });
  if (!existing.verified) {
    return recoverUndispatchedNativeReceipt({ github, context, core, attemptState, reason: `existing CodeRabbit review could not be verified (${existing.error.message})` });
  }
  if (existing.reviewed) {
    return recoverUndispatchedNativeReceipt({ github, context, core, attemptState,
      reason: `a prior same-head review cannot prove this head/base request; ${FRESH_PR_GUIDANCE}` });
  }
  if (!existing.reviewed) {
    // Label creation is deliberate setup, not a side effect of asking for a
    // review. Fail closed if the configured provider label has not been created.
    try {
      const label = await github.rest.issues.getLabel({ owner, repo, name: DISPATCH_LABEL });
      if (label.data?.name !== DISPATCH_LABEL) throw new Error('unexpected provider label identity');
    } catch (error) {
      return recoverUndispatchedNativeReceipt({ github, context, core, attemptState, reason: `configured provider label ${DISPATCH_LABEL} is unavailable (${error.message}); no dispatch was attempted` });
    }
  }
  const validation = await nativeCandidateReasons({ ...candidateArgs, dispatched: false });
  const reasons = validation.reasons;
  if (validation.invalidCandidate) return resetCandidate({ github, owner, repo, pullNumber, core, reason: reasons.join('; ') });
  if (existing.changesRequested) reasons.push('CodeRabbit requested changes on this exact head');
  if (reasons.length) {
    return recoverUndispatchedNativeReceipt({ github, context, core, attemptState, reason: reasons.join('; ') });
  }

  const comments = await github.paginate(github.rest.issues.listComments,
    { owner, repo, issue_number: pullNumber, per_page: 100 });
  if (!Array.isArray(comments) || comments.some((comment) => parseNativeDispatchReceipt(comment)?.headSha === expectedHeadSha)) {
    return recoverUndispatchedNativeReceipt({ github, context, core, attemptState,
      reason: `this head already has a potentially spent native attempt; ${FRESH_PR_GUIDANCE}` });
  }

  const priorHistory = await inspectNativeAttemptHistory({ github, owner, repo, pullNumber, headSha: expectedHeadSha,
    baseSha, selfRunId: context.runId, core });
  if (!priorHistory.verified) return recoverUndispatchedNativeReceipt({ github, context, core, attemptState,
    reason: priorHistory.error.message });
  attemptState.nativePreexistingCommentIds = new Set(comments.map((comment) => comment.id));
  attemptState.nativeReceiptBody = nativeDispatchReceiptBody({ headSha: expectedHeadSha, baseSha, runId: context.runId });
  const receiptResponse = await github.rest.issues.createComment({ owner, repo, issue_number: pullNumber,
    body: attemptState.nativeReceiptBody });
  const receipt = parseNativeDispatchReceipt(receiptResponse.data);
  if (!receipt) throw new Error('native request receipt write was not verified');
  const dispatch = await inspectNativeDispatchReceipt({
    github, owner, repo, pullNumber, headSha: expectedHeadSha, baseSha, selfRunId: context.runId, core,
  });
  const receiptValidation = await nativeCandidateReasons({ ...candidateArgs, dispatched: false });
  const receiptHistory = await inspectNativeAttemptHistory({ github, owner, repo, pullNumber, headSha: expectedHeadSha,
    baseSha, selfRunId: context.runId, core });
  if (!dispatch.verified || !receiptHistory.verified || receiptValidation.reasons.length) {
    return recoverUndispatchedNativeReceipt({ github, context, core, attemptState,
      reason: dispatch.error?.message || receiptHistory.error?.message || receiptValidation.reasons.join('; ') });
  }

  attemptState.dispatchAttempted = true;
  try {
    await github.rest.issues.addLabels({ owner, repo, issue_number: pullNumber, labels: [DISPATCH_LABEL] });
  } catch (error) {
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    core.setFailed(`CodeRabbit dispatch label could not be recorded for ${expectedHeadSha} (${error.message}); ${REQUESTED_LABEL} was preserved so a retry cannot buy a duplicate review.`);
    return { status: 'blocked', headSha: expectedHeadSha, reason: error.message };
  }
  await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);

  // GitHub suppresses recursive Actions runs for GITHUB_TOKEN label writes.
  // Observe the provider here; do not depend on a self-generated label event.
  const attempts = config.reviewPollAttempts ?? 24;
  const pollMs = config.reviewPollMs ?? 15_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (pollMs > 0) await settle(pollMs);
    const live = (await github.rest.pulls.get({ owner, repo, pull_number: pullNumber })).data;
    const liveLabels = pullRequestLabelNames(live);
    const invalid = validateAuthorizationState(live, context.payload.repository.default_branch);
    if (live.head.sha !== expectedHeadSha) invalid.push('head changed after dispatch');
    if (live.base.sha !== baseSha) invalid.push('base changed after dispatch');
    if (invalid.length) return resetCandidate({ github, owner, repo, pullNumber, core,
      reason: `native polling invalidated the candidate: ${invalid.join('; ')}` });
    if (!liveLabels.has(REQUESTED_LABEL) || !liveLabels.has(DISPATCH_LABEL)) invalid.push('native dispatch state changed');
    if (invalid.length) {
      return resetCandidate({ github, owner, repo, pullNumber, core,
        reason: `native polling invalidated dispatch state: ${invalid.join('; ')}` });
    }
    const observed = await inspectExactHeadCodeRabbitReview({ github, owner, repo, pullNumber, headSha: expectedHeadSha, requestedAfter: receipt.requestedAfter });
    if (!observed.verified) {
      core.warning(`Could not observe CodeRabbit review delivery: ${observed.error.message}`);
      continue;
    }
    if (!observed.reviewed) continue;
    const history = await inspectNativeAttemptHistory({ github, owner, repo, pullNumber, headSha: expectedHeadSha,
      selfRunId: context.runId, core, activeReceipt: receipt });
    if (!history.verified) {
      core.setFailed(`Native review history is ambiguous (${history.error.message}); dispatch state was preserved.`);
      return { status: 'blocked', headSha: expectedHeadSha, reason: 'ambiguous_native_history' };
    }
    await awaitSettledChecks({ github, owner, repo, pullNumber, headSha: expectedHeadSha, config, core,
      selfRunId: context.runId, settle });
    const finalValidation = await nativeCandidateReasons({ ...candidateArgs, dispatched: true });
    const finalReasons = finalValidation.reasons;
    if (finalValidation.invalidCandidate) return resetCandidate({ github, owner, repo, pullNumber, core,
      reason: `native final validation invalidated the candidate: ${finalReasons.join('; ')}` });
    if (observed.changesRequested) finalReasons.push('CodeRabbit requested changes on this exact head');
    const finalHistory = await inspectNativeAttemptHistory({ github, owner, repo, pullNumber, headSha: expectedHeadSha,
      selfRunId: context.runId, core, activeReceipt: receipt });
    if (!finalHistory.verified) finalReasons.push(finalHistory.error.message);
    if (finalHistory.verified) await releaseDeliveredDispatch({ github, owner, repo, pullNumber, core, headSha: expectedHeadSha });
    if (finalReasons.length) {
      core.setFailed(`CodeRabbit delivered a review for ${expectedHeadSha}, but ${finalReasons.join('; ')}. The receipt was kept, so no second review will be requested for this head; re-apply ${READY_LABEL} to re-check it once the blocker clears.`);
      return { status: 'blocked', headSha: expectedHeadSha, reviewed: true };
    }
    core.notice(`CodeRabbit delivered a formal review for frozen head ${expectedHeadSha}. Findings still require disposition; this is not merge clearance.`);
    return { status: 'reviewed', headSha: expectedHeadSha, reviewed: true };
  }
  core.setFailed(`CodeRabbit dispatch remains pending for ${expectedHeadSha}: no completed exact-head review was verified within the observation window. Requested and dispatch labels were preserved. After confirming delivery, re-apply ${READY_LABEL} to reconcile without another request.`);
  return { status: 'pending', headSha: expectedHeadSha, reviewed: false };
}

async function runGate({ github, context, core, config, attemptState }) {
  const { owner, repo } = context.repo;
  const action = context.payload.action;
  const pullNumber = context.payload.pull_request.number;
  const quietPeriodMs = config.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
  const mergeabilityPollAttempts = config.mergeabilityPollAttempts
    ?? DEFAULT_MERGEABILITY_POLL_ATTEMPTS;
  const mergeabilityPollMs = config.mergeabilityPollMs ?? DEFAULT_MERGEABILITY_POLL_MS;
  const ackPollAttempts = config.ackPollAttempts ?? DEFAULT_ACK_POLL_ATTEMPTS;
  const ackPollMs = config.ackPollMs ?? DEFAULT_ACK_POLL_MS;
  const settle = config.settle
    || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  if (action === 'opened' && config.nativeDispatch === true) {
    return recordCandidateBirth({ github, context, core });
  }

  const baseBranchChanged = action === 'edited' && Boolean(context.payload.changes?.base);
  const requestedLabelRemoved = action === 'unlabeled'
    && normalize(context.payload.label?.name) === REQUESTED_LABEL;
  const dispatchLabelRemoved = action === 'unlabeled'
    && normalize(context.payload.label?.name) === DISPATCH_LABEL;
  if (RESET_ACTIONS.has(action) || baseBranchChanged || requestedLabelRemoved || dispatchLabelRemoved) {
    const reset = await resetCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: baseBranchChanged
        ? 'pull_request_target.edited.base'
        : requestedLabelRemoved
          ? 'pull_request_target.unlabeled.requested_marker'
          : dispatchLabelRemoved
            ? 'pull_request_target.unlabeled.dispatch_marker'
            : `pull_request_target.${action}`,
    });
    // A push, reopen or retarget makes a NEW candidate on this same PR. Record it
    // only after a clean reset, so an epoch never describes a candidate whose old
    // request state could still be live.
    const newCandidate = action === 'synchronize' || action === 'reopened' || baseBranchChanged;
    if (config.nativeDispatch === true && newCandidate && reset?.status === 'reset') {
      await recordCandidateEpoch({ github, context, core });
    }
    return reset;
  }

  if (action === 'edited') {
    // An edited event can be queued before an in-flight run records its marker.
    // Treat requested state as possibly pre-existing until the live snapshot and
    // command lookup succeed, so recovery never clears a valid dedupe marker
    // based on the older event payload.
    attemptState.requestedMarkerPreexisted = true;
    // Delegate rather than re-implement. This branch used to carry its own copy
    // of the reconciliation sequence and had already lost the confirmation
    // re-read, so a head change or marker removal racing the command lookup was
    // reported as a confirmed duplicate here and as a reset everywhere else.
    return reconcileLabelEvent({
      github,
      owner,
      repo,
      pullNumber,
      core,
      defaultBranch: context.payload.repository.default_branch,
      action,
      label: null,
      config,
      selfRunId: context.runId,
      reasonPrefix: 'pull_request_target.edited',
    });
  }

  const eventLabel = normalize(context.payload.label?.name);
  const isReadyLabelEvent = action === 'labeled' && eventLabel === READY_LABEL;
  if ((action === 'labeled' || action === 'unlabeled') && !isReadyLabelEvent) {
    // This event may have queued before an in-flight gate recorded its marker.
    // Preserve live dedupe state if the first reconciliation read fails rather
    // than trusting the older event payload and enabling a second paid command.
    attemptState.requestedMarkerPreexisted = true;
    return reconcileLabelEvent({
      github,
      owner,
      repo,
      pullNumber,
      core,
      defaultBranch: context.payload.repository.default_branch,
      action,
      label: eventLabel,
      config,
      selfRunId: context.runId,
    });
  }

  if (!isReadyLabelEvent) {
    return { status: 'ignored', reason: `pull_request_target.${action}` };
  }

  const permissionResponse = await github.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: context.actor,
  });
  const permission = normalize(permissionResponse.data.permission);
  if (!ALLOWED_PERMISSIONS.has(permission)) {
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `${context.actor} has ${permission || 'no'} repository permission`,
    });
  }

  const expectedHeadSha = context.payload.pull_request.head.sha;
  const initialPullRequest = await getPullRequestWithResolvedMergeability({
    github,
    owner,
    repo,
    pullNumber,
    attempts: mergeabilityPollAttempts,
    pollMs: mergeabilityPollMs,
    settle,
  });
  const initialReasons = validatePullRequest(
    initialPullRequest,
    context.payload.repository.default_branch,
    expectedHeadSha,
  );
  if (initialReasons.length > 0) {
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: initialReasons.join('; '),
    });
  }

  const labels = pullRequestLabelNames(initialPullRequest);
  if (labels.has(REQUESTED_LABEL) && labels.has(DISPATCH_LABEL)) {
    // A maintainer may re-apply ready after CodeRabbit finishes because a
    // GITHUB_TOKEN label write does not reliably start another workflow run.
    // Reconcile the existing dispatch; never clear it or post a second label.
    return reconcileLabelEvent({
      github,
      owner,
      repo,
      pullNumber,
      core,
      defaultBranch: context.payload.repository.default_branch,
      action,
      label: eventLabel,
      config,
      selfRunId: context.runId,
      authorizedReadyHeadSha: expectedHeadSha,
      authorizedReadyBaseSha: context.payload.pull_request.base.sha,
    });
  }
  if (labels.has(REQUESTED_LABEL)) {
    if (config.nativeDispatch === true) {
      // REQUESTED without DISPATCH is ambiguous native state. The provider may
      // have received a label even if the follow-up read cannot see it, so this
      // must never use the legacy command cleanup and retry path.
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      core.setFailed(`CodeRabbit native request state is incomplete for ${expectedHeadSha}; ${REQUESTED_LABEL} was preserved because a prior dispatch may have been observed. Do not relabel until an owner deliberately resets this state.`);
      return { status: 'blocked', headSha: expectedHeadSha, reason: 'incomplete_native_dispatch_state' };
    }
    try {
      if (await requestedMarkerHasCommand({
        github,
        owner,
        repo,
        pullNumber,
        headSha: expectedHeadSha,
      })) {
        // The SECOND laundering path, and the one that matters most: this is the
        // ready-label route, so it is exactly what an operator relabelling after a
        // refused or unverifiable attempt lands on. Reporting a green `duplicate`
        // here would present a request CodeRabbit never accepted as a completed
        // one. Marker + command is dedupe state; only a reply is proof.
        const existing = await inspectExistingRequest({
          github, owner, repo, pullNumber, headSha: expectedHeadSha,
        });
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);

        if (existing.acknowledged) {
          core.notice(`CodeRabbit already acknowledged a request for ${expectedHeadSha}; duplicate event ignored.`);
          return { status: 'duplicate', headSha: expectedHeadSha, acknowledged: true };
        }
        return blockCandidate({
          github,
          owner,
          repo,
          pullNumber,
          core,
          // blockCandidate removes only the ready label, so the requested marker
          // and its command stay attached here — which is what must happen: the
          // attempt may have been spent, or may still be live.
          reason: existing.refused
            ? `a review command for ${expectedHeadSha} was already posted and CodeRabbit REFUSED it; that attempt was spent, so relabelling cannot buy another — resolve it by hand`
            : existing.verified
              ? `a review command for ${expectedHeadSha} was already posted but CodeRabbit never acknowledged it; relabelling will not make it heard — confirm no review exists for this head, then resolve it by hand`
              : `a review command for ${expectedHeadSha} was already posted and its acknowledgement could not be checked (${existing.error?.message || 'lookup failed'}); the command and marker were preserved so a retry cannot buy a second review`,
        });
      }
      // The marker had no command for THIS head, but the pull request can still
      // carry a superseded head's command from a run this event replaced. Delete
      // any Actions-authored command BEFORE clearing the marker — the ordering
      // resetCandidate uses — or the retry posts a second paid request beside it.
      const supersededCleanup = await deleteReviewCommands({
        github, owner, repo, pullNumber, core,
      });
      if (!supersededCleanup.verified) {
        return blockCandidate({
          github,
          owner,
          repo,
          pullNumber,
          core,
          reason: `${supersededCleanup.reason}; the requested marker was preserved so a relabel cannot buy a second review`,
        });
      }
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
      core.warning('Cleared a requested marker and any superseded review command; retrying the gate.');
    } catch (verificationError) {
      return blockCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: `could not verify the requested marker (${verificationError.message}); the marker was preserved to prevent a duplicate review`,
      });
    }
  }

  // A ready label applied while a check is still running used to be refused on
  // the spot — and the refusal removed the label, so no review was ever
  // requested (PR #780). Wait the running checks out first; the validation below
  // still judges every result.
  await awaitSettledChecks({ github, owner, repo, pullNumber, headSha: expectedHeadSha, config, core,
    selfRunId: context.runId, settle });
  const [checkBlockers, reviewDecisionBlockers] = await Promise.all([
    collectCheckBlockers({
      github,
      owner,
      repo,
      headSha: expectedHeadSha,
      config,
      core,
      selfRunId: context.runId,
    }),
    collectReviewDecisionBlockers({ github, owner, repo, pullNumber, core, headSha: expectedHeadSha }),
  ]);
  const blockers = [...checkBlockers, ...reviewDecisionBlockers];
  if (blockers.length > 0) {
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: blockers.join('; '),
    });
  }

  if (quietPeriodMs > 0) await settle(quietPeriodMs);
  const [
    confirmationPullRequest,
    confirmationCheckBlockers,
    confirmationReviewDecisionBlockers,
  ] = await Promise.all([
    getPullRequestWithResolvedMergeability({
      github,
      owner,
      repo,
      pullNumber,
      attempts: mergeabilityPollAttempts,
      pollMs: mergeabilityPollMs,
      settle,
    }),
    collectCheckBlockers({
      github,
      owner,
      repo,
      headSha: expectedHeadSha,
      config,
      core,
      selfRunId: context.runId,
    }),
    // Re-read after the quiet period: a reviewer can submit CHANGES_REQUESTED
    // during it, and this confirmation pass exists precisely to catch state that
    // moved between the first snapshot and the post.
    collectReviewDecisionBlockers({ github, owner, repo, pullNumber, core, headSha: expectedHeadSha }),
  ]);
  const confirmationReasons = validatePullRequest(
    confirmationPullRequest,
    context.payload.repository.default_branch,
    expectedHeadSha,
  );
  confirmationReasons.push(...confirmationCheckBlockers);
  confirmationReasons.push(...confirmationReviewDecisionBlockers);
  if (confirmationReasons.length > 0) {
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: confirmationReasons.join('; '),
    });
  }

  let commentsBeforeAttempt;
  try {
    commentsBeforeAttempt = await github.paginate(
      github.rest.issues.listComments,
      { owner, repo, issue_number: pullNumber, per_page: 100 },
    );
  } catch (snapshotError) {
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `could not snapshot existing review comments (${snapshotError.message})`,
    });
  }
  const preexistingCommentIds = new Set(commentsBeforeAttempt.map((comment) => comment.id));
  attemptState.preexistingCommentIds = preexistingCommentIds;
  try {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pullNumber,
      labels: [REQUESTED_LABEL],
    });
  } catch (markerError) {
    let cleanupNote = '';
    try {
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
    } catch (cleanupError) {
      cleanupNote = `; requested-marker cleanup also failed (${cleanupError.message})`;
    }
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `could not record the review-request marker (${markerError.message})${cleanupNote}`,
    });
  }

  let finalPullRequest;
  let finalCheckBlockers;
  let finalReviewDecisionBlockers;
  try {
    [finalPullRequest, finalCheckBlockers, finalReviewDecisionBlockers] = await Promise.all([
      getPullRequestWithResolvedMergeability({
        github,
        owner,
        repo,
        pullNumber,
        attempts: mergeabilityPollAttempts,
        pollMs: mergeabilityPollMs,
        settle,
      }),
      collectCheckBlockers({
        github,
        owner,
        repo,
        headSha: expectedHeadSha,
        config,
        core,
        selfRunId: context.runId,
      }),
      // The LAST look before the command goes out. Checking the review decision
      // only in the two earlier snapshots left a window — the mergeability poll and
      // the marker write both happen after them — in which an objection could land
      // and still cost a review slot.
      collectReviewDecisionBlockers({ github, owner, repo, pullNumber, core, headSha: expectedHeadSha }),
    ]);
  } catch (finalSnapshotError) {
    let cleanupNote = '';
    try {
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
    } catch (cleanupError) {
      cleanupNote = `; requested-marker cleanup also failed (${cleanupError.message})`;
    }
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `could not complete the final candidate snapshot (${finalSnapshotError.message})${cleanupNote}`,
    });
  }
  const finalReasons = validatePullRequest(
    finalPullRequest,
    context.payload.repository.default_branch,
    expectedHeadSha,
  );
  // Workflow runs QUEUE rather than cancel, so a maintainer who removes the
  // requested marker to abort an in-flight request would otherwise still get the
  // command posted before the queued reset runs — spending a review that was
  // deliberately cancelled. The marker must still be attached at both final
  // validations, not just the ready label.
  finalReasons.push(...requestedMarkerStillAttached(finalPullRequest));
  finalReasons.push(...finalCheckBlockers);
  finalReasons.push(...finalReviewDecisionBlockers);
  if (finalReasons.length > 0) {
    await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: finalReasons.join('; '),
    });
  }

  if (config.nativeDispatch === true) {
    return dispatchNativeReview({ github, context, core, config, attemptState, expectedHeadSha, settle });
  }

  let createdComment;
  let recoveredCommand = false;
  try {
    const commentResponse = await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: reviewCommandBody(expectedHeadSha),
    });
    createdComment = commentResponse.data;
  } catch (commentError) {
    let recoveredComment = null;
    // A CONFIRMED absence and an UNVERIFIABLE lookup are different states and
    // must not share a branch. If the lookup itself failed we do not know
    // whether GitHub accepted the command, so clearing the dedupe marker would
    // invite a relabel that posts a SECOND paid review for the same head. The
    // outer recovery path already draws this distinction; this one did not.
    let verificationSucceeded = false;
    try {
      const comments = await github.paginate(
        github.rest.issues.listComments,
        { owner, repo, issue_number: pullNumber, per_page: 100 },
      );
      recoveredComment = comments.find((comment) => (
        !preexistingCommentIds.has(comment.id)
        && isActionsReviewComment(comment, expectedHeadSha)
      )) || null;
      verificationSucceeded = true;
    } catch (verificationError) {
      core.warning(`Could not verify the failed comment request: ${verificationError.message}`);
    }

    if (!recoveredComment) {
      if (verificationSucceeded) {
        await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
      }
      return blockCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: verificationSucceeded
          ? `GitHub did not confirm the review comment (${commentError.message}); the requested marker was cleared for a deliberate retry`
          : `GitHub did not confirm the review comment (${commentError.message}) and the follow-up lookup also failed; the requested marker was preserved so a retry cannot buy a second review`,
      });
    }

    // A recovered command is a POSTED command; it earns exactly the same
    // post-comment revalidation as one GitHub confirmed. Returning here used to
    // skip it, so a head/base/auto-merge/check change racing the ambiguous post
    // left the command standing and spent a review on an unfrozen candidate.
    core.warning('GitHub reported a comment error, but the exact command comment exists; revalidating the candidate before crediting it.');
    createdComment = recoveredComment;
    recoveredCommand = true;
  }

  let postCommentPullRequest;
  let postCommentCheckBlockers;
  try {
    [postCommentPullRequest, postCommentCheckBlockers] = await Promise.all([
      getPullRequestWithResolvedMergeability({
        github,
        owner,
        repo,
        pullNumber,
        attempts: mergeabilityPollAttempts,
        pollMs: mergeabilityPollMs,
        settle,
      }),
      collectCheckBlockers({
        github,
        owner,
        repo,
        headSha: expectedHeadSha,
        config,
        core,
        selfRunId: context.runId,
      }),
    ]);
  } catch (postCommentSnapshotError) {
    let cleanupNote = '';
    try {
      await github.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: createdComment.id,
      });
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
    } catch (cleanupError) {
      cleanupNote = `; raced-command cleanup also failed (${cleanupError.message})`;
    }
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `could not complete the post-comment candidate snapshot (${postCommentSnapshotError.message})${cleanupNote}`,
    });
  }
  const postCommentReasons = validatePullRequest(
    postCommentPullRequest,
    context.payload.repository.default_branch,
    expectedHeadSha,
  );
  postCommentReasons.push(...requestedMarkerStillAttached(postCommentPullRequest));
  postCommentReasons.push(...postCommentCheckBlockers);
  if (postCommentReasons.length > 0) {
    try {
      await github.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: createdComment.id,
      });
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
    } catch (cleanupError) {
      core.warning(`Could not remove the raced review command; preserving dedupe state: ${cleanupError.message}`);
    }
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `pull request changed while the review command was being posted; ${postCommentReasons.join('; ')}`,
    });
  }
  // The command is posted and the candidate is still valid. That is NOT yet a
  // requested review — see awaitCodeRabbitAcknowledgement above for why.
  //
  // RESIDUAL, and the honest limit of this check: the acknowledgement is bound to
  // the command by AUTHOR, by ORDER (it must be the first CodeRabbit comment after
  // it) and by TIME (inside the window), but not CAUSALLY. CodeRabbit's reply does
  // not name the head or the command it answers, and its documentation defines no
  // acknowledgement contract, so a reply to some other action arriving first in
  // that window would be misread. What this check does prove is the thing that was
  // actually broken and silently false for months: that the command was HEARD
  // rather than dropped for being bot-authored.
  //
  // It deliberately does NOT try to prove a review of this exact head exists. That
  // proof is head-bound and belongs where it already lives — the merge gate, which
  // must match a CodeRabbit review's commit_id to the final head. Widening this
  // 30-second poll into a review-existence check would take minutes and would
  // duplicate a gate that already exists.
  const acknowledgement = await awaitCodeRabbitAcknowledgement({
    github,
    owner,
    repo,
    pullNumber,
    sinceCommentId: createdComment.id,
    attempts: ackPollAttempts,
    pollMs: ackPollMs,
    settle,
    core,
  });

  if (!acknowledgement.acknowledged) {
    if (acknowledgement.refused) {
      // CodeRabbit HEARD the command and declined it. Measured behaviour: a
      // refusal still costs the attempt. So this is the one non-acknowledged
      // outcome where the command and marker must STAY — deleting them would
      // present a spent attempt as though nothing had been tried, and the next
      // relabel would spend another.
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      return blockCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: `CodeRabbit REFUSED the review command for ${expectedHeadSha} (it replied, but declined); the attempt was still spent, so the command and requested marker were preserved rather than presenting this as an untried candidate`,
      });
    }
    if (!acknowledgement.verified) {
      // UNVERIFIABLE, not absent. Keep the command and the dedupe marker exactly
      // as they are: the request may be live, and clearing the marker here would
      // let a relabel buy a second paid review for the same head. The ready label
      // still comes off, because this candidate is not awaiting another attempt.
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      return blockCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: `the review command was posted but CodeRabbit's acknowledgement could not be checked (${acknowledgement.error?.message || 'lookup failed'}); the command and the requested marker were preserved so a retry cannot buy a second review — confirm by hand whether a review exists for ${expectedHeadSha} before relabelling`,
      });
    }

    // CONFIRMED unheard after the full window. Clear the command and marker so the
    // next attempt is a genuine one.
    //
    // RESIDUAL, stated rather than buried: deleting the comment cannot revoke an
    // event CodeRabbit may already be processing. If it answers after the window
    // closes and someone then relabels, two paid reviews are possible. The window
    // is sized so that gap is narrow — every acknowledgement ever measured here
    // arrived inside 11s, against a 30s wait — and it cannot be closed by waiting,
    // only narrowed. It is why the failure message tells the operator to confirm no
    // review exists for this head before relabelling, and why the ready-label path
    // now refuses to re-post over an existing command rather than quietly adding a
    // second one.
    let cleanupNote = '';
    let markerCleared = false;
    try {
      await github.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: createdComment.id,
      });
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
      markerCleared = true;
    } catch (cleanupError) {
      // Never clear the marker while its command may still stand — that pairing is
      // what prevents a duplicate paid review.
      cleanupNote = `; the posted command could not be removed (${cleanupError.message}), so the requested marker was preserved and a relabel will be treated as a duplicate`;
    }
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `CodeRabbit did not acknowledge the review command for ${expectedHeadSha} within the acknowledgement window, so no review was requested${markerCleared ? ' and the command and requested marker were cleared for a deliberate retry' : ''}${cleanupNote}. Before relabelling, confirm no review already exists for this head — a late acknowledgement cannot be revoked by deleting the comment`,
    });
  }

  // The acknowledgement wait is up to 30 seconds of real time AFTER the last state
  // snapshot. A head change, a newly failing check, a removed label, auto-merge
  // being switched on, or a CHANGES_REQUESTED verdict inside that window would
  // otherwise be reported as a clean success on a candidate that had already
  // stopped being one. Re-read before crediting.
  let settledPullRequest;
  let settledCheckBlockers;
  let settledReviewDecisionBlockers;
  try {
    [settledPullRequest, settledCheckBlockers, settledReviewDecisionBlockers] = await Promise.all([
      getPullRequestWithResolvedMergeability({
        github,
        owner,
        repo,
        pullNumber,
        attempts: mergeabilityPollAttempts,
        pollMs: mergeabilityPollMs,
        settle,
      }),
      collectCheckBlockers({
        github,
        owner,
        repo,
        headSha: expectedHeadSha,
        config,
        core,
        selfRunId: context.runId,
      }),
      collectReviewDecisionBlockers({ github, owner, repo, pullNumber, core, headSha: expectedHeadSha }),
    ]);
  } catch (settledSnapshotError) {
    // The review IS requested and acknowledged at this point — that cannot be
    // undone, and the command must stay so a relabel cannot buy a second one. Only
    // the verdict is withheld.
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `CodeRabbit acknowledged the review for ${expectedHeadSha}, but the candidate could not be re-verified afterwards (${settledSnapshotError.message}); the command and marker were preserved — re-check the candidate by hand`,
    });
  }

  const settledReasons = validatePullRequest(
    settledPullRequest,
    context.payload.repository.default_branch,
    expectedHeadSha,
  );
  settledReasons.push(...requestedMarkerStillAttached(settledPullRequest));
  settledReasons.push(...settledCheckBlockers);
  settledReasons.push(...settledReviewDecisionBlockers);
  if (settledReasons.length > 0) {
    // Deliberately NOT deleting the command here: CodeRabbit has already accepted
    // it, so the review is spent whether or not the comment survives. Removing it
    // would make the next relabel look untried and buy a second one.
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    return blockCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `CodeRabbit acknowledged the review for ${expectedHeadSha}, but the candidate changed while waiting for that acknowledgement, so the review no longer covers a valid frozen candidate; ${settledReasons.join('; ')}`,
    });
  }

  await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
  core.notice(`Requested one CodeRabbit review for frozen head ${expectedHeadSha}; CodeRabbit acknowledged it. This proves the command was HEARD, not that a review of this exact head exists — the merge gate still has to match a review's commit_id to the final head.`);
  return recoveredCommand
    ? { status: 'requested', headSha: expectedHeadSha, recovered: true, acknowledged: true }
    : { status: 'requested', headSha: expectedHeadSha, acknowledged: true };
}

async function run(args) {
  // Review events are NOT handled here. `pull_request_review` would run this
  // workflow from the pull request's own ref rather than the default branch,
  // handing PR-authored steps this job's `issues: write` token — see the header
  // comment in .github/workflows/coderabbit-final-review.yml. The trigger is
  // gone, so this entry point only ever sees `pull_request_target`. Fail loudly
  // rather than silently reconciling if that assumption is ever broken.
  if (args.context.eventName !== 'pull_request_target') {
    args.core.setFailed(
      `CodeRabbit final review gate refuses to run on "${args.context.eventName}": this privileged `
      + 'workflow is pull_request_target-only, because any other pull-request event would source '
      + 'its steps from the pull request itself. Remove that trigger.',
    );
    return { status: 'blocked', reason: `unsupported event ${args.context.eventName}` };
  }
  const attemptState = {
    preexistingCommentIds: null,
    requestedMarkerPreexisted: pullRequestLabelNames(args.context.payload.pull_request)
      .has(REQUESTED_LABEL),
  };
  try {
    return await runGate({ ...args, attemptState });
  } catch (unexpectedError) {
    const {
      github, context, core,
    } = args;
    const { owner, repo } = context.repo;
    const pullNumber = context.payload.pull_request.number;
    const headSha = context.payload.pull_request.head.sha;
    // Log the STACK before any recovery work. `setFailed` below reports only
    // `error.message`, and a bare "Cannot read properties of undefined (reading
    // 'app')" names neither the file nor the line: the repo-wide gate crash of
    // 2026-09-03 (PR #563, run 33707346152) cost hours of bisecting for want of
    // these few frames. Emit it first so it survives even if the recovery path
    // below throws on its way out.
    core.error(
      'CodeRabbit final review gate crashed internally (this is a bug in the gate, not a '
      + `problem with the pull request): ${unexpectedError && unexpectedError.stack
        ? unexpectedError.stack
        : String(unexpectedError)}`,
    );
    if (attemptState.dispatchAttempted) {
      // Once addLabels was attempted, neither a missing legacy comment nor an
      // empty comment listing proves CodeRabbit did not see the provider label.
      // Preserve the marker and let a deliberate owner reset decide any retry.
      try {
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      } catch (cleanupError) {
        core.warning(`Could not clear ready state after a native dispatch failure: ${cleanupError.message}`);
      }
      core.setFailed(`CodeRabbit native dispatch failed unexpectedly for ${headSha} (${unexpectedError.message}); ${REQUESTED_LABEL} was preserved because the provider may have observed ${DISPATCH_LABEL}.`);
      return { status: 'blocked', headSha, reason: unexpectedError.message };
    }
    if (attemptState.nativeDispatchStarted) return recoverUndispatchedNativeReceipt({
      github, context, core, attemptState, reason: unexpectedError.message,
    });
    let verificationSucceeded = false;
    let commandCommentExists = false;

    if (attemptState.preexistingCommentIds === null) {
      // The current attempt cannot have posted a command before its comment
      // snapshot — but the QUEUED payload is not evidence of that. A ready-label
      // event can queue behind an earlier run and carry a payload predating that
      // run's marker; trusting it here clears a marker whose command is live, and
      // the next relabel buys a second paid review. Metadata and unrelated-label
      // events already force the conservative value; read the LIVE labels so every
      // path is accurate, and preserve the marker when that read fails.
      try {
        const livePullRequest = (await github.rest.pulls.get({
          owner, repo, pull_number: pullNumber,
        })).data;
        verificationSucceeded = !pullRequestLabelNames(livePullRequest).has(REQUESTED_LABEL);
      } catch (liveStateError) {
        core.warning(`Could not read live gate state after an unexpected gate failure: ${liveStateError.message}`);
        verificationSucceeded = false;
      }
    } else {
      try {
        const comments = await github.paginate(
          github.rest.issues.listComments,
          { owner, repo, issue_number: pullNumber, per_page: 100 },
        );
        commandCommentExists = comments.some((comment) => (
          !attemptState.preexistingCommentIds.has(comment.id)
          && isActionsReviewComment(comment, headSha)
        ));
        verificationSucceeded = true;
      } catch (verificationError) {
        core.warning(`Could not verify recovery after an unexpected gate failure: ${verificationError.message}`);
      }
    }

    if (commandCommentExists) {
      const recoveredCleanupFailures = await removeLabelsIndependently(
        github, owner, repo, pullNumber, [READY_LABEL],
      );
      core.warning(`Recovered an exact review command after an unexpected gate failure: ${unexpectedError.message}`);
      if (recoveredCleanupFailures.length > 0) {
        core.warning(`Could not clear workflow labels after recovery: ${recoveredCleanupFailures.join('; ')}`);
      }
      // The THIRD place "a command exists" was being read as "a review was
      // requested". Crashing after a refusal or an unverifiable poll would
      // otherwise recover as a success and undo the whole acknowledgement check —
      // the crash path is precisely when the gate knows least, so it is the last
      // place that should be optimistic. The command and marker are left attached
      // either way; only the reported outcome differs.
      const recoveredAcknowledgement = await inspectExistingRequest({
        github, owner, repo, pullNumber, headSha,
      });
      if (recoveredAcknowledgement.acknowledged) {
        return {
          status: 'requested', headSha, recovered: true, acknowledged: true,
        };
      }
      core.setFailed(`The gate crashed after posting a review command for ${headSha} (${unexpectedError.message}) and CodeRabbit's acknowledgement ${recoveredAcknowledgement.verified ? 'was never observed' : 'could not be checked'}; the command and requested marker were preserved, so confirm by hand whether a review exists for this head before relabelling.`);
      return {
        status: 'blocked', headSha, recovered: true, acknowledged: false,
      };
    }

    // READY_LABEL is cleared deliberately, on an internal crash included. It
    // LOOKS like the gate is discarding the operator's intent on its own bug,
    // and it was raised as a possible defect — but leaving the label attached
    // would WEDGE the pull request: GitHub fires no `labeled` event for a label
    // that is already present, so an operator could never retry by re-applying
    // it (see removeLabelsIndependently). Clearing it is what MAKES the retry
    // possible. The defect this crash exposed was never the clearing; it was
    // that the run said nothing useful about why. Hence the stack above and the
    // operator note below, not a preserved label that triggers nothing.
    const labelsToClear = verificationSucceeded
      ? [REQUESTED_LABEL, READY_LABEL]
      : [READY_LABEL];
    const cleanupFailures = await removeLabelsIndependently(
      github, owner, repo, pullNumber, labelsToClear,
    );
    const markerNote = verificationSucceeded
      ? 'workflow labels were cleared for a deliberate retry'
      : 'the requested marker was preserved until a retry can verify whether a command landed';
    const cleanupNote = cleanupFailures.length > 0
      ? `; workflow label cleanup failed for ${cleanupFailures.join('; ')} — remove the labels by hand before relabelling`
      : '';
    core.setFailed(
      `CodeRabbit final review gate failed unexpectedly (${unexpectedError.message}); `
      + `${markerNote}${cleanupNote}. This is an internal gate error, not a blocked candidate — `
      + 'the full stack trace is in this run\'s error annotation; fix the gate, then re-apply '
      + `${READY_LABEL} to retry.`,
    );
    return { status: 'blocked', reason: unexpectedError.message };
  }
}

module.exports = {
  ACCEPTABLE_CHECK_CONCLUSIONS,
  DISPATCH_LABEL,
  READY_LABEL,
  REQUESTED_LABEL,
  REVIEW_COMMAND,
  evaluateChecks,
  reviewCommandBody,
  nativeDispatchReceiptBody,
  candidateBirthBody,
  candidateEpochBody,
  run,
  validateAuthorizationState,
  validatePullRequest,
};
