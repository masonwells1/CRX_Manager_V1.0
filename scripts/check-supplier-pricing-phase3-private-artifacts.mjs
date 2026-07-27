#!/usr/bin/env node
/**
 * Fail closed when a private Phase 3C packet is Git-visible now or anywhere in
 * the commit range about to be pushed. Diagnostics deliberately contain paths
 * and categories only: never a blob, row, Product identifier, or source text.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { APPROVED_SERIALIZED_FORMATS, OWNER_DECISION_HEADERS, PRIVATE_ARTIFACT_BASENAMES, REPO_ROOT } from './supplier-pricing-phase3-private-artifacts.mjs';

const MAX_STRUCTURAL_SCAN_BYTES = 8 * 1024 * 1024;
const WORKTREE_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_JSON_NODES = 1_000_000;
const PRIVATE_ARTIFACT_BASENAMES_LOWER = new Set([...PRIVATE_ARTIFACT_BASENAMES].map(name => name.toLowerCase()));
const JSON_FORMATS = new Set(APPROVED_SERIALIZED_FORMATS);
const ZERO_SHA = '0000000000000000000000000000000000000000';
const SNAPSHOT_ROOT_KEYS = ['products', 'snapshot_sha256', 'expected_old_phase3_defaults', 'migration_high_water'];
const MANIFEST_ROOT_KEYS = ['rows', 'manifest_sha256', 'generated_from_snapshot_sha256', 'summary', 'approval_state'];
const PRODUCT_ROW_KEYS = ['id', 'sku', 'product_name', 'pricing_version', 'updated_at'];
const MANIFEST_ROW_KEYS = ['product_id', 'current_product', 'proposed_phase3', 'field_decisions', 'row_sha256'];
const STRUCTURAL_KEY_GROUPS = [SNAPSHOT_ROOT_KEYS, MANIFEST_ROOT_KEYS, PRODUCT_ROW_KEYS, MANIFEST_ROW_KEYS];
const STREAM_TAIL_CHARS = Math.max(4096, OWNER_DECISION_HEADERS.join(',').length * 4);

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
function normalizeCsvHeaderCell(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).replaceAll('""', '"') : trimmed;
}
function privateJsonNodeReason(value) {
  const pending = [value];
  const seen = new WeakSet();
  let visited = 0;
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    if (visited > MAX_JSON_NODES) return 'private artifact JSON exceeds bounded structural node limit';
    if (!Array.isArray(node)) {
      if (JSON_FORMATS.has(node.format)) return 'approved private JSON format structure';
      const keys = new Set(Object.keys(node));
      if (STRUCTURAL_KEY_GROUPS.some(group => group.every(key => keys.has(key)))) return 'private snapshot or manifest key structure';
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return null;
}
function normalizedText(bytes) { return (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).toString('utf8').replace(/^\uFEFF/, ''); }
function decodeJsonUnicodeEscapes(text) { return text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16))); }
function escapedRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function hasQuotedProperty(text, key) {
  return new RegExp(`"${escapedRegex(key)}"\\s*:`).test(text);
}
function textualJsonStructureReason(text) {
  const comparable = decodeJsonUnicodeEscapes(text);
  for (const format of JSON_FORMATS) {
    const formatPattern = new RegExp(`"format"\\s*:\\s*"${escapedRegex(format)}(?:"|(?=\\s*[,}\\]]|$))`);
    if (formatPattern.test(comparable)) return 'private JSON format marker in malformed candidate';
  }
  if (STRUCTURAL_KEY_GROUPS.some(group => group.every(key => hasQuotedProperty(comparable, key)))) {
    return 'private snapshot or manifest key structure';
  }
  return null;
}
function isOwnerDecisionHeaderLine(line) {
  const normalized = line.replace(/^\uFEFF/, '').trim();
  if (!normalized) return false;
  const cells = normalized.split(',').map(normalizeCsvHeaderCell);
  return cells.length === OWNER_DECISION_HEADERS.length && cells.every((cell, index) => cell === OWNER_DECISION_HEADERS[index]);
}
function ownerDecisionHeaderReason(text) {
  return text.split(/\r?\n/).some(isOwnerDecisionHeaderLine) ? 'owner decision sheet CSV header structure' : null;
}
/** Detect packet structure, not canonical whitespace or a filename. */
export function structuralPrivateArtifactReason(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length > MAX_STRUCTURAL_SCAN_BYTES) return 'private artifact candidate exceeds bounded structural scan limit';
  // A UTF-8 BOM is an encoding marker, not packet content. Treat it exactly
  // like leading whitespace for both JSON and owner-sheet structure checks.
  const text = normalizedText(buffer);
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const parsedReason = privateJsonNodeReason(parsed);
      if (parsedReason) return parsedReason;
    } catch (_error) { /* position-independent structural checks below fail closed */ }
  }
  return textualJsonStructureReason(text) ?? ownerDecisionHeaderReason(text);
}
function sameFileIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameWorktreeStatIdentity(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink
    && left.mode === right.mode;
}
function canonicalWorktreeCandidate(root, repoPath, cache = null) {
  const requestedRoot = path.resolve(root);
  let canonicalRoot = cache?.roots.get(requestedRoot);
  if (!canonicalRoot) {
    canonicalRoot = realpathSync(requestedRoot);
    cache?.roots.set(requestedRoot, canonicalRoot);
  }
  if (canonicalRoot !== requestedRoot) throw new Error('private Phase 3C worktree root must be canonical');
  const file = path.resolve(canonicalRoot, repoPath);
  if (!file.startsWith(`${canonicalRoot}${path.sep}`)) return null;
  const parent = path.dirname(file);
  const parentEntry = lstatSync(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) throw new Error('private Phase 3C worktree candidate parent is a symlink, junction, or escapes the repository');
  const cachedParent = cache?.parents.get(parent);
  let canonicalParent;
  if (cachedParent && sameFileIdentity(cachedParent, parentEntry)) canonicalParent = parent;
  else {
    canonicalParent = realpathSync(parent);
    cache?.parents.set(parent, parentEntry);
  }
  if (canonicalParent !== parent || !canonicalParent.startsWith(canonicalRoot)) throw new Error('private Phase 3C worktree candidate parent is a symlink, junction, or escapes the repository');
  return { file, canonicalRoot };
}
export function readWorktreeCandidate(root, repoPath, { beforeRead, afterRead, maxBytes = MAX_STRUCTURAL_SCAN_BYTES + 1, cache = null } = {}) {
  const candidate = canonicalWorktreeCandidate(root, repoPath, cache);
  if (candidate === null) return null;
  const { file } = candidate;
  const entry = lstatSync(file);
  if (!entry.isFile()) return null;
  if (entry.isSymbolicLink()) throw new Error('private Phase 3C worktree candidate is a symlink or junction');
  const followed = statSync(file);
  if (!followed.isFile() || !sameWorktreeStatIdentity(entry, followed) || realpathSync(file) !== file) throw new Error('private Phase 3C worktree candidate changed during scan');
  const fd = openSync(file, 'r');
  try {
    const descriptor = fstatSync(fd);
    if (!descriptor.isFile() || !sameWorktreeStatIdentity(entry, descriptor)) throw new Error('private Phase 3C worktree candidate changed during scan');
    beforeRead?.({ file, fd });
    const beforeReadEntry = lstatSync(file); const beforeReadFollowed = statSync(file); const beforeReadDescriptor = fstatSync(fd);
    if (!beforeReadEntry.isFile() || beforeReadEntry.isSymbolicLink() || !sameWorktreeStatIdentity(entry, beforeReadEntry) || !sameWorktreeStatIdentity(entry, beforeReadFollowed) || !sameWorktreeStatIdentity(entry, beforeReadDescriptor) || canonicalWorktreeCandidate(root, repoPath, cache) === null) throw new Error('private Phase 3C worktree candidate changed during scan');
    const count = Math.min(entry.size, maxBytes);
    const buffer = Buffer.alloc(count);
    const read = readSync(fd, buffer, 0, count, 0);
    afterRead?.({ file, fd });
    const afterReadEntry = lstatSync(file); const afterReadFollowed = statSync(file); const afterReadDescriptor = fstatSync(fd);
    if (read !== count || !afterReadEntry.isFile() || afterReadEntry.isSymbolicLink() || !sameWorktreeStatIdentity(entry, afterReadEntry) || !sameWorktreeStatIdentity(entry, afterReadFollowed) || !sameWorktreeStatIdentity(entry, afterReadDescriptor) || canonicalWorktreeCandidate(root, repoPath, cache) === null) throw new Error('private Phase 3C worktree candidate changed during scan');
    const confirmation = Buffer.alloc(count);
    const confirmed = readSync(fd, confirmation, 0, count, 0);
    const finalEntry = lstatSync(file); const finalFollowed = statSync(file); const finalDescriptor = fstatSync(fd);
    if (confirmed !== count || !buffer.equals(confirmation) || !sameWorktreeStatIdentity(entry, finalEntry) || !sameWorktreeStatIdentity(entry, finalFollowed) || !sameWorktreeStatIdentity(entry, finalDescriptor) || canonicalWorktreeCandidate(root, repoPath, cache) === null) throw new Error('private Phase 3C worktree candidate changed during scan');
    return { bytes: buffer.subarray(0, read), size: entry.size, complete: read === entry.size };
  } finally { closeSync(fd); }
}
function createOwnerHeaderStreamDetector() {
  const canonicalHeader = OWNER_DECISION_HEADERS.join(',');
  let line = '';
  let discarded = false;
  let found = false;
  const finishLine = () => {
    if (!discarded && line === canonicalHeader) found = true;
    line = '';
    discarded = false;
  };
  return {
    feed(text) {
      for (const character of text) {
        if (character === '\n') { finishLine(); continue; }
        // Header names contain no whitespace or quote characters. Compacting
        // only those legal CSV wrappers keeps arbitrary padding bounded while
        // retaining every meaningful byte in the exact ordered comparison.
        if (character === ' ' || character === '\t' || character === '\r' || character === '\uFEFF' || character === '"') continue;
        if (line.length < canonicalHeader.length) line += character;
        else discarded = true;
      }
    },
    finish() { finishLine(); return found; },
  };
}
function createStructuralStreamScanner() {
  let tail = '';
  let formatPropertySignal = false;
  const formatValueSignals = new Set();
  const propertySignals = new Set();
  const ownerHeader = createOwnerHeaderStreamDetector();
  return {
    feed(text) {
      ownerHeader.feed(text);
      const window = tail + text;
      const comparable = decodeJsonUnicodeEscapes(window);
      if (hasQuotedProperty(comparable, 'format')) formatPropertySignal = true;
      for (const format of JSON_FORMATS) {
        const valuePattern = new RegExp(`"${escapedRegex(format)}(?:"|(?=\\s*[,}\\]]|$))`);
        if (valuePattern.test(comparable)) formatValueSignals.add(format);
      }
      for (const key of STRUCTURAL_KEY_GROUPS.flat()) {
        if (hasQuotedProperty(comparable, key)) propertySignals.add(key);
      }
      tail = window.slice(-STREAM_TAIL_CHARS);
    },
    finish() {
      const ownerSignal = ownerHeader.finish();
      const structuralSignal = STRUCTURAL_KEY_GROUPS.some(group => group.every(key => propertySignals.has(key)));
      return (formatPropertySignal && formatValueSignals.size > 0) || structuralSignal || ownerSignal;
    },
  };
}
function assertStableWorktreeCandidate(root, repoPath, file, baseline, fd, cache = null) {
  const entry = lstatSync(file);
  const followed = statSync(file);
  const descriptor = fstatSync(fd);
  if (!entry.isFile() || entry.isSymbolicLink()
    || !followed.isFile() || !descriptor.isFile()
    || !sameWorktreeStatIdentity(baseline, entry)
    || !sameWorktreeStatIdentity(baseline, followed)
    || !sameWorktreeStatIdentity(baseline, descriptor)
    || realpathSync(file) !== file
    || canonicalWorktreeCandidate(root, repoPath, cache) === null) {
    throw new Error('private Phase 3C worktree candidate changed during scan');
  }
}
function scanWorktreeCandidate(root, repoPath, { afterFirstPass, cache = null } = {}) {
  const candidate = canonicalWorktreeCandidate(root, repoPath, cache);
  if (candidate === null) return null;
  const { file } = candidate;
  const entry = lstatSync(file); const followed = statSync(file);
  if (!entry.isFile()) return null;
  if (entry.isSymbolicLink() || !sameWorktreeStatIdentity(entry, followed) || realpathSync(file) !== file) throw new Error('private Phase 3C worktree candidate changed during scan');
  const fd = openSync(file, 'r');
  try {
    assertStableWorktreeCandidate(root, repoPath, file, entry, fd, cache);
    const scanOnce = ({ capture }) => {
      const chunk = Buffer.alloc(WORKTREE_SCAN_CHUNK_BYTES);
      const digest = createHash('sha256');
      const scanner = createStructuralStreamScanner();
      const decoder = new StringDecoder('utf8');
      const captured = capture ? [] : null;
      let offset = 0;
      while (offset < entry.size) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, entry.size - offset), offset);
        if (read <= 0) throw new Error('private Phase 3C worktree candidate changed during scan');
        const bytes = chunk.subarray(0, read);
        digest.update(bytes);
        scanner.feed(decoder.write(bytes));
        if (captured) captured.push(Buffer.from(bytes));
        offset += read;
      }
      scanner.feed(decoder.end());
      return {
        bytes: captured ? Buffer.concat(captured, entry.size) : null,
        digest: digest.digest('hex'),
        signal: scanner.finish(),
      };
    };
    const first = scanOnce({ capture: entry.size <= MAX_STRUCTURAL_SCAN_BYTES });
    afterFirstPass?.({ file, fd });
    assertStableWorktreeCandidate(root, repoPath, file, entry, fd, cache);
    const second = scanOnce({ capture: false });
    assertStableWorktreeCandidate(root, repoPath, file, entry, fd, cache);
    if (first.digest !== second.digest || first.signal !== second.signal) throw new Error('private Phase 3C worktree candidate changed during scan');
    const reason = first.bytes === null
      ? (first.signal ? 'private artifact worktree candidate exceeds bounded structural scan limit' : null)
      : structuralPrivateArtifactReason(first.bytes);
    return { reason, size: entry.size };
  } finally { closeSync(fd); }
}
export function ignoredLargeCandidateHasPrivateSignal(root, repoPath, _prefix, { afterFirstPass } = {}) {
  return Boolean(scanWorktreeCandidate(root, repoPath, { afterFirstPass })?.reason);
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
function currentIndexCandidateViolations(root, execute) {
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
function stagedIndexContentViolations(root, execute) {
  const violations = [];
  for (const repoPath of gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=AMR'], root, execute)) {
    if (gitBlobSize(`:${repoPath}`, root, execute) > MAX_STRUCTURAL_SCAN_BYTES) {
      violations.push({ repoPath, reason: 'private artifact staged blob exceeds bounded structural scan limit' });
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
  const ignored = new Set(gitPaths(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], root, execute));
  const violations = [];
  const candidates = new Map();
  for (const repoPath of modified) candidates.set(repoPath, 'modified');
  for (const repoPath of untracked) candidates.set(repoPath, 'untracked');
  for (const repoPath of ignored) if (!candidates.has(repoPath)) candidates.set(repoPath, 'ignored');
  const started = performance.now();
  const cache = { roots: new Map(), parents: new Map() };
  for (const [repoPath, source] of candidates) {
    const result = scanWorktreeCandidate(root, repoPath, { cache });
    if (result?.reason) violations.push({ repoPath, reason: result.reason });
    else if (result && result.size > MAX_STRUCTURAL_SCAN_BYTES && source !== 'ignored') {
      violations.push({ repoPath, reason: 'private artifact worktree candidate exceeds bounded structural scan limit' });
    }
  }
  return { violations, candidateCount: candidates.size, ignoredCount: ignored.size, durationMs: Math.round(performance.now() - started) };
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
  const ignoredVisible = gitPaths(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], root, execute);
  const visible = new Set([
    ...gitPaths(['ls-files', '-z'], root, execute),
    ...gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], root, execute),
    ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, execute),
    ...ignoredVisible,
  ]);
  const rangeCommits = ranges.flatMap(range => commitsForRange(range, root, execute));
  const checkedCommits = [...new Set([...commits.map(commit => assertCommitSha(commit, 'history')), ...rangeCommits])];
  const worktree = worktreeContentViolations(root, execute);
  const violations = [
    ...findForbiddenPrivateArtifactPaths([...visible]),
    ...currentIndexCandidateViolations(root, execute),
    ...stagedIndexContentViolations(root, execute),
    ...worktree.violations,
    ...historyViolations(checkedCommits, root, execute),
  ];
  if (violations.length) {
    const summary = [...new Map(violations.map(item => [`${item.repoPath}\0${item.reason}`, item])).values()];
    throw new Error(`private Phase 3C artifact containment failure: ${summary.map(item => `${item.repoPath} (${item.reason})`).join(', ')}`);
  }
  return { checked_path_count: visible.size, checked_commit_count: checkedCommits.length, checked_ignored_count: worktree.ignoredCount, worktree_scan_duration_ms: worktree.durationMs };
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
