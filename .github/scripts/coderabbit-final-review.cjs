'use strict';

const READY_LABEL = 'ready-for-coderabbit';
const REQUESTED_LABEL = 'coderabbit-review-requested';
const REVIEW_COMMAND = '@coderabbitai review';
const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const CODERABBIT_BOT_LOGIN = 'coderabbitai[bot]';
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

function evaluateChecks({ checkRuns, statuses, requiredChecks, ignoredChecks = [] }) {
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
  return resetLabels({ github, owner, repo, pullNumber, core, reason });
}

async function blockCandidate({ github, owner, repo, pullNumber, core, reason }) {
  await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
  core.setFailed(`CodeRabbit final review was not requested: ${reason}`);
  return { status: 'blocked', reason };
}

function validatePullRequest(pullRequest, defaultBranch, expectedHeadSha) {
  const reasons = [];
  const labels = pullRequestLabelNames(pullRequest);

  if (pullRequest.state !== 'open') reasons.push('pull request is not open');
  if (pullRequest.draft) reasons.push('pull request is still a draft');
  if (!labels.has(READY_LABEL)) reasons.push(`${READY_LABEL} is no longer attached`);
  if (pullRequest.base.ref !== defaultBranch) {
    reasons.push(`base branch is ${pullRequest.base.ref}, not ${defaultBranch}`);
  }
  if (pullRequest.auto_merge) reasons.push('auto-merge is enabled');
  if (pullRequest.mergeable !== true || pullRequest.mergeable_state === 'unknown') {
    reasons.push('GitHub has not confirmed that the pull request is mergeable');
  }
  if (pullRequest.mergeable_state === 'dirty') {
    reasons.push('pull request has merge conflicts');
  }
  if (pullRequest.mergeable_state === 'behind') {
    reasons.push('pull request branch is behind the base branch');
  }
  if (pullRequest.head.sha !== expectedHeadSha) {
    reasons.push('pull request head changed after the ready label was applied');
  }

  return reasons;
}

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
  const candidates = checkRuns.filter((check) => workflowAppIds.has(Number(check.app?.id)));

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

async function requestedMarkerHasCommand({ github, owner, repo, pullNumber, headSha }) {
  const comments = await github.paginate(
    github.rest.issues.listComments,
    { owner, repo, issue_number: pullNumber, per_page: 100 },
  );
  return comments.some((comment) => isActionsReviewComment(comment, headSha));
}

async function reconcileLabelEvent({
  github, owner, repo, pullNumber, core, defaultBranch, action, label,
}) {
  const reasonPrefix = `pull_request_target.${action}.${normalize(label) || 'unknown_label'}`;
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
    github.paginate(
      github.rest.checks.listForRef,
      { owner, repo, ref: headSha, filter: 'latest', per_page: 100 },
      (response) => response.data.check_runs,
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
    const editedPullRequest = (await github.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    })).data;
    const editedHeadSha = editedPullRequest.head.sha;
    const editedLabels = pullRequestLabelNames(editedPullRequest);

    if (editedLabels.has(REQUESTED_LABEL)) {
      const editedStateReasons = validateAuthorizationState(
        editedPullRequest,
        context.payload.repository.default_branch,
      );
      if (editedStateReasons.length > 0) {
        return resetCandidate({
          github,
          owner,
          repo,
          pullNumber,
          core,
          reason: `pull_request_target.edited.invalid_live_state: ${editedStateReasons.join('; ')}`,
        });
      }
      let markerConfirmed = false;
      try {
        markerConfirmed = await requestedMarkerHasCommand({
          github,
          owner,
          repo,
          pullNumber,
          headSha: editedHeadSha,
        });
      } catch (error) {
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
        core.setFailed(`Could not revalidate the requested marker after a PR edit (${error.message}); merge authorization was invalidated and the requested marker was preserved for deduplication.`);
        return { status: 'blocked', headSha: editedHeadSha, reason: error.message };
      }
      if (markerConfirmed) {
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
        core.notice(`Preserved the confirmed CodeRabbit request for ${editedHeadSha} after a metadata edit.`);
        return { status: 'duplicate', headSha: editedHeadSha };
      }
      return resetCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: 'pull_request_target.edited.stale_state',
      });
    }

    if (editedLabels.has(READY_LABEL)) {
      return resetCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: 'pull_request_target.edited.unconfirmed_ready_state',
      });
    }

    return { status: 'ignored', reason: 'pull_request_target.edited.no_gate_state' };
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
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
      core.warning('Cleared a requested marker that had no matching GitHub Actions review command; retrying the gate.');
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
    try {
      const comments = await github.paginate(
        github.rest.issues.listComments,
        { owner, repo, issue_number: pullNumber, per_page: 100 },
      );
      recoveredComment = comments.find((comment) => (
        !preexistingCommentIds.has(comment.id)
        && isActionsReviewComment(comment, expectedHeadSha)
      )) || null;
    } catch (verificationError) {
      core.warning(`Could not verify the failed comment request: ${verificationError.message}`);
    }

    if (!recoveredComment) {
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
      return blockCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: `GitHub did not confirm the review comment (${commentError.message}); the requested marker was cleared for a deliberate retry`,
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

async function blockCodeRabbitAuthorizationAndReset({
  github, owner, repo, pullNumber, core, headSha, reason,
}) {
  await resetCandidate({
    github,
    owner,
    repo,
    pullNumber,
    core,
    reason: `pull_request_review.coderabbit.stale_state: ${reason}`,
  });
  core.setFailed(`CodeRabbit final review evidence is not acceptable: ${reason}; stale gate state was reset.`);
  return { status: 'blocked', headSha, reason };
}

async function blockCodeRabbitAuthorizationAndReconcile({
  github, owner, repo, pullNumber, core, pullRequest, reason,
}) {
  const headSha = pullRequest.head.sha;
  const labels = pullRequestLabelNames(pullRequest);

  if (!labels.has(REQUESTED_LABEL)) {
    return blockCodeRabbitAuthorizationAndReset({
      github, owner, repo, pullNumber, core, headSha, reason,
    });
  }

  let markerConfirmed;
  try {
    markerConfirmed = await requestedMarkerHasCommand({
      github,
      owner,
      repo,
      pullNumber,
      headSha,
    });
  } catch (error) {
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    core.setFailed(`CodeRabbit final review evidence is not acceptable: ${reason}; the current-head request could not be verified (${error.message}), so its marker was preserved to prevent a duplicate paid review.`);
    return { status: 'blocked', headSha, reason };
  }

  let confirmationPullRequest;
  try {
    confirmationPullRequest = (await github.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    })).data;
  } catch (error) {
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    core.setFailed(`CodeRabbit final review evidence is not acceptable: ${reason}; the current-head request could not be confirmed (${error.message}), so its marker was preserved to prevent a duplicate paid review.`);
    return { status: 'blocked', headSha, reason };
  }

  const confirmationLabels = pullRequestLabelNames(confirmationPullRequest);
  if (confirmationPullRequest.head.sha !== headSha) {
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    core.setFailed(`CodeRabbit final review evidence is not acceptable: ${reason}; the PR head changed again while current-head request state was reconciled, so the requested marker was preserved to prevent a duplicate paid review.`);
    return { status: 'blocked', headSha: confirmationPullRequest.head.sha, reason };
  }

  if (markerConfirmed && confirmationLabels.has(REQUESTED_LABEL)) {
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    core.setFailed(`CodeRabbit final review evidence is not acceptable: ${reason}; the confirmed current-head request marker was preserved to prevent a duplicate paid review.`);
    return { status: 'blocked', headSha, reason };
  }

  return blockCodeRabbitAuthorizationAndReset({
    github, owner, repo, pullNumber, core, headSha, reason,
  });
}

async function runReviewAuthorization({ github, context, core, config }) {
  const { owner, repo } = context.repo;
  const pullNumber = context.payload.pull_request.number;
  const review = context.payload.review || {};
  const reviewer = normalize(review.user?.login);

  if (reviewer !== normalize(CODERABBIT_BOT_LOGIN)) {
    const pullRequest = (await github.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    })).data;
    const headSha = pullRequest.head.sha;
    const labels = pullRequestLabelNames(pullRequest);

    if (labels.has(REQUESTED_LABEL)) {
      const stateReasons = validateAuthorizationState(
        pullRequest,
        context.payload.repository.default_branch,
      );
      if (stateReasons.length > 0) {
        return resetCandidate({
          github,
          owner,
          repo,
          pullNumber,
          core,
          reason: `pull_request_review.non_coderabbit.invalid_live_state: ${stateReasons.join('; ')}`,
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
          context.payload.repository.default_branch,
        );
        if (confirmationPullRequest.head.sha !== headSha) {
          confirmationReasons.push('pull request head changed during non-CodeRabbit review reconciliation');
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
            reason: `pull_request_review.non_coderabbit.changed_live_state: ${confirmationReasons.join('; ')}`,
          });
        }
      } catch (error) {
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
        core.setFailed(`Could not reconcile requested state after a non-CodeRabbit review (${error.message}); merge authorization was invalidated and the requested marker was preserved for deduplication.`);
        return { status: 'blocked', headSha, reason: error.message };
      }

      if (markerConfirmed) {
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
        core.notice(`Preserved the confirmed CodeRabbit request for ${headSha} after a non-CodeRabbit review.`);
        return { status: 'duplicate', headSha };
      }
      return resetCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: 'pull_request_review.non_coderabbit.stale_state',
      });
    }

    if (labels.has(READY_LABEL)) {
      return resetCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: 'pull_request_review.non_coderabbit.unconfirmed_ready_state',
      });
    }

    return { status: 'ignored', reason: 'pull_request_review.non_coderabbit.no_gate_state' };
  }

  const pullRequest = (await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  })).data;
  const headSha = pullRequest.head.sha;
  const labels = pullRequestLabelNames(pullRequest);
  const reasons = [];

  if (review.commit_id !== headSha) {
    return blockCodeRabbitAuthorizationAndReconcile({
      github,
      owner,
      repo,
      pullNumber,
      core,
      pullRequest,
      reason: 'CodeRabbit review commit does not match the live PR head',
    });
  }

  const liveStateReasons = validateAuthorizationState(
    pullRequest,
    context.payload.repository.default_branch,
  );
  if (liveStateReasons.length > 0) {
    return blockCodeRabbitAuthorizationAndReset({
      github,
      owner,
      repo,
      pullNumber,
      core,
      headSha,
      reason: liveStateReasons.join('; '),
    });
  }

  if (context.payload.action !== 'submitted' || normalize(review.state) !== 'approved') {
    reasons.push(`CodeRabbit review is ${normalize(review.state) || context.payload.action}`);
  }
  if (!labels.has(REQUESTED_LABEL)) reasons.push(`${REQUESTED_LABEL} is not attached`);

  let commandRecorded = false;
  let commandVerificationFailed = false;
  try {
    commandRecorded = await requestedMarkerHasCommand({
      github,
      owner,
      repo,
      pullNumber,
      headSha,
    });
  } catch (error) {
    commandVerificationFailed = true;
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    reasons.push(`could not verify the gate-recorded command (${error.message})`);
  }
  if (!commandRecorded && !commandVerificationFailed) {
    return blockCodeRabbitAuthorizationAndReset({
      github,
      owner,
      repo,
      pullNumber,
      core,
      headSha,
      reason: 'no gate command marker records the live PR head',
    });
  }

  if (labels.has(READY_LABEL) && !commandVerificationFailed) {
    if (!commandRecorded || !labels.has(REQUESTED_LABEL)) {
      return blockCodeRabbitAuthorizationAndReset({
        github,
        owner,
        repo,
        pullNumber,
        core,
        headSha,
        reason: `${READY_LABEL} is still attached without a confirmed current-head request`,
      });
    }
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
  }

  try {
    reasons.push(...await collectCheckBlockers({
      github,
      owner,
      repo,
      headSha,
      config,
      core,
    }));
  } catch (error) {
    reasons.push(`could not revalidate reported checks (${error.message})`);
  }

  try {
    const confirmationPullRequest = (await github.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    })).data;
    const confirmationLabels = pullRequestLabelNames(confirmationPullRequest);
    const confirmationStateReasons = validateAuthorizationState(
      confirmationPullRequest,
      context.payload.repository.default_branch,
    );
    if (confirmationStateReasons.length > 0) {
      return blockCodeRabbitAuthorizationAndReset({
        github,
        owner,
        repo,
        pullNumber,
        core,
        headSha: confirmationPullRequest.head.sha,
        reason: confirmationStateReasons.join('; '),
      });
    }
    if (confirmationPullRequest.head.sha !== headSha) {
      return blockCodeRabbitAuthorizationAndReconcile({
        github,
        owner,
        repo,
        pullNumber,
        core,
        pullRequest: confirmationPullRequest,
        reason: 'pull request head changed during CodeRabbit review authorization',
      });
    }
    if (!confirmationLabels.has(REQUESTED_LABEL)) {
      return blockCodeRabbitAuthorizationAndReset({
        github,
        owner,
        repo,
        pullNumber,
        core,
        headSha,
        reason: `${REQUESTED_LABEL} is no longer attached`,
      });
    }
    if (confirmationLabels.has(READY_LABEL)) {
      return blockCodeRabbitAuthorizationAndReconcile({
        github,
        owner,
        repo,
        pullNumber,
        core,
        pullRequest: confirmationPullRequest,
        reason: `${READY_LABEL} was attached during CodeRabbit review authorization`,
      });
    }
  } catch (error) {
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    reasons.push(`could not confirm the final live PR state (${error.message})`);
  }

  if (reasons.length > 0) {
    core.setFailed(`CodeRabbit final review evidence is not acceptable: ${reasons.join('; ')}`);
    return { status: 'blocked', headSha, reason: reasons.join('; ') };
  }

  core.notice(`CodeRabbit final review evidence accepted for exact head ${headSha}.`);
  return { status: 'authorized', headSha };
}

async function run(args) {
  if (args.context.eventName === 'pull_request_review') {
    try {
      return await runReviewAuthorization(args);
    } catch (error) {
      const { owner, repo } = args.context.repo;
      const pullNumber = args.context.payload.pull_request.number;
      try {
        await removeLabelIfPresent(args.github, owner, repo, pullNumber, READY_LABEL);
      } catch (cleanupError) {
        args.core.warning(`Could not clear ready state after review reconciliation failed (${cleanupError.message}).`);
      }
      args.core.setFailed(`CodeRabbit final-candidate authorization failed closed (${error.message}).`);
      return { status: 'blocked', reason: error.message };
    }
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
    let verificationSucceeded = false;
    let commandCommentExists = false;

    if (attemptState.preexistingCommentIds === null) {
      // The current attempt cannot have posted a command before its comment snapshot.
      verificationSucceeded = !attemptState.requestedMarkerPreexisted;
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
    core.setFailed(`CodeRabbit final review gate failed unexpectedly (${unexpectedError.message}); ${markerNote}${cleanupNote}`);
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
  runReviewAuthorization,
  validatePullRequest,
};
