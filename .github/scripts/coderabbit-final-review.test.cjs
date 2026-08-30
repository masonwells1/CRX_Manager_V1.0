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
const REQUIRED_CHECKS = ['foundation', 'Vercel'];

function completedCheck(name, conclusion = 'success') {
  return {
    name,
    status: 'completed',
    conclusion,
    completed_at: '2026-08-30T12:00:00Z',
  };
}

function commitStatus(context, state = 'success') {
  return { context, state, updated_at: '2026-08-30T12:00:00Z' };
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
  eventLabel = READY_LABEL,
  permission = 'write',
  pulls = [pullRequest(), pullRequest(), pullRequest()],
  checkRuns = [completedCheck('foundation')],
  statuses = [commitStatus('Vercel'), commitStatus('CodeRabbit', 'pending')],
  commentFailure = null,
  existingComments = [],
  checkRunsSequence = null,
  statusesSequence = null,
} = {}) {
  const liveLabels = new Set(pulls[0].labels.map((label) => label.name));
  const comments = existingComments.map((comment) => ({ ...comment }));
  const timeline = [];
  const failures = [];
  const notices = [];
  let pullIndex = 0;
  let checkRunsIndex = 0;
  let statusesIndex = 0;

  function currentPull() {
    const source = pulls[Math.min(pullIndex++, pulls.length - 1)];
    return {
      ...source,
      labels: [...liveLabels].map((name) => ({ name })),
    };
  }

  const github = {
    rest: {
      checks: {
        listForRef: async () => {
          const sequence = checkRunsSequence || [checkRuns];
          const current = sequence[Math.min(checkRunsIndex++, sequence.length - 1)];
          return { data: { check_runs: current } };
        },
      },
      issues: {
        addLabels: async ({ labels }) => labels.forEach((label) => {
          liveLabels.add(label);
          timeline.push({
            event: 'labeled',
            label: { name: label },
            actor: { login: 'github-actions[bot]' },
            created_at: new Date().toISOString(),
          });
        }),
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
        listComments: async () => ({ data: comments }),
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
      label: eventLabel ? { name: eventLabel } : undefined,
      pull_request: pullRequest(),
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

test('missing, pending, or failed checks block the paid review request', async () => {
  const harness = makeHarness({
    checkRuns: [
      { name: 'foundation', status: 'in_progress', conclusion: null, started_at: '2026-08-30T12:00:00Z' },
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
      [{ name: 'foundation', status: 'in_progress', conclusion: null }],
    ],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(harness.failures[0], /foundation/);
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
