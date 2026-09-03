'use strict';

const READY_LABEL = 'ready-for-coderabbit';
const REQUESTED_LABEL = 'coderabbit-review-requested';
const REVIEW_COMMAND = '@coderabbitai review';
const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
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
    github, owner, repo, pullNumber, [READY_LABEL, REQUESTED_LABEL],
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

// The single reconciliation routine. Every event that must re-derive gate state
// from the LIVE pull request goes through here — label events and metadata
// edits alike. `reasonPrefix` is the only thing that varied between the former
// copies, and the copies had already diverged: the `edited` one omitted the
// post-lookup confirmation re-read below, so a head change or marker removal
// racing the lookup was reported as a confirmed duplicate instead of a reset.
async function reconcileLabelEvent({
  github, owner, repo, pullNumber, core, defaultBranch, action, label, reasonPrefix: prefixOverride,
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
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      core.notice(`Preserved the confirmed CodeRabbit request for ${headSha} after a label event.`);
      return { status: 'duplicate', headSha };
    }
    return resetCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `${reasonPrefix}.stale_state`,
    });
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

async function collectCheckBlockers({ github, owner, repo, headSha, config, core }) {
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
  await attachRequiredWorkflowProvenance({
    github,
    owner,
    repo,
    checkRuns,
    requiredChecks: config.requiredChecks,
    core,
  });
  return evaluateChecks({
    checkRuns,
    statuses,
    requiredChecks: config.requiredChecks,
    ignoredChecks: config.ignoredChecks,
  });
}

async function runGate({ github, context, core, config, attemptState }) {
  const { owner, repo } = context.repo;
  const action = context.payload.action;
  const pullNumber = context.payload.pull_request.number;
  const quietPeriodMs = config.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
  const mergeabilityPollAttempts = config.mergeabilityPollAttempts
    ?? DEFAULT_MERGEABILITY_POLL_ATTEMPTS;
  const mergeabilityPollMs = config.mergeabilityPollMs ?? DEFAULT_MERGEABILITY_POLL_MS;
  const settle = config.settle
    || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  const baseBranchChanged = action === 'edited' && Boolean(context.payload.changes?.base);
  const requestedLabelRemoved = action === 'unlabeled'
    && normalize(context.payload.label?.name) === REQUESTED_LABEL;
  if (RESET_ACTIONS.has(action) || baseBranchChanged || requestedLabelRemoved) {
    return resetCandidate({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: baseBranchChanged
        ? 'pull_request_target.edited.base'
        : requestedLabelRemoved
          ? 'pull_request_target.unlabeled.requested_marker'
          : `pull_request_target.${action}`,
    });
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
  if (labels.has(REQUESTED_LABEL)) {
    try {
      if (await requestedMarkerHasCommand({
        github,
        owner,
        repo,
        pullNumber,
        headSha: expectedHeadSha,
      })) {
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
        core.notice(`CodeRabbit was already requested for ${expectedHeadSha}; duplicate event ignored.`);
        return { status: 'duplicate', headSha: expectedHeadSha };
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

  const blockers = await collectCheckBlockers({
    github,
    owner,
    repo,
    headSha: expectedHeadSha,
    config,
    core,
  });
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
  const [confirmationPullRequest, confirmationCheckBlockers] = await Promise.all([
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
    }),
  ]);
  const confirmationReasons = validatePullRequest(
    confirmationPullRequest,
    context.payload.repository.default_branch,
    expectedHeadSha,
  );
  confirmationReasons.push(...confirmationCheckBlockers);
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
  try {
    [finalPullRequest, finalCheckBlockers] = await Promise.all([
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
      }),
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
  await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
  core.notice(`Requested one CodeRabbit review for frozen head ${expectedHeadSha}.`);
  return recoveredCommand
    ? { status: 'requested', headSha: expectedHeadSha, recovered: true }
    : { status: 'requested', headSha: expectedHeadSha };
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
      return {
        status: 'requested', headSha, recovered: true,
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
  READY_LABEL,
  REQUESTED_LABEL,
  REVIEW_COMMAND,
  evaluateChecks,
  reviewCommandBody,
  run,
  validateAuthorizationState,
  validatePullRequest,
};
