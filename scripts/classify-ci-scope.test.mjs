#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  classifyCiScope,
  classifyPathList,
  isFastDocumentationPath,
  parseChangedEntries,
  parseChangedPaths,
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
  write(root, 'docs/audits/evidence.md', '# baseline\n');
  write(root, 'docs/CHANGELOG.md', '# changelog\n');
  write(root, 'src/example.ts', 'export const value = 1;\n');
  const base = commitAll(root, 'baseline');
  return { root, base };
}

const safePaths = [
  'README.md',
  'docs/CHANGELOG.md',
  'docs/changelog.d/2026-08-26-docs-fast-lane.md',
  'docs/manual/KNOWN_ISSUES.md',
  'docs/archive/2026/report.md',
  'docs/audits/2026/report.md',
  'docs/handoffs/next.md',
  'docs/loops/review.md',
  'docs/plans/build.md',
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

equal(classifyPathList([]).fullCi, true, 'empty diff must run full CI');
equal(classifyPathList(['docs/audits/a.md', 'docs/plans/b.md']).docsOnly, true, 'ordinary docs');
equal(classifyPathList(['docs/audits/a.md', 'src/App.tsx']).fullCi, true, 'mixed changes');
equal(classifyPathList(Array.from({ length: 5001 }, (_, index) => `docs/audits/${index}.md`)).fullCi, true, 'path limit');
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

const workflow = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
for (const requiredFragment of [
  'types: [opened, reopened, synchronize, ready_for_review, edited]',
  'name: Classify CI scope',
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
    write(root, 'docs/audits/evidence.md', '# changed\n');
    const head = commitAll(root, 'ordinary docs');
    const result = classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head });
    equal(result.docsOnly, true, 'real docs diff must use fast lane');
    equal(result.changedPaths.length, 1, 'real docs diff path count');
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
    write(root, 'docs/audits/evidence.md', '# branch docs\n');
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
    write(root, 'docs/audits/evidence.md', '# changed\n');
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
    const head = commitAll(root, 'safe rename');
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'pull_request', baseSha: base, headSha: head }).docsOnly,
      true,
      'safe-to-safe rename must use fast lane',
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
    rmSync(path.join(root, 'docs', 'audits', 'evidence.md'));
    const head = commitAll(root, 'safe deletion');
    equal(
      classifyCiScope({ repoRoot: root, eventName: 'push', baseSha: base, headSha: head }).docsOnly,
      true,
      'safe deletion must use fast lane',
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
    git(root, ['update-index', '--add', '--cacheinfo', `120000,${blob},docs/audits/link.md`]);
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
