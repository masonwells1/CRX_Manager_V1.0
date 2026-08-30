'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  READY_LABEL,
  REQUESTED_LABEL,
  REVIEW_COMMAND,
  evaluateChecks,
  reviewCommandBody,
  run,
} = require('./coderabbit-final-review.cjs');

const HEAD = '1111111111111111111111111111111111111111';
const NEXT_HEAD = '2222222222222222222222222222222222222222';
const REQUIRED_CHECKS = [
  {
    name: 'foundation',
    source: 'check_run',
    appId: 15368,
    workflowId: 4242,
    workflowPath: '.github/workflows/ci.yml',
  },
  {
    name: 'Vercel',
    source: 'status',
    creator: 'vercel[bot]',
  },
];

function completedCheck(name, conclusion = 'success') {
  return {
    id: 1,
    app: { id: 15368 },
    name,
    status: 'completed',
    conclusion,
    created_at: '2026-08-30T11:59:00Z',
    completed_at: '2026-08-30T12:00:00Z',
    workflow_id: 4242,
    workflow_path: '.github/workflows/ci.yml',
  };
}

function commitStatus(context, state = 'success') {
  return {
    id: 1,
    context,
    state,
    created_at: '2026-08-30T12:00:00Z',
    creator: { login: context === 'Vercel' ? 'vercel[bot]' : 'coderabbitai[bot]' },
  };
}

function pullRequest({ head = HEAD, labels = [READY_LABEL], draft = false, autoMerge = null } = {}) {
  return {
    number: 42,
    state: 'open',
    draft,
    base: { ref: 'main' },
    head: { sha: head },
    labels: labels.map((name) => ({ name })),
    auto_merge: autoMerge,
    mergeable: true,
    mergeable_state: 'blocked',
  };
}

function makeHarness({
  action = 'labeled',
  changes = undefined,
  eventLabel = READY_LABEL,
  permission = 'write',
  pulls = [pullRequest(), pullRequest(), pullRequest()],
  checkRuns = [completedCheck('foundation')],
  statuses = [commitStatus('Vercel'), commitStatus('CodeRabbit', 'pending')],
  commentFailure = null,
  requestedLabelFailure = null,
  existingComments = [],
  checkRunsSequence = null,
  statusesSequence = null,
  resolvedWorkflowPath = '.github/workflows/ci.yml',
  liveLabelSequence = null,
  pullFailuresAt = [],
  checkRunFailuresAt = [],
  commentListFailuresAt = [],
  eventPullRequest = pullRequest(),
  workflowRunFailure = false,
} = {}) {
  const liveLabels = new Set(pulls[0].labels.map((label) => label.name));
  const comments = existingComments.map((comment) => ({ ...comment }));
  const timeline = [];
  const failures = [];
  const notices = [];
  let pullIndex = 0;
  let checkRunsIndex = 0;
  let statusesIndex = 0;
  let commentListIndex = 0;

  function currentPull() {
    const callNumber = pullIndex + 1;
    if (pullFailuresAt.includes(callNumber)) {
      pullIndex += 1;
      throw new Error(`pull snapshot ${callNumber} failed`);
    }
    const source = pulls[Math.min(pullIndex, pulls.length - 1)];
    if (liveLabelSequence) {
      const snapshot = liveLabelSequence[Math.min(pullIndex, liveLabelSequence.length - 1)];
      liveLabels.clear();
      snapshot.forEach((label) => liveLabels.add(label));
    }
    pullIndex += 1;
    return {
      ...source,
      labels: [...liveLabels].map((name) => ({ name })),
    };
  }

  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => {
          if (workflowRunFailure) throw new Error('workflow lookup failed');
          return { data: { workflow_id: 4242, path: resolvedWorkflowPath } };
        },
      },
      checks: {
        listForRef: async () => {
          const callNumber = checkRunsIndex + 1;
          if (checkRunFailuresAt.includes(callNumber)) {
            checkRunsIndex += 1;
            throw new Error(`check-run snapshot ${callNumber} failed`);
          }
          const sequence = checkRunsSequence || [checkRuns];
          const current = sequence[Math.min(checkRunsIndex++, sequence.length - 1)];
          return { data: { check_runs: current } };
        },
      },
      issues: {
        addLabels: async ({ labels }) => {
          if (labels.includes(REQUESTED_LABEL) && requestedLabelFailure === 'definite') {
            throw new Error('label rejected');
          }
          labels.forEach((label) => {
            liveLabels.add(label);
            timeline.push({
              event: 'labeled',
              label: { name: label },
              actor: { login: 'github-actions[bot]' },
              created_at: new Date().toISOString(),
            });
          });
          if (labels.includes(REQUESTED_LABEL) && requestedLabelFailure === 'ambiguous') {
            throw new Error('connection closed after label write');
          }
        },
        createComment: async ({ body }) => {
          if (commentFailure === 'ambiguous') {
            comments.push({
              id: comments.length + 1,
              body,
              created_at: new Date().toISOString(),
              user: { login: 'github-actions[bot]' },
            });
            throw new Error('connection closed after write');
          }
          if (commentFailure === 'ambiguous-untrusted') {
            comments.push({
              id: comments.length + 1,
              body,
              created_at: new Date().toISOString(),
              user: { login: 'outside-commenter' },
            });
            throw new Error('connection closed before write');
          }
          if (commentFailure === 'definite') throw new Error('comment rejected');
          const comment = {
            id: comments.length + 1,
            body,
            created_at: new Date().toISOString(),
            user: { login: 'github-actions[bot]' },
          };
          comments.push(comment);
          return { data: comment };
        },
        deleteComment: async ({ comment_id: commentId }) => {
          const index = comments.findIndex((comment) => comment.id === commentId);
          if (index >= 0) comments.splice(index, 1);
        },
        listComments: async () => {
          const callNumber = commentListIndex + 1;
          commentListIndex += 1;
          if (commentListFailuresAt.includes(callNumber)) {
            throw new Error(`comment snapshot ${callNumber} failed`);
          }
          return { data: comments };
        },
        listEventsForTimeline: async () => ({ data: timeline }),
        removeLabel: async ({ name }) => {
          if (!liveLabels.delete(name)) {
            const error = new Error('label missing');
            error.status = 404;
            throw error;
          }
        },
      },
      pulls: {
        get: async () => ({ data: currentPull() }),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
        listCommitStatusesForRef: async () => {
          const sequence = statusesSequence || [statuses];
          const current = sequence[Math.min(statusesIndex++, sequence.length - 1)];
          return { data: current };
        },
      },
    },
    paginate: async (method, params, map) => {
      const response = await method(params);
      return map ? map(response) : response.data;
    },
  };
  const context = {
    actor: 'masonwells1',
    repo: { owner: 'masonwells1', repo: 'FarmRx' },
    payload: {
      action,
      changes,
      label: eventLabel ? { name: eventLabel } : undefined,
      pull_request: eventPullRequest,
      repository: { default_branch: 'main' },
    },
  };
  const core = {
    notice: (message) => notices.push(message),
    setFailed: (message) => failures.push(message),
    warning: (message) => notices.push(message),
  };

  return {
    comments,
    context,
    core,
    failures,
    github,
    liveLabels,
    notices,
  };
}

async function execute(harness) {
  return run({
    github: harness.github,
    context: harness.context,
    core: harness.core,
    config: {
      requiredChecks: REQUIRED_CHECKS,
      ignoredChecks: ['CodeRabbit'],
      quietPeriodMs: 0,
      mergeabilityPollMs: 0,
    },
  });
}

test('omitting the quiet-period option invokes the production 30-second confirmation wait', async () => {
  const harness = makeHarness();
  const waits = [];
  const result = await run({
    github: harness.github,
    context: harness.context,
    core: harness.core,
    config: {
      requiredChecks: REQUIRED_CHECKS,
      ignoredChecks: ['CodeRabbit'],
      mergeabilityPollMs: 0,
      settle: async (milliseconds) => waits.push(milliseconds),
    },
  });

  assert.equal(result.status, 'requested');
  assert.deepEqual(waits, [30_000]);
});

test('green frozen candidate posts exactly one review command and records the request', async () => {
  const harness = makeHarness();
  const result = await execute(harness);

  assert.equal(result.status, 'requested');
  assert.deepEqual(harness.comments.map((comment) => comment.body), [reviewCommandBody(HEAD)]);
  assert.equal(harness.comments[0].body.split('\n')[0], REVIEW_COMMAND);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.deepEqual(harness.failures, []);
});

test('duplicate ready events never post a second review command', async () => {
  const harness = makeHarness();
  await execute(harness);
  harness.liveLabels.add(READY_LABEL);
  const duplicate = await execute(harness);

  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(harness.comments.map((comment) => comment.body), [reviewCommandBody(HEAD)]);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
});

test('a stranded requested marker without a matching Actions comment self-heals and retries', async () => {
  const harness = makeHarness({
    pulls: [pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] })],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'requested');
  assert.deepEqual(harness.comments.map((comment) => comment.body), [reviewCommandBody(HEAD)]);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.match(harness.notices.join('\n'), /no matching GitHub Actions review command/);
});

test('an unverifiable requested marker stays attached and cannot cause a duplicate paid review', async () => {
  const harness = makeHarness({
    pulls: [pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] })],
    commentListFailuresAt: [1],
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });

  const failedVerification = await execute(harness);
  assert.equal(failedVerification.status, 'blocked');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.equal(harness.comments.length, 1);
  assert.match(harness.failures[0], /marker was preserved to prevent a duplicate review/);

  await harness.github.rest.issues.addLabels({ labels: [READY_LABEL] });
  const retry = await execute(harness);
  assert.equal(retry.status, 'duplicate');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.equal(harness.comments.length, 1);
});

test('a new commit resets both workflow labels', async () => {
  const harness = makeHarness({
    action: 'synchronize',
    eventLabel: null,
    pulls: [pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] })],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'reset');
  assert.equal(harness.liveLabels.size, 0);
  assert.deepEqual(harness.comments, []);
});

test('changing the pull request base resets both workflow labels', async () => {
  const harness = makeHarness({
    action: 'edited',
    changes: { base: { from: { ref: 'release' } } },
    eventLabel: null,
    pulls: [pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] })],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'reset');
  assert.equal(result.reason, 'pull_request_target.edited.base');
  assert.equal(harness.liveLabels.size, 0);
  assert.deepEqual(harness.comments, []);
});

test('editing pull request metadata without changing the base does not reset labels', async () => {
  const harness = makeHarness({
    action: 'edited',
    changes: { title: { from: 'Old title' } },
    eventLabel: null,
    pulls: [pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] })],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'ignored');
  assert.equal(result.reason, 'pull_request_target.edited');
  assert.deepEqual([...harness.liveLabels].sort(), [READY_LABEL, REQUESTED_LABEL].sort());
  assert.deepEqual(harness.comments, []);
});

test('missing, pending, or failed checks block the paid review request', async () => {
  const harness = makeHarness({
    checkRuns: [
      {
        id: 2,
        app: { id: 15368 },
        name: 'foundation',
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-08-30T12:00:00Z',
        workflow_path: '.github/workflows/ci.yml',
      },
      completedCheck('security-scan', 'failure'),
    ],
    statuses: [commitStatus('CodeRabbit', 'pending')],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.match(harness.failures[0], /foundation/);
  assert.match(harness.failures[0], /security-scan/);
  assert.match(harness.failures[0], /Vercel/);
  assert.doesNotMatch(harness.failures[0], /CodeRabbit: pending/);
});

test('a check rerun that starts during the quiet confirmation blocks the request', async () => {
  const harness = makeHarness({
    checkRunsSequence: [
      [completedCheck('foundation')],
      [{
        id: 2,
        app: { id: 15368 },
        name: 'foundation',
        status: 'in_progress',
        conclusion: null,
        workflow_path: '.github/workflows/ci.yml',
      }],
    ],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(harness.failures[0], /foundation/);
});

test('a newer overlapping rerun wins even if an older run completes later', () => {
  const blockers = evaluateChecks({
    checkRuns: [
      {
        id: 100,
        app: { id: 15368 },
        name: 'foundation',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-08-30T12:00:00Z',
        started_at: '2026-08-30T12:00:01Z',
        completed_at: '2026-08-30T12:10:00Z',
        workflow_id: 4242,
        workflow_path: '.github/workflows/ci.yml',
      },
      {
        id: 101,
        app: { id: 15368 },
        name: 'foundation',
        status: 'in_progress',
        conclusion: null,
        created_at: '2026-08-30T12:05:00Z',
        started_at: '2026-08-30T12:05:01Z',
        completed_at: null,
        workflow_id: 4242,
        workflow_path: '.github/workflows/ci.yml',
      },
    ],
    statuses: [commitStatus('Vercel')],
    requiredChecks: REQUIRED_CHECKS,
  });

  assert.match(blockers.join('\n'), /foundation: in_progress\/no conclusion/);
});

test('a failed requested-marker write clears both workflow labels and posts no command', async (t) => {
  for (const failureMode of ['definite', 'ambiguous']) {
    await t.test(failureMode, async () => {
      const harness = makeHarness({ requestedLabelFailure: failureMode });
      const result = await execute(harness);

      assert.equal(result.status, 'blocked');
      assert.deepEqual(harness.comments, []);
      assert.equal(harness.liveLabels.has(READY_LABEL), false);
      assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
      assert.match(harness.failures[0], /could not record the review-request marker/);
    });
  }
});

test('removing the ready label during the quiet period cancels the review request', async () => {
  const harness = makeHarness({
    liveLabelSequence: [[READY_LABEL], []],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(harness.failures[0], /ready-for-coderabbit is no longer attached/);
});

test('a final snapshot API failure clears both workflow labels and posts no command', async () => {
  const harness = makeHarness({ pullFailuresAt: [3] });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(harness.failures[0], /could not complete the final candidate snapshot/);
});

test('a post-comment snapshot API failure deletes the command and clears both labels', async () => {
  const harness = makeHarness({ pullFailuresAt: [4] });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(harness.failures[0], /could not complete the post-comment candidate snapshot/);
});

test('an unexpected initial API failure clears the ready label for a deliberate retry', async () => {
  const harness = makeHarness({ pullFailuresAt: [1] });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(harness.failures[0], /gate failed unexpectedly/);
});

test('unexpected recovery never mistakes a pre-existing exact-head command for this attempt', async () => {
  const harness = makeHarness({
    checkRunFailuresAt: [2],
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.equal(harness.comments.length, 1);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(harness.failures[0], /gate failed unexpectedly/);
});

test('an early API failure preserves a pre-existing marker and prevents a duplicate retry', async () => {
  const markedPullRequest = pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] });
  const harness = makeHarness({
    pulls: [markedPullRequest],
    eventPullRequest: markedPullRequest,
    pullFailuresAt: [1],
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });

  const failedVerification = await execute(harness);
  assert.equal(failedVerification.status, 'blocked');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.equal(harness.comments.length, 1);
  assert.match(harness.failures[0], /requested marker was preserved/);

  await harness.github.rest.issues.addLabels({ labels: [READY_LABEL] });
  const retry = await execute(harness);
  assert.equal(retry.status, 'duplicate');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.equal(harness.comments.length, 1);
});

test('drafts, auto-merge, branch state, stale heads, and low-permission actors fail closed', async (t) => {
  const behind = pullRequest();
  behind.mergeable_state = 'behind';
  const unknown = pullRequest();
  unknown.mergeable = null;
  unknown.mergeable_state = 'unknown';
  const cases = [
    ['draft', { pulls: [pullRequest({ draft: true })] }],
    ['auto-merge', { pulls: [pullRequest({ autoMerge: {} })] }],
    ['behind base', { pulls: [behind] }],
    ['unknown mergeability', { pulls: [unknown] }],
    ['stale head', { pulls: [pullRequest({ head: NEXT_HEAD })] }],
    ['low permission', { permission: 'triage' }],
  ];

  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const harness = makeHarness(options);
      const result = await execute(harness);
      assert.equal(result.status, 'blocked');
      assert.deepEqual(harness.comments, []);
      assert.equal(harness.liveLabels.has(READY_LABEL), false);
    });
  }

  await t.test('merge conflict', async () => {
    const conflicted = pullRequest();
    conflicted.mergeable = false;
    conflicted.mergeable_state = 'dirty';
    const harness = makeHarness({ pulls: [conflicted] });
    const result = await execute(harness);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(harness.comments, []);
  });
});

test('temporarily unknown mergeability is polled before the candidate is rejected', async () => {
  const unknown = pullRequest();
  unknown.mergeable = null;
  unknown.mergeable_state = 'unknown';
  const harness = makeHarness({
    pulls: [unknown, pullRequest(), pullRequest(), pullRequest()],
  });
  const waits = [];
  const result = await run({
    github: harness.github,
    context: harness.context,
    core: harness.core,
    config: {
      requiredChecks: REQUIRED_CHECKS,
      ignoredChecks: ['CodeRabbit'],
      quietPeriodMs: 0,
      mergeabilityPollMs: 17,
      settle: async (milliseconds) => waits.push(milliseconds),
    },
  });

  assert.equal(result.status, 'requested');
  assert.deepEqual(waits, [17]);
  assert.deepEqual(harness.failures, []);
});

test('a non-finite mergeability-attempt value still performs one pull-request read', async () => {
  const harness = makeHarness();
  const result = await run({
    github: harness.github,
    context: harness.context,
    core: harness.core,
    config: {
      requiredChecks: REQUIRED_CHECKS,
      ignoredChecks: ['CodeRabbit'],
      quietPeriodMs: 0,
      mergeabilityPollAttempts: Number.NaN,
      mergeabilityPollMs: 0,
    },
  });

  assert.equal(result.status, 'requested');
  assert.deepEqual(harness.failures, []);
});

test('a workflow-provenance lookup failure warns with the API error and blocks closed', async () => {
  const check = completedCheck('foundation');
  check.workflow_id = undefined;
  check.workflow_path = undefined;
  check.details_url = 'https://github.com/masonwells1/FarmRx/actions/runs/123456/job/789';
  const harness = makeHarness({ checkRuns: [check], workflowRunFailure: true });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.match(harness.notices.join('\n'), /workflow lookup failed/);
  assert.match(harness.failures[0], /trusted required check is missing or not successful/);
});

test('a head change during the gate removes the request marker and posts no comment', async () => {
  const harness = makeHarness({
    pulls: [pullRequest(), pullRequest(), pullRequest({ head: NEXT_HEAD })],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
});

test('a head change while the command is posted deletes the raced comment and clears the marker', async () => {
  const harness = makeHarness({
    pulls: [pullRequest(), pullRequest(), pullRequest(), pullRequest({ head: NEXT_HEAD })],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(harness.failures[0], /changed while the review command was being posted/);
});

test('a definite comment failure clears both labels so the pull request cannot be stranded', async () => {
  const harness = makeHarness({ commentFailure: 'definite' });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.deepEqual(harness.comments, []);
  assert.match(harness.failures[0], /marker was cleared/);
});

test('an ambiguous comment failure preserves dedupe state when the command actually landed', async () => {
  const harness = makeHarness({ commentFailure: 'ambiguous' });
  const result = await execute(harness);

  assert.equal(result.status, 'requested');
  assert.equal(result.recovered, true);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.deepEqual(harness.comments.map((comment) => comment.body), [reviewCommandBody(HEAD)]);
  assert.deepEqual(harness.failures, []);
});

test('an ambiguous failure never trusts the same command from another commenter', async () => {
  const harness = makeHarness({ commentFailure: 'ambiguous-untrusted' });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(harness.failures[0], /marker was cleared/);
});

test('ambiguous recovery never mistakes an old-head Actions command for a new write', async () => {
  const harness = makeHarness({
    commentFailure: 'definite',
    existingComments: [{
      id: 99,
      body: reviewCommandBody(NEXT_HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.equal(harness.comments.length, 1);
  assert.match(harness.failures[0], /marker was cleared/);
});

test('an old-head marker and command cannot suppress the current-head request', async () => {
  const harness = makeHarness({
    pulls: [pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] })],
    existingComments: [{
      id: 99,
      body: reviewCommandBody(NEXT_HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'requested');
  assert.deepEqual(
    harness.comments.map((comment) => comment.body),
    [reviewCommandBody(NEXT_HEAD), reviewCommandBody(HEAD)],
  );
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
});

test('check evaluation accepts neutral/skipped results and ignores CodeRabbit pending state', () => {
  const blockers = evaluateChecks({
    checkRuns: [
      completedCheck('foundation'),
      completedCheck('optional-neutral', 'neutral'),
      completedCheck('optional-skipped', 'skipped'),
    ],
    statuses: [commitStatus('Vercel'), commitStatus('CodeRabbit', 'pending')],
    requiredChecks: REQUIRED_CHECKS,
    ignoredChecks: ['CodeRabbit'],
  });

  assert.deepEqual(blockers, []);
});

test('required checks demand exact success while optional neutral/skipped checks remain acceptable', () => {
  const blockers = evaluateChecks({
    checkRuns: [completedCheck('foundation', 'skipped')],
    statuses: [commitStatus('Vercel')],
    requiredChecks: REQUIRED_CHECKS,
  });

  assert.match(blockers.join('\n'), /foundation: trusted required check is missing or not successful/);
});

test('a same-name check from another app cannot mask a failed trusted required check', () => {
  const trustedFailure = {
    ...completedCheck('foundation', 'failure'),
    id: 100,
  };
  const spoofedSuccess = {
    ...completedCheck('foundation'),
    id: 101,
    app: { id: 99999 },
    workflow_path: '.github/workflows/fake.yml',
  };
  const blockers = evaluateChecks({
    checkRuns: [trustedFailure, spoofedSuccess],
    statuses: [commitStatus('Vercel')],
    requiredChecks: REQUIRED_CHECKS,
  });

  assert.match(blockers.join('\n'), /duplicate or untrusted same-name check provenance/);
  assert.match(blockers.join('\n'), /trusted required check is missing or not successful/);
});

test('a same-app check from another workflow cannot satisfy a required check', () => {
  const wrongWorkflow = {
    ...completedCheck('foundation'),
    id: 101,
    workflow_path: '.github/workflows/not-ci.yml',
  };
  const blockers = evaluateChecks({
    checkRuns: [wrongWorkflow],
    statuses: [commitStatus('Vercel')],
    requiredChecks: REQUIRED_CHECKS,
  });

  assert.match(blockers.join('\n'), /duplicate or untrusted same-name check provenance/);
  assert.match(blockers.join('\n'), /trusted required check is missing or not successful/);
});

test('the live gate resolves a required GitHub Actions check to its workflow before requesting review', async () => {
  const unresolvedCheck = {
    ...completedCheck('foundation'),
    workflow_path: undefined,
    details_url: 'https://github.com/masonwells1/FarmRx/actions/runs/123456/job/789',
  };
  const harness = makeHarness({ checkRuns: [unresolvedCheck] });
  const result = await execute(harness);

  assert.equal(result.status, 'requested');
  assert.deepEqual(harness.failures, []);
});

test('the live gate rejects a required GitHub Actions check resolved to another workflow', async () => {
  const unresolvedCheck = {
    ...completedCheck('foundation'),
    workflow_path: undefined,
    details_url: 'https://github.com/masonwells1/FarmRx/actions/runs/123456/job/789',
  };
  const harness = makeHarness({
    checkRuns: [unresolvedCheck],
    resolvedWorkflowPath: '.github/workflows/untrusted.yml',
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.match(harness.failures.join('\n'), /duplicate or untrusted same-name check provenance/);
});
