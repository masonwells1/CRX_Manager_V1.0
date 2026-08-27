#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ENTRY_RE, entryContentVerdict } from '../.claude/hooks/changelog-entry-lib.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;
const SAFE_PATH_RE = /^[A-Za-z0-9._/-]+$/;
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);
const MAX_CHANGED_PATHS = 5000;
const PROTECTED_CONTROL_SEGMENTS = new Set(['.agents', '.claude', '.codex', '.github', '.husky']);
const PROTECTED_INSTRUCTION_BASENAME_RE = /^(?:(?:agents|claude)(?:\.[a-z0-9_-]+)*|gemini|skill)\.md$|^copilot-instructions\.md$/;

const FAST_DOC_EXACT = new Set([
  'README.md',
  'docs/CHANGELOG.md',
  'docs/manual/KNOWN_ISSUES.md',
]);

const FAST_DOC_PREFIXES = [
  'docs/archive/',
  'docs/audits/',
  'docs/handoffs/',
  'docs/loops/',
  'docs/plans/',
];

function fullCi(reason, changedPaths = []) {
  return {
    docsOnly: false,
    fullCi: true,
    reason,
    changedPaths,
  };
}

function decodeUtf8Exact(buffer, label) {
  const decoded = buffer.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(buffer)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  return decoded;
}

function splitNul(buffer) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    fields.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) {
    throw new Error('git output was not NUL terminated');
  }
  return fields;
}

function runGit(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const stderr = decodeUtf8Exact(result.stderr ?? Buffer.alloc(0), 'git stderr').trim();
    throw new Error(`git ${args[0]} failed (${result.status}): ${stderr}`);
  }
  return result;
}

function assertCommit(repoRoot, sha) {
  if (!SHA_RE.test(sha)) throw new Error(`invalid commit SHA: ${sha}`);
  runGit(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
}

export function parseChangedEntries(buffer) {
  const fields = splitNul(buffer);
  const entries = [];
  for (let index = 0; index < fields.length; ) {
    const status = decodeUtf8Exact(fields[index], 'git diff status');
    index += 1;
    if (!/^[ACDMRTUXB][0-9]{0,3}$/.test(status)) {
      throw new Error(`unexpected git diff status: ${status}`);
    }
    if (index >= fields.length) throw new Error(`missing path for git diff status ${status}`);
    entries.push({ status, path: decodeUtf8Exact(fields[index], 'git diff path') });
    index += 1;
    if (status.startsWith('R') || status.startsWith('C')) {
      if (index >= fields.length) throw new Error(`missing second path for git diff status ${status}`);
      entries.push({ status, path: decodeUtf8Exact(fields[index], 'git diff path') });
      index += 1;
    }
  }
  return entries;
}

export function parseChangedPaths(buffer) {
  return parseChangedEntries(buffer).map(entry => entry.path);
}

function validateRepoPath(candidate) {
  if (!candidate || !SAFE_PATH_RE.test(candidate)) return false;
  if (candidate.startsWith('/') || candidate.endsWith('/')) return false;
  if (candidate.includes('\\') || candidate.includes('//')) return false;
  const segments = candidate.split('/');
  return !segments.some(segment => segment === '' || segment === '.' || segment === '..');
}

function hasProtectedAgentControlMarker(candidate) {
  const segments = candidate.split('/');
  const basename = segments.at(-1).toLowerCase();
  if (PROTECTED_INSTRUCTION_BASENAME_RE.test(basename)) return true;
  return segments.slice(0, -1).some(segment => PROTECTED_CONTROL_SEGMENTS.has(segment.toLowerCase()));
}

export function isFastDocumentationPath(candidate) {
  if (!validateRepoPath(candidate) || !candidate.endsWith('.md')) return false;
  if (hasProtectedAgentControlMarker(candidate)) return false;
  if (FAST_DOC_EXACT.has(candidate)) return true;
  if (ENTRY_RE.test(candidate)) return true;
  return FAST_DOC_PREFIXES.some(prefix => candidate.startsWith(prefix) && candidate.length > prefix.length);
}

function readBlobText(repoRoot, sha, repoPath) {
  const result = runGit(repoRoot, ['show', `${sha}:${repoPath}`]);
  return decodeUtf8Exact(result.stdout, `Git blob ${repoPath}`);
}

function readTreeEntry(repoRoot, sha, repoPath) {
  const result = runGit(repoRoot, ['ls-tree', '-z', sha, '--', repoPath]);
  if (result.stdout.length === 0) return null;
  const records = splitNul(result.stdout);
  if (records.length !== 1) throw new Error(`ambiguous tree entry for ${repoPath}`);
  const record = decodeUtf8Exact(records[0], 'git tree entry');
  const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40})\t(.+)$/.exec(record);
  if (!match || match[4] !== repoPath) throw new Error(`malformed tree entry for ${repoPath}`);
  return { mode: match[1], type: match[2], oid: match[3] };
}

function resolveCompareStart(repoRoot, eventName, baseSha, headSha) {
  if (eventName === 'push') return baseSha;
  if (eventName !== 'pull_request') throw new Error(`unsupported event: ${eventName}`);
  const result = runGit(repoRoot, ['merge-base', '--all', baseSha, headSha]);
  const mergeBases = decodeUtf8Exact(result.stdout, 'git merge-base output')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
  if (mergeBases.length !== 1 || !SHA_RE.test(mergeBases[0])) {
    throw new Error(`expected one merge base, found ${mergeBases.length}`);
  }
  return mergeBases[0].toLowerCase();
}

export function classifyPathList(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return fullCi('no-changed-paths');
  }
  if (changedPaths.length > MAX_CHANGED_PATHS) {
    return fullCi('changed-path-limit', changedPaths);
  }
  for (const changedPath of changedPaths) {
    if (!isFastDocumentationPath(changedPath)) {
      return fullCi('non-doc-or-protected-path', changedPaths);
    }
  }
  return {
    docsOnly: true,
    fullCi: false,
    reason: 'ordinary-docs-only',
    changedPaths,
  };
}

export function classifyCiScope({ repoRoot, eventName, baseSha, headSha }) {
  try {
    const resolvedRoot = path.resolve(repoRoot);
    const normalizedBase = String(baseSha ?? '').toLowerCase();
    const normalizedHead = String(headSha ?? '').toLowerCase();
    assertCommit(resolvedRoot, normalizedBase);
    assertCommit(resolvedRoot, normalizedHead);

    const checkedOutHead = decodeUtf8Exact(
      runGit(resolvedRoot, ['rev-parse', 'HEAD']).stdout,
      'git HEAD',
    ).trim().toLowerCase();
    if (checkedOutHead !== normalizedHead) {
      throw new Error(`checked out HEAD ${checkedOutHead} does not equal event head ${normalizedHead}`);
    }

    const compareStart = resolveCompareStart(resolvedRoot, eventName, normalizedBase, normalizedHead);
    assertCommit(resolvedRoot, compareStart);
    const diff = runGit(resolvedRoot, [
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      compareStart,
      normalizedHead,
      '--',
    ]);
    const changedEntries = parseChangedEntries(diff.stdout);
    const changedPaths = changedEntries.map(entry => entry.path);
    const pathClassification = classifyPathList(changedPaths);
    if (pathClassification.fullCi) return pathClassification;

    if (changedEntries.some(entry => ENTRY_RE.test(entry.path) && entry.status !== 'A')) {
      return fullCi('non-added-changelog-entry', changedPaths);
    }

    for (const changedPath of changedPaths) {
      const before = readTreeEntry(resolvedRoot, compareStart, changedPath);
      const after = readTreeEntry(resolvedRoot, normalizedHead, changedPath);
      if (!before && !after) return fullCi('missing-tree-entry', changedPaths);
      for (const entry of [before, after]) {
        if (!entry) continue;
        if (entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) {
          return fullCi('non-regular-doc-entry', changedPaths);
        }
      }
      if (after && ENTRY_RE.test(changedPath)) {
        const verdict = entryContentVerdict(
          changedPath,
          readBlobText(resolvedRoot, normalizedHead, changedPath),
        );
        if (verdict !== true) return fullCi('invalid-changelog-entry', changedPaths);
      }
    }

    return pathClassification;
  } catch (error) {
    console.error(`CI scope classification fell back to full proof: ${error.message}`);
    return fullCi('classification-error');
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument sequence near ${flag ?? '<end>'}`);
    }
    values.set(flag.slice(2), value);
  }
  return {
    repoRoot: values.get('repo-root'),
    eventName: values.get('event-name'),
    baseSha: values.get('base'),
    headSha: values.get('head'),
    githubOutput: values.get('github-output'),
  };
}

function writeGithubOutputs(outputPath, result) {
  appendFileSync(
    outputPath,
    [
      `docs_only=${result.docsOnly}`,
      `full_ci=${result.fullCi}`,
      `reason=${result.reason}`,
      `changed_count=${result.changedPaths.length}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.repoRoot || !options.eventName || !options.baseSha || !options.headSha || !options.githubOutput) {
    throw new Error('required arguments: --repo-root --event-name --base --head --github-output');
  }
  const result = classifyCiScope(options);
  writeGithubOutputs(options.githubOutput, result);
  console.log(JSON.stringify(result));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`CI scope classifier failed closed: ${error.message}`);
    process.exitCode = 2;
  }
}
