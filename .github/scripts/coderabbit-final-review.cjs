'use strict';

const READY_LABEL = 'ready-for-coderabbit';
const REQUESTED_LABEL = 'coderabbit-review-requested';
const REVIEW_COMMAND = '@coderabbitai review';
const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const RESET_ACTIONS = new Set(['synchronize', 'reopened', 'converted_to_draft']);
const ALLOWED_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const ACCEPTABLE_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const DEFAULT_QUIET_PERIOD_MS = 30_000;
const DEFAULT_MERGEABILITY_POLL_ATTEMPTS = 4;
const DEFAULT_MERGEABILITY_POLL_MS = 2_000;

function normalize(value) {
  return String(value || '').trim().toLowerCase();
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
  if (!required || typeof required !== 'object' || !required.name) {
    return 'required-check configuration is missing a named provenance policy';
  }
  if (
    required.source === 'check_run'
    && required.appId
    && required.workflowId
    && required.workflowPath
  ) return null;
  if (required.source === 'status' && required.creator) return null;
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

function evaluateChecks({ checkRuns, statuses, requiredChecks, ignoredChecks = [] }) {
  const ignored = new Set(ignoredChecks.map(normalize));
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
  const blockers = [];

  for (const check of checksByIdentity.values()) {
    if (ignored.has(normalize(check.name))) continue;
    if (check.workflow_provenance_error) {
      blockers.push(`${check.name}: workflow provenance could not be verified (${check.workflow_provenance_error})`);
      continue;
    }
    if (check.status !== 'completed' || !ACCEPTABLE_CHECK_CONCLUSIONS.has(check.conclusion)) {
      blockers.push(`${check.name}: ${check.status}/${check.conclusion || 'no conclusion'}`);
    }
  }

  for (const status of statusesByIdentity.values()) {
    if (ignored.has(normalize(status.context))) continue;
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

async function resetLabels({ github, owner, repo, pullNumber, core, reason }) {
  await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
  await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
  core.notice(`CodeRabbit final-review state reset: ${reason}`);
  return { status: 'reset', reason };
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
  if (RESET_ACTIONS.has(action) || baseBranchChanged) {
    return resetLabels({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: baseBranchChanged
        ? 'pull_request_target.edited.base'
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
    const editedLabels = pullRequestLabelNames(editedPullRequest);

    if (editedLabels.has(REQUESTED_LABEL)) {
      const editedHeadSha = editedPullRequest.head.sha;
      if (await requestedMarkerHasCommand({
        github,
        owner,
        repo,
        pullNumber,
        headSha: editedHeadSha,
      })) {
        await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
        core.notice(`Preserved the confirmed CodeRabbit request for ${editedHeadSha} after a metadata edit.`);
        return { status: 'duplicate', headSha: editedHeadSha };
      }
      return resetLabels({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: 'pull_request_target.edited.stale_state',
      });
    }

    if (editedLabels.has(READY_LABEL)) {
      return resetLabels({
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

  if (action !== 'labeled' || normalize(context.payload.label?.name) !== READY_LABEL) {
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
  try {
    const commentResponse = await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: reviewCommandBody(expectedHeadSha),
    });
    createdComment = commentResponse.data;
  } catch (commentError) {
    let commandCommentExists = false;
    try {
      const comments = await github.paginate(
        github.rest.issues.listComments,
        { owner, repo, issue_number: pullNumber, per_page: 100 },
      );
      commandCommentExists = comments.some((comment) => (
        !preexistingCommentIds.has(comment.id)
        && isActionsReviewComment(comment, expectedHeadSha)
      ));
    } catch (verificationError) {
      core.warning(`Could not verify the failed comment request: ${verificationError.message}`);
    }

    if (commandCommentExists) {
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      core.warning('GitHub reported a comment error, but the exact command comment exists; preserving the requested marker.');
      return { status: 'requested', headSha: expectedHeadSha, recovered: true };
    }

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
  return { status: 'requested', headSha: expectedHeadSha };
}

async function run(args) {
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
      await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
      core.warning(`Recovered an exact review command after an unexpected gate failure: ${unexpectedError.message}`);
      return {
        status: 'requested', headSha, recovered: true,
      };
    }

    if (verificationSucceeded) {
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
    }
    await removeLabelIfPresent(github, owner, repo, pullNumber, READY_LABEL);
    const markerNote = verificationSucceeded
      ? 'workflow labels were cleared for a deliberate retry'
      : 'the requested marker was preserved until a retry can verify whether a command landed';
    core.setFailed(`CodeRabbit final review gate failed unexpectedly (${unexpectedError.message}); ${markerNote}`);
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
  validatePullRequest,
};
