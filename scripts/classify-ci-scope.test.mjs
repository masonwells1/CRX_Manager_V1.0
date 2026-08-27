#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  applyPriorFullProof,
  classifyCiScope,
  classifyPathList,
  classifyPullRequestEvent,
  fullProofArtifactName,
  isFastDocumentationPath,
  parseChangedEntries,
  parseChangedPaths,
  runClassifier,
  verifyPriorFullCiProof,
} from './classify-ci-scope.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let assertions = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function throws(callback, message) {
  assert.throws(callback, undefined, message);
  assertions += 1;
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
}

function markdownFilesUnder(relativeRoot) {
  const absoluteRoot = path.join(REPO_ROOT, ...relativeRoot.split('/'));
  if (!existsSync(absoluteRoot)) return [];
  const found = [];
  const visit = (absoluteDirectory, relativeDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolute = path.join(absoluteDirectory, entry.name);
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(relative);
    }
  };
  visit(absoluteRoot, relativeRoot);
  return found;
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function createRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'crx-ci-scope-'));
  git(root, ['init', '--initial-branch=main', '--template=']);
  const isolatedHooks = path.join(root, '.git', 'test-hooks');
  mkdirSync(isolatedHooks, { recursive: true });
  git(root, ['config', '--local', 'core.hooksPath', isolatedHooks]);
  git(root, ['config', '--local', 'commit.gpgSign', 'false']);
  git(root, ['config', '--local', 'tag.gpgSign', 'false']);
  git(root, ['config', '--local', 'user.email', 'ci-scope@example.invalid']);
  git(root, ['config', '--local', 'user.name', 'CI Scope Test']);
  write(root, 'README.md', '# project\n');
  write(root, 'docs/audits/evidence.md', '# baseline\n');
  write(root, 'docs/CHANGELOG.md', '# changelog\n');
  write(root, 'docs/manual/KNOWN_ISSUES.md', '# known issues\n');
  write(root, 'src/example.ts', 'export const value = 1;\n');
  const base = commitAll(root, 'baseline');
  return { root, base };
}

const safePaths = [
  'README.md',
  'docs/CHANGELOG.md',
  'docs/changelog.d/2026-08-26-docs-fast-lane.md',
];
for (const candidate of safePaths) equal(isFastDocumentationPath(candidate), true, candidate);

const protectedPaths = [
  'AGENTS.md',
  'CLAUDE.md',
  '.coderabbit.yaml',
  '.claude/skills/example/SKILL.md',
  '.codex/hooks/example.mjs',
  '.github/workflows/ci.yml',
  '.husky/pre-push',
  'package.json',
  'scripts/classify-ci-scope.mjs',
  'supabase/migrations/20260826000000_example.sql',
  'src/App.tsx',
  'docs/app-workflow-map.html',
  'docs/changelog.d/README.md',
  'docs/changelog.d/2026-13-26-impossible-date.md',
  'docs/changelog.d/2026-08-26-Bad-Slug.md',
  'docs/manual/DECISION_LOG.md',
  'docs/manual/AGENT_ONBOARDING.md',
  'docs/manual/KNOWN_ISSUES.md',
  'docs/archive/2026/report.md',
  'docs/audits/2026/report.md',
  'docs/handoffs/next.md',
  'docs/loops/review.md',
  'docs/plans/build.md',
  'docs/reference/migration-history.md',
  'docs/workflows/SAFE_DEVELOPMENT_RULES.md',
  'docs/audits/report.MD',
  'docs/audits/AGENTS.md',
  'docs/audits/AGENTS.override.md',
  'docs/audits/agents.OVERRIDE.md',
  'docs/audits/nested/AgEnTs.OvErRiDe.md',
  'docs/handoffs/agents.md',
  'docs/plans/ClAuDe.md',
  'docs/loops/CLAUDE.local.md',
  'docs/loops/claude.review.override.md',
  'docs/archive/GEMINI.md',
  'docs/archive/SKILL.md',
  'docs/audits/copilot-instructions.md',
  'docs/audits/.claude/instructions.md',
  'docs/audits/.CoDeX/instructions.md',
  'docs/handoffs/.agents/skills/reviewer.md',
  'docs/plans/.github/pull_request_template.md',
  'docs/loops/.HUSKY/instructions.md',
  'docs/audits/../plans/report.md',
  'docs\\audits\\report.md',
  '/docs/audits/report.md',
];
for (const candidate of protectedPaths) equal(isFastDocumentationPath(candidate), false, candidate);

const agentConsumedDocs = [
  'docs/archive',
  'docs/audits',
  'docs/build-loops',
  'docs/handoffs',
  'docs/loops',
  'docs/plans',
].flatMap(markdownFilesUnder);
equal(agentConsumedDocs.length > 0, true, 'agent-consumed documentation inventory must not be empty');
for (const candidate of agentConsumedDocs) {
  equal(isFastDocumentationPath(candidate), false, `agent-consumed document must run full CI: ${candidate}`);
}

equal(classifyPathList([]).fullCi, true, 'empty diff must run full CI');
equal(classifyPathList(['README.md', 'docs/CHANGELOG.md']).docsOnly, true, 'ordinary passive records');
equal(classifyPathList(['README.md', 'src/App.tsx']).fullCi, true, 'mixed changes');
equal(classifyPathList(Array.from({ length: 5001 }, () => 'README.md')).reason, 'changed-path-limit', 'path limit');
throws(() => parseChangedPaths(Buffer.from('M\0docs/audits/a.md')), 'unterminated git output');
throws(
  () => parseChangedPaths(Buffer.from([0x4d, 0x00, 0x64, 0x6f, 0x63, 0x73, 0x2f, 0xff, 0x00])),
  'non-UTF-8 git path',
);
equal(
  parseChangedEntries(Buffer.from('A\0docs/changelog.d/2026-08-26-new.md\0'))[0].status,
  'A',
  'status parser must preserve additions',
);

const readyPr = { action: 'opened', pull_request: { draft: false } };
const draftPr = { action: 'opened', pull_request: { draft: true } };
equal(classifyPullRequestEvent('push', {}).route, 'code', 'pushes use code routing');
equal(classifyPullRequestEvent('pull_request', readyPr).route, 'code', 'ready opened PR uses code routing');
equal(classifyPullRequestEvent('pull_request', draftPr).route, 'code', 'opened draft still requires code proof');
equal(
  classifyPullRequestEvent('pull_request', { action: 'synchronize', pull_request: { draft: true } }).route,
  'code',
  'draft synchronize still requires code proof',
);
equal(
  classifyPullRequestEvent('pull_request', { action: 'ready_for_review', pull_request: { draft: false } }).route,
  'force-full',
  'ready-for-review forces full proof',
);
for (const changes of [{ title: { from: 'old' } }, { body: { from: 'old' } }, { title: { from: 'old' }, body: { from: 'old' } }]) {
  equal(
    classifyPullRequestEvent('pull_request', { action: 'edited', changes, pull_request: { draft: false } }).route,
    'metadata',
    'title/body-only edits are metadata candidates',
  );
}
for (const changes of [{ base: { ref: { from: 'release' } } }, {}, { labels: { from: [] } }, null]) {
  equal(
    classifyPullRequestEvent('pull_request', { action: 'edited', changes, pull_request: { draft: false } }).route,
    'force-full',
    'base or ambiguous edits force full proof',
  );
}
equal(
  classifyPullRequestEvent('pull_request', { action: 'edited', changes: { base: { ref: { from: 'release' } } }, pull_request: { draft: true } }).route,
  'force-full',
  'base edits force full proof even while draft',
);

const proofBase = 'a'.repeat(40);
const proofHead = 'b'.repeat(40);
const proofName = fullProofArtifactName(proofBase, proofHead);
equal(proofName, `crx-full-ci-proof-${proofBase}-${proofHead}`, 'full proof artifact binds base and head');
const artifactListing = runId => ({
  total_count: 1,
  artifacts: [{
    name: proofName,
    expired: false,
    created_at: '2026-08-27T00:00:00Z',
    workflow_run: { id: runId, head_sha: proofHead },
  }],
});
const workflowRun = (runId, overrides = {}) => ({
  id: runId,
  status: 'completed',
  conclusion: 'success',
  event: 'pull_request',
  path: '.github/workflows/ci.yml',
  head_sha: proofHead,
  created_at: `2026-08-27T${String(runId % 24).padStart(2, '0')}:00:00Z`,
  pull_requests: [{ base: { sha: proofBase }, head: { sha: proofHead } }],
  ...overrides,
});
const workflowRunListing = runs => ({ total_count: runs.length, workflow_runs: runs });
const response = (payload, ok = true, status = 200) => ({ ok, status, json: async () => payload });
equal(
  await verifyPriorFullCiProof({
    repository: 'masonwells1/CRX_Manager_V1.0',
    baseSha: proofBase,
    headSha: proofHead,
    currentRunId: '999',
    fetchImpl: async url => url.includes('/actions/workflows/')
      ? response(workflowRunListing([workflowRun(321)]))
      : response(artifactListing(321)),
  }),
  true,
  'successful prior full workflow proof is accepted',
);
equal(
  await verifyPriorFullCiProof({
    repository: 'masonwells1/CRX_Manager_V1.0',
    baseSha: proofBase,
    headSha: proofHead,
    currentRunId: '321',
    fetchImpl: async url => url.includes('/actions/workflows/')
      ? response(workflowRunListing([workflowRun(321)]))
      : response(artifactListing(321)),
  }),
  false,
  'current workflow cannot attest itself',
);
equal(
  await verifyPriorFullCiProof({
    repository: 'masonwells1/CRX_Manager_V1.0',
    baseSha: proofBase,
    headSha: proofHead,
    currentRunId: '999',
    fetchImpl: async url => url.includes('/actions/workflows/')
      ? response(workflowRunListing([workflowRun(321, { conclusion: 'failure' })]))
      : response(artifactListing(321)),
  }),
  false,
  'failed prior workflow is not accepted',
);
{
  let artifactRequests = 0;
  equal(
    await verifyPriorFullCiProof({
      repository: 'masonwells1/CRX_Manager_V1.0',
      baseSha: proofBase,
      headSha: proofHead,
      currentRunId: '999',
      fetchImpl: async url => {
        if (url.includes('/actions/workflows/')) {
          return response(workflowRunListing([
            workflowRun(321, { created_at: '2026-08-27T00:00:00Z' }),
            workflowRun(654, { created_at: '2026-08-27T01:00:00Z', conclusion: 'failure' }),
          ]));
        }
        artifactRequests += 1;
        return response(artifactListing(321));
      },
    }),
    false,
    'newest failed full run blocks an older success',
  );
  equal(artifactRequests, 0, 'a newest failed run blocks proof before artifact lookup');
}
{
  equal(
    await verifyPriorFullCiProof({
      repository: 'masonwells1/CRX_Manager_V1.0',
      baseSha: proofBase,
      headSha: proofHead,
      currentRunId: '999',
      fetchImpl: async url => {
        if (url.includes('/actions/workflows/')) {
          return response(workflowRunListing([
            workflowRun(321, { created_at: '2026-08-27T00:00:00Z' }),
            workflowRun(654, { created_at: '2026-08-27T01:00:00Z' }),
          ]));
        }
        return response(artifactListing(321));
      },
    }),
    false,
    'a newer successful cheap run without an artifact blocks an older full proof',
  );
}
equal(
  applyPriorFullProof({ docsOnly: false, fullCi: true, reason: 'code', changedPaths: ['src/App.tsx'] }, 'metadata', true).fullCi,
  false,
  'metadata routing becomes cheap only with prior full proof',
);
equal(
  applyPriorFullProof({ docsOnly: false, fullCi: true, reason: 'code', changedPaths: ['src/App.tsx'] }, 'metadata', false).fullCi,
  true,
  'metadata routing without prior proof preserves full CI',
);
equal(
  applyPriorFullProof({ docsOnly: false, fullCi: true, reason: 'code', changedPaths: ['src/App.tsx'] }, 'code', true).fullCi,
  true,
  'prior artifact cannot cheap-route a code event',
);
equal(
  await verifyPriorFullCiProof({
    repository: 'masonwells1/CRX_Manager_V1.0',
    baseSha: proofBase,
    headSha: proofHead,
    currentRunId: '999',
    fetchImpl: async url => url.includes('/actions/workflows/')
      ? response(workflowRunListing([workflowRun(321)]))
      : response({ ...artifactListing(321), artifacts: [{ ...artifactListing(321).artifacts[0], expired: true }] }),
  }),
  false,
  'expired proof artifacts are rejected',
);
await assert.rejects(
  verifyPriorFullCiProof({
    repository: 'masonwells1/CRX_Manager_V1.0',
    baseSha: proofBase,
    headSha: proofHead,
    currentRunId: '999',
    fetchImpl: async () => response({}, false, 403),
  }),
  /workflow-run lookup failed/,
);
assertions += 1;

const workflow = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
for (const requiredFragment of [
  'types: [opened, reopened, synchronize, ready_for_review, edited]',
  'name: Classify CI scope',
  'timeout-minutes: 5',
  '--event-path "$GITHUB_EVENT_PATH"',
  'name: Publish exact full-CI proof',
  'crx-full-ci-proof-${{ github.event.pull_request.base.sha }}-${{ github.event.pull_request.head.sha }}',
  "github.event.action == 'edited' && 'edited' || 'code'",
  'if ! git -C "$GITHUB_WORKSPACE" cat-file -e "${compare_base}^{commit}" 2>/dev/null; then',
  'git -C "$GITHUB_WORKSPACE" worktree add --detach "$trusted_root" "$compare_base"',
  '--github-output "$classifier_output"; then',
  'cat "$classifier_output" >> "$GITHUB_OUTPUT"',
  'needs: [phase3-private-artifact-containment, ci-scope]',
  'needs: [phase3-private-artifact-containment, ci-scope, sql-validation]',
  'CI_SCOPE_RESULT: ${{ needs.ci-scope.result }}',
  'if: ${{ needs.ci-scope.outputs.full_ci == \'true\' }}',
]) {
  equal(workflow.includes(requiredFragment), true, `workflow contract: ${requiredFragment}`);
}
equal(
  /^  lint-typecheck-test:\r?\n    name: Lint, Type Check, Test, Build\r?\n    runs-on: ubuntu-latest\r?\n    needs: \[phase3-private-artifact-containment, ci-scope, sql-validation\]\r?\n(?:    #.*\r?\n){2}    if: \$\{\{ always\(\) \}\}/m.test(workflow),
  true,
  'required lint job must execute even after a failed dependency',
);
equal(
  /name: Documentation consistency\r?\n\s+run: npm run check:docs/.test(workflow),
  true,
  'documentation consistency must run in both lanes',
);
equal(
  /- name: Phase 3C private-artifact regression tests\r?\n\s+if: \$\{\{ needs\.ci-scope\.outputs\.full_ci == 'true' \}\}\r?\n\s+run: npm run test:supplier-pricing-phase3c-packet/.test(workflow),
  true,
  'Phase 3C packet regressions must remain explicit in the trusted full lane',
);

const disposables = [];
try {
  {
    const { root, base } = createRepo();
    disposables.push(root);
    write(root, 'README.md', '# changed\n');
    const head = commitAll(root, 'ordinary docs');
    const result = classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head });
    equal(result.docsOnly, true, 'real docs diff must use fast lane');
    equal(result.changedPaths.length, 1, 'real docs diff path count');
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    write(root, 'src/example.ts', 'export const value = 2;\n');
    const head = commitAll(root, 'code change');
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head, eventRoute: 'code' }).fullCi,
      true,
      'draft status cannot bypass code-path proof',
    );
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head, eventRoute: 'force-full' }).fullCi,
      true,
      'forced event routing overrides path-based shortcuts',
    );
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    write(root, 'src/example.ts', 'export const value = 3;\n');
    const head = commitAll(root, 'base-edit integration fixture');
    const eventPath = path.join(root, 'base-edit-event.json');
    const outputPath = path.join(root, 'base-edit-output.txt');
    writeFileSync(eventPath, JSON.stringify({
      action: 'edited',
      changes: { base: { ref: { from: 'release' } } },
      pull_request: { draft: false },
    }), 'utf8');
    const result = await runClassifier({
      repoRoot: root,
      eventName: 'pull_request',
      baseSha: base,
      headSha: head,
      githubOutput: outputPath,
      eventPath,
      repository: 'masonwells1/CRX_Manager_V1.0',
      currentRunId: '999',
    });
    equal(result.fullCi, true, 'CLI wiring forces full proof for a base edit');
    equal(readFileSync(outputPath, 'utf8').includes('event_route=force-full'), true, 'CLI output records forced base-edit routing');
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    write(root, 'src/example.ts', 'export const value = 4;\n');
    const head = commitAll(root, 'metadata integration fixture');
    const eventPath = path.join(root, 'metadata-event.json');
    const outputPath = path.join(root, 'metadata-output.txt');
    writeFileSync(eventPath, JSON.stringify({
      action: 'edited',
      changes: { title: { from: 'old title' } },
      pull_request: { draft: false },
    }), 'utf8');
    let sawAbortSignal = false;
    const artifactName = fullProofArtifactName(base, head);
    const result = await runClassifier({
      repoRoot: root,
      eventName: 'pull_request',
      baseSha: base,
      headSha: head,
      githubOutput: outputPath,
      eventPath,
      repository: 'masonwells1/CRX_Manager_V1.0',
      currentRunId: '999',
    }, {
      fetchImpl: async (url, options) => {
        sawAbortSignal = options.signal instanceof AbortSignal;
        if (url.includes('/actions/workflows/')) {
          return response({
            total_count: 1,
            workflow_runs: [{
              id: 777,
              status: 'completed',
              conclusion: 'success',
              event: 'pull_request',
              path: '.github/workflows/ci.yml',
              head_sha: head,
              created_at: '2026-08-27T02:00:00Z',
              pull_requests: [{ base: { sha: base }, head: { sha: head } }],
            }],
          });
        }
        if (url.includes('/actions/artifacts')) {
          return response({
            total_count: 1,
            artifacts: [{
              name: artifactName,
              expired: false,
              created_at: '2026-08-27T02:00:00Z',
              workflow_run: { id: 777, head_sha: head },
            }],
          });
        }
        throw new Error(`unexpected proof URL: ${url}`);
      },
    });
    equal(sawAbortSignal, true, 'CLI wiring bounds GitHub API requests with an abort signal');
    equal(result.fullCi, false, 'CLI wiring applies exact successful metadata proof');
    equal(readFileSync(outputPath, 'utf8').includes('prior_full_proof=true'), true, 'CLI output records accepted exact proof');
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    write(root, 'src/example.ts', 'export const value = 5;\n');
    const head = commitAll(root, 'metadata timeout fixture');
    const eventPath = path.join(root, 'metadata-timeout-event.json');
    const outputPath = path.join(root, 'metadata-timeout-output.txt');
    writeFileSync(eventPath, JSON.stringify({
      action: 'edited',
      changes: { body: { from: 'old body' } },
      pull_request: { draft: false },
    }), 'utf8');
    const result = await runClassifier({
      repoRoot: root,
      eventName: 'pull_request',
      baseSha: base,
      headSha: head,
      githubOutput: outputPath,
      eventPath,
      repository: 'masonwells1/CRX_Manager_V1.0',
      currentRunId: '999',
    }, {
      fetchImpl: async () => { throw new Error('simulated API timeout'); },
    });
    equal(result.fullCi, true, 'CLI wiring fails closed when proof lookup times out');
    equal(readFileSync(outputPath, 'utf8').includes('prior_full_proof=false'), true, 'CLI output records timeout fallback');
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    write(
      root,
      'docs/changelog.d/2026-08-26-docs-fast-lane.md',
      '## 2026-08-26 - docs fast lane\n\nThe trusted classifier accepts this record.\n',
    );
    const head = commitAll(root, 'valid changelog fragment');
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head }).docsOnly,
      true,
      'valid changelog fragment must use fast lane',
    );
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    write(
      root,
      'docs/changelog.d/2026-08-26-empty-record.md',
      '## 2026-08-26 - empty record\n',
    );
    const head = commitAll(root, 'invalid changelog fragment');
    const result = classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head });
    equal(result.fullCi, true, 'invalid changelog content must run full CI');
    equal(result.reason, 'invalid-changelog-entry', 'invalid changelog reason');
  }

  for (const operation of ['modify', 'delete', 'rename']) {
    const { root } = createRepo();
    disposables.push(root);
    const original = 'docs/changelog.d/2026-08-25-existing-record.md';
    write(
      root,
      original,
      '## 2026-08-25 - existing record\n\nThis record belongs to an earlier change.\n',
    );
    const base = commitAll(root, 'existing changelog record');
    if (operation === 'modify') {
      write(
        root,
        original,
        '## 2026-08-25 - edited old record\n\nThis must not stand in for a new record.\n',
      );
    } else if (operation === 'delete') {
      rmSync(path.join(root, ...original.split('/')));
    } else {
      git(root, ['mv', original, 'docs/changelog.d/2026-08-26-renamed-old-record.md']);
    }
    const head = commitAll(root, `${operation} existing changelog record`);
    const result = classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head });
    equal(result.fullCi, true, `${operation} of existing changelog record must run full CI`);
    equal(result.reason, 'non-added-changelog-entry', `${operation} changelog status reason`);
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    git(root, ['checkout', '-b', 'docs-branch']);
    write(root, 'README.md', '# branch docs\n');
    const head = commitAll(root, 'branch docs');
    git(root, ['checkout', 'main']);
    write(root, 'src/main-only.ts', 'export const mainOnly = true;\n');
    const advancedBase = commitAll(root, 'advance base');
    git(root, ['checkout', 'docs-branch']);
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: advancedBase, headSha: head }).docsOnly,
      true,
      'pull requests must use the three-dot merge-base change set',
    );
    equal(base.length, 40, 'fixture base is an exact SHA');
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    write(root, 'README.md', '# changed\n');
    write(root, 'src/example.ts', 'export const value = 2;\n');
    const head = commitAll(root, 'mixed');
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head }).fullCi,
      true,
      'real mixed diff must run full CI',
    );
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
    git(root, ['mv', 'docs/audits/evidence.md', 'docs/plans/evidence.md']);
    const head = commitAll(root, 'agent-control docs rename');
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head }).fullCi,
      true,
      'rename between agent-consumed document folders must run full CI',
    );
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    git(root, ['mv', 'src/example.ts', 'docs/audits/example.md']);
    const head = commitAll(root, 'unsafe rename');
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head }).fullCi,
      true,
      'unsafe-to-safe rename must run full CI',
    );
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    rmSync(path.join(root, 'README.md'));
    const head = commitAll(root, 'passive record deletion');
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'push', baseSha: base, headSha: head }).docsOnly,
      true,
      'passive exact-record deletion must use fast lane',
    );
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'push', baseSha: base, headSha: base }).fullCi,
      true,
      'empty commit range must run full CI',
    );
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'push', baseSha: '0'.repeat(40), headSha: base }).fullCi,
      true,
      'unknown push base must run full CI',
    );
  }

  {
    const { root, base } = createRepo();
    disposables.push(root);
    const blob = git(root, ['hash-object', '-w', '--stdin']);
    git(root, ['update-index', '--add', '--cacheinfo', `120000,${blob},docs/CHANGELOG.md`]);
    git(root, ['commit', '-m', 'symlink-shaped docs entry']);
    const head = git(root, ['rev-parse', 'HEAD']);
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'push', baseSha: base, headSha: head }).fullCi,
      true,
      'symlink-shaped docs entry must run full CI',
    );
  }

  equal(
    classifyCiScope({ repoRoot: 'Z:\\missing-ci-scope-repo', eventName: 'push', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }).fullCi,
    true,
    'missing repository must run full CI',
  );
} finally {
  for (const root of disposables) rmSync(root, { recursive: true, force: true });
}

console.log(`classify-ci-scope: ${assertions} assertions passed`);
