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

function newestByName(items, nameKey, dateKeys) {
  const newest = new Map();

  for (const item of items) {
    const name = normalize(item[nameKey]);
    if (!name) continue;

    const timestamp = dateKeys
      .map((key) => item[key])
      .find(Boolean) || '';
    const existing = newest.get(name);
    if (!existing || timestamp > existing.timestamp) {
      newest.set(name, { item, timestamp });
    }
  }

  return new Map([...newest].map(([name, entry]) => [name, entry.item]));
}

function evaluateChecks({ checkRuns, statuses, requiredChecks, ignoredChecks = [] }) {
  const ignored = new Set(ignoredChecks.map(normalize));
  const checksByName = newestByName(checkRuns, 'name', [
    'completed_at',
    'started_at',
    'created_at',
  ]);
  const statusesByName = newestByName(statuses, 'context', [
    'updated_at',
    'created_at',
  ]);
  const blockers = [];

  for (const [name, check] of checksByName) {
    if (ignored.has(name)) continue;
    if (check.status !== 'completed' || !ACCEPTABLE_CHECK_CONCLUSIONS.has(check.conclusion)) {
      blockers.push(`${check.name}: ${check.status}/${check.conclusion || 'no conclusion'}`);
    }
  }

  for (const [name, status] of statusesByName) {
    if (ignored.has(name)) continue;
    if (status.state !== 'success') {
      blockers.push(`${status.context}: ${status.state}`);
    }
  }

  for (const requiredName of requiredChecks) {
    const name = normalize(requiredName);
    const check = checksByName.get(name);
    const status = statusesByName.get(name);
    const checkPassed = check
      && check.status === 'completed'
      && ACCEPTABLE_CHECK_CONCLUSIONS.has(check.conclusion);
    const statusPassed = status && status.state === 'success';

    if (!checkPassed && !statusPassed) {
      blockers.push(`${requiredName}: required check is missing or not successful`);
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

  if (pullRequest.state !== 'open') reasons.push('pull request is not open');
  if (pullRequest.draft) reasons.push('pull request is still a draft');
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
  const boundedAttempts = Math.max(1, attempts);

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

async function collectCheckBlockers({ github, owner, repo, headSha, config }) {
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
  return evaluateChecks({
    checkRuns,
    statuses,
    requiredChecks: config.requiredChecks,
    ignoredChecks: config.ignoredChecks,
  });
}

async function run({ github, context, core, config }) {
  const { owner, repo } = context.repo;
  const action = context.payload.action;
  const pullNumber = context.payload.pull_request.number;
  const quietPeriodMs = config.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
  const mergeabilityPollAttempts = config.mergeabilityPollAttempts
    ?? DEFAULT_MERGEABILITY_POLL_ATTEMPTS;
  const mergeabilityPollMs = config.mergeabilityPollMs ?? DEFAULT_MERGEABILITY_POLL_MS;
  const settle = config.settle
    || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  if (RESET_ACTIONS.has(action)) {
    return resetLabels({
      github,
      owner,
      repo,
      pullNumber,
      core,
      reason: `pull_request_target.${action}`,
    });
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
      await removeLabelIfPresent(github, owner, repo, pullNumber, REQUESTED_LABEL);
      return blockCandidate({
        github,
        owner,
        repo,
        pullNumber,
        core,
        reason: `could not verify the requested marker (${verificationError.message}); the marker was cleared for a deliberate retry`,
      });
    }
  }

  const blockers = await collectCheckBlockers({
    github,
    owner,
    repo,
    headSha: expectedHeadSha,
    config,
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
  await github.rest.issues.addLabels({
    owner,
    repo,
    issue_number: pullNumber,
    labels: [REQUESTED_LABEL],
  });

  const [finalPullRequest, finalCheckBlockers] = await Promise.all([
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
    }),
  ]);
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

  const [postCommentPullRequest, postCommentCheckBlockers] = await Promise.all([
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
    }),
  ]);
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
