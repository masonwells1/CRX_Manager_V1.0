#!/usr/bin/env node
/**
 * Fail closed when a private Phase 3C packet is Git-visible now or anywhere in
 * the commit range about to be pushed. Diagnostics deliberately contain paths
 * and categories only: never a blob, row, Product identifier, or source text.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVED_SERIALIZED_FORMATS, OWNER_DECISION_HEADERS, PRIVATE_ARTIFACT_BASENAMES, REPO_ROOT } from './supplier-pricing-phase3-private-artifacts.mjs';

const MAX_STRUCTURAL_SCAN_BYTES = 8 * 1024 * 1024;
const PRIVATE_ARTIFACT_BASENAMES_LOWER = new Set([...PRIVATE_ARTIFACT_BASENAMES].map(name => name.toLowerCase()));
const IGNORED_PRIVATE_ARTIFACT_PATHSPECS = [
  ...[...PRIVATE_ARTIFACT_BASENAMES].map(name => `:(icase,glob)**/${name}`),
  ':(icase,glob)**/private-artifacts/**',
];
const JSON_FORMATS = new Set(APPROVED_SERIALIZED_FORMATS);
const CONTENT_NEEDLES = [...JSON_FORMATS, '"format"', 'product_id'];
const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * Husky and Git can export GIT_DIR/GIT_INDEX_FILE/etc. Those variables would
 * silently redirect a checker asked to inspect an isolated root (or a Git
 * fixture) back to the hook's repository. The caller's cwd/root is the sole
 * authority for containment, so every Git subprocess starts hermetically.
 */
export function hermeticGitEnvironment(environment = process.env) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) if (key.toUpperCase().startsWith('GIT_')) delete clean[key];
  return clean;
}
function gitOutput(args, root = REPO_ROOT, execute = execFileSync, { encoding = 'utf8', input, maxBuffer } = {}) {
  return execute('git', args, { cwd: root, encoding, input, maxBuffer, env: hermeticGitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
}
function gitPaths(args, root = REPO_ROOT, execute = execFileSync) {
  return String(gitOutput(args, root, execute)).split('\0').filter(Boolean);
}
function gitPathsAllowNoMatch(args, root = REPO_ROOT, execute = execFileSync) {
  try { return gitPaths(args, root, execute); }
  catch (error) { if (error?.status === 1) return []; throw error; }
}
function gitLines(args, root = REPO_ROOT, execute = execFileSync) {
  return String(gitOutput(args, root, execute)).trim().split(/\r?\n/).filter(Boolean);
}
function gitBuffer(args, root = REPO_ROOT, execute = execFileSync) {
  const output = gitOutput(args, root, execute, { encoding: 'buffer', maxBuffer: MAX_STRUCTURAL_SCAN_BYTES + 1 });
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}
function gitBlobSize(spec, root = REPO_ROOT, execute = execFileSync) {
  const size = Number(String(gitOutput(['cat-file', '-s', spec], root, execute)).trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('private Phase 3C containment could not determine Git blob size');
  return size;
}
function assertCommitSha(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`private Phase 3C history containment requires a valid ${label} commit SHA`);
  return value.toLowerCase();
}

export function forbiddenArtifactReason(repoPath) {
  const segments = repoPath.split(/[\\/]/).filter(Boolean);
  if (segments.some(segment => segment.toLowerCase() === 'private-artifacts')) return 'private-artifacts directory';
  if (segments.some(segment => PRIVATE_ARTIFACT_BASENAMES_LOWER.has(segment.toLowerCase()))) return 'private artifact basename';
  return null;
}
export function findForbiddenPrivateArtifactPaths(paths) {
  return paths.map(repoPath => ({ repoPath, reason: forbiddenArtifactReason(repoPath) })).filter(item => item.reason);
}
function isNodeModulesPath(repoPath) { return repoPath.split(/[\\/]/).includes('node_modules'); }
function normalizeCsvHeaderCell(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).replaceAll('""', '"') : trimmed;
}
/** Detect packet structure, not canonical whitespace or a filename. */
export function structuralPrivateArtifactReason(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const prefix = buffer.subarray(0, Math.min(buffer.length, 64 * 1024)).toString('utf8');
  const looksRelevant = CONTENT_NEEDLES.some(needle => prefix.includes(needle));
  if (buffer.length > MAX_STRUCTURAL_SCAN_BYTES) return looksRelevant ? 'private artifact candidate exceeds bounded structural scan limit' : null;
  // A UTF-8 BOM is an encoding marker, not packet content. Treat it exactly
  // like leading whitespace for both JSON and owner-sheet structure checks.
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && JSON_FORMATS.has(parsed.format)) return 'approved private JSON format structure';
    } catch (_error) { /* A malformed public file is not a packet structure. */ }
  }
  const header = text.split(/\r?\n/, 1)[0];
  if (header) {
    const cells = header.split(',').map(normalizeCsvHeaderCell);
    if (cells.length === OWNER_DECISION_HEADERS.length && cells.every((cell, index) => cell === OWNER_DECISION_HEADERS[index])) return 'owner decision sheet CSV header structure';
  }
  return null;
}
function sameFileIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
export function readWorktreeCandidate(root, repoPath, { beforeRead, afterRead } = {}) {
  const file = path.resolve(root, repoPath);
  const canonicalRoot = path.resolve(root);
  if (!file.startsWith(`${canonicalRoot}${path.sep}`)) return null;
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink()) return null;
  const followed = statSync(file);
  if (!followed.isFile() || !sameFileIdentity(entry, followed) || followed.size !== entry.size) throw new Error('private Phase 3C worktree candidate changed during scan');
  const fd = openSync(file, 'r');
  try {
    const descriptor = fstatSync(fd);
    if (!descriptor.isFile() || !sameFileIdentity(entry, descriptor) || descriptor.size !== entry.size) throw new Error('private Phase 3C worktree candidate changed during scan');
    beforeRead?.({ file, fd });
    const beforeReadEntry = lstatSync(file); const beforeReadFollowed = statSync(file); const beforeReadDescriptor = fstatSync(fd);
    if (!beforeReadEntry.isFile() || beforeReadEntry.isSymbolicLink() || !sameFileIdentity(entry, beforeReadEntry) || !sameFileIdentity(entry, beforeReadFollowed) || !sameFileIdentity(entry, beforeReadDescriptor) || beforeReadEntry.size !== entry.size || beforeReadFollowed.size !== entry.size || beforeReadDescriptor.size !== entry.size) throw new Error('private Phase 3C worktree candidate changed during scan');
    const count = Math.min(entry.size, MAX_STRUCTURAL_SCAN_BYTES + 1);
    const buffer = Buffer.alloc(count);
    const read = readSync(fd, buffer, 0, count, 0);
    afterRead?.({ file, fd });
    const afterReadEntry = lstatSync(file); const afterReadFollowed = statSync(file); const afterReadDescriptor = fstatSync(fd);
    if (read !== count || !afterReadEntry.isFile() || afterReadEntry.isSymbolicLink() || !sameFileIdentity(entry, afterReadEntry) || !sameFileIdentity(entry, afterReadFollowed) || !sameFileIdentity(entry, afterReadDescriptor) || afterReadEntry.size !== entry.size || afterReadFollowed.size !== entry.size || afterReadDescriptor.size !== entry.size) throw new Error('private Phase 3C worktree candidate changed during scan');
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
}
function candidateIndexPaths(root, execute) {
  const candidates = new Map();
  for (const format of JSON_FORMATS) {
    for (const repoPath of gitPathsAllowNoMatch(['grep', '--cached', '-I', '-l', '-z', '-F', '-e', format], root, execute)) candidates.set(repoPath, true);
  }
  // A raw format key catches a minified packet whose format value uses JSON
  // escapes; the JSON parser below still decides whether it is a packet.
  for (const repoPath of gitPathsAllowNoMatch(['grep', '--cached', '-I', '-l', '-z', '-F', '-e', '"format"'], root, execute)) {
    if (!candidates.has(repoPath)) candidates.set(repoPath, false);
  }
  // The owner sheet has no JSON format. This bounded header prefix is enough
  // to find a renamed/minified CSV without scanning generic product-id fields.
  for (const repoPath of gitPathsAllowNoMatch(['grep', '--cached', '-I', '-l', '-z', '-E', 'product_id[[:space:]]*,[[:space:]]*sku[[:space:]]*,[[:space:]]*product_name'], root, execute)) {
    if (!candidates.has(repoPath)) candidates.set(repoPath, false);
  }
  return candidates;
}
function indexContentViolations(root, execute) {
  const violations = [];
  for (const [repoPath, hasPhase3FormatMarker] of candidateIndexPaths(root, execute)) {
    if (gitBlobSize(`:${repoPath}`, root, execute) > MAX_STRUCTURAL_SCAN_BYTES) {
      if (hasPhase3FormatMarker) violations.push({ repoPath, reason: 'private artifact candidate exceeds bounded structural scan limit' });
      continue;
    }
    const reason = structuralPrivateArtifactReason(gitBuffer(['show', `:${repoPath}`], root, execute));
    if (reason) violations.push({ repoPath, reason });
  }
  return violations;
}
function worktreeContentViolations(root, execute) {
  const modified = new Set(gitPaths(['diff', '--name-only', '-z', '--diff-filter=ACMR'], root, execute));
  const untracked = new Set(gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, execute));
  const violations = [];
  for (const repoPath of new Set([...modified, ...untracked])) {
    if (isNodeModulesPath(repoPath)) continue;
    const bytes = readWorktreeCandidate(root, repoPath);
    const reason = bytes === null ? null : structuralPrivateArtifactReason(bytes);
    if (reason) violations.push({ repoPath, reason });
  }
  return violations;
}

function commitsForRange(range, root, execute) {
  const [base, head, ...extra] = String(range).split('..');
  if (extra.length || !base || !head) throw new Error('private Phase 3C history containment requires an explicit base..head range');
  return gitLines(['rev-list', '--reverse', `${assertCommitSha(base, 'base')}..${assertCommitSha(head, 'head')}`], root, execute);
}
function changedPathsForCommit(commit, root, execute) {
  // -m compares a merge result with every parent, so a conflict-resolution
  // blob that exists only in the merge commit cannot disappear from history
  // containment. A path can appear once per parent; inspect it once at the
  // final commit tree after deduplication.
  return [...new Set(gitPaths(['diff-tree', '--root', '-m', '-r', '--no-commit-id', '--diff-filter=AMR', '--name-only', '-z', commit], root, execute))];
}
function historyViolations(commits, root, execute) {
  const violations = [];
  for (const commit of commits) {
    for (const repoPath of changedPathsForCommit(assertCommitSha(commit, 'history'), root, execute)) {
      const directReason = forbiddenArtifactReason(repoPath);
      if (directReason) violations.push({ repoPath: `${commit}:${repoPath}`, reason: directReason });
      const blobSpec = `${commit}:${repoPath}`;
      const blobSize = gitBlobSize(blobSpec, root, execute);
      const reason = blobSize > MAX_STRUCTURAL_SCAN_BYTES
        ? 'private artifact changed blob exceeds bounded structural scan limit'
        : structuralPrivateArtifactReason(gitBuffer(['show', blobSpec], root, execute));
      if (reason) violations.push({ repoPath: `${commit}:${repoPath}`, reason });
    }
  }
  return violations;
}

export function checkPrivateArtifactContainment({ root = REPO_ROOT, execute = execFileSync, ranges = [], commits = [] } = {}) {
  const visible = new Set([
    ...gitPaths(['ls-files', '-z'], root, execute),
    ...gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], root, execute),
    ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, execute),
    ...gitPaths(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...IGNORED_PRIVATE_ARTIFACT_PATHSPECS], root, execute),
  ]);
  const rangeCommits = ranges.flatMap(range => commitsForRange(range, root, execute));
  const checkedCommits = [...new Set([...commits.map(commit => assertCommitSha(commit, 'history')), ...rangeCommits])];
  const violations = [
    ...findForbiddenPrivateArtifactPaths([...visible]),
    ...indexContentViolations(root, execute),
    ...worktreeContentViolations(root, execute),
    ...historyViolations(checkedCommits, root, execute),
  ];
  if (violations.length) {
    const summary = [...new Map(violations.map(item => [`${item.repoPath}\0${item.reason}`, item])).values()];
    throw new Error(`private Phase 3C artifact containment failure: ${summary.map(item => `${item.repoPath} (${item.reason})`).join(', ')}`);
  }
  return { checked_path_count: visible.size, checked_commit_count: checkedCommits.length };
}

function outgoingCommitsForNewRemoteRef(localSha, remoteName, root, execute) {
  if (typeof remoteName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(remoteName)) throw new Error('private Phase 3C pre-push containment requires a safe remote name');
  return gitLines(['rev-list', '--reverse', assertCommitSha(localSha, 'local'), `--not`, `--remotes=${remoteName}`], root, execute);
}
export function checkPrePushPrivateArtifactContainment({ root = REPO_ROOT, execute = execFileSync, remoteName, stdin } = {}) {
  const updates = String(stdin ?? '').split(/\r?\n/).filter(Boolean);
  const ranges = [];
  const commits = [];
  for (const update of updates) {
    const fields = update.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error('private Phase 3C pre-push containment received malformed ref update');
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if (!localRef.startsWith('refs/') || !remoteRef.startsWith('refs/')) throw new Error('private Phase 3C pre-push containment received malformed ref update');
    if (localSha === ZERO_SHA) continue; // deletion exports no new blob
    assertCommitSha(localSha, 'local');
    if (remoteSha === ZERO_SHA) commits.push(...outgoingCommitsForNewRemoteRef(localSha, remoteName, root, execute));
    else ranges.push(`${assertCommitSha(remoteSha, 'remote')}..${localSha.toLowerCase()}`);
  }
  return checkPrivateArtifactContainment({ root, execute, ranges, commits });
}
export function checkGitHubEventPrivateArtifactContainment({ root = REPO_ROOT, execute = execFileSync, environment = process.env, readFile = readFileSync } = {}) {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (typeof eventPath !== 'string' || !path.isAbsolute(eventPath)) throw new Error('private Phase 3C CI containment requires GITHUB_EVENT_PATH');
  let event;
  try { event = JSON.parse(readFile(eventPath, 'utf8')); } catch (_error) { throw new Error('private Phase 3C CI containment could not parse GitHub event metadata'); }
  const name = environment.GITHUB_EVENT_NAME;
  if (name === 'pull_request') return checkPrivateArtifactContainment({ root, execute, ranges: [`${assertCommitSha(event?.pull_request?.base?.sha, 'pull-request base')}..${assertCommitSha(event?.pull_request?.head?.sha, 'pull-request head')}`] });
  if (name === 'push') return checkPrivateArtifactContainment({ root, execute, ranges: [`${assertCommitSha(event?.before, 'push base')}..${assertCommitSha(event?.after, 'push head')}`] });
  throw new Error(`private Phase 3C CI containment does not support GitHub event ${String(name)}`);
}

function parseCli(args) {
  const result = { ranges: [], prePushRemote: null, githubEvent: false };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--range') { const value = args[++index]; if (!value) throw new Error('disclosure-safe usage: --range requires base..head'); result.ranges.push(value); continue; }
    if (token === '--pre-push') { if (result.prePushRemote !== null) throw new Error('disclosure-safe usage: duplicate --pre-push'); const value = args[++index]; if (!value) throw new Error('disclosure-safe usage: --pre-push requires remote name'); result.prePushRemote = value; continue; }
    if (token === '--github-event') { if (result.githubEvent) throw new Error('disclosure-safe usage: duplicate --github-event'); result.githubEvent = true; continue; }
    throw new Error('disclosure-safe usage: unknown containment option');
  }
  if ((result.prePushRemote !== null ? 1 : 0) + Number(result.githubEvent) > 1) throw new Error('disclosure-safe usage: pre-push and GitHub-event modes are exclusive');
  return result;
}
function main() {
  const cli = parseCli(process.argv.slice(2));
  const result = cli.githubEvent
    ? checkGitHubEventPrivateArtifactContainment()
    : cli.prePushRemote !== null
      ? checkPrePushPrivateArtifactContainment({ remoteName: cli.prePushRemote, stdin: readFileSync(0, 'utf8') })
      : checkPrivateArtifactContainment({ ranges: cli.ranges });
  console.log(`PHASE3_PRIVATE_ARTIFACT_CONTAINMENT_PASS checked_paths=${result.checked_path_count} checked_commits=${result.checked_commit_count}`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main();
