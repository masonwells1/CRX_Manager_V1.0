'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  READY_LABEL,
  REQUESTED_LABEL,
  REVIEW_COMMAND,
  evaluateChecks,
  reviewCommandBody,
  run,
  validateAuthorizationState,
  validatePullRequest,
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
const IGNORED_CHECKS = [
  {
    name: 'CodeRabbit',
    source: 'status',
    creator: 'coderabbitai[bot]',
  },
];

function trustedGateDetectionScript() {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'coderabbit-final-review.yml'),
    'utf8',
  );
  const marker = '      - name: Detect the trusted default-branch gate implementation';
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1);
  const nextStep = workflow.indexOf('\n      - name:', start + marker.length);
  const section = workflow.slice(start, nextStep === -1 ? undefined : nextStep);
  const runBlock = section.match(/\n        run: \|\r?\n([\s\S]+)$/);
  assert.ok(runBlock);
  return runBlock[1]
    .split(/\r?\n/)
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');
}

// This privileged job holds `issues: write`, and that is only safe while every
// trigger sources the workflow YAML from the DEFAULT BRANCH. `pull_request_target`
// does. `pull_request_review` does NOT — it runs the pull request's own copy, so a
// PR editing this file would execute its own steps with this job's write token.
// Proven on PR #516: a `pull_request_review` run of this workflow succeeded while
// the file did not exist on `main` at all. Re-adding any such trigger must fail here.
test('no pull-request event other than pull_request_target triggers this privileged workflow', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'coderabbit-final-review.yml'),
    'utf8',
  );
  const onBlock = workflow.match(/\non:\r?\n([\s\S]*?)\r?\n(?=\S)/);
  assert.ok(onBlock, 'workflow must declare an `on:` block');
  const triggers = onBlock[1]
    .split(/\r?\n/)
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().replace(/:$/, ''));
  assert.deepEqual(
    triggers,
    ['pull_request_target'],
    'this workflow must stay pull_request_target-only; any other pull-request trigger '
    + 'would let the PR supply the steps that run with this job\'s issues:write token',
  );
});

test('the gate refuses to run on any event other than pull_request_target', async () => {
  const harness = makeHarness({ eventName: 'pull_request_review', action: 'submitted' });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /unsupported event pull_request_review/);
  assert.match(harness.failures[0], /pull_request_target-only/);
  // It must not have touched labels or comments on the way out.
  assert.equal(harness.comments.length, 0);
});

const BOOTSTRAP_HEAD_REF = 'codex/coderabbit-ready-label-20260830';

function executeTrustedGateDetection({
  pullNumber, headRef = BOOTSTRAP_HEAD_REF, baseRef = 'main', scriptExists,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coderabbit-final-bootstrap-'));
  const output = path.join(root, 'github-output.txt');
  if (scriptExists) {
    const scriptDirectory = path.join(root, '.github', 'scripts');
    fs.mkdirSync(scriptDirectory, { recursive: true });
    fs.writeFileSync(path.join(scriptDirectory, 'coderabbit-final-review.cjs'), 'module.exports = {};\n');
  }

  try {
    const windowsGitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const bash = process.platform === 'win32' && fs.existsSync(windowsGitBash)
      ? windowsGitBash
      : 'bash';
    const result = spawnSync(bash, ['-c', trustedGateDetectionScript()], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        BOOTSTRAP_PR_NUMBER: String(pullNumber),
        BOOTSTRAP_HEAD_REF: headRef,
        BOOTSTRAP_BASE_REF: baseRef,
        GITHUB_OUTPUT: output,
      },
    });
    return {
      ...result,
      gateOutput: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Regression: the six shared live-state conditions were written out in BOTH
// validators, which gate the same security decision. A change to one copy would
// silently let one path accept a candidate the other rejects. validatePullRequest
// is now derived from validateAuthorizationState; this pins the containment so a
// future re-duplication that drops or weakens a condition fails here.
test('validatePullRequest reports every validateAuthorizationState reason', () => {
  const brokenStates = [
    { state: 'closed' },
    { draft: true },
    { base: 'production' },
    { autoMerge: { enabled_by: { login: 'someone' } } },
    { mergeable: false },
    { mergeableState: 'unknown' },
    { mergeableState: 'dirty' },
    { mergeableState: 'behind' },
    { state: 'closed', draft: true, base: 'production', mergeableState: 'dirty' },
  ];

  for (const options of brokenStates) {
    const pr = pullRequest(options);
    const shared = validateAuthorizationState(pr, 'main');
    const full = validatePullRequest(pr, 'main', pr.head.sha);

    assert.ok(shared.length > 0, `fixture produced no shared reason: ${JSON.stringify(options)}`);
    for (const reason of shared) {
      assert.ok(
        full.includes(reason),
        `validatePullRequest dropped "${reason}" for ${JSON.stringify(options)}`,
      );
    }
  }
});

test('the workflow no-ops only for the introducing-PR bootstrap identity', () => {
  const result = executeTrustedGateDetection({ pullNumber: 516, scriptExists: false });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.gateOutput, /^available=false$/m);
});

// Regression: the identity was pinned to `github.event.pull_request.base.sha`.
// `main` requires a PR to be up to date before it can merge, so that SHA MUST
// change before the merge — the pin made this PR unmergeable by construction.
// The bootstrap identity must not reference any base SHA at all.
test('the bootstrap identity survives the base moving, and names no base SHA', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'coderabbit-final-review.yml'),
    'utf8',
  );
  const job = workflow.slice(workflow.indexOf('  final-review-gate:'));
  assert.doesNotMatch(job, /BOOTSTRAP_BASE_SHA/);
  assert.doesNotMatch(job, /pull_request\.base\.sha/);
  assert.doesNotMatch(job, /\b[0-9a-f]{40}\b/);

  // The detection script reads only these, so a moved base cannot change it.
  const result = executeTrustedGateDetection({ pullNumber: 516, scriptExists: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.gateOutput, /^available=false$/m);
});

test('the workflow fails closed if the trusted script is later absent', () => {
  const mismatchedIdentities = [
    { pullNumber: 517 },
    { pullNumber: 516, headRef: 'codex/some-other-branch' },
    { pullNumber: 516, baseRef: 'production' },
    { pullNumber: 517, headRef: 'codex/some-other-branch', baseRef: 'production' },
  ];

  for (const identity of mismatchedIdentities) {
    const result = executeTrustedGateDetection({ ...identity, scriptExists: false });
    assert.notEqual(result.status, 0, JSON.stringify(identity));
    assert.doesNotMatch(result.gateOutput, /^available=false$/m);
  }
});

test('the workflow enforces the trusted script after it exists on the default branch', () => {
  const result = executeTrustedGateDetection({
    pullNumber: 517,
    headRef: 'codex/some-other-branch',
    scriptExists: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.gateOutput, /^available=true$/m);
});

test('the workflow runs every subscribed label event through the trusted gate', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'coderabbit-final-review.yml'),
    'utf8',
  );
  const job = workflow.slice(workflow.indexOf('  final-review-gate:'));

  assert.doesNotMatch(job, /github\.event\.action\s*!=\s*'labeled'/);
  assert.doesNotMatch(job, /github\.event\.label\.name\s*==\s*'ready-for-coderabbit'/);
});

test('the workflow binds the CodeRabbit exclusion to the trusted status creator', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'coderabbit-final-review.yml'),
    'utf8',
  );

  assert.match(
    workflow,
    /ignoredChecks:\s*\[\s*\{\s*name: 'CodeRabbit',\s*source: 'status',\s*creator: 'coderabbitai\[bot\]'/,
  );
  assert.doesNotMatch(workflow, /ignoredChecks:\s*\[\s*['"]CodeRabbit['"]\s*\]/);
});

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

function pullRequest({
  head = HEAD,
  labels = [READY_LABEL],
  draft = false,
  autoMerge = null,
  state = 'open',
  base = 'main',
  mergeable = true,
  mergeableState = 'blocked',
} = {}) {
  return {
    number: 42,
    state,
    draft,
    base: { ref: base },
    head: { sha: head },
    labels: labels.map((name) => ({ name })),
    auto_merge: autoMerge,
    mergeable,
    mergeable_state: mergeableState,
  };
}

function makeHarness({
  eventName = 'pull_request_target',
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
  resolvedWorkflowByRunId = null,
  liveLabelSequence = null,
  pullFailuresAt = [],
  checkRunFailuresAt = [],
  commentListFailuresAt = [],
  eventPullRequest = pullRequest(),
  workflowRunFailure = false,
  review = undefined,
  removeLabelFailures = [],
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
        getWorkflowRun: async ({ run_id: runId }) => {
          if (workflowRunFailure) throw new Error('workflow lookup failed');
          if (resolvedWorkflowByRunId?.[runId]) {
            return { data: resolvedWorkflowByRunId[runId] };
          }
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
          if (removeLabelFailures.includes(name)) {
            const error = new Error(`label removal rejected for ${name}`);
            error.status = 500;
            throw error;
          }
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
    eventName,
    repo: { owner: 'masonwells1', repo: 'FarmRx' },
    payload: {
      action,
      changes,
      label: eventLabel ? { name: eventLabel } : undefined,
      pull_request: eventPullRequest,
      review,
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
      ignoredChecks: IGNORED_CHECKS,
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
      ignoredChecks: IGNORED_CHECKS,
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
  assert.match(harness.notices.join('\n'), /any superseded review command/);
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
    eventPullRequest: pullRequest({ head: NEXT_HEAD, labels: [READY_LABEL, REQUESTED_LABEL] }),
  });
  const result = await execute(harness);

  assert.equal(result.status, 'reset');
  assert.equal(harness.liveLabels.size, 0);
  assert.deepEqual(harness.comments, []);
});

// Regression: the reset removed the two labels with bare sequential awaits, so a
// transient failure on the first skipped the second — leaving a stale
// `coderabbit-review-requested` marker on a candidate the gate had just
// invalidated, which the outer recovery then preserves.
test('a reset attempts the second label removal even when the first fails', async () => {
  const harness = makeHarness({
    action: 'synchronize',
    eventLabel: null,
    pulls: [pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] })],
    eventPullRequest: pullRequest({ head: NEXT_HEAD, labels: [READY_LABEL, REQUESTED_LABEL] }),
    removeLabelFailures: [READY_LABEL],
  });
  const result = await execute(harness);

  // The requested marker MUST come off even though the ready removal threw first.
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.notEqual(result.status, 'reset');
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

test('enabling or disabling auto-merge resets both workflow labels', async () => {
  for (const action of ['auto_merge_enabled', 'auto_merge_disabled']) {
    const harness = makeHarness({
      action,
      eventLabel: null,
      pulls: [pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] })],
      eventPullRequest: pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] }),
    });
    const result = await execute(harness);

    assert.equal(result.status, 'reset');
    assert.equal(harness.liveLabels.size, 0);
  }
});

test('a metadata edit clears stale requested state after replacing a queued synchronize reset', async () => {
  const harness = makeHarness({
    action: 'edited',
    changes: { title: { from: 'Old title' } },
    eventLabel: null,
    eventPullRequest: pullRequest({ head: NEXT_HEAD, labels: [READY_LABEL, REQUESTED_LABEL] }),
    pulls: [pullRequest({ head: NEXT_HEAD, labels: [READY_LABEL, REQUESTED_LABEL] })],
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'reset');
  assert.equal(result.reason, 'pull_request_target.edited.stale_state');
  assert.equal(harness.liveLabels.size, 0);
  // Changed from 1 to 0 deliberately, 2026-09-02. This asserted that the reset
  // left the old-head command in place. That was the defect: the candidate is
  // invalid (live head is NEXT_HEAD, the command is for HEAD), so leaving the
  // command lets CodeRabbit spend a review on a superseded candidate. A reset
  // now deletes it.
  assert.equal(harness.comments.length, 0);
});

test('a metadata edit preserves a confirmed current-head request and removes stray ready state', async () => {
  const harness = makeHarness({
    action: 'edited',
    changes: { body: { from: 'Old body' } },
    eventLabel: null,
    pulls: [pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] })],
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'duplicate');
  assert.equal(result.headSha, HEAD);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.equal(harness.comments.length, 1);
});

test('a metadata edit with no workflow state is ignored', async () => {
  const harness = makeHarness({
    action: 'edited',
    changes: { title: { from: 'Old title' } },
    eventLabel: null,
    pulls: [pullRequest({ labels: [] })],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'ignored');
  assert.equal(result.reason, 'pull_request_target.edited.no_gate_state');
  assert.equal(harness.liveLabels.size, 0);
  assert.deepEqual(harness.comments, []);
});

// Regression: the approval path took a BARE pulls.get while the label path
// polled for resolved mergeability. Catching GitHub mid-recalculation
// (mergeable: null / 'unknown') made validateAuthorizationState report a
// blocker, and on this path a blocker DELETES the posted command and both
// labels — destroying a valid exact-head approval and forcing a second paid
// review. Both paths must agree about what a live snapshot is.
test('an unrelated label event that displaces a queued synchronize reset clears stale gate state', async () => {
  const changed = pullRequest({ head: NEXT_HEAD, labels: [READY_LABEL, REQUESTED_LABEL] });
  const harness = makeHarness({
    action: 'labeled',
    eventLabel: 'unrelated-label',
    pulls: [changed],
    eventPullRequest: pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] }),
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'reset');
  assert.equal(harness.liveLabels.size, 0);
  assert.match(result.reason, /labeled\.unrelated-label\.stale_state/);
});

test('an unrelated label event preserves a confirmed current-head request', async () => {
  const current = pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] });
  const harness = makeHarness({
    action: 'labeled',
    eventLabel: 'unrelated-label',
    pulls: [current, current],
    eventPullRequest: current,
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'duplicate');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.equal(harness.comments.length, 1);
});

test('an ordinary unrelated label event with no gate state is ignored', async () => {
  const current = pullRequest({ labels: [] });
  const harness = makeHarness({
    action: 'unlabeled',
    eventLabel: 'unrelated-label',
    pulls: [current],
    eventPullRequest: current,
  });
  const result = await execute(harness);

  assert.equal(result.status, 'ignored');
  assert.equal(result.reason, 'pull_request_target.unlabeled.unrelated-label.no_gate_state');
});

test('a stale ready-label payload cannot clear a live dedupe marker', async () => {
  // Same race as the unrelated-label case above, on the ready-label path: the
  // queued payload predates the in-flight run's marker. Recovery must read the
  // LIVE labels, not the payload, or it clears a marker whose command is live.
  const current = pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] });
  const harness = makeHarness({
    action: 'labeled',
    eventLabel: READY_LABEL,
    eventPullRequest: pullRequest({ labels: [] }),
    pulls: [current],
    pullFailuresAt: [1],
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });

  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.equal(harness.comments.length, 1);
  assert.match(harness.failures[0], /requested marker was preserved/);
});

test('a stale unrelated-label payload cannot lose dedupe state after the first live read fails', async () => {
  const current = pullRequest({ labels: [READY_LABEL, REQUESTED_LABEL] });
  const harness = makeHarness({
    action: 'labeled',
    eventLabel: 'unrelated-label',
    // The event queued before the active gate recorded its live marker.
    eventPullRequest: pullRequest({ labels: [] }),
    pulls: [current],
    pullFailuresAt: [1],
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });

  const failedReconciliation = await execute(harness);
  assert.equal(failedReconciliation.status, 'blocked');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.equal(harness.comments.length, 1);
  assert.match(harness.failures[0], /requested marker was preserved/);

  await harness.github.rest.issues.addLabels({ labels: [READY_LABEL] });
  harness.context.payload.label = { name: READY_LABEL };
  const retry = await execute(harness);

  assert.equal(retry.status, 'duplicate');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.equal(harness.comments.length, 1);
});

test('a metadata edit that displaces a draft reset clears the old gate labels', async () => {
  const draft = pullRequest({ labels: [REQUESTED_LABEL], draft: true });
  const harness = makeHarness({
    action: 'edited',
    changes: { title: { from: 'Old title' } },
    eventLabel: null,
    pulls: [draft],
    eventPullRequest: pullRequest({ labels: [REQUESTED_LABEL] }),
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'reset');
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.match(result.reason, /still a draft/);
});

// Regression: the `edited` branch used to carry its own copy of the
// reconciliation sequence and had lost the post-lookup confirmation re-read. A
// head change racing the command lookup was therefore reported as a confirmed
// duplicate here while every other event path reset. It now delegates.
test('a metadata edit re-reads the pull request and resets when the head races the lookup', async () => {
  const harness = makeHarness({
    action: 'edited',
    changes: { title: { from: 'Old title' } },
    eventLabel: null,
    eventPullRequest: pullRequest({ labels: [REQUESTED_LABEL] }),
    pulls: [
      pullRequest({ labels: [REQUESTED_LABEL] }),
      pullRequest({ head: NEXT_HEAD, labels: [REQUESTED_LABEL] }),
    ],
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'reset');
  assert.match(result.reason, /^pull_request_target\.edited\.changed_live_state/);
  assert.match(result.reason, /head changed during label-event reconciliation/);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
});

test('ready-for-review and requested-marker removal both invalidate prior authorization', async () => {
  for (const event of [
    { action: 'ready_for_review', eventLabel: null },
    { action: 'unlabeled', eventLabel: REQUESTED_LABEL },
  ]) {
    const harness = makeHarness({
      ...event,
      pulls: [pullRequest({ labels: [REQUESTED_LABEL] })],
      eventPullRequest: pullRequest({ labels: [REQUESTED_LABEL] }),
    });
    const result = await execute(harness);

    assert.equal(result.status, 'reset');
    assert.equal(harness.liveLabels.has(REQUESTED_LABEL), false);
  }
});

for (const [failureName, failureOptions] of [
  ['live pull snapshot failure', { pullFailuresAt: [1] }],
  ['current-head command lookup failure', { commentListFailuresAt: [1] }],
]) {
  test(`a displaced metadata edit preserves dedupe state after ${failureName}`, async () => {
    const harness = makeHarness({
      action: 'edited',
      changes: { title: { from: 'Old title' } },
      eventLabel: null,
      // The event was queued before the active gate added its live marker.
      eventPullRequest: pullRequest({ labels: [] }),
      pulls: [pullRequest({ labels: [REQUESTED_LABEL] })],
      existingComments: [{
        id: 99,
        body: reviewCommandBody(HEAD),
        created_at: new Date().toISOString(),
        user: { login: 'github-actions[bot]' },
      }],
      ...failureOptions,
    });

    const failedReconciliation = await execute(harness);
    assert.equal(failedReconciliation.status, 'blocked');
    assert.equal(harness.liveLabels.has(READY_LABEL), false);
    assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
    assert.equal(harness.comments.length, 1);
    assert.match(harness.failures[0], /requested marker was preserved/);

    await harness.github.rest.issues.addLabels({ labels: [READY_LABEL] });
    harness.context.payload.action = 'labeled';
    harness.context.payload.label = { name: READY_LABEL };
    const retry = await execute(harness);

    assert.equal(retry.status, 'duplicate');
    assert.equal(harness.liveLabels.has(READY_LABEL), false);
    assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
    assert.equal(harness.comments.length, 1);
  });
}

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

// Regression: a `synchronize` queued behind a FINISHED request run reaches the
// reset after that run's post-comment cleanup window has closed, so clearing the
// labels was not enough — the command posted for the old head stayed on the PR
// and CodeRabbit could still spend a review on the invalidated candidate.
test('a push reset deletes the superseded old-head command', async () => {
  const harness = makeHarness({
    action: 'synchronize',
    eventLabel: null,
    pulls: [pullRequest({ head: NEXT_HEAD, labels: [REQUESTED_LABEL] })],
    eventPullRequest: pullRequest({ head: NEXT_HEAD, labels: [REQUESTED_LABEL] }),
    existingComments: [{
      id: 99,
      body: reviewCommandBody(HEAD),
      created_at: new Date().toISOString(),
      user: { login: 'github-actions[bot]' },
    }],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'reset');
  assert.deepEqual(harness.comments, [], 'the old-head command must be deleted, not just unlabelled');
  assert.equal(harness.liveLabels.size, 0);
});

// Regression, and a correction of this test's first version. It originally
// asserted that a current-head command SURVIVES a reset, which was wrong: a base
// edit, draft conversion, reopen or auto-merge change invalidates the candidate
// with the head UNCHANGED. Preserving the command there is exactly the failure —
// a relabel posts a second paid command while the first can still be reviewed.
// A reset means the candidate is invalid, so the command goes regardless of head.
for (const [name, event] of [
  ['a base edit', { action: 'edited', changes: { base: { ref: { from: 'main' } } } }],
  ['a draft conversion', { action: 'converted_to_draft' }],
  ['a reopen', { action: 'reopened' }],
  ['an auto-merge change', { action: 'auto_merge_enabled' }],
]) {
  test(`${name} deletes the posted command even though the head did not move`, async () => {
    const harness = makeHarness({
      ...event,
      eventLabel: null,
      pulls: [pullRequest({ labels: [REQUESTED_LABEL] })],
      eventPullRequest: pullRequest({ labels: [REQUESTED_LABEL] }),
      existingComments: [{
        id: 99,
        body: reviewCommandBody(HEAD),
        created_at: new Date().toISOString(),
        user: { login: 'github-actions[bot]' },
      }],
    });
    const result = await execute(harness);

    assert.equal(result.status, 'reset');
    assert.deepEqual(
      harness.comments, [],
      'an invalidated candidate must not keep its command just because the head is unchanged',
    );
  });
}

// Regression: an UNVERIFIABLE cleanup is not a clean one. If the lookup that
// finds the posted command fails, a command may still be live; clearing the
// dedupe marker there lets the next ready label post a SECOND paid command
// beside it. Same distinction the comment-post recovery path draws.
test('a reset whose command lookup fails preserves the dedupe marker', async () => {
  const harness = makeHarness({
    action: 'synchronize',
    eventLabel: null,
    pulls: [pullRequest({ head: NEXT_HEAD, labels: [READY_LABEL, REQUESTED_LABEL] })],
    eventPullRequest: pullRequest({ head: NEXT_HEAD, labels: [READY_LABEL, REQUESTED_LABEL] }),
    commentListFailuresAt: [1],
  });
  const result = await execute(harness);

  assert.notEqual(result.status, 'reset', 'an unverified cleanup must not report a clean reset');
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true, 'the dedupe marker must survive');
  assert.equal(harness.liveLabels.has(READY_LABEL), false, 'the ready label must still come off');
  assert.match(harness.failures[0], /could not be fully reset/);
  assert.match(harness.failures[0], /cannot buy a second review/);
});

test('a reset leaves comments that are not Actions-authored review commands alone', async () => {
  const harness = makeHarness({
    action: 'synchronize',
    eventLabel: null,
    pulls: [pullRequest({ head: NEXT_HEAD, labels: [REQUESTED_LABEL] })],
    eventPullRequest: pullRequest({ head: NEXT_HEAD, labels: [REQUESTED_LABEL] }),
    existingComments: [
      { id: 98, body: 'a human note', created_at: new Date().toISOString(), user: { login: 'masonwells1' } },
      { id: 99, body: reviewCommandBody(HEAD), created_at: new Date().toISOString(), user: { login: 'github-actions[bot]' } },
      { id: 100, body: REVIEW_COMMAND, created_at: new Date().toISOString(), user: { login: 'masonwells1' } },
    ],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'reset');
  assert.deepEqual(
    harness.comments.map((comment) => comment.id), [98, 100],
    'only the Actions-authored marked command may be deleted',
  );
});

// Regression: workflow runs QUEUE rather than cancel, so a maintainer removing
// the requested marker to abort an in-flight request would still have had the
// command posted before the queued reset ran — spending a review that was
// deliberately cancelled. Both final validations now require the marker.
test('removing the requested marker mid-flight cancels the request and posts no command', async () => {
  const harness = makeHarness({
    liveLabelSequence: [[READY_LABEL], [READY_LABEL], [READY_LABEL], [READY_LABEL]],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(harness.comments, []);
  assert.match(harness.failures[0], /coderabbit-review-requested was removed while the request was in flight/);
  // Must be caught by the FINAL validation, BEFORE the command is posted — not
  // by the post-comment pass, which would mean the review was spent and the
  // comment then deleted. That distinction is the whole point of the fix.
  assert.doesNotMatch(harness.failures[0], /while the review command was being posted/);
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

test('a failed marker removal never strands the ready label during recovery', async () => {
  const harness = makeHarness({
    pullFailuresAt: [1],
    removeLabelFailures: [REQUESTED_LABEL],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  // The ready label MUST come off even though the marker removal threw first:
  // it is already attached, so no further `labeled` event can retrigger the gate.
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.match(harness.failures[0], /gate failed unexpectedly/);
  assert.match(harness.failures[0], /label cleanup failed/);
  assert.match(harness.failures[0], new RegExp(REQUESTED_LABEL));
});

test('a failed ready-label removal during recovery is reported, not thrown', async () => {
  const harness = makeHarness({
    pullFailuresAt: [1],
    removeLabelFailures: [READY_LABEL],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.equal(harness.liveLabels.has(READY_LABEL), true);
  assert.match(harness.failures[0], /label cleanup failed/);
  assert.match(harness.failures[0], /remove the labels by hand/);
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
      ignoredChecks: IGNORED_CHECKS,
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
      ignoredChecks: IGNORED_CHECKS,
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

// Regression: the ambiguous-recovery branch used to return `requested` straight
// away, skipping the post-comment revalidation the confirmed path runs. A head
// change racing the ambiguous post therefore left the command standing and spent
// a CodeRabbit review on an unfrozen candidate. A recovered command is a POSTED
// command and earns the same revalidation.
test('an ambiguous recovery still revalidates and deletes a command left on a raced head', async () => {
  const harness = makeHarness({
    commentFailure: 'ambiguous',
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

// Regression: when createComment fails AND the recovery lookup also fails, the
// gate cannot know whether GitHub accepted the command. Clearing the dedupe
// marker there invites a relabel that buys a SECOND paid review for the same
// head. A confirmed absence and an unverifiable lookup are different states.
test('an unverifiable recovery lookup preserves the dedupe marker', async () => {
  const harness = makeHarness({
    commentFailure: 'definite',
    commentListFailuresAt: [2],
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.equal(harness.liveLabels.has(READY_LABEL), false);
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
  assert.match(harness.failures[0], /follow-up lookup also failed/);
  assert.match(harness.failures[0], /cannot buy a second review/);
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

test('an old-head marker and command are deleted, not left beside the current-head request', async () => {
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
  // The superseded command must be GONE. Leaving it beside the new one spends a
  // second review out of the paid hourly allowance on one frozen candidate.
  assert.deepEqual(
    harness.comments.map((comment) => comment.body),
    [reviewCommandBody(HEAD)],
  );
  assert.equal(harness.liveLabels.has(REQUESTED_LABEL), true);
});

test('check evaluation accepts neutral/skipped results and ignores trusted CodeRabbit pending state', () => {
  const blockers = evaluateChecks({
    checkRuns: [
      completedCheck('foundation'),
      completedCheck('optional-neutral', 'neutral'),
      completedCheck('optional-skipped', 'skipped'),
    ],
    statuses: [commitStatus('Vercel'), commitStatus('CodeRabbit', 'pending')],
    requiredChecks: REQUIRED_CHECKS,
    ignoredChecks: IGNORED_CHECKS,
  });

  assert.deepEqual(blockers, []);
});

test('a foreign failed status named CodeRabbit is not ignored', () => {
  const foreignStatus = {
    ...commitStatus('CodeRabbit', 'failure'),
    creator: { login: 'not-coderabbit[bot]' },
  };
  const blockers = evaluateChecks({
    checkRuns: [completedCheck('foundation')],
    statuses: [commitStatus('Vercel'), foreignStatus],
    requiredChecks: REQUIRED_CHECKS,
    ignoredChecks: IGNORED_CHECKS,
  });

  assert.match(blockers.join('\n'), /CodeRabbit: failure/);
});

test('a foreign failed check run named CodeRabbit is not ignored', () => {
  const foreignCheck = {
    ...completedCheck('CodeRabbit', 'failure'),
    app: { id: 15368 },
  };
  const blockers = evaluateChecks({
    checkRuns: [completedCheck('foundation'), foreignCheck],
    statuses: [commitStatus('Vercel'), commitStatus('CodeRabbit', 'pending')],
    requiredChecks: REQUIRED_CHECKS,
    ignoredChecks: IGNORED_CHECKS,
  });

  assert.match(blockers.join('\n'), /CodeRabbit: completed\/failure/);
});

test('a name-only ignored-check policy fails closed', () => {
  const blockers = evaluateChecks({
    checkRuns: [completedCheck('foundation')],
    statuses: [commitStatus('Vercel'), commitStatus('CodeRabbit', 'pending')],
    requiredChecks: REQUIRED_CHECKS,
    ignoredChecks: ['CodeRabbit'],
  });

  assert.match(
    blockers.join('\n'),
    /ignored-check configuration is missing a named provenance policy/,
  );
  assert.match(blockers.join('\n'), /CodeRabbit: pending/);
});

test('a whitespace-only trusted creator cannot ignore a creator-less CodeRabbit status', () => {
  const creatorlessStatus = {
    ...commitStatus('CodeRabbit', 'pending'),
    creator: undefined,
  };
  const blockers = evaluateChecks({
    checkRuns: [completedCheck('foundation')],
    statuses: [commitStatus('Vercel'), creatorlessStatus],
    requiredChecks: REQUIRED_CHECKS,
    ignoredChecks: [{ name: 'CodeRabbit', source: 'status', creator: '   ' }],
  });

  assert.match(blockers.join('\n'), /ignored-check configuration is not provenance-bound/);
  assert.match(blockers.join('\n'), /CodeRabbit: pending/);
});

test('malformed structured ignored-check identities all fail closed', () => {
  const malformedPolicies = [
    { name: '', source: 'status', creator: 'coderabbitai[bot]' },
    { name: '   ', source: 'status', creator: 'coderabbitai[bot]' },
    { name: { value: 'CodeRabbit' }, source: 'status', creator: 'coderabbitai[bot]' },
    { name: 'CodeRabbit', source: 'status', creator: null },
    { name: 'CodeRabbit', source: 'status', creator: { login: 'coderabbitai[bot]' } },
    { name: 'CodeRabbit', source: 'check_run', appId: 'not-a-number' },
    { name: 'CodeRabbit', source: 'check_run', appId: '347564' },
    { name: 'CodeRabbit', source: 'check_run', appId: 0 },
    { name: 'CodeRabbit', source: 'check_run', appId: -347564 },
    { name: 'CodeRabbit', source: 'check_run', appId: 347564.5 },
    { name: 'CodeRabbit', source: 'check_run', appId: Number.NaN },
  ];

  for (const policy of malformedPolicies) {
    const blockers = evaluateChecks({
      checkRuns: [completedCheck('foundation')],
      statuses: [commitStatus('Vercel')],
      requiredChecks: REQUIRED_CHECKS,
      ignoredChecks: [policy],
    });

    assert.match(blockers.join('\n'), /ignored-check configuration/);
  }
});

test('malformed required-check identity strings and app IDs fail closed', () => {
  const malformedRequiredChecks = [
    { ...REQUIRED_CHECKS[0], name: '   ' },
    { ...REQUIRED_CHECKS[0], workflowPath: '   ' },
    { ...REQUIRED_CHECKS[0], appId: '15368' },
    { ...REQUIRED_CHECKS[0], appId: -1 },
    { ...REQUIRED_CHECKS[0], appId: 15368.5 },
    { name: 'Vercel', source: 'status', creator: '   ' },
    { name: 'Vercel', source: 'status', creator: { login: 'vercel[bot]' } },
  ];

  for (const requiredCheck of malformedRequiredChecks) {
    const blockers = evaluateChecks({
      checkRuns: [completedCheck('foundation')],
      statuses: [commitStatus('Vercel')],
      requiredChecks: [requiredCheck],
      ignoredChecks: IGNORED_CHECKS,
    });

    assert.match(blockers.join('\n'), /required-check configuration/);
  }
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

test('a passing same-name job from another workflow cannot hide a failed optional check', async () => {
  const harness = makeHarness({
    checkRuns: [
      completedCheck('foundation'),
      {
        ...completedCheck('Phase 3C Containment (Windows)', 'failure'),
        id: 200,
        workflow_id: undefined,
        workflow_path: undefined,
        details_url: 'https://github.com/example/repo/actions/runs/500/job/1',
      },
      {
        ...completedCheck('Phase 3C Containment (Windows)', 'success'),
        id: 201,
        workflow_id: undefined,
        workflow_path: undefined,
        details_url: 'https://github.com/example/repo/actions/runs/501/job/2',
      },
    ],
    resolvedWorkflowByRunId: {
      500: { workflow_id: 4242, path: '.github/workflows/ci.yml' },
      501: { workflow_id: 9001, path: '.github/workflows/untrusted.yml' },
    },
  });
  const result = await execute(harness);

  assert.equal(result.status, 'blocked');
  assert.match(harness.failures[0], /Phase 3C Containment \(Windows\): completed\/failure/);
  assert.deepEqual(harness.comments, []);
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
