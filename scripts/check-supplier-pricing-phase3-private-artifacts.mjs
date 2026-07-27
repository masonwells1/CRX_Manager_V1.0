#!/usr/bin/env node
/**
 * Fail closed when a private Phase 3C packet is Git-visible now or anywhere in
 * the commit range about to be pushed. Diagnostics deliberately contain paths
 * and categories only: never a blob, row, Product identifier, or source text.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { APPROVED_SERIALIZED_FORMATS, OWNER_DECISION_HEADERS, PRIVATE_ARTIFACT_BASENAMES, REPO_ROOT } from './supplier-pricing-phase3-private-artifacts.mjs';

// These are resource bounds, not format allowlists. They are deliberately
// above the 51,810-path / ~0.66 GiB Phase 3C containment baseline. A logical
// candidate is charged once even when an identity-safe worktree read confirms
// its bytes a second time.
export const MAX_STRUCTURAL_SCAN_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_STRUCTURAL_SCAN_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_STRUCTURAL_SCAN_CANDIDATES = 100_000;
// This checkout has 2,073 commits at the correction baseline. 4,096 leaves
// practical headroom without permitting a pathological number of diff-tree
// subprocesses before the history path budget can engage.
export const MAX_HISTORY_COMMITS = 4_096;
// `ls-files -z` and recursive `ls-tree -z` enumerate the full repository.
// Keep their subprocess output bounded, but well above the current baseline.
export const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
// The PR workflow behaviorally verifies this protocol from the trusted base
// checker before it hands that checker the candidate checkout. A source-text
// marker is not a protocol and is never used as one.
export const GITHUB_EVENT_HANDOFF_PROTOCOL = 'phase3c-github-event-root-v2';
export const GITHUB_EVENT_HANDOFF_FLAG = '--attest-github-handoff';
const WORKTREE_SCAN_CHUNK_BYTES = 64 * 1024;
const UTF16_REPLAY_BYTES = 4096;
const MAX_JSON_NODES = 1_000_000;
const REGULAR_GIT_MODES = new Set(['100644', '100755']);
const PRIVATE_ARTIFACT_BASENAMES_LOWER = new Set([...PRIVATE_ARTIFACT_BASENAMES].map(name => name.toLowerCase()));
const JSON_FORMATS = new Set(APPROVED_SERIALIZED_FORMATS);
const ZERO_SHA = '0000000000000000000000000000000000000000';
const SNAPSHOT_ROOT_KEYS = ['products', 'snapshot_sha256', 'expected_old_phase3_defaults', 'migration_high_water'];
const MANIFEST_ROOT_KEYS = ['rows', 'manifest_sha256', 'generated_from_snapshot_sha256', 'summary', 'approval_state'];
const PRODUCT_ROW_KEYS = ['id', 'sku', 'product_name', 'pricing_version', 'updated_at'];
const MANIFEST_ROW_KEYS = ['product_id', 'current_product', 'proposed_phase3', 'field_decisions', 'row_sha256'];
const STRUCTURAL_KEY_GROUPS = [SNAPSHOT_ROOT_KEYS, MANIFEST_ROOT_KEYS, PRODUCT_ROW_KEYS, MANIFEST_ROW_KEYS];
const STREAM_TAIL_CHARS = Math.max(4096, OWNER_DECISION_HEADERS.join(',').length * 4);
const OWNER_HEADER_RECORD_DELIMITER_RE = /[\r\n\v\f\u0085\u2028\u2029\u001c-\u001f]/u;

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
export function gitOutput(args, root = REPO_ROOT, execute = execFileSync, { encoding = 'utf8', input, maxBuffer = GIT_OUTPUT_MAX_BUFFER } = {}) {
  return execute('git', args, { cwd: root, encoding, input, maxBuffer, env: hermeticGitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
}
function gitPaths(args, root = REPO_ROOT, execute = execFileSync) {
  return String(gitOutput(args, root, execute)).split('\0').filter(Boolean);
}
function gitLines(args, root = REPO_ROOT, execute = execFileSync) {
  return String(gitOutput(args, root, execute)).trim().split(/\r?\n/).filter(Boolean);
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
function bareRepositoryObjectRoot(repoPath) {
  const normalized = repoPath.replaceAll('\\', '/');
  const match = /^(.*)\/objects\/(?:[0-9a-f]{2}\/[0-9a-f]{38,62}|pack\/pack-[0-9a-f]{40,64}\.(?:pack|idx))$/iu.exec(normalized);
  return match?.[1] || null;
}
function bareRepositoryRoots(paths) {
  const pathSet = new Set(paths.map(repoPath => repoPath.replaceAll('\\', '/')));
  const roots = new Set();
  for (const repoPath of pathSet) {
    const root = bareRepositoryObjectRoot(repoPath);
    if (root && pathSet.has(`${root}/HEAD`) && pathSet.has(`${root}/config`)) roots.add(root);
  }
  return roots;
}
function commitContainsBareRepository(commit, repoPath, root, execute) {
  const bareRoot = bareRepositoryObjectRoot(repoPath);
  if (!bareRoot) return null;
  try {
    gitOutput(['cat-file', '-e', `${commit}:${bareRoot}/HEAD`], root, execute);
    gitOutput(['cat-file', '-e', `${commit}:${bareRoot}/config`], root, execute);
    return bareRoot;
  } catch {
    return null;
  }
}
function normalizeCsvHeaderCell(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).replaceAll('""', '"') : trimmed;
}

export class ScanBudget {
  constructor() { this.candidates = 0; this.logicalBytes = 0; }
  admit(size) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('private Phase 3C containment could not determine candidate size');
    if (this.candidates >= MAX_STRUCTURAL_SCAN_CANDIDATES) throw new Error('private Phase 3C containment candidate-count cap exceeded');
    if (size > MAX_STRUCTURAL_SCAN_BYTES) throw new Error('private Phase 3C containment per-file scan cap exceeded');
    if (this.logicalBytes > MAX_TOTAL_STRUCTURAL_SCAN_BYTES - size) throw new Error('private Phase 3C containment total-byte scan cap exceeded');
    this.candidates += 1;
    this.logicalBytes += size;
  }
}
export class HistoryTraversalBudget {
  constructor(maxPaths) {
    if (!Number.isSafeInteger(maxPaths) || maxPaths < 0) throw new Error('private Phase 3C containment could not determine history traversal bound');
    this.maxPaths = maxPaths;
    this.paths = 0;
  }
  admit(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('private Phase 3C containment could not determine changed history path count');
    if (count > this.maxPaths - this.paths) throw new Error('private Phase 3C containment history-path cap exceeded');
    this.paths += count;
  }
}
function reducedContainmentLimit(value, hardLimit) {
  if (value === undefined) return hardLimit;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('private Phase 3C containment could not determine test traversal bound');
  return Math.min(value, hardLimit);
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
function normalizeText(text) { return text.replace(/^\uFEFF/, ''); }
function decodeUtf16Be(bytes, offset = 0) {
  const source = (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).subarray(offset);
  const evenLength = source.length - (source.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let index = 0; index < evenLength; index += 2) { swapped[index] = source[index + 1]; swapped[index + 1] = source[index]; }
  return swapped.toString('utf16le');
}
/**
 * Packet signatures are deliberately checked in all supported text encodings.
 * This makes no-BOM UTF-16 deterministic without trusting a heuristic, while
 * the exact structural signatures prevent ordinary public prose from matching.
 */
function decodedTextCandidates(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return [
    normalizeText(source.toString('utf8')),
    normalizeText(source.toString('utf16le')),
    normalizeText(source.subarray(1).toString('utf16le')),
    normalizeText(decodeUtf16Be(source)),
    normalizeText(decodeUtf16Be(source, 1)),
  ];
}
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
  const normalized = normalizeText(line).trim();
  if (!normalized) return false;
  const cells = normalized.split(',').map(normalizeCsvHeaderCell);
  return cells.length === OWNER_DECISION_HEADERS.length && cells.every((cell, index) => cell === OWNER_DECISION_HEADERS[index]);
}
function ownerDecisionHeaderReason(text) {
  return text.split(OWNER_HEADER_RECORD_DELIMITER_RE).some(isOwnerDecisionHeaderLine) ? 'owner decision sheet CSV header structure' : null;
}
function compressedArchiveReason(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  // Keep signatures numeric so this checker does not contain a raw archive
  // header and reject its own source while scanning the introducing PR.
  const signatures = [
    [0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08],
    [0x1f, 0x8b, 0x08], [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
  ].map(signature => Buffer.from(signature));
  const bzipPrefix = Buffer.from([0x42, 0x5a, 0x68]);
  const bzipBlockMagic = Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59]);
  let hasBzipHeader = false;
  for (let index = source.indexOf(bzipPrefix); index !== -1; index = source.indexOf(bzipPrefix, index + 1)) {
    const blockSize = source[index + 3];
    if (blockSize >= 0x31 && blockSize <= 0x39 && source.subarray(index + 4, index + 10).equals(bzipBlockMagic)) {
      hasBzipHeader = true;
      break;
    }
  }
  return hasBzipHeader || signatures.some(signature => source.indexOf(signature) !== -1)
    ? 'compressed archive container cannot be inspected'
    : null;
}
/** Detect packet structure, not canonical whitespace or a filename. */
export function structuralPrivateArtifactReason(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length > MAX_STRUCTURAL_SCAN_BYTES) return 'private artifact candidate exceeds bounded structural scan limit';
  const archiveReason = compressedArchiveReason(buffer);
  if (archiveReason) return archiveReason;
  const candidates = decodedTextCandidates(buffer);
  for (const text of candidates) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        const parsedReason = privateJsonNodeReason(parsed);
        if (parsedReason) return parsedReason;
      } catch (_error) { /* position-independent structural checks below fail closed */ }
    }
  }
  for (const text of candidates) {
    const textualReason = textualJsonStructureReason(text) ?? ownerDecisionHeaderReason(text);
    if (textualReason) return textualReason;
  }
  return null;
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
  if (entry.isSymbolicLink()) throw new Error('private Phase 3C worktree candidate is a symlink or junction');
  if (!entry.isFile()) return null;
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
  const isPaddingWhitespace = character => {
    const code = character.codePointAt(0);
    if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
    return code === 0x00a0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
      || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
  };
  const finishLine = () => {
    if (!discarded && line === canonicalHeader) found = true;
    line = '';
    discarded = false;
  };
  return {
    feed(text) {
      for (const character of text) {
        if (OWNER_HEADER_RECORD_DELIMITER_RE.test(character)) { finishLine(); continue; }
        // Header names contain no whitespace or quote characters. Compacting
        // only those legal CSV wrappers keeps arbitrary padding bounded while
        // retaining every meaningful byte in the exact ordered comparison.
        if (character === '"' || isPaddingWhitespace(character)) continue;
        if (line.length < canonicalHeader.length) line += character;
        else discarded = true;
      }
    },
    finish() { finishLine(); return found; },
  };
}
function createStructuralTextStreamScanner() {
  let tail = '';
  let incompleteUnicodeEscape = '';
  let formatPropertySignal = false;
  const formatValueSignals = new Set();
  const propertySignals = new Set();
  const ownerHeader = createOwnerHeaderStreamDetector();
  const deferredPropertyPattern = new RegExp(`"(${['format', ...new Set(STRUCTURAL_KEY_GROUPS.flat())].map(escapedRegex).join('|')})"\\s*$`);
  let pendingProperty = null;
  const signalProperty = key => {
    if (key === 'format') formatPropertySignal = true;
    else propertySignals.add(key);
  };
  const decodeChunk = text => {
    const raw = incompleteUnicodeEscape + text;
    const incomplete = raw.match(/\\(?:u[0-9a-fA-F]{0,3})?$/)?.[0] ?? '';
    incompleteUnicodeEscape = incomplete;
    return decodeJsonUnicodeEscapes(incomplete ? raw.slice(0, -incomplete.length) : raw);
  };
  return {
    feed(text) {
      ownerHeader.feed(text);
      const decoded = decodeChunk(text);
      const window = tail + decoded;
      const comparable = window;
      if (pendingProperty) {
        const next = decoded.match(/\S/u)?.[0];
        if (next) {
          if (next === ':') signalProperty(pendingProperty);
          pendingProperty = null;
        }
      }
      if (hasQuotedProperty(comparable, 'format')) formatPropertySignal = true;
      for (const format of JSON_FORMATS) {
        const valuePattern = new RegExp(`"${escapedRegex(format)}(?:"|(?=\\s*[,}\\]]|$))`);
        if (valuePattern.test(comparable)) formatValueSignals.add(format);
      }
      for (const key of STRUCTURAL_KEY_GROUPS.flat()) {
        if (hasQuotedProperty(comparable, key)) propertySignals.add(key);
      }
      const deferred = deferredPropertyPattern.exec(comparable)?.[1];
      if (deferred) pendingProperty = deferred;
      tail = window.slice(-STREAM_TAIL_CHARS);
    },
    finish() {
      const ownerSignal = ownerHeader.finish();
      const structuralSignal = STRUCTURAL_KEY_GROUPS.some(group => group.every(key => propertySignals.has(key)));
      if (formatPropertySignal && formatValueSignals.size > 0) return 'private JSON format marker in malformed candidate';
      if (structuralSignal) return 'private snapshot or manifest key structure';
      if (ownerSignal) return 'owner decision sheet CSV header structure';
      return null;
    },
  };
}

function createUtf16BeStreamDecoder() {
  const decoder = new StringDecoder('utf16le');
  let dangling = null;
  return {
    write(bytes) {
      const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const joined = dangling === null ? source : Buffer.concat([Buffer.from([dangling]), source]);
      const evenLength = joined.length - (joined.length % 2);
      dangling = evenLength === joined.length ? null : joined[evenLength];
      if (evenLength === 0) return '';
      const swapped = Buffer.allocUnsafe(evenLength);
      for (let index = 0; index < evenLength; index += 2) { swapped[index] = joined[index + 1]; swapped[index + 1] = joined[index]; }
      return decoder.write(swapped);
    },
    end() {
      // An odd trailing byte cannot form a supported UTF-16 character. It is
      // retained as malformed input rather than dropped into a false match.
      dangling = null;
      return decoder.end();
    },
  };
}

function createOffsetStreamDecoder(decoder, initialSkip) {
  let skip = initialSkip;
  return {
    write(bytes) {
      const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (skip === 0) return decoder.write(source);
      if (source.length <= skip) { skip -= source.length; return ''; }
      const result = decoder.write(source.subarray(skip));
      skip = 0;
      return result;
    },
    end() { return decoder.end(); },
  };
}

function createStructuralByteStreamScanner({ checkArchives = true } = {}) {
  const utf8Decoder = new StringDecoder('utf8');
  const utf8Scanner = createStructuralTextStreamScanner();
  let utf16Decoders = null;
  let utf16Scanners = null;
  let rawTail = Buffer.alloc(0);
  let archiveTail = Buffer.alloc(0);
  let archiveReason = null;
  const shouldActivateUtf16 = bytes => {
    for (let index = 0; index + 1 < bytes.length; index += 1) {
      if ((bytes[index] === 0xff && bytes[index + 1] === 0xfe) || (bytes[index] === 0xfe && bytes[index + 1] === 0xff)) return true;
    }
    // UTF-16 private structures contain ASCII property/header text. Detect a
    // short local alternating-NUL run anywhere, not only at byte zero, so a
    // large arbitrary prefix cannot suppress the alternate decoders.
    let evenZeros = 0; let oddZeros = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0) { if (index % 2 === 0) evenZeros += 1; else oddZeros += 1; }
      if (index >= 16 && bytes[index - 16] === 0) { if ((index - 16) % 2 === 0) evenZeros -= 1; else oddZeros -= 1; }
      if (index >= 15 && ((evenZeros >= 6 && oddZeros <= 1) || (oddZeros >= 6 && evenZeros <= 1))) return true;
    }
    return false;
  };
  const activateUtf16 = () => {
    utf16Decoders = [
      createOffsetStreamDecoder(new StringDecoder('utf16le'), 0),
      createOffsetStreamDecoder(new StringDecoder('utf16le'), 1),
      createOffsetStreamDecoder(createUtf16BeStreamDecoder(), 0),
      createOffsetStreamDecoder(createUtf16BeStreamDecoder(), 1),
    ];
    utf16Scanners = utf16Decoders.map(() => createStructuralTextStreamScanner());
    for (let index = 0; index < utf16Decoders.length; index += 1) utf16Scanners[index].feed(utf16Decoders[index].write(rawTail));
    rawTail = Buffer.alloc(0);
  };
  return {
    feed(bytes) {
      if (checkArchives) {
        const archiveProbe = archiveTail.length === 0 ? bytes : Buffer.concat([archiveTail, bytes]);
        archiveReason ??= compressedArchiveReason(archiveProbe);
        archiveTail = Buffer.from(archiveProbe.subarray(-9));
      }
      utf8Scanner.feed(utf8Decoder.write(bytes));
      if (utf16Decoders) { for (let index = 0; index < utf16Decoders.length; index += 1) utf16Scanners[index].feed(utf16Decoders[index].write(bytes)); return; }
      const replay = rawTail.length === 0 ? bytes : Buffer.concat([rawTail, bytes]);
      if (shouldActivateUtf16(replay)) { rawTail = replay; activateUtf16(); return; }
      rawTail = replay.length <= UTF16_REPLAY_BYTES ? replay : Buffer.from(replay.subarray(-UTF16_REPLAY_BYTES));
    },
    finish() {
      utf8Scanner.feed(utf8Decoder.end());
      let reason = utf8Scanner.finish();
      if (!utf16Decoders && shouldActivateUtf16(rawTail)) activateUtf16();
      if (utf16Decoders) {
        for (let index = 0; index < utf16Decoders.length; index += 1) {
          utf16Scanners[index].feed(utf16Decoders[index].end());
          reason ??= utf16Scanners[index].finish();
        }
      }
      return archiveReason ?? reason;
    },
  };
}
export function structuralPrivateArtifactStreamReason(chunks) {
  const scanner = createStructuralByteStreamScanner();
  for (const chunk of chunks) scanner.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return scanner.finish();
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
function scanWorktreeCandidate(root, repoPath, { afterFirstPass, cache = null, budget = new ScanBudget(), checkArchives = true } = {}) {
  const candidate = canonicalWorktreeCandidate(root, repoPath, cache);
  if (candidate === null) return null;
  const { file } = candidate;
  const entry = lstatSync(file);
  if (entry.isSymbolicLink()) throw new Error('private Phase 3C worktree candidate is a symlink or junction');
  if (!entry.isFile()) return null;
  const followed = statSync(file);
  if (!sameWorktreeStatIdentity(entry, followed) || realpathSync(file) !== file) throw new Error('private Phase 3C worktree candidate changed during scan');
  budget.admit(entry.size);
  const fd = openSync(file, 'r');
  try {
    assertStableWorktreeCandidate(root, repoPath, file, entry, fd, cache);
    const scanOnce = () => {
      const chunk = Buffer.alloc(WORKTREE_SCAN_CHUNK_BYTES);
      const digest = createHash('sha256');
      const scanner = createStructuralByteStreamScanner({ checkArchives });
      let offset = 0;
      while (offset < entry.size) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, entry.size - offset), offset);
        if (read <= 0) throw new Error('private Phase 3C worktree candidate changed during scan');
        const bytes = chunk.subarray(0, read);
        digest.update(bytes);
        scanner.feed(bytes);
        offset += read;
      }
      return {
        digest: digest.digest('hex'),
        reason: scanner.finish(),
      };
    };
    const first = scanOnce();
    afterFirstPass?.({ file, fd });
    assertStableWorktreeCandidate(root, repoPath, file, entry, fd, cache);
    const second = scanOnce();
    assertStableWorktreeCandidate(root, repoPath, file, entry, fd, cache);
    if (first.digest !== second.digest || first.reason !== second.reason) throw new Error('private Phase 3C worktree candidate changed during scan');
    return { reason: first.reason, size: entry.size };
  } finally { closeSync(fd); }
}
export function ignoredLargeCandidateHasPrivateSignal(root, repoPath, _prefix, { afterFirstPass } = {}) {
  return Boolean(scanWorktreeCandidate(root, repoPath, { afterFirstPass })?.reason);
}
class AsyncByteReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.pending = Buffer.alloc(0); }
  async more() {
    const next = await this.iterator.next();
    if (next.done) throw new Error('private Phase 3C containment Git blob stream ended unexpectedly');
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
  }
  async bytes(length) {
    while (this.pending.length < length) await this.more();
    const result = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return result;
  }
  async line() {
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline !== -1) {
        if (newline > 256) throw new Error('private Phase 3C containment received an invalid Git blob header');
        const result = this.pending.subarray(0, newline).toString('ascii');
        this.pending = this.pending.subarray(newline + 1);
        return result;
      }
      if (this.pending.length > 256) throw new Error('private Phase 3C containment received an invalid Git blob header');
      await this.more();
    }
  }
}

async function scanGitBlobEntries(entries, root, budget) {
  if (entries.length === 0) return new Map();
  const child = spawn('git', ['cat-file', '--batch'], { cwd: root, env: hermeticGitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { if (code === 0) resolve(); else reject(new Error('private Phase 3C containment Git blob stream failed')); });
  });
  child.stderr.resume();
  child.stdin.end(`${entries.map(entry => entry.spec).join('\n')}\n`);
  const reader = new AsyncByteReader(child.stdout);
  const reasons = new Map();
  try {
    for (const entry of entries) {
      const header = await reader.line();
      const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/i.exec(header);
      if (!match) throw new Error('private Phase 3C containment received an invalid Git blob header');
      if (match[1].toLowerCase() !== entry.spec.toLowerCase()) throw new Error('private Phase 3C containment received a mismatched Git blob header');
      const size = Number(match[2]);
      budget.admit(size);
      const scanner = createStructuralByteStreamScanner();
      let remaining = size;
      while (remaining > 0) {
        const bytes = await reader.bytes(Math.min(WORKTREE_SCAN_CHUNK_BYTES, remaining));
        scanner.feed(bytes);
        remaining -= bytes.length;
      }
      const separator = await reader.bytes(1);
      if (separator[0] !== 0x0a) throw new Error('private Phase 3C containment received an invalid Git blob separator');
      reasons.set(entry.key, scanner.finish());
    }
    await exit;
    return reasons;
  } catch (error) {
    child.kill();
    try { await exit; } catch (_ignored) { /* preserve the containment error */ }
    throw error;
  }
}

function currentIndexEntries(root, execute) {
  const entries = [];
  for (const record of String(gitOutput(['ls-files', '--stage', '-z'], root, execute)).split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])$/.exec(separator === -1 ? '' : record.slice(0, separator));
    if (!match) throw new Error('private Phase 3C containment could not parse Git index entry');
    const repoPath = record.slice(separator + 1);
    if (match[3] !== '0') throw new Error('private Phase 3C containment rejected unmerged Git index entry');
    entries.push({ repoPath, mode: match[1], spec: match[2], key: `index:${repoPath}` });
  }
  return entries;
}

async function currentIndexCandidateViolations(root, execute, budget) {
  const violations = [];
  const regular = [];
  const entries = currentIndexEntries(root, execute);
  for (const bareRoot of bareRepositoryRoots(entries.map(entry => entry.repoPath))) {
    violations.push({ repoPath: bareRoot, reason: 'bare Git repository' });
  }
  for (const entry of entries) {
    if (!REGULAR_GIT_MODES.has(entry.mode)) { violations.push({ repoPath: entry.repoPath, reason: 'non-regular Git mode' }); continue; }
    regular.push(entry);
  }
  const reasons = await scanGitBlobEntries(regular, root, budget);
  for (const entry of regular) {
    const reason = reasons.get(entry.key);
    if (reason) violations.push({ repoPath: entry.repoPath, reason });
  }
  return { violations, entries: new Map(entries.map(entry => [entry.repoPath, entry])) };
}

function stagedIndexContentViolations(root, execute, indexEntries) {
  const violations = [];
  for (const repoPath of gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=AMRT'], root, execute)) {
    const entry = indexEntries.get(repoPath);
    if (!entry || !REGULAR_GIT_MODES.has(entry.mode)) violations.push({ repoPath, reason: 'non-regular Git mode' });
  }
  return violations;
}

function worktreeEntryKind(root, repoPath) {
  const lexicalRoot = path.resolve(root);
  const lexicalPath = path.resolve(lexicalRoot, repoPath);
  if (!lexicalPath.startsWith(`${lexicalRoot}${path.sep}`)) throw new Error('private Phase 3C worktree candidate escapes the repository');
  const segments = path.relative(lexicalRoot, lexicalPath).split(path.sep);
  if (!segments.length || segments.some(segment => !segment || segment === '..')) throw new Error('private Phase 3C worktree candidate escapes the repository');
  let current = lexicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const entry = lstatSync(current);
    // Do not follow a final symlink or a reparse-point parent. Either is a
    // non-regular entry; ignored tooling links retain their explicit
    // allowance, while embedded repositories fail closed below.
    if (entry.isSymbolicLink()) return 'non-regular';
    if (index < segments.length - 1) {
      if (!entry.isDirectory()) return 'non-regular';
    } else if (entry.isFile()) return 'regular';
    else if (entry.isDirectory()) {
      try {
        lstatSync(path.join(current, '.git'));
        return 'embedded-repository';
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      try {
        const head = lstatSync(path.join(current, 'HEAD'));
        const config = lstatSync(path.join(current, 'config'));
        const objects = lstatSync(path.join(current, 'objects'));
        if (head.isFile() && config.isFile() && objects.isDirectory()) return 'bare-repository';
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return 'non-regular';
    } else return 'non-regular';
  }
  return 'non-regular';
}

function worktreeContentViolations(root, execute, budget) {
  const modified = new Set(gitPaths(['diff', '--name-only', '-z', '--diff-filter=ACMRT'], root, execute));
  const untracked = new Set(gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, execute));
  const ignored = new Set(gitPaths(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], root, execute));
  const violations = [];
  const candidates = new Map();
  for (const repoPath of modified) candidates.set(repoPath, 'modified');
  for (const repoPath of untracked) candidates.set(repoPath, 'untracked');
  for (const repoPath of ignored) if (!candidates.has(repoPath)) candidates.set(repoPath, 'ignored');
  const started = performance.now();
  const cache = { roots: new Map(), parents: new Map() };
  const bareRoots = bareRepositoryRoots([...candidates.keys()]);
  for (const bareRoot of bareRoots) violations.push({ repoPath: bareRoot, reason: 'bare Git repository' });
  for (const [repoPath, source] of candidates) {
    const normalizedRepoPath = repoPath.replaceAll('\\', '/');
    if ([...bareRoots].some(bareRoot => normalizedRepoPath === bareRoot || normalizedRepoPath.startsWith(`${bareRoot}/`))) continue;
    // `git ls-files --ignored` includes ordinary tool-owned links such as
    // node_modules/.bin. Never follow those entries: an unrelated ignored
    // reparse point cannot make a private packet Git-visible. A Phase 3C
    // filename/path remains a failure before this skip, so a packet symlink
    // or junction still fails closed without dereferencing its target.
    if (source === 'ignored') {
      const forbiddenReason = forbiddenArtifactReason(repoPath);
      // The lexical violation is sufficient: never dereference a forbidden
      // ignored path before reporting it. This keeps a packet-named link from
      // changing the diagnostic or reaching an attacker-controlled target.
      if (forbiddenReason) { violations.push({ repoPath, reason: forbiddenReason }); continue; }
    }
    // Git collapses both ignored and untracked embedded repositories to one
    // directory candidate. Detect their `.git` marker without walking nested
    // content; a benign ignored symlink remains non-regular and is skipped.
    if (source === 'ignored' || source === 'untracked') {
      const entryKind = worktreeEntryKind(root, repoPath);
      if (entryKind === 'embedded-repository') { violations.push({ repoPath, reason: 'embedded Git repository' }); continue; }
      if (entryKind === 'bare-repository') { violations.push({ repoPath, reason: 'bare Git repository' }); continue; }
      if (entryKind !== 'regular') continue;
    }
    // Ignored dependencies and caches are not Git-visible packet candidates;
    // retain ZIP rejection for tracked, modified, and untracked paths only.
    const result = scanWorktreeCandidate(root, repoPath, { cache, budget, checkArchives: source !== 'ignored' });
    if (result?.reason) violations.push({ repoPath, reason: result.reason });
  }
  return { violations, candidateCount: candidates.size, ignoredCount: ignored.size, durationMs: Math.round(performance.now() - started) };
}

function commitsForRange(range, root, execute) {
  const [base, head, ...extra] = String(range).split('..');
  if (extra.length || !base || !head) throw new Error('private Phase 3C history containment requires an explicit base..head range');
  return gitLines(['rev-list', '--reverse', `--max-count=${MAX_HISTORY_COMMITS + 1}`, `${assertCommitSha(base, 'base')}..${assertCommitSha(head, 'head')}`], root, execute);
}
function changedPathsForCommit(commit, root, execute) {
  // -m compares a merge result with every parent, so a conflict-resolution
  // blob that exists only in the merge commit cannot disappear from history
  // containment. A path can appear once per parent; inspect it once at the
  // final commit tree after deduplication.
  return [...new Set(gitPaths(['diff-tree', '--root', '-m', '-r', '--no-commit-id', '--diff-filter=AMRT', '--name-only', '-z', commit], root, execute))];
}
function gitTreeEntry(commit, repoPath, root, execute) {
  const record = String(gitOutput(['ls-tree', '-z', commit, '--', repoPath], root, execute)).split('\0').filter(Boolean);
  if (record.length !== 1) throw new Error('private Phase 3C containment could not resolve changed Git tree entry');
  const separator = record[0].indexOf('\t');
  const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/.exec(separator === -1 ? '' : record[0].slice(0, separator));
  if (!match || record[0].slice(separator + 1) !== repoPath) throw new Error('private Phase 3C containment could not parse changed Git tree entry');
  return { mode: match[1], type: match[2], object: match[3] };
}
function commitTreeEntries(commit, root, execute) {
  const entries = [];
  for (const record of String(gitOutput(['ls-tree', '-r', '-z', assertCommitSha(commit, 'candidate')], root, execute)).split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/.exec(separator === -1 ? '' : record.slice(0, separator));
    const repoPath = separator === -1 ? '' : record.slice(separator + 1);
    if (!match || !repoPath) throw new Error('private Phase 3C containment could not parse candidate commit tree entry');
    entries.push({ repoPath, mode: match[1], type: match[2], object: match[3] });
  }
  if (entries.length > MAX_STRUCTURAL_SCAN_CANDIDATES) throw new Error('private Phase 3C containment candidate-count cap exceeded');
  return entries;
}
async function candidateCommitTreeViolations(commit, root, execute, budget) {
  const entries = commitTreeEntries(commit, root, execute);
  const violations = [];
  const regular = [];
  for (const bareRoot of bareRepositoryRoots(entries.map(entry => entry.repoPath))) {
    violations.push({ repoPath: `${commit}:${bareRoot}`, reason: 'bare Git repository' });
  }
  for (const entry of entries) {
    const directReason = forbiddenArtifactReason(entry.repoPath);
    if (directReason) violations.push({ repoPath: `${commit}:${entry.repoPath}`, reason: directReason });
    if (!REGULAR_GIT_MODES.has(entry.mode) || entry.type !== 'blob') { violations.push({ repoPath: `${commit}:${entry.repoPath}`, reason: 'non-regular Git mode' }); continue; }
    regular.push({ repoPath: `${commit}:${entry.repoPath}`, spec: entry.object, key: `candidate:${commit}:${entry.repoPath}` });
  }
  const reasons = await scanGitBlobEntries(regular, root, budget);
  for (const entry of regular) {
    const reason = reasons.get(entry.key);
    if (reason) violations.push({ repoPath: entry.repoPath, reason });
  }
  return { violations, entryCount: entries.length };
}
async function historyViolations(commits, root, execute, budget, historyBudget) {
  const violations = [];
  const entries = [];
  for (const commit of commits) {
    const paths = changedPathsForCommit(assertCommitSha(commit, 'history'), root, execute);
    // Reject the whole changed-path batch before resolving any individual
    // tree entry. This bounds expensive ls-tree subprocesses even for a
    // deleted-at-tip history whose current tree is small.
    historyBudget.admit(paths.length);
    for (const repoPath of paths) {
      const directReason = forbiddenArtifactReason(repoPath);
      if (directReason) violations.push({ repoPath: `${commit}:${repoPath}`, reason: directReason });
      const bareRoot = commitContainsBareRepository(commit, repoPath, root, execute);
      if (bareRoot) violations.push({ repoPath: `${commit}:${bareRoot}`, reason: 'bare Git repository' });
      const tree = gitTreeEntry(commit, repoPath, root, execute);
      if (!REGULAR_GIT_MODES.has(tree.mode) || tree.type !== 'blob') { violations.push({ repoPath: `${commit}:${repoPath}`, reason: 'non-regular Git mode' }); continue; }
      entries.push({ repoPath: `${commit}:${repoPath}`, spec: tree.object, key: `history:${commit}:${repoPath}` });
    }
  }
  const reasons = await scanGitBlobEntries(entries, root, budget);
  for (const entry of entries) {
    const reason = reasons.get(entry.key);
    if (reason) violations.push({ repoPath: entry.repoPath, reason });
  }
  return violations;
}

export async function checkPrivateArtifactContainment({ root = REPO_ROOT, execute = execFileSync, ranges = [], commits = [], testLimits = {} } = {}) {
  const ignoredVisible = gitPaths(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], root, execute);
  const visible = new Set([
    ...gitPaths(['ls-files', '-z'], root, execute),
    ...gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], root, execute),
    ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, execute),
    ...ignoredVisible,
  ]);
  if (visible.size > MAX_STRUCTURAL_SCAN_CANDIDATES) throw new Error('private Phase 3C containment candidate-count cap exceeded');
  const rangeCommits = ranges.flatMap(range => commitsForRange(range, root, execute));
  const checkedCommits = [...new Set([...commits.map(commit => assertCommitSha(commit, 'history')), ...rangeCommits])];
  if (checkedCommits.length > reducedContainmentLimit(testLimits.maxCheckedCommits, MAX_HISTORY_COMMITS)) throw new Error('private Phase 3C containment checked-commit cap exceeded');
  const budget = new ScanBudget();
  const index = await currentIndexCandidateViolations(root, execute, budget);
  const worktree = worktreeContentViolations(root, execute, budget);
  const historyBudget = new HistoryTraversalBudget(reducedContainmentLimit(testLimits.maxHistoryPaths, MAX_STRUCTURAL_SCAN_CANDIDATES - budget.candidates));
  const violations = [
    ...findForbiddenPrivateArtifactPaths([...visible]),
    ...index.violations,
    ...stagedIndexContentViolations(root, execute, index.entries),
    ...worktree.violations,
    ...await historyViolations(checkedCommits, root, execute, budget, historyBudget),
  ];
  if (violations.length) {
    const summary = [...new Map(violations.map(item => [`${item.repoPath}\0${item.reason}`, item])).values()];
    throw new Error(`private Phase 3C artifact containment failure: ${summary.map(item => `${item.repoPath} (${item.reason})`).join(', ')}`);
  }
  return { checked_path_count: visible.size, checked_commit_count: checkedCommits.length, checked_ignored_count: worktree.ignoredCount, worktree_scan_duration_ms: worktree.durationMs, scanned_candidate_count: budget.candidates, scanned_logical_bytes: budget.logicalBytes };
}

function outgoingCommitsForNewRemoteRef(localSha, remoteName, root, execute) {
  if (typeof remoteName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(remoteName)) throw new Error('private Phase 3C pre-push containment requires a safe remote name');
  return gitLines(['rev-list', '--reverse', `--max-count=${MAX_HISTORY_COMMITS + 1}`, assertCommitSha(localSha, 'local'), `--not`, `--remotes=${remoteName}`], root, execute);
}
export async function checkPrePushPrivateArtifactContainment({ root = REPO_ROOT, execute = execFileSync, remoteName, stdin } = {}) {
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
function commitsForNewPush(head, root, execute) {
  return gitLines(['rev-list', '--reverse', `--max-count=${MAX_HISTORY_COMMITS + 1}`, assertCommitSha(head, 'push head')], root, execute);
}
function canonicalContainmentRoot(root, expectedHead, execute) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('private Phase 3C CI containment requires an absolute candidate root');
  const canonical = realpathSync(root);
  if (canonical !== path.resolve(root)) throw new Error('private Phase 3C CI containment requires a canonical candidate root');
  const topLevel = String(gitOutput(['rev-parse', '--show-toplevel'], canonical, execute)).trim();
  if (path.resolve(topLevel) !== canonical) throw new Error('private Phase 3C CI containment candidate root is not a Git worktree root');
  const head = assertCommitSha(String(gitOutput(['rev-parse', 'HEAD'], canonical, execute)).trim(), 'candidate head');
  if (head !== expectedHead) throw new Error('private Phase 3C CI containment candidate root does not match the event head');
  return canonical;
}
function eventCommitIsAvailable(sha, root, execute) {
  try { return String(gitOutput(['cat-file', '-t', sha], root, execute)).trim() === 'commit'; } catch (_error) { return false; }
}
export function githubEventHandoffAttestation(eventHead) {
  return `PHASE3_PRIVATE_ARTIFACT_HANDOFF protocol=${GITHUB_EVENT_HANDOFF_PROTOCOL} event_head=${assertCommitSha(eventHead, 'event')}`;
}
export async function checkGitHubEventPrivateArtifactContainment({ root = REPO_ROOT, execute = execFileSync, environment = process.env, readFile = readFileSync } = {}) {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (typeof eventPath !== 'string' || !path.isAbsolute(eventPath)) throw new Error('private Phase 3C CI containment requires GITHUB_EVENT_PATH');
  let event;
  try { event = JSON.parse(readFile(eventPath, 'utf8')); } catch (_error) { throw new Error('private Phase 3C CI containment could not parse GitHub event metadata'); }
  const name = environment.GITHUB_EVENT_NAME;
  if (name === 'pull_request') {
    const base = assertCommitSha(event?.pull_request?.base?.sha, 'pull-request base');
    const head = assertCommitSha(event?.pull_request?.head?.sha, 'pull-request head');
    // Both exact event commits must be present. Deliberately do not require
    // base ancestry: a legitimate behind-base PR may have a non-descendant
    // head, and Git's explicit base..head range remains the requested scope.
    for (const sha of [base, head]) if (!eventCommitIsAvailable(sha, root, execute)) throw new Error('private Phase 3C CI containment event commit is unavailable');
    const candidateRoot = canonicalContainmentRoot(root, head, execute);
    return { ...await checkPrivateArtifactContainment({ root: candidateRoot, execute, ranges: [`${base}..${head}`] }), github_event_head: head };
  }
  if (name === 'pull_request_target') {
    const base = assertCommitSha(event?.pull_request?.base?.sha, 'pull-request base');
    const head = assertCommitSha(event?.pull_request?.head?.sha, 'pull-request head');
    // pull_request_target deliberately runs the checker from the base commit.
    // It never materializes candidate files: the exact candidate tree and
    // history are scanned through Git objects only.
    for (const sha of [base, head]) if (!eventCommitIsAvailable(sha, root, execute)) throw new Error('private Phase 3C CI containment event commit is unavailable');
    const trustedBaseRoot = canonicalContainmentRoot(root, base, execute);
    const budget = new ScanBudget();
    const candidate = await candidateCommitTreeViolations(head, trustedBaseRoot, execute, budget);
    const targetCommits = commitsForRange(`${base}..${head}`, trustedBaseRoot, execute);
    // `commitsForRange` deliberately asks Git for one more than the allowed
    // maximum. Reject that sentinel before any history scan so a long PR
    // cannot hide a private add/delete in the truncated tail.
    if (targetCommits.length > MAX_HISTORY_COMMITS) throw new Error('private Phase 3C pull-request-target history commit cap exceeded');
    const historyBudget = new HistoryTraversalBudget(MAX_STRUCTURAL_SCAN_CANDIDATES - budget.candidates);
    const history = await historyViolations(targetCommits, trustedBaseRoot, execute, budget, historyBudget);
    const violations = [...candidate.violations, ...history];
    if (violations.length) {
      const summary = [...new Map(violations.map(item => [`${item.repoPath}\0${item.reason}`, item])).values()];
      throw new Error(`private Phase 3C artifact containment failure: ${summary.map(item => `${item.repoPath} (${item.reason})`).join(', ')}`);
    }
    return {
      checked_path_count: candidate.entryCount,
      checked_commit_count: targetCommits.length,
      checked_ignored_count: 0,
      worktree_scan_duration_ms: 0,
      scanned_candidate_count: budget.candidates,
      scanned_logical_bytes: budget.logicalBytes,
      github_event_head: head,
    };
  }
  if (name === 'push') {
    const base = assertCommitSha(event?.before, 'push base');
    const head = assertCommitSha(event?.after, 'push head');
    for (const sha of [base, head]) if (sha !== ZERO_SHA && !eventCommitIsAvailable(sha, root, execute)) throw new Error('private Phase 3C CI containment event commit is unavailable');
    const candidateRoot = canonicalContainmentRoot(root, head, execute);
    // GitHub uses all zeroes when a ref is created. There is no valid
    // ZERO_SHA..head range, so enumerate the bounded candidate ancestry
    // directly and let the ordinary checked-commit cap fail closed.
    const options = base === ZERO_SHA
      ? { commits: commitsForNewPush(head, candidateRoot, execute) }
      : { ranges: [`${base}..${head}`] };
    return { ...await checkPrivateArtifactContainment({ root: candidateRoot, execute, ...options }), github_event_head: head };
  }
  throw new Error(`private Phase 3C CI containment does not support GitHub event ${String(name)}`);
}

function parseCli(args) {
  const result = { ranges: [], prePushRemote: null, githubEvent: false, root: null, attestGitHubHandoff: false };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--range') { const value = args[++index]; if (!value) throw new Error('disclosure-safe usage: --range requires base..head'); result.ranges.push(value); continue; }
    if (token === '--pre-push') { if (result.prePushRemote !== null) throw new Error('disclosure-safe usage: duplicate --pre-push'); const value = args[++index]; if (!value) throw new Error('disclosure-safe usage: --pre-push requires remote name'); result.prePushRemote = value; continue; }
    if (token === '--github-event') { if (result.githubEvent) throw new Error('disclosure-safe usage: duplicate --github-event'); result.githubEvent = true; continue; }
    if (token === GITHUB_EVENT_HANDOFF_FLAG) { if (result.attestGitHubHandoff) throw new Error('disclosure-safe usage: duplicate GitHub handoff attestation'); result.attestGitHubHandoff = true; continue; }
    if (token === '--root') { if (result.root !== null) throw new Error('disclosure-safe usage: duplicate --root'); const value = args[++index]; if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('disclosure-safe usage: --root requires an absolute path'); result.root = value; continue; }
    throw new Error('disclosure-safe usage: unknown containment option');
  }
  if ((result.prePushRemote !== null ? 1 : 0) + Number(result.githubEvent) > 1) throw new Error('disclosure-safe usage: pre-push and GitHub-event modes are exclusive');
  if (result.root !== null && !result.githubEvent) throw new Error('disclosure-safe usage: --root requires --github-event');
  if (result.attestGitHubHandoff && (!result.githubEvent || result.root === null)) throw new Error('disclosure-safe usage: GitHub handoff attestation requires --github-event and --root');
  return result;
}
async function main() {
  const cli = parseCli(process.argv.slice(2));
  const result = cli.githubEvent
    ? await checkGitHubEventPrivateArtifactContainment({ root: cli.root ?? REPO_ROOT })
    : cli.prePushRemote !== null
      ? await checkPrePushPrivateArtifactContainment({ remoteName: cli.prePushRemote, stdin: readFileSync(0, 'utf8') })
      : await checkPrivateArtifactContainment({ ranges: cli.ranges });
  if (cli.attestGitHubHandoff) console.log(githubEventHandoffAttestation(result.github_event_head));
  else console.log(`PHASE3_PRIVATE_ARTIFACT_CONTAINMENT_PASS checked_paths=${result.checked_path_count} checked_commits=${result.checked_commit_count} scanned_candidates=${result.scanned_candidate_count} scanned_logical_bytes=${result.scanned_logical_bytes}`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
