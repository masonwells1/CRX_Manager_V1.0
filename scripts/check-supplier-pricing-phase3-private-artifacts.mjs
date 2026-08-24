#!/usr/bin/env node
/**
 * Fail closed when a private Phase 3C packet is Git-visible now or anywhere in
 * the commit range about to be pushed. Diagnostics deliberately contain paths
 * and categories only: never a blob, row, Product identifier, or source text.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { APPROVED_SERIALIZED_FORMATS, OWNER_DECISION_HEADERS, PRIVATE_ARTIFACT_BASENAMES, REPO_ROOT } from './supplier-pricing-phase3-private-artifacts.mjs';

// These are resource bounds, not format allowlists. They are deliberately
// above the 51,810-path / ~0.66 GiB Phase 3C containment baseline. A logical
// candidate is charged once even when an identity-safe worktree read confirms
// its bytes a second time.
export const MAX_STRUCTURAL_SCAN_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_STRUCTURAL_SCAN_BYTES = 3 * 1024 * 1024 * 1024;
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
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff]);
// UTF-32 detection never retains a candidate-sized decoded string. The replay
// lets a BOM/NUL signal that straddles a read boundary activate the bounded
// lanes, while each lane itself retains no more than one incomplete code point.
const UTF32_REPLAY_BYTES = 4096;
const UTF32_TEXT_CHUNK_CHARS = 4096;
const CPIO_BINARY_HEADER_BYTES = 26;
const MAX_CPIO_BINARY_NAME_BYTES = 4096;
const MAX_GZIP_OPTIONAL_FIELD_BYTES = 4096;
// Fixed header + XLEN + maximum FEXTRA + maximum NUL-terminated FNAME and
// FCOMMENT + FHCRC. Retaining one byte less is the exact overlap needed for a
// maximum-size header whose final byte arrives in the next stream chunk.
const MAX_GZIP_HEADER_BYTES = 10 + 2 + MAX_GZIP_OPTIONAL_FIELD_BYTES + ((MAX_GZIP_OPTIONAL_FIELD_BYTES + 1) * 2) + 2;
const ARCHIVE_STREAM_TAIL_BYTES = Math.max(511, CPIO_BINARY_HEADER_BYTES + MAX_CPIO_BINARY_NAME_BYTES - 1, MAX_GZIP_HEADER_BYTES - 1);
const TRANSFER_DECODE_CHUNK_BYTES = 64 * 1024;
const MAX_JSON_NODES = 1_000_000;
const REGULAR_GIT_MODES = new Set(['100644', '100755']);
const PRIVATE_ARTIFACT_BASENAMES_LOWER = new Set([...PRIVATE_ARTIFACT_BASENAMES].map(name => name.toLowerCase()));
const JSON_FORMATS = new Set(APPROVED_SERIALIZED_FORMATS);
const ZERO_SHA_PATTERN = /^(?:0{40}|0{64})$/;
const SNAPSHOT_ROOT_KEYS = ['products', 'snapshot_sha256', 'expected_old_phase3_defaults', 'migration_high_water'];
const MANIFEST_ROOT_KEYS = ['rows', 'manifest_sha256', 'generated_from_snapshot_sha256', 'summary', 'approval_state'];
const PRODUCT_ROW_KEYS = ['id', 'sku', 'product_name', 'pricing_version', 'updated_at'];
const MANIFEST_ROW_KEYS = ['product_id', 'current_product', 'proposed_phase3', 'field_decisions', 'row_sha256'];
const STRUCTURAL_KEY_GROUPS = [SNAPSHOT_ROOT_KEYS, MANIFEST_ROOT_KEYS, PRODUCT_ROW_KEYS, MANIFEST_ROW_KEYS];
export const STRUCTURAL_SIGNATURE_REASON = 'private snapshot or manifest key structure';
export const PRODUCT_HEADER_REASON = 'private product CSV/TSV header structure';
const STREAM_TAIL_CHARS = Math.max(4096, OWNER_DECISION_HEADERS.join(',').length * 4);
const OWNER_HEADER_RECORD_DELIMITER_RE = /[\r\n\v\f\u0085\u2028\u2029\u001c-\u001f]/u;
const BASE64_TRANSFER_CHUNK_BYTES = 64 * 1024;
const BASE64_TRANSFER_CHARACTERS_RE = /^[A-Za-z0-9+/_=-]*$/;
const BASE64_TRANSFER_BYTE_ALLOWED = new Uint8Array(256);
for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_=-\t\n\v\f\r ') BASE64_TRANSFER_BYTE_ALLOWED[character.charCodeAt(0)] = 1;
const MAX_EMBEDDED_BASE64_WHITESPACE_BYTES = 4096;
const MAX_EMBEDDED_HEX_WHITESPACE_BYTES = 4096;
const TOOL_OWNED_IGNORED_PREFIXES = new Set(['node_modules/', 'dist/', 'dist-ssr/', 'coverage/', 'playwright-report/', '.playwright-mcp/', '.playwright-cli/', 'graphify-out/', 'test-results/', 'output/playwright/', 'output/phase1a-db/']);
const OPERATOR_OWNED_IGNORED_PREFIXES = new Set(['backups/', '.perf-sweep-data/', '.epa-data-quality/', '.vercel/']);

function unsafeStructuralSignatureExemptionPath(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.length === 0 || repoPath.includes('\\') || repoPath.includes('\0')) return 'path must be a non-empty normalized POSIX path';
  if (repoPath !== path.posix.normalize(repoPath) || repoPath.startsWith('/') || repoPath.endsWith('/') || repoPath.includes('//')) return 'path must be an exact normalized repo-relative path';
  if (/[*?\[\]{}:]/u.test(repoPath) || /[\x00-\x1f\x7f]/u.test(repoPath)) return 'path must not contain glob, drive, or control characters';
  const segments = repoPath.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return 'path must not contain empty or traversal segments';
  if (segments.some(segment => segment.toLowerCase() === 'private-artifacts' || segment.toLowerCase() === '.git')) return 'path must not be inside a private-artifact or Git administration path';
  if ([...TOOL_OWNED_IGNORED_PREFIXES, ...OPERATOR_OWNED_IGNORED_PREFIXES].some(prefix => repoPath.startsWith(prefix))) return 'path must not use a tool-owned or ignored prefix';
  return null;
}

/**
 * Explicit reviewed exceptions are exact files, never prefixes. They are only
 * for test/documentation sources whose benign text necessarily contains the
 * structural key signature; path-level and container checks remain active.
 */
export function validateStructuralSignatureExemptions(exemptions) {
  if (!exemptions || typeof exemptions !== 'object' || Array.isArray(exemptions)) throw new Error('private Phase 3C structural-signature exemptions must be an object');
  const validated = {};
  for (const [repoPath, reason] of Object.entries(exemptions)) {
    const pathError = unsafeStructuralSignatureExemptionPath(repoPath);
    if (pathError) throw new Error(`private Phase 3C structural-signature exemption rejected: ${pathError}`);
    if (typeof reason !== 'string' || reason.trim().length < 25) throw new Error(`private Phase 3C structural-signature exemption for ${repoPath} requires a concrete review reason`);
    validated[repoPath] = reason.trim();
  }
  return Object.freeze(validated);
}

export function validateStructuralSignatureHistoryExemptions(exemptions) {
  if (!exemptions || typeof exemptions !== 'object' || Array.isArray(exemptions)) throw new Error('private Phase 3C historical structural-signature exemptions must be an object');
  const validated = {};
  for (const [identity, reason] of Object.entries(exemptions)) {
    const match = /^([0-9a-f]{40,64}):(.+)$/u.exec(identity);
    if (!match) throw new Error('private Phase 3C historical structural-signature exemption requires an exact commit:path identity');
    const pathError = unsafeStructuralSignatureExemptionPath(match[2]);
    if (pathError) throw new Error(`private Phase 3C historical structural-signature exemption rejected: ${pathError}`);
    if (typeof reason !== 'string' || reason.trim().length < 25) throw new Error(`private Phase 3C historical structural-signature exemption for ${identity} requires a concrete review reason`);
    validated[identity] = reason.trim();
  }
  return Object.freeze(validated);
}

export const STRUCTURAL_SIGNATURE_EXEMPTIONS = validateStructuralSignatureExemptions({
});
const STRUCTURAL_SIGNATURE_EXEMPTION_PATHS = new Set(Object.keys(STRUCTURAL_SIGNATURE_EXEMPTIONS));
const REVIEWED_SYNTHETIC_HISTORY_REASON = 'Reviewed synthetic scanner test source predating split-key fixture construction; contains no private packet rows.';
export const STRUCTURAL_SIGNATURE_HISTORY_EXEMPTIONS = validateStructuralSignatureHistoryExemptions({
  'fa78c4f76808159897b5bd3d9d29fd04ffa24341:scripts/supplier-pricing-phase3-private-artifacts.test.mjs': REVIEWED_SYNTHETIC_HISTORY_REASON,
  '5e3bb07fa835928c951ee2b6dbd42315821bb7c9:scripts/supplier-pricing-phase3-private-artifacts.test.mjs': REVIEWED_SYNTHETIC_HISTORY_REASON,
  '075d47e9eec1970935ed1da2e85b90fd7d0c0540:scripts/supplier-pricing-phase3-private-artifacts.test.mjs': REVIEWED_SYNTHETIC_HISTORY_REASON,
  'dc6d4d47ad33dfe64b31295fffac39c980e15f2f:scripts/supplier-pricing-phase3-private-artifacts.test.mjs': REVIEWED_SYNTHETIC_HISTORY_REASON,
  '84f0302d6c1ff5b1f7e4a858197381cea48fbff0:scripts/supplier-pricing-phase3-private-artifacts.test.mjs': REVIEWED_SYNTHETIC_HISTORY_REASON,
  'c9ace3027bb4afcddb76adc128156e97eb63a12e:scripts/supplier-pricing-phase3-private-artifacts.test.mjs': REVIEWED_SYNTHETIC_HISTORY_REASON,
});
const STRUCTURAL_SIGNATURE_HISTORY_EXEMPTION_IDENTITIES = new Set(Object.keys(STRUCTURAL_SIGNATURE_HISTORY_EXEMPTIONS));

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
function gitNulRecords(args, root = REPO_ROOT, execute = execFileSync, label = 'Git path') {
  const output = gitOutput(args, root, execute, { encoding: null });
  if (!Buffer.isBuffer(output)) throw new Error(`private Phase 3C containment requires Buffer output for ${label}`);
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error(`private Phase 3C containment received unterminated ${label} records`);
  const records = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index === start) throw new Error(`private Phase 3C containment received an empty ${label} record`);
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start !== output.length) throw new Error(`private Phase 3C containment received unterminated ${label} records`);
  return records;
}
function decodeGitPathRecord(bytes, label = 'Git path') {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error(`private Phase 3C containment received an invalid ${label}`);
  let repoPath;
  try { repoPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_error) { throw new Error(`private Phase 3C containment rejected invalid UTF-8 ${label}`); }
  // Git path comparison is byte-sensitive. Do not accept a replacement
  // character or a normalization: only the exact original bytes may become a
  // JavaScript path/key after this point.
  if (!Buffer.from(repoPath, 'utf8').equals(bytes)) throw new Error(`private Phase 3C containment rejected invalid UTF-8 ${label}`);
  return repoPath;
}
function decodeGitAsciiRecord(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.some(byte => byte > 0x7f)) throw new Error(`private Phase 3C containment received an invalid ${label}`);
  return bytes.toString('ascii');
}
function gitPaths(args, root = REPO_ROOT, execute = execFileSync) {
  return gitNulRecords(args, root, execute, 'Git path').map(record => decodeGitPathRecord(record));
}
function uniqueValidatedGitPaths(paths) {
  const unique = new Map();
  for (const repoPath of paths) {
    // `decodeGitPathRecord` proved this exact round trip before callers may
    // deduplicate. UTF-8 has one canonical byte encoding for these strings,
    // so this preserves Git's byte-level path identity (including combining
    // characters and newlines) rather than normalizing names.
    unique.set(Buffer.from(repoPath, 'utf8').toString('hex'), repoPath);
  }
  return [...unique.values()];
}
function gitLines(args, root = REPO_ROOT, execute = execFileSync) {
  return String(gitOutput(args, root, execute)).trim().split(/\r?\n/).filter(Boolean);
}
function assertCommitSha(value, label) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) throw new Error(`private Phase 3C history containment requires a valid ${label} commit SHA`);
  return value.toLowerCase();
}
function isZeroSha(value) { return typeof value === 'string' && ZERO_SHA_PATTERN.test(value); }

export function forbiddenArtifactReason(repoPath) {
  const segments = repoPath.split(/[\\/]/).filter(Boolean);
  if (segments.some(segment => segment.toLowerCase() === 'private-artifacts')) return 'private-artifacts directory';
  if (segments.some(segment => segment.toLowerCase() === '.git')) return 'Git administration path';
  if (segments.some(segment => PRIVATE_ARTIFACT_BASENAMES_LOWER.has(segment.toLowerCase()))) return 'private artifact basename';
  return null;
}
export function findForbiddenPrivateArtifactPaths(paths) {
  return paths.map(repoPath => ({ repoPath, reason: forbiddenArtifactReason(repoPath) })).filter(item => item.reason);
}
export function isStructuralSignatureExempt(repoPath, reason, historyIdentity = null) {
  if (reason !== STRUCTURAL_SIGNATURE_REASON) return false;
  const normalizedPath = String(repoPath);
  if (STRUCTURAL_SIGNATURE_EXEMPTION_PATHS.has(normalizedPath)) return true;
  const identity = String(historyIdentity || '');
  const separator = identity.indexOf(':');
  return separator > 0 &&
    identity.slice(separator + 1) === normalizedPath &&
    STRUCTURAL_SIGNATURE_HISTORY_EXEMPTION_IDENTITIES.has(identity);
}
function acceptedStructuralReason(repoPath, reason, historyIdentity = null) {
  return reason && !isStructuralSignatureExempt(repoPath, reason, historyIdentity) ? reason : null;
}
function bareRepositoryObjectRoot(repoPath) {
  const normalized = repoPath.replaceAll('\\', '/');
  const match = /^(?:(.*)\/)?objects\/(?:[0-9a-f]{2}\/[0-9a-f]{38,62}|pack\/pack-[0-9a-f]{40,64}\.(?:pack|idx)|info\/alternates)$/iu.exec(normalized);
  return match ? (match[1] || '.') : null;
}
function bareRepositoryMemberPath(root, member) {
  return root === '.' ? member : `${root}/${member}`;
}
function isBareRepositoryMember(repoPath, root) {
  const normalized = repoPath.replaceAll('\\', '/');
  return root === '.' || normalized === root || normalized.startsWith(`${root}/`);
}
function isToolOwnedIgnoredPath(repoPath) {
  const normalized = repoPath.replaceAll('\\', '/');
  // Only top-level, named generated roots are tool-owned. A nested
  // `private/node_modules/` directory is operator-controlled and must retain
  // archive inspection; broad segment matching would let it hide a packet.
  return [...TOOL_OWNED_IGNORED_PREFIXES].some(prefix => normalized.startsWith(prefix));
}
function isTransientToolOwnedIgnoredEntryError(source, root, repoPath, error) {
  // Git can list an ignored build artifact just before its producing tool
  // replaces the directory. The direct path check has already run, and a
  // stable artifact remains subject to the normal content scan; only this
  // vanished tool-owned generated path can be ignored.
  // A missing worktree root is not a build-output race. Keep that setup failure
  // fail-closed; only a candidate traversal beneath an extant root may vanish.
  return source === 'ignored' && existsSync(root) && isToolOwnedIgnoredPath(repoPath) && error?.code === 'ENOENT';
}
function isOperatorOwnedIgnoredPath(repoPath) {
  const normalized = repoPath.replaceAll('\\', '/');
  return [...OPERATOR_OWNED_IGNORED_PREFIXES].some(prefix => normalized.startsWith(prefix));
}
function bareRepositoryRoots(paths) {
  const pathSet = new Set(paths.map(repoPath => repoPath.replaceAll('\\', '/')));
  const roots = new Set();
  for (const repoPath of pathSet) {
    const root = bareRepositoryObjectRoot(repoPath);
    if (root && pathSet.has(bareRepositoryMemberPath(root, 'HEAD')) && pathSet.has(bareRepositoryMemberPath(root, 'config'))) roots.add(root);
  }
  return roots;
}
function commitContainsBareRepository(commit, repoPath, root, execute) {
  const bareRoot = bareRepositoryObjectRoot(repoPath);
  if (!bareRoot) return null;
  try {
    gitOutput(['cat-file', '-e', `${commit}:${bareRepositoryMemberPath(bareRoot, 'HEAD')}`], root, execute);
    gitOutput(['cat-file', '-e', `${commit}:${bareRepositoryMemberPath(bareRoot, 'config')}`], root, execute);
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
  admit(size, repoPath = '<unknown>') {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`private Phase 3C containment could not determine candidate size at ${repoPath}`);
    if (this.candidates >= MAX_STRUCTURAL_SCAN_CANDIDATES) throw new Error(`private Phase 3C containment candidate-count cap exceeded at ${repoPath}`);
    if (size > MAX_STRUCTURAL_SCAN_BYTES) throw new Error(`private Phase 3C containment per-file scan cap exceeded at ${repoPath}`);
    if (this.logicalBytes > MAX_TOTAL_STRUCTURAL_SCAN_BYTES - size) throw new Error(`private Phase 3C containment total-byte scan cap exceeded at ${repoPath}`);
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
function decodedTextCandidateReason(candidates) {
  for (const text of candidates) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsedReason = privateJsonNodeReason(JSON.parse(text));
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
function bytesAt(source, offset, signature) {
  return offset >= 0 && offset + signature.length <= source.length
    && signature.every((value, index) => source[offset + index] === value);
}
function hasPlausibleTarHeader(source, magicOffset) {
  const header = magicOffset - 257;
  if (header < 0 || header + 512 > source.length) return false;
  const magic = source.subarray(magicOffset, magicOffset + 6);
  if (!magic.equals(Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00]))
    && !magic.equals(Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x20]))) return false;
  const checksumText = source.subarray(header + 148, header + 156).toString('ascii').replace(/[\0 ]/g, '');
  if (!/^[0-7]{1,6}$/.test(checksumText)) return false;
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : source[header + index];
  return Number.parseInt(checksumText, 8) === checksum;
}
function hasPlausibleCpioHeader(source, offset) {
  const newc = bytesAt(source, offset, [0x30, 0x37, 0x30, 0x37, 0x30, 0x31]) || bytesAt(source, offset, [0x30, 0x37, 0x30, 0x37, 0x30, 0x32]);
  if (newc && offset + 110 <= source.length) {
    const fields = source.subarray(offset + 6, offset + 110).toString('ascii');
    if (!/^[0-9a-f]{104}$/i.test(fields)) return false;
    const nameSize = Number.parseInt(fields.slice(88, 96), 16);
    return Number.isSafeInteger(nameSize) && nameSize > 0 && nameSize <= 4096;
  }
  if (bytesAt(source, offset, [0x30, 0x37, 0x30, 0x37, 0x30, 0x37]) && offset + 76 <= source.length) {
    const fields = source.subarray(offset + 6, offset + 76).toString('ascii');
    return /^[0-7 ]{70}$/.test(fields) && /[0-7]/.test(fields);
  }
  if (offset + CPIO_BINARY_HEADER_BYTES > source.length || !bytesAt(source, offset, [0x71, 0xc7]) && !bytesAt(source, offset, [0xc7, 0x71])) return false;
  const littleEndian = source[offset] === 0xc7;
  const nameSize = littleEndian ? source.readUInt16LE(offset + 20) : source.readUInt16BE(offset + 20);
  if (nameSize < 2 || nameSize > MAX_CPIO_BINARY_NAME_BYTES) return false;
  const nameStart = offset + CPIO_BINARY_HEADER_BYTES;
  const nameEnd = nameStart + nameSize;
  if (nameEnd > source.length) return false;
  const pathname = source.subarray(nameStart, nameEnd);
  return pathname.at(-1) === 0 && pathname.subarray(0, -1).indexOf(0) === -1;
}
function hasPlausibleZipLocalHeader(source, offset) {
  // A local file header has a 30-byte fixed part followed by the name and
  // extra fields. Do not reject a bare four-byte magic: public binary/text
  // payloads can contain it incidentally.
  if (!bytesAt(source, offset, [0x50, 0x4b, 0x03, 0x04]) || offset + 30 > source.length) return false;
  const version = source.readUInt16LE(offset + 4);
  const flags = source.readUInt16LE(offset + 6);
  const method = source.readUInt16LE(offset + 8);
  const nameLength = source.readUInt16LE(offset + 26);
  const extraLength = source.readUInt16LE(offset + 28);
  if (version < 10 || version > 63 || method > 99 || (flags & 0xc000) !== 0 || nameLength === 0 || nameLength > 4096 || extraLength > MAX_GZIP_OPTIONAL_FIELD_BYTES) return false;
  const headerEnd = offset + 30 + nameLength + extraLength;
  if (headerEnd > source.length) return false;
  const name = source.subarray(offset + 30, offset + 30 + nameLength);
  return name.indexOf(0) === -1;
}
function hasPlausibleZipEocd(source, offset) {
  // EOCD has a 22-byte fixed part plus an optional bounded comment. A data
  // descriptor (`PK\x07\x08`) is intentionally not an archive proof by itself.
  if (!bytesAt(source, offset, [0x50, 0x4b, 0x05, 0x06]) || offset + 22 > source.length) return false;
  const disk = source.readUInt16LE(offset + 4);
  const centralDisk = source.readUInt16LE(offset + 6);
  const entriesOnDisk = source.readUInt16LE(offset + 8);
  const entriesTotal = source.readUInt16LE(offset + 10);
  const commentLength = source.readUInt16LE(offset + 20);
  return disk === 0 && centralDisk === 0 && entriesOnDisk === entriesTotal && offset + 22 + commentLength <= source.length;
}
function boundedGzipZeroTerminatedField(source, offset) {
  const available = source.length - offset;
  const inspected = Math.min(available, MAX_GZIP_OPTIONAL_FIELD_BYTES + 1);
  const terminator = source.subarray(offset, offset + inspected).indexOf(0);
  if (terminator !== -1) return { state: 'complete', end: offset + terminator + 1 };
  return available > MAX_GZIP_OPTIONAL_FIELD_BYTES ? { state: 'recognized-overbound' } : { state: 'incomplete' };
}
function gzipHeaderState(source, offset) {
  // RFC 1952 fixed header: magic, method 8, FLG with reserved bits clear,
  // MTIME/XFL/OS. The tri-state result distinguishes a benign invalid header
  // from an incomplete recognized header and from a recognized archive. Once
  // a valid fixed header declares an over-bound optional field, fail closed
  // even if its terminator has not arrived.
  if (!bytesAt(source, offset, [0x1f, 0x8b, 0x08])) return 'invalid';
  if (offset + 10 > source.length) return 'incomplete';
  const flags = source[offset + 3];
  if ((flags & 0xe0) !== 0) return 'invalid';
  let cursor = offset + 10;
  if (flags & 0x04) {
    if (cursor + 2 > source.length) return 'incomplete';
    const extraLength = source.readUInt16LE(cursor);
    if (extraLength > MAX_GZIP_OPTIONAL_FIELD_BYTES) return 'recognized-overbound';
    if (cursor + 2 + extraLength > source.length) return 'incomplete';
    cursor += 2 + extraLength;
  }
  for (const flag of [0x08, 0x10]) {
    if (!(flags & flag)) continue;
    const field = boundedGzipZeroTerminatedField(source, cursor);
    if (field.state !== 'complete') return field.state;
    cursor = field.end;
  }
  if ((flags & 0x02) && cursor + 2 > source.length) return 'incomplete';
  return 'recognized';
}
function hasPlausibleCabHeader(source, offset) {
  if (source[offset] !== 0x4d || offset + 36 > source.length || !bytesAt(source, offset, [0x4d, 0x53, 0x43, 0x46])) return false;
  if (source.readUInt32LE(offset + 4) !== 0) return false;
  const cabinetSize = source.readUInt32LE(offset + 8);
  const versionMinor = source[offset + 24]; const versionMajor = source[offset + 25];
  return cabinetSize >= 36 && versionMajor === 1 && versionMinor <= 3;
}
function hasPlausibleZstdFrame(source, offset) {
  if (source[offset] !== 0x28 || !bytesAt(source, offset, [0x28, 0xb5, 0x2f, 0xfd]) || offset + 5 > source.length) return false;
  const descriptor = source[offset + 4];
  // Bit 3 is reserved. A non-single-segment frame needs a window descriptor.
  if ((descriptor & 0x08) !== 0) return false;
  const singleSegment = (descriptor & 0x20) !== 0;
  const fcsFlag = descriptor >> 6;
  const fcsLength = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag;
  return offset + 5 + (singleSegment ? 0 : 1) + fcsLength <= source.length;
}
function hasPlausibleLz4Frame(source, offset) {
  if (source[offset] !== 0x04 || !bytesAt(source, offset, [0x04, 0x22, 0x4d, 0x18]) || offset + 7 > source.length) return false;
  const flg = source[offset + 4]; const bd = source[offset + 5];
  return (flg & 0xc2) === 0x40 && (bd & 0x8f) === 0 && (bd >> 4) >= 4 && (bd >> 4) <= 7;
}
function hasPlausibleLz4LegacyFrame(source, offset) {
  return bytesAt(source, offset, [0x02, 0x21, 0x4c, 0x18]) && offset + 8 <= source.length;
}
function hasPlausibleGitPackHeader(source, offset) {
  if (offset < 0 || offset + 32 > source.length || !bytesAt(source, offset, [0x50, 0x41, 0x43, 0x4b])) return false;
  const version = source.readUInt32BE(offset + 4);
  const objectCount = source.readUInt32BE(offset + 8);
  return (version === 2 || version === 3) && objectCount <= 100_000_000;
}
function hasSkippableFrame(source, offset) {
  if (offset < 0 || offset + 8 > source.length || source[offset] < 0x50 || source[offset] > 0x5f
    || !bytesAt(source, offset + 1, [0x2a, 0x4d, 0x18])) return false;
  // The payload need not be present: a complete skippable-frame header is an
  // uninspectable container and must fail closed. readUInt32LE adds no useful
  // validation here because it always returns a valid unsigned 32-bit value.
  return true;
}
function compressedArchiveReason(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  // Keep signatures numeric so this checker does not contain a raw archive
  // header and reject its own source while scanning the introducing PR.
  const signatures = [
    [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
    [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a], [0x21, 0x3c, 0x74, 0x68, 0x69, 0x6e, 0x3e, 0x0a],
  ].map(signature => Buffer.from(signature));
  const bzipPrefix = Buffer.from([0x42, 0x5a, 0x68]);
  const bzipBlockMagic = Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59]);
  for (let index = source.indexOf(bzipPrefix); index !== -1; index = source.indexOf(bzipPrefix, index + 1)) {
    const blockSize = source[index + 3];
    if (blockSize >= 0x31 && blockSize <= 0x39 && source.subarray(index + 4, index + 10).equals(bzipBlockMagic)) return 'compressed archive container cannot be inspected';
  }
  if (signatures.some(signature => source.indexOf(signature) !== -1)) return 'compressed archive container cannot be inspected';
  const findValidated = (prefix, validator) => {
    for (let index = source.indexOf(prefix); index !== -1; index = source.indexOf(prefix, index + 1)) if (validator(index)) return true;
    return false;
  };
  if (findValidated(Buffer.from([0x50, 0x4b, 0x03, 0x04]), index => hasPlausibleZipLocalHeader(source, index))
    || findValidated(Buffer.from([0x50, 0x4b, 0x05, 0x06]), index => hasPlausibleZipEocd(source, index))) return 'compressed archive container cannot be inspected';
  const gzipPrefix = Buffer.from([0x1f, 0x8b, 0x08]);
  for (let index = source.indexOf(gzipPrefix); index !== -1; index = source.indexOf(gzipPrefix, index + 1)) {
    const state = gzipHeaderState(source, index);
    if (state === 'recognized' || state === 'recognized-overbound') return 'compressed archive container cannot be inspected';
  }
  if (findValidated(Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72]), index => hasPlausibleTarHeader(source, index))) return 'compressed archive container cannot be inspected';
  if (findValidated(Buffer.from([0x30, 0x37, 0x30, 0x37, 0x30]), index => hasPlausibleCpioHeader(source, index))) return 'compressed archive container cannot be inspected';
  if (findValidated(Buffer.from([0x71, 0xc7]), index => hasPlausibleCpioHeader(source, index))
    || findValidated(Buffer.from([0xc7, 0x71]), index => hasPlausibleCpioHeader(source, index))) return 'compressed archive container cannot be inspected';
  if (findValidated(Buffer.from([0x4d, 0x53, 0x43, 0x46]), index => hasPlausibleCabHeader(source, index))) return 'compressed archive container cannot be inspected';
  if (findValidated(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), index => hasPlausibleZstdFrame(source, index))) return 'compressed archive container cannot be inspected';
  if (findValidated(Buffer.from([0x04, 0x22, 0x4d, 0x18]), index => hasPlausibleLz4Frame(source, index))) return 'compressed archive container cannot be inspected';
  if (findValidated(Buffer.from([0x02, 0x21, 0x4c, 0x18]), index => hasPlausibleLz4LegacyFrame(source, index))) return 'compressed archive container cannot be inspected';
  if (findValidated(Buffer.from([0x50, 0x41, 0x43, 0x4b]), index => hasPlausibleGitPackHeader(source, index))) return 'compressed archive container cannot be inspected';
  const skippableSuffix = Buffer.from([0x2a, 0x4d, 0x18]);
  for (let suffix = source.indexOf(skippableSuffix); suffix !== -1; suffix = source.indexOf(skippableSuffix, suffix + 1)) {
    if (hasSkippableFrame(source, suffix - 1)) return 'compressed archive container cannot be inspected';
  }
  return null;
}
function createArchiveStreamScanner() {
  let tail = Buffer.alloc(0); let reason = null;
  return {
    feed(bytes) {
      if (reason) return;
      const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const probe = tail.length === 0 ? source : Buffer.concat([tail, source]);
      reason = compressedArchiveReason(probe);
      tail = Buffer.from(probe.subarray(-ARCHIVE_STREAM_TAIL_BYTES));
    },
    finish() { return reason; },
  };
}
/** Detect packet structure, not canonical whitespace or a filename. */
export function structuralPrivateArtifactReason(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length > MAX_STRUCTURAL_SCAN_BYTES) return 'private artifact candidate exceeds bounded structural scan limit';
  const scanner = createStructuralByteStreamScanner();
  scanner.feed(buffer);
  const reason = scanner.finish();
  if (reason !== 'private JSON format marker in malformed candidate') return reason;
  // Preserve the more precise direct UTF-8/UTF-16 diagnostic for an actual
  // parsed private JSON object. Alternate decodings are allocated only after
  // the bounded streaming detector has already found a private marker. An
  // ASCII Base64/hex wrapper has no UTF-16 signal and must not allocate four
  // file-sized diagnostic strings after the streaming detector has succeeded.
  const utf8Reason = decodedTextCandidateReason([normalizeText(buffer.toString('utf8'))]);
  if (utf8Reason) return utf8Reason;
  const hasUtf16Signal = buffer.indexOf(0) !== -1 || buffer.indexOf(UTF16_LE_BOM) !== -1 || buffer.indexOf(UTF16_BE_BOM) !== -1;
  if (!hasUtf16Signal) return reason;
  return decodedTextCandidateReason([
    normalizeText(buffer.toString('utf16le')),
    normalizeText(buffer.subarray(1).toString('utf16le')),
    normalizeText(decodeUtf16Be(buffer)),
    normalizeText(decodeUtf16Be(buffer, 1)),
  ]) ?? reason;
}

export function checkCommitMessagePrivateArtifactContainment(file) {
  if (typeof file !== 'string' || file.length === 0 || file.includes('\0')) throw new Error('private Phase 3C commit-message containment requires a message file');
  const resolved = path.resolve(file);
  const entry = lstatSync(resolved);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('private Phase 3C commit-message containment requires a regular non-link file');
  if (entry.size > MAX_STRUCTURAL_SCAN_BYTES) throw new Error('private Phase 3C commit-message containment failure: commit message exceeds bounded structural scan limit');
  let fd;
  try {
    fd = openSync(resolved, 'r');
    const before = fstatSync(fd);
    if (!sameWorktreeStatIdentity(entry, before)) throw new Error('private Phase 3C commit message changed during scan');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('private Phase 3C commit message changed during scan');
      offset += count;
    }
    const after = fstatSync(fd);
    if (!sameWorktreeStatIdentity(before, after)) throw new Error('private Phase 3C commit message changed during scan');
    const reason = structuralPrivateArtifactReason(bytes);
    if (reason) throw new Error(`private Phase 3C commit-message containment failure: commit message (${reason})`);
    return { scanned_logical_bytes: bytes.length };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
function createProductHeaderStreamDetector() {
  const canonicalHeader = PRODUCT_ROW_KEYS.join(',');
  let line = '';
  let discarded = false;
  let found = false;
  const isPaddingWhitespace = character => {
    const code = character.codePointAt(0);
    if (character === '\t') return false;
    if (code <= 0x20) return code === 0x20 || (code >= 0x0a && code <= 0x0d);
    return code === 0x00a0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
      || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
  };
  const finishLine = () => {
    const normalized = line.includes('\t') && !line.includes(',') ? line.replaceAll('\t', ',') : line;
    if (!discarded && normalized === canonicalHeader) found = true;
    line = '';
    discarded = false;
  };
  return {
    feed(text) {
      for (const character of text) {
        if (OWNER_HEADER_RECORD_DELIMITER_RE.test(character) && character !== '\t') { finishLine(); continue; }
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
  const structuralKeys = ['format', ...new Set(STRUCTURAL_KEY_GROUPS.flat())];
  const structuralAlternation = structuralKeys.map(escapedRegex).join('|');
  const propertyPattern = new RegExp(`"(${structuralAlternation})"\\s*:`, 'g');
  const deferredPropertyPattern = new RegExp(`"(${structuralAlternation})"\\s*$`);
  const formatValuePattern = new RegExp(`"(${[...JSON_FORMATS].map(escapedRegex).join('|')})(?:"|(?=\\s*[,}\\]]|$))`, 'g');
  const ownerHeader = createOwnerHeaderStreamDetector();
  const productHeader = createProductHeaderStreamDetector();
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
      const decoded = decodeChunk(text);
      const window = tail + decoded;
      ownerHeader.feed(decoded);
      productHeader.feed(decoded);
      if (pendingProperty) {
        const next = decoded.match(/\S/u)?.[0];
        if (next) {
          if (next === ':') signalProperty(pendingProperty);
          pendingProperty = null;
        }
      }
      propertyPattern.lastIndex = 0;
      for (let match = propertyPattern.exec(window); match; match = propertyPattern.exec(window)) signalProperty(match[1]);
      formatValuePattern.lastIndex = 0;
      for (let match = formatValuePattern.exec(window); match; match = formatValuePattern.exec(window)) formatValueSignals.add(match[1]);
      const deferred = deferredPropertyPattern.exec(window)?.[1];
      if (deferred) pendingProperty = deferred;
      tail = window.slice(-STREAM_TAIL_CHARS);
    },
    finish() {
      const ownerSignal = ownerHeader.finish();
      const productHeaderSignal = productHeader.finish();
      const structuralSignal = STRUCTURAL_KEY_GROUPS.some(group => group.every(key => propertySignals.has(key)));
      if (formatPropertySignal && formatValueSignals.size > 0) return 'private JSON format marker in malformed candidate';
      if (structuralSignal) return 'private snapshot or manifest key structure';
      if (ownerSignal) return 'owner decision sheet CSV header structure';
      if (productHeaderSignal) return PRODUCT_HEADER_REASON;
      return null;
    },
  };
}

function createUtf32StructuralCandidate(byteOrder, initialSkip) {
  const scanner = createStructuralTextStreamScanner();
  let skip = initialSkip;
  let carry = Buffer.alloc(0);
  let completed = false;
  const feedCharacters = characters => {
    if (characters) scanner.feed(characters);
  };
  return {
    feed(bytes) {
      if (completed) return;
      const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const source = skip === 0 ? input : input.subarray(Math.min(skip, input.length));
      skip = Math.max(0, skip - input.length);
      if (source.length === 0) return;
      const joined = carry.length === 0 ? source : Buffer.concat([carry, source]);
      const completeLength = joined.length - (joined.length % 4);
      carry = completeLength === joined.length ? Buffer.alloc(0) : Buffer.from(joined.subarray(completeLength));
      let text = '';
      for (let index = 0; index < completeLength; index += 4) {
        const codePoint = byteOrder === 'le' ? joined.readUInt32LE(index) : joined.readUInt32BE(index);
        text += codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : '\uFFFD';
        if (text.length >= UTF32_TEXT_CHUNK_CHARS) { feedCharacters(text); text = ''; }
      }
      feedCharacters(text);
    },
    finish() { completed = true; carry = Buffer.alloc(0); return scanner.finish(); },
  };
}
function utf32SignalIn(tail, source) {
  // UTF-32 ASCII/BOM signatures necessarily contain NUL bytes. The native
  // Buffer search keeps ordinary multi-megabyte prose out of the lane probe.
  if (tail.indexOf(0) === -1 && source.indexOf(0) === -1) return false;
  const prefix = tail.length;
  const length = prefix + source.length;
  const at = index => index < prefix ? tail[index] : source[index - prefix];
  const hasBomAt = index => {
    if (index < 0 || index + 3 >= length) return false;
    if ((at(index) === 0xff && at(index + 1) === 0xfe && at(index + 2) === 0 && at(index + 3) === 0)
      || (at(index) === 0 && at(index + 1) === 0 && at(index + 2) === 0xfe && at(index + 3) === 0xff)) return true;
    return false;
  };
  for (let index = Math.max(0, prefix - 3); index <= prefix; index += 1) if (hasBomAt(index)) return true;
  if (source.indexOf(Buffer.from([0xff, 0xfe, 0x00, 0x00])) !== -1 || source.indexOf(Buffer.from([0x00, 0x00, 0xfe, 0xff])) !== -1) return true;
  const isUtf32Start = index => {
    if (index < 0 || index + 15 >= length) return false;
    let littleEndian = true; let bigEndian = true;
    for (let group = 0; group < 4; group += 1) {
      const cursor = index + group * 4;
      littleEndian &&= at(cursor) !== 0 && at(cursor + 1) === 0 && at(cursor + 2) === 0 && at(cursor + 3) === 0;
      bigEndian &&= at(cursor) === 0 && at(cursor + 1) === 0 && at(cursor + 2) === 0 && at(cursor + 3) !== 0;
    }
    return littleEndian || bigEndian;
  };
  const inspectZeroes = (bytes, base) => {
    for (let zero = bytes.indexOf(0); zero !== -1; zero = bytes.indexOf(0, zero + 1)) {
      for (let delta = 0; delta < 4; delta += 1) if (isUtf32Start(base + zero - delta)) return true;
    }
    return false;
  };
  if (inspectZeroes(source, prefix)) return true;
  // Only the final three retained bytes can form a new candidate with the
  // current chunk; older replay bytes were checked on their own arrival.
  const seam = tail.subarray(-3);
  if (seam.length) {
    const seamOffset = prefix - seam.length;
    if (inspectZeroes(seam, seamOffset)) return true;
  }
  return false;
}
function createUtf32StructuralStreamScanner() {
  let replay = Buffer.alloc(0);
  let lanes = null;
  const activate = current => {
    lanes = [];
    for (let offset = 0; offset < 4; offset += 1) {
      lanes.push(createUtf32StructuralCandidate('le', offset), createUtf32StructuralCandidate('be', offset));
    }
    // The retained prefix is bounded, and the current source chunk is fed
    // directly rather than copied into replay. Every possible 4-byte phase is
    // covered, so a replay beginning in the middle of a code point is safe.
    for (const lane of lanes) { lane.feed(replay); lane.feed(current); }
    replay = Buffer.alloc(0);
  };
  return {
    feed(bytes) {
      const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (lanes) { for (const lane of lanes) lane.feed(source); return; }
      if (utf32SignalIn(replay, source)) { activate(source); return; }
      const retained = source.length >= UTF32_REPLAY_BYTES
        ? source.subarray(-UTF32_REPLAY_BYTES)
        : Buffer.concat([replay, source]).subarray(-UTF32_REPLAY_BYTES);
      replay = Buffer.from(retained);
    },
    finish() {
      if (!lanes && utf32SignalIn(Buffer.alloc(0), replay)) activate(Buffer.alloc(0));
      if (!lanes) return null;
      let reason = null;
      for (const lane of lanes) reason ??= lane.finish();
      return reason;
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
  const swapped = Buffer.alloc(evenLength);
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

function createBase64TransferScanner({ checkArchives = true } = {}) {
  let decoded = null;
  let quartet = ''; let active = true; let saw = false; let terminal = false; let preserveDecodedPrefix = false;
  const feedDecoded = bytes => {
    decoded ??= createStructuralByteStreamScanner({ checkArchives, checkBase64: false });
    decoded.feed(bytes);
  };
  const consumeChunk = bytes => {
    if (!active) return;
    // Most source/data files are not Base64. A byte table exits at their first
    // non-transfer byte, avoiding whole-chunk string allocation on hook scans.
    for (let index = 0; index < bytes.length; index += 1) {
      if (BASE64_TRANSFER_BYTE_ALLOWED[bytes[index]] === 0) { active = false; return; }
    }
    const transfer = bytes.toString('latin1').replace(/[\t\n\r ]/g, '');
    if (!BASE64_TRANSFER_CHARACTERS_RE.test(transfer) || (terminal && transfer.length > 0)) {
      preserveDecodedPrefix = terminal && transfer.length > 0;
      active = false;
      return;
    }
    const normalized = transfer.replaceAll('-', '+').replaceAll('_', '/');
    if (normalized.length === 0) return;
    saw = true;
    const input = quartet + normalized;
    const paddingOffset = input.indexOf('=');
    const body = paddingOffset === -1 ? input : input.slice(0, paddingOffset);
    const fullBodyLength = body.length - (body.length % 4);
    if (fullBodyLength) feedDecoded(Buffer.from(body.slice(0, fullBodyLength), 'base64'));
    quartet = input.slice(fullBodyLength);
    if (paddingOffset === -1) return;
    if (quartet.length < 4) return;
    if (!/^(?:[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/.test(quartet)) { active = false; return; }
    feedDecoded(Buffer.from(quartet, 'base64'));
    terminal = true;
    quartet = '';
  };
  return {
    feed(bytes) {
      const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      for (let offset = 0; active && offset < source.length; offset += BASE64_TRANSFER_CHUNK_BYTES) consumeChunk(source.subarray(offset, offset + BASE64_TRANSFER_CHUNK_BYTES));
    },
    finish() {
      if (!saw) return null;
      if (!active) return preserveDecodedPrefix ? decoded?.finish() ?? null : null;
      if (quartet.length) {
        // URL-safe transfer encoding commonly omits terminal padding. Only a
        // valid 2- or 3-character final quantum is safe to complete here.
        // A malformed residual must not erase evidence decoded from complete
        // quanta already seen. This does not relax mid-file transfer parsing:
        // `active === false` still rejects a non-transfer byte immediately.
        if (!/^[A-Za-z0-9+/]{2,3}$/.test(quartet)) return decoded?.finish() ?? null;
        feedDecoded(Buffer.from(quartet.padEnd(4, '='), 'base64'));
      }
      return decoded?.finish() ?? null;
    },
  };
}
function base64AlphabetValue(byte) {
  if (byte >= 0x41 && byte <= 0x5a) return String.fromCharCode(byte);
  if (byte >= 0x61 && byte <= 0x7a) return String.fromCharCode(byte);
  if (byte >= 0x30 && byte <= 0x39) return String.fromCharCode(byte);
  if (byte === 0x2b || byte === 0x2f) return String.fromCharCode(byte);
  if (byte === 0x2d) return '+';
  if (byte === 0x5f) return '/';
  return null;
}
function createEmbeddedBase64PhaseScanner({ checkArchives = true, initialCharacterSkip = 0 } = {}) {
  if (!Number.isInteger(initialCharacterSkip) || initialCharacterSkip < 0 || initialCharacterSkip > 3) throw new Error('private Phase 3C Base64 alignment is invalid');
  let characterSkip = initialCharacterSkip;
  let quartet = ''; let decoded = null; let pendingQuartets = ''; let batch = null; let used = 0; let length = 0; let whitespace = 0; let whitespaceOverbound = false; let active = true; let preserveDecodedPrefix = false; let terminal = false; let terminalTail = 0; let found = null;
  const flushDecodedBytes = () => {
    if (used === 0) return;
    decoded ??= createStructuralByteStreamScanner({ checkArchives, checkBase64: false });
    decoded.feed(batch.subarray(0, used));
    used = 0;
  };
  const addDecodedByte = value => {
    batch ??= Buffer.allocUnsafe(TRANSFER_DECODE_CHUNK_BYTES);
    batch[used++] = value;
    if (used === batch.length) flushDecodedBytes();
  };
  const decodeQuartet = value => {
    const sextet = character => {
      const code = character.charCodeAt(0);
      if (code >= 0x41 && code <= 0x5a) return code - 0x41;
      if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
      if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
      return character === '+' ? 62 : 63;
    };
    const first = sextet(value[0]); const second = sextet(value[1]);
    addDecodedByte((first << 2) | (second >> 4));
    if (value[2] === '=') return true;
    const third = sextet(value[2]);
    addDecodedByte(((second & 0x0f) << 4) | (third >> 2));
    if (value[3] === '=') return true;
    addDecodedByte(((third & 0x03) << 6) | sextet(value[3]));
    return true;
  };
  const feedDecoded = value => {
    pendingQuartets += value;
    if (length < 32) return true;
    for (let index = 0; index < pendingQuartets.length; index += 4) {
      if (!decodeQuartet(pendingQuartets.slice(index, index + 4))) return false;
    }
    pendingQuartets = '';
    return true;
  };
  const finishDecoded = () => {
    if (length >= 32 && pendingQuartets && !feedDecoded('')) return null;
    flushDecodedBytes();
    return decoded?.finish() ?? null;
  };
  const finishToken = () => {
    if (length < 32) return null;
    if (!active) return preserveDecodedPrefix ? finishDecoded() : null;
    if (terminal) return finishDecoded();
    // With one residual alphabet character, complete quanta remain a maximal
    // valid prefix. This covers an unpadded packet plus one trailing alphabet
    // character without decoding that unusable byte.
    if (quartet.length === 1) return finishDecoded();
    if ((quartet.length === 2 || quartet.length === 3) && !feedDecoded(quartet.padEnd(4, '='))) return null;
    return finishDecoded();
  };
  const reset = () => { characterSkip = initialCharacterSkip; quartet = ''; decoded = null; pendingQuartets = ''; batch = null; used = 0; length = 0; whitespace = 0; whitespaceOverbound = false; active = true; preserveDecodedPrefix = false; terminal = false; terminalTail = 0; };
  const flush = () => { found ??= finishToken(); reset(); };
  const receive = byte => {
    const alphabet = base64AlphabetValue(byte);
    if (alphabet !== null) {
      whitespace = 0;
      length += 1;
      if (whitespaceOverbound && length >= 32) { found ??= 'encoded transfer candidate exceeds bounded whitespace limit'; active = false; return; }
      if (characterSkip > 0) { characterSkip -= 1; return; }
      if (terminal) { terminalTail += 1; if (terminalTail > 1) { preserveDecodedPrefix = true; active = false; } return; }
      if (!active || quartet.includes('=')) { active = false; return; }
      quartet += alphabet;
      if (quartet.length === 4) { if (!feedDecoded(quartet)) active = false; quartet = ''; }
      return;
    }
    if (byte === 0x3d) {
      length += 1;
      if (!active || terminal || quartet.length < 2) { preserveDecodedPrefix = terminal; active = false; return; }
      quartet += '=';
      if (quartet.length < 4) return;
      if (!/^(?:[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/.test(quartet)) { active = false; return; }
      if (!feedDecoded(quartet)) { active = false; return; }
      quartet = ''; terminal = true; return;
    }
    if ((byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d || byte === 0x20) && length > 0 && active) {
      whitespace = Math.min(whitespace + 1, MAX_EMBEDDED_BASE64_WHITESPACE_BYTES + 1);
      if (whitespace <= MAX_EMBEDDED_BASE64_WHITESPACE_BYTES) return;
      whitespaceOverbound = true;
      if (length >= 32) found ??= 'encoded transfer candidate exceeds bounded whitespace limit';
      return;
    }
    flush();
  };
  return {
    feed(bytes) { for (const byte of Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) receive(byte); },
    finish() { flush(); return found; },
  };
}
function createEmbeddedBase64TokenScanner({ checkArchives = true } = {}) {
  // Whitespace-tolerant source tokens can begin with ordinary Base64-alphabet
  // prose (for example `x <encoded packet>`). Four fixed lanes cover every
  // quartet alignment; longer prefixes differ only by complete quartets.
  // Every lane retains the same bounded batch/state and never recursively
  // re-enters transfer decoding.
  const phases = [0, 1, 2, 3].map(initialCharacterSkip => createEmbeddedBase64PhaseScanner({ checkArchives, initialCharacterSkip }));
  return {
    feed(bytes) { for (const phase of phases) phase.feed(bytes); },
    finish() {
      let found = null;
      for (const phase of phases) found ??= phase.finish();
      return found;
    },
  };
}
function hexNibble(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}
function isHexTransferWhitespace(byte) { return byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d || byte === 0x20; }
function createHexTransferScanner({ checkArchives = true, wholeFile = false, initialNibbleSkip = 0 } = {}) {
  if (!Number.isInteger(initialNibbleSkip) || initialNibbleSkip < 0 || initialNibbleSkip > 1) throw new Error('private Phase 3C hexadecimal alignment is invalid');
  let nibbleSkip = initialNibbleSkip;
  let scanner = null; let high = -1; let length = 0; let effectiveLength = 0; let active = true; let found = null; let prefix = ''; let decoding = false; let batch = null; let used = 0;
  const addByte = value => {
    batch ??= Buffer.allocUnsafe(TRANSFER_DECODE_CHUNK_BYTES);
    batch[used++] = value;
    if (used === batch.length) feedBatch();
  };
  const feedBatch = () => {
    if (used === 0) return;
    scanner ??= createStructuralByteStreamScanner({ checkArchives, checkBase64: false });
    scanner.feed(batch.subarray(0, used)); used = 0;
  };
  const finishToken = () => {
    // An odd final nibble cannot form a byte, but it must not erase the
    // complete-byte prefix already passed to the bounded scanner.
    if (!active || !decoding) return null;
    feedBatch();
    return scanner?.finish() ?? null;
  };
  const reset = () => { nibbleSkip = initialNibbleSkip; scanner = null; high = -1; length = 0; effectiveLength = 0; active = true; prefix = ''; decoding = false; batch = null; used = 0; };
  const flush = () => { if (length === 0) return; found ??= finishToken(); reset(); };
  const receive = byte => {
    if (wholeFile && !active) return;
    const nibble = hexNibble(byte);
    if (nibble !== -1) {
      length += 1;
      if (nibbleSkip > 0) { nibbleSkip -= 1; return; }
      effectiveLength += 1;
      if (!decoding) {
        prefix += String.fromCharCode(byte);
        if (effectiveLength < 64) return;
        for (let index = 0; index < prefix.length; index += 2) addByte((hexNibble(prefix.charCodeAt(index)) << 4) | hexNibble(prefix.charCodeAt(index + 1)));
        prefix = ''; decoding = true;
        return;
      }
      if (high === -1) { high = nibble; return; }
      addByte((high << 4) | nibble); high = -1;
      return;
    }
    if (wholeFile && isHexTransferWhitespace(byte)) return;
    if (wholeFile) { active = false; return; }
    flush();
  };
  return {
    feed(bytes) { for (const byte of Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) receive(byte); },
    finish() { if (wholeFile) return finishToken(); flush(); return found; },
  };
}
function createEmbeddedWhitespaceHexPhaseScanner({ checkArchives = true, initialNibbleSkip = 0 } = {}) {
  if (!Number.isInteger(initialNibbleSkip) || initialNibbleSkip < 0 || initialNibbleSkip > 1) throw new Error('private Phase 3C hexadecimal alignment is invalid');
  let nibbleSkip = initialNibbleSkip;
  let scanner = null; let high = -1; let length = 0; let effectiveLength = 0; let whitespace = 0; let whitespaceOverbound = false; let prefix = ''; let batch = null; let used = 0; let found = null;
  const feedBatch = () => {
    if (used === 0) return;
    scanner ??= createStructuralByteStreamScanner({ checkArchives, checkBase64: false });
    scanner.feed(batch.subarray(0, used)); used = 0;
  };
  const addByte = value => {
    batch ??= Buffer.allocUnsafe(TRANSFER_DECODE_CHUNK_BYTES);
    batch[used++] = value;
    if (used === batch.length) feedBatch();
  };
  const finishToken = () => {
    if (effectiveLength < 64) return null;
    // As above, discard at most one incomplete nibble while retaining every
    // decoded complete byte. This scanner never recursively re-enters the
    // Base64/hex transfer lanes.
    feedBatch();
    return scanner?.finish() ?? null;
  };
  const reset = () => { nibbleSkip = initialNibbleSkip; scanner = null; high = -1; length = 0; effectiveLength = 0; whitespace = 0; whitespaceOverbound = false; prefix = ''; batch = null; used = 0; };
  const flush = () => { if (length > 0) found ??= finishToken(); reset(); };
  const receive = byte => {
    const nibble = hexNibble(byte);
    if (nibble !== -1) {
      whitespace = 0;
      length += 1;
      if (whitespaceOverbound && length >= 64) { found ??= 'encoded transfer candidate exceeds bounded whitespace limit'; return; }
      if (nibbleSkip > 0) { nibbleSkip -= 1; return; }
      effectiveLength += 1;
      if (effectiveLength <= 64) {
        prefix += String.fromCharCode(byte);
        if (effectiveLength === 64) {
          for (let index = 0; index < prefix.length; index += 2) addByte((hexNibble(prefix.charCodeAt(index)) << 4) | hexNibble(prefix.charCodeAt(index + 1)));
          prefix = '';
        }
        return;
      }
      if (high === -1) { high = nibble; return; }
      addByte((high << 4) | nibble); high = -1;
      return;
    }
    if (isHexTransferWhitespace(byte) && length > 0) {
      whitespace = Math.min(whitespace + 1, MAX_EMBEDDED_HEX_WHITESPACE_BYTES + 1);
      if (whitespace <= MAX_EMBEDDED_HEX_WHITESPACE_BYTES) return;
      whitespaceOverbound = true;
      if (length >= 64) found ??= 'encoded transfer candidate exceeds bounded whitespace limit';
      return;
    }
    flush();
  };
  return {
    feed(bytes) { for (const byte of Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) receive(byte); },
    finish() { flush(); return found; },
  };
}
function createEmbeddedWhitespaceHexTokenScanner({ checkArchives = true } = {}) {
  // Two fixed lanes cover both nibble phases without retaining an unbounded
  // token or recursively decoding the resulting bytes.
  const phases = [0, 1].map(initialNibbleSkip => createEmbeddedWhitespaceHexPhaseScanner({ checkArchives, initialNibbleSkip }));
  return {
    feed(bytes) { for (const phase of phases) phase.feed(bytes); },
    finish() {
      let found = null;
      for (const phase of phases) found ??= phase.finish();
      return found;
    },
  };
}
function createPemBase64Scanner({ checkArchives = true } = {}) {
  let line = ''; let overflow = false; let body = null; let found = null;
  const isBegin = value => /^-----BEGIN [A-Z0-9 _-]+-----[\t ]*$/.test(value);
  const isEnd = value => /^-----END [A-Z0-9 _-]+-----[\t ]*$/.test(value);
  const finishLine = () => {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (body === null) {
      if (!overflow && isBegin(normalizedLine)) body = createBase64TransferScanner({ checkArchives });
    } else if (!overflow && isEnd(normalizedLine)) {
      found ??= body.finish(); body = null;
    } else if (!overflow) body.feed(Buffer.from(`${normalizedLine}\n`, 'latin1'));
    line = ''; overflow = false;
  };
  return {
    feed(bytes) {
      for (const byte of Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) {
        if (byte === 0x0a) { finishLine(); continue; }
        if (overflow) { body?.feed(Buffer.from([byte])); continue; }
        if (line.length < 256) { line += String.fromCharCode(byte); continue; }
        overflow = true;
        if (body) body.feed(Buffer.from(line, 'latin1'));
        body?.feed(Buffer.from([byte]));
      }
    },
    finish() {
      if (line.length || overflow) finishLine();
      if (body !== null) { found ??= body.finish(); body = null; }
      return found;
    },
  };
}
function createAlternateEncodingScanner({ checkArchives = true } = {}) {
  // Keep this scanner live from byte zero so MIME-style line wrapping can
  // cross the 32-character activation threshold. Before that threshold it
  // retains at most eight quartets and performs no decoded-byte allocation.
  const embeddedBase64 = createEmbeddedBase64TokenScanner({ checkArchives });
  const pemBase64 = createPemBase64Scanner({ checkArchives });
  const wholeHex = [0, 1].map(initialNibbleSkip => createHexTransferScanner({ checkArchives, wholeFile: true, initialNibbleSkip }));
  const embeddedHex = createEmbeddedWhitespaceHexTokenScanner({ checkArchives });
  return {
    feed(bytes) {
      const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      embeddedBase64.feed(source);
      pemBase64.feed(source);
      for (const phase of wholeHex) phase.feed(source);
      embeddedHex.feed(source);
    },
    finish() {
      let wholeHexReason = null;
      for (const phase of wholeHex) wholeHexReason ??= phase.finish();
      return pemBase64.finish() ?? embeddedBase64.finish() ?? wholeHexReason ?? embeddedHex.finish() ?? null;
    },
  };
}
function createStructuralByteStreamScanner({ checkArchives = true, checkBase64 = true } = {}) {
  const utf8Decoder = new StringDecoder('utf8');
  const utf8Scanner = createStructuralTextStreamScanner();
  const utf32Scanner = createUtf32StructuralStreamScanner();
  let utf16Decoders = null;
  let utf16Scanners = null;
  let rawTail = Buffer.alloc(0);
  const base64 = checkBase64 ? createBase64TransferScanner({ checkArchives }) : null;
  const wrappedBase64 = checkBase64 ? createAlternateEncodingScanner({ checkArchives }) : null;
  const archiveScanner = checkArchives ? createArchiveStreamScanner() : null;
  const shouldActivateUtf16 = bytes => {
    const hasNull = bytes.indexOf(0) !== -1;
    if (!hasNull) {
      if (bytes.indexOf(UTF16_LE_BOM) !== -1 || bytes.indexOf(UTF16_BE_BOM) !== -1) return true;
      return false;
    }
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
      base64?.feed(bytes);
      wrappedBase64?.feed(bytes);
      archiveScanner?.feed(bytes);
      utf8Scanner.feed(utf8Decoder.write(bytes));
      utf32Scanner.feed(bytes);
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
      return archiveScanner?.finish() ?? reason ?? utf32Scanner.finish() ?? base64?.finish() ?? wrappedBase64?.finish() ?? null;
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
  budget.admit(entry.size, repoPath);
  const fd = openSync(file, 'r');
  try {
    assertStableWorktreeCandidate(root, repoPath, file, entry, fd, cache);
    const readPass = scanner => {
      const chunk = Buffer.alloc(WORKTREE_SCAN_CHUNK_BYTES);
      const digest = createHash('sha256');
      let offset = 0;
      while (offset < entry.size) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, entry.size - offset), offset);
        if (read <= 0) throw new Error('private Phase 3C worktree candidate changed during scan');
        const bytes = chunk.subarray(0, read);
        digest.update(bytes);
        scanner?.feed(bytes);
        offset += read;
      }
      return {
        digest: digest.digest('hex'),
        reason: scanner?.finish() ?? null,
      };
    };
    const first = readPass(createStructuralByteStreamScanner({ checkArchives }));
    afterFirstPass?.({ file, fd });
    assertStableWorktreeCandidate(root, repoPath, file, entry, fd, cache);
    // The second pass proves byte identity without repeating every structural
    // decoder. SHA-256 equality plus the descriptor/path stat checks below
    // preserves the same race-closure guarantee as comparing two reasons.
    const second = readPass(null);
    assertStableWorktreeCandidate(root, repoPath, file, entry, fd, cache);
    if (first.digest !== second.digest) throw new Error('private Phase 3C worktree candidate changed during scan');
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

async function scanGitObjectEntries(entries, root, budget) {
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
      const match = /^([0-9a-f]{40,64}) (blob|commit) ([0-9]+)$/i.exec(header);
      if (!match) throw new Error('private Phase 3C containment received an invalid Git blob header');
      if (match[1].toLowerCase() !== entry.spec.toLowerCase()) throw new Error('private Phase 3C containment received a mismatched Git blob header');
      if (match[2] !== (entry.type ?? 'blob')) throw new Error('private Phase 3C containment received an unexpected Git object type');
      const size = Number(match[3]);
      budget.admit(size, entry.repoPath);
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
  for (const record of gitNulRecords(['ls-files', '--stage', '-z'], root, execute, 'Git index entry')) {
    const separator = record.indexOf(0x09);
    const header = separator === -1 ? '' : decodeGitAsciiRecord(record.subarray(0, separator), 'Git index header');
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])$/.exec(header);
    if (!match) throw new Error('private Phase 3C containment could not parse Git index entry');
    const repoPath = separator === -1 ? '' : decodeGitPathRecord(record.subarray(separator + 1), 'Git index path');
    if (match[3] !== '0') throw new Error('private Phase 3C containment rejected unmerged Git index entry');
    entries.push({ repoPath, mode: match[1], spec: match[2], key: `index:${repoPath}` });
  }
  return entries;
}

async function currentIndexCandidateViolations(root, execute, budget) {
  const violations = [];
  const regular = [];
  const entries = currentIndexEntries(root, execute);
  const bareRoots = bareRepositoryRoots(entries.map(entry => entry.repoPath));
  const bareRootList = [...bareRoots];
  for (const bareRoot of bareRoots) {
    violations.push({ repoPath: bareRoot, reason: 'bare Git repository' });
  }
  for (const entry of entries) {
    const directReason = forbiddenArtifactReason(entry.repoPath);
    if (directReason) { violations.push({ repoPath: entry.repoPath, reason: directReason }); continue; }
    if (bareRootList.some(bareRoot => isBareRepositoryMember(entry.repoPath, bareRoot))) continue;
    if (!REGULAR_GIT_MODES.has(entry.mode)) { violations.push({ repoPath: entry.repoPath, reason: 'non-regular Git mode' }); continue; }
    regular.push(entry);
  }
  const reasons = await scanGitObjectEntries(regular, root, budget);
  for (const entry of regular) {
    const reason = reasons.get(entry.key);
    const acceptedReason = acceptedStructuralReason(entry.repoPath, reason);
    if (acceptedReason) violations.push({ repoPath: entry.repoPath, reason: acceptedReason });
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

// Windows path comparison is case-insensitive on disk, so a containment
// decision must not hinge on the casing Git happened to print.
function containmentPathKey(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function isContainedDirectory(child, parent) { return containmentPathKey(child).startsWith(`${containmentPathKey(parent)}${path.sep}`); }

/**
 * A linked worktree of THIS repository carries a `.git` pointer FILE, while a
 * foreign embedded repository carries a `.git` DIRECTORY. Read the pointer
 * without following it and require it to land inside this repository's own
 * worktree registry. Anything else — a directory, a symlink, extra lines, or a
 * pointer aimed at another repository's administration directory — fails here
 * and is classified as an embedded repository by the caller.
 *
 * Landing inside the registry is necessary but not sufficient: a pointer file
 * is ordinary text, so a foreign directory can simply copy a legitimate
 * worktree's pointer and inherit its exemption. Git records the reverse link —
 * each administration entry names the `.git` file it was issued for — so the
 * pointer is required to point back at THIS candidate.
 *
 * That comparison is made on filesystem identity, not on path text. Node's
 * `realpathSync` hands back the casing it was given on Windows, so one
 * directory reached through two spellings would read as two different places,
 * while in a directory with per-directory case sensitivity enabled `session`
 * and `SESSION` really are two directories and must not be conflated. What is
 * compared is the DIRECTORY the backlink names rather than the pointer file
 * itself, so copying the pointer — or hard-linking it, which would preserve the
 * file's identity — still fails, NTFS having no way to hard-link a directory.
 */
export function ownWorktreeMarker(absolute, worktreesDirectory) {
  const marker = path.join(absolute, '.git');
  let entry;
  try { entry = lstatSync(marker); } catch (error) { if (error?.code !== 'ENOENT') throw error; return false; }
  if (!entry.isFile()) return false;
  let contents;
  try { contents = readFileSync(marker, 'utf8'); } catch { return false; }
  const lines = contents.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith('gitdir: ')) return false;
  const gitdir = path.resolve(absolute, lines[0].slice('gitdir: '.length).trim());
  if (!isContainedDirectory(gitdir, worktreesDirectory)) return false;
  try { if (!lstatSync(gitdir).isDirectory()) return false; } catch { return false; }
  let backlink;
  try { backlink = readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim(); } catch { return false; }
  if (!backlink) return false;
  // A worktree Git can no longer resolve fails closed here rather than being
  // waved through as this checkout seen twice.
  return sameDirectory(path.dirname(path.resolve(gitdir, backlink)), absolute);
}

/** Whether two paths name the same directory on disk, compared by filesystem identity. */
function sameDirectory(left, right) {
  try {
    const first = statSync(left, { bigint: true });
    const second = statSync(right, { bigint: true });
    return first.isDirectory() && second.isDirectory() && first.dev === second.dev && first.ino === second.ino && first.ino !== 0n;
  } catch { return false; }
}

/**
 * Repo-relative directories that Git itself reports as additional worktrees of
 * this repository AND that carry a verified own-worktree pointer file.
 *
 * `.claude/worktrees/` is ignored by this checkout, so a parallel session's
 * worktree arrives as an ignored directory candidate. Without this exemption
 * every such worktree reads as a foreign repository smuggled inside the repo
 * and blocks every push. Nothing is weakened by skipping them: an ignored path
 * cannot be committed from here, and that worktree runs this same guard on its
 * own push. Both signals are required, and any failure to obtain Git's own
 * answer exempts nothing.
 *
 * Returns the registry alongside this repository's worktree administration
 * directory, because the caller must re-verify the pointer on the candidate
 * directory it is actually about to exempt.
 */
function registeredWorktreeDirectories(root, execute) {
  const registered = new Set();
  const containerDirectories = new Set();
  const lexicalRoot = path.resolve(root);
  let records;
  let commonDirectory;
  try {
    records = gitLines(['worktree', 'list', '--porcelain'], root, execute);
    const [commonDirLine] = gitLines(['rev-parse', '--git-common-dir'], root, execute);
    if (!commonDirLine) return { paths: registered, worktreesDirectory: null, containerDirectories };
    commonDirectory = path.resolve(lexicalRoot, commonDirLine);
  } catch { return { paths: registered, worktreesDirectory: null, containerDirectories }; }
  const worktreesDirectory = path.join(commonDirectory, 'worktrees');
  for (const record of records) {
    if (!record.startsWith('worktree ')) continue;
    const absolute = path.resolve(lexicalRoot, record.slice('worktree '.length).trim());
    if (!isContainedDirectory(absolute, lexicalRoot)) continue;
    if (!ownWorktreeMarker(absolute, worktreesDirectory)) continue;
    const relative = path.relative(lexicalRoot, absolute).split(path.sep).join('/');
    // Normalized like every other containment comparison: membership must not
    // hinge on the casing `git worktree list --porcelain` happened to print.
    registered.add(containmentPathKey(relative));
    // A verified worktree's parent directory is where sibling worktrees of the
    // same checkout live, alive or stale: Git already collapses this worktree
    // itself to one line, but a directory Git no longer registers (removed by
    // hand instead of `git worktree remove`) does not collapse and its own
    // dependency tree is enumerated in full below. The parent is recorded here,
    // from the un-normalized path, so the ignored-file scan can name it in a
    // real Git pathspec. A worktree registered directly at the repository root
    // has no such parent to name without naming the repository itself, so it
    // contributes nothing here.
    const parent = path.posix.dirname(relative);
    if (parent && parent !== '.') containerDirectories.add(parent);
  }
  return { paths: registered, worktreesDirectory, containerDirectories };
}

/**
 * Builds Git pathspec excludes that keep the ignored-file scan below out of
 * a worktree container's dependency/build bulk without hiding real content.
 * Scope is deliberately narrow: only the exact top-level names this file
 * already treats as tool-owned (see TOOL_OWNED_IGNORED_PREFIXES), only when
 * nested under a verified worktree's own parent directory, matched with `**`
 * so it also catches the same bulk sitting in a stale sibling directory Git
 * no longer registers. Everything else under a worktree container — source
 * files, session state, anything not named after a known tool-owned root —
 * remains fully enumerated and scanned. An empty `containerDirectories` (no
 * registered worktrees, or `git worktree list` unavailable) yields no
 * excludes at all, leaving the scan identical to before this exemption
 * existed.
 */
function worktreeContainerToolOwnedExcludePathspecs(containerDirectories) {
  const names = [...TOOL_OWNED_IGNORED_PREFIXES].map(prefix => prefix.replace(/\/$/, ''));
  const pathspecs = [];
  for (const container of [...containerDirectories].sort()) {
    // `container` is a filesystem-derived path segment, not a literal we wrote
    // ourselves — a worktree parent directory could in principle contain glob
    // metacharacters (`*`, `?`, `[`, `\`). Escaping them keeps this a literal
    // path match instead of an accidental glob that could exclude paths
    // outside the intended worktree container.
    const escapedContainer = container.replace(/[\\*?[\]]/g, '\\$&');
    for (const name of names) pathspecs.push(`:(exclude,glob)${escapedContainer}/**/${name}/**`);
  }
  return pathspecs;
}

function worktreeEntryKind(root, repoPath, ownWorktrees = { paths: new Set(), worktreesDirectory: null }) {
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
        // This checkout seen twice, not a foreign repository inside it. Both
        // signals are re-verified against THIS directory: Git lists it as a
        // worktree of this repository, and the directory itself carries a
        // pointer file into this repository's worktree registry. A registry key
        // match alone is not enough — on a Windows directory with per-directory
        // case sensitivity enabled, `session` and `SESSION` are two different
        // directories that fold to one key, and a foreign repository parked at
        // the colliding name would otherwise inherit the exemption.
        if (ownWorktrees.paths.has(containmentPathKey(segments.slice(0, index + 1).join('/')))
          && ownWorktrees.worktreesDirectory
          && ownWorktreeMarker(current, ownWorktrees.worktreesDirectory)) return 'own-worktree';
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

function worktreeContentViolations(root, execute, budget, { includeIgnored = true, ownWorktrees: providedOwnWorktrees, retryingTransientIgnoredEntries = false } = {}) {
  const ownWorktrees = providedOwnWorktrees ?? registeredWorktreeDirectories(root, execute);
  const modified = new Set(gitPaths(['diff', '--name-only', '-z', '--diff-filter=ACMRT'], root, execute));
  const untracked = new Set(gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, execute));
  const ignoreExcludes = worktreeContainerToolOwnedExcludePathspecs(ownWorktrees.containerDirectories);
  const ignored = includeIgnored
    ? new Set(gitPaths(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...(ignoreExcludes.length ? ['--', ...ignoreExcludes] : [])], root, execute))
    : new Set();
  const violations = [];
  const candidates = new Map();
  for (const repoPath of modified) candidates.set(repoPath, 'modified');
  for (const repoPath of untracked) candidates.set(repoPath, 'untracked');
  for (const repoPath of ignored) if (!candidates.has(repoPath)) candidates.set(repoPath, 'ignored');
  const started = performance.now();
  const cache = { roots: new Map(), parents: new Map() };
  const bareRoots = bareRepositoryRoots([...candidates.keys()]);
  const bareRootList = [...bareRoots];
  let sawTransientIgnoredEntry = false;
  for (const bareRoot of bareRoots) violations.push({ repoPath: bareRoot, reason: 'bare Git repository' });
  for (const [repoPath, source] of candidates) {
    // Path-level violations must win before a candidate is dereferenced or
    // classified by source, including tracked, modified, and untracked paths.
    const directReason = forbiddenArtifactReason(repoPath);
    if (directReason) { violations.push({ repoPath, reason: directReason }); continue; }
    if (bareRootList.some(bareRoot => isBareRepositoryMember(repoPath, bareRoot))) continue;
    // `git ls-files --ignored` includes ordinary tool-owned links such as
    // node_modules/.bin. Never follow those entries: an unrelated ignored
    // reparse point cannot make a private packet Git-visible. A Phase 3C
    // filename/path remains a failure before this skip, so a packet symlink
    // or junction still fails closed without dereferencing its target.
    // Git collapses both ignored and untracked embedded repositories to one
    // directory candidate. Detect their `.git` marker without walking nested
    // content; a benign ignored symlink remains non-regular and is skipped.
    if (source === 'ignored' || source === 'untracked') {
      let entryKind;
      try {
        entryKind = worktreeEntryKind(root, repoPath, ownWorktrees);
      } catch (error) {
        if (!retryingTransientIgnoredEntries && isTransientToolOwnedIgnoredEntryError(source, root, repoPath, error)) {
          sawTransientIgnoredEntry = true;
          continue;
        }
        throw error;
      }
      if (entryKind === 'embedded-repository') { violations.push({ repoPath, reason: 'embedded Git repository' }); continue; }
      if (entryKind === 'bare-repository') { violations.push({ repoPath, reason: 'bare Git repository' }); continue; }
      // A verified linked worktree of this repository is skipped rather than
      // walked: its contents belong to that checkout's own push.
      if (entryKind === 'own-worktree') continue;
      if (entryKind !== 'regular') continue;
    }
    // Tool-owned dependency/build roots contain harmless third-party archives.
    // Other ignored paths remain operator-controlled packet candidates, so an
    // ignored archive at the repository root or in an ordinary folder fails
    // closed just like tracked and untracked archives.
    // These exact top-level roots are generated locally and ignored by Git.
    // Skipping them at the ignored-source boundary prevents backups and tool
    // caches from blocking every push. If a file is force-added, its source is
    // staged/tracked instead and it receives the full structural/archive scan.
    if (source === 'ignored' && isOperatorOwnedIgnoredPath(repoPath)) continue;
    const checkArchives = source !== 'ignored' || !isToolOwnedIgnoredPath(repoPath);
    let result;
    try {
      result = scanWorktreeCandidate(root, repoPath, { cache, budget, checkArchives });
    } catch (error) {
      if (!retryingTransientIgnoredEntries && isTransientToolOwnedIgnoredEntryError(source, root, repoPath, error)) {
        sawTransientIgnoredEntry = true;
        continue;
      }
      throw error;
    }
    const acceptedReason = acceptedStructuralReason(repoPath, result?.reason);
    if (acceptedReason) violations.push({ repoPath, reason: acceptedReason });
  }
  if (sawTransientIgnoredEntry) {
    // A disappeared generated entry is tolerated once so an ordinary rebuild
    // cannot make every push fail. Re-list and re-scan the worktree before
    // success: a file recreated during the first pass must be inspected, and
    // a second disappearance fails closed rather than hiding it.
    const recovery = worktreeContentViolations(root, execute, budget, {
      includeIgnored,
      ownWorktrees,
      retryingTransientIgnoredEntries: true,
    });
    return { ...recovery, durationMs: Math.round(performance.now() - started) };
  }
  return { violations, candidateCount: candidates.size, ignoredCount: ignored.size, durationMs: Math.round(performance.now() - started) };
}

function commitsForRange(range, root, execute) {
  const [base, head, ...extra] = String(range).split('..');
  if (extra.length || !base || !head) throw new Error('private Phase 3C history containment requires an explicit base..head range');
  return gitLines(['rev-list', '--reverse', `--max-count=${MAX_HISTORY_COMMITS + 1}`, `${assertCommitSha(base, 'base')}..${assertCommitSha(head, 'head')}`], root, execute);
}
function changedEntriesForCommit(commit, root, execute) {
  // -m compares a merge result with every parent, so a conflict-resolution
  // blob that exists only in the merge commit cannot disappear from history
  // containment. Raw output already includes the destination mode and object,
  // avoiding one ls-tree process per path during a new branch's ancestry scan.
  // Rename detection is disabled so every record is one header/path pair.
  const records = gitNulRecords(['diff-tree', '--root', '-m', '-r', '--no-commit-id', '--diff-filter=AMT', '--no-renames', '--raw', '-z', commit], root, execute, 'raw history');
  if (records.length % 2 !== 0) throw new Error('private Phase 3C containment received malformed raw history entries');
  const entries = new Map();
  for (let index = 0; index < records.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40,64} ([0-9a-f]{40,64}) ([AMT])$/.exec(decodeGitAsciiRecord(records[index], 'raw history header'));
    const repoPath = decodeGitPathRecord(records[index + 1], 'raw history path');
    if (!match || !repoPath) throw new Error('private Phase 3C containment could not parse raw history entry');
    entries.set(Buffer.from(repoPath, 'utf8').toString('hex'), { repoPath, mode: match[2], type: match[2] === '160000' ? 'commit' : 'blob', object: match[3] });
  }
  return [...entries.values()];
}
function commitTreeEntries(commit, root, execute) {
  const entries = [];
  for (const record of gitNulRecords(['ls-tree', '-r', '-z', assertCommitSha(commit, 'candidate')], root, execute, 'candidate commit tree entry')) {
    const separator = record.indexOf(0x09);
    const header = separator === -1 ? '' : decodeGitAsciiRecord(record.subarray(0, separator), 'candidate commit tree header');
    const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/.exec(header);
    const repoPath = separator === -1 ? '' : decodeGitPathRecord(record.subarray(separator + 1), 'candidate commit tree path');
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
  const bareRoots = bareRepositoryRoots(entries.map(entry => entry.repoPath));
  const bareRootList = [...bareRoots];
  for (const bareRoot of bareRoots) {
    violations.push({ repoPath: `${commit}:${bareRoot}`, reason: 'bare Git repository' });
  }
  for (const entry of entries) {
    if (bareRootList.some(bareRoot => isBareRepositoryMember(entry.repoPath, bareRoot))) continue;
    const directReason = forbiddenArtifactReason(entry.repoPath);
    if (directReason) violations.push({ repoPath: `${commit}:${entry.repoPath}`, reason: directReason });
    if (!REGULAR_GIT_MODES.has(entry.mode) || entry.type !== 'blob') { violations.push({ repoPath: `${commit}:${entry.repoPath}`, reason: 'non-regular Git mode' }); continue; }
    regular.push({ repoPath: `${commit}:${entry.repoPath}`, exemptionPath: entry.repoPath, spec: entry.object, key: `candidate:${commit}:${entry.repoPath}` });
  }
  const reasons = await scanGitObjectEntries(regular, root, budget);
  for (const entry of regular) {
    const reason = reasons.get(entry.key);
    const acceptedReason = acceptedStructuralReason(entry.exemptionPath, reason);
    if (acceptedReason) violations.push({ repoPath: entry.repoPath, reason: acceptedReason });
  }
  return { violations, entryCount: entries.length };
}
async function historyViolations(commits, root, execute, budget, historyBudget) {
  const violations = [];
  const entries = [];
  const commitEntries = commits.map(commit => ({ repoPath: `${commit}:commit-object`, spec: assertCommitSha(commit, 'history'), key: `history-commit:${commit}`, type: 'commit' }));
  const commitReasons = await scanGitObjectEntries(commitEntries, root, budget);
  for (const entry of commitEntries) {
    const reason = commitReasons.get(entry.key);
    if (reason) violations.push({ repoPath: entry.repoPath, reason });
  }
  for (const commit of commits) {
    const changedEntries = changedEntriesForCommit(assertCommitSha(commit, 'history'), root, execute);
    historyBudget.admit(changedEntries.length);
    for (const tree of changedEntries) {
      const { repoPath } = tree;
      const directReason = forbiddenArtifactReason(repoPath);
      if (directReason) violations.push({ repoPath: `${commit}:${repoPath}`, reason: directReason });
      const bareRoot = commitContainsBareRepository(commit, repoPath, root, execute);
      if (bareRoot) violations.push({ repoPath: `${commit}:${bareRoot}`, reason: 'bare Git repository' });
      if (!REGULAR_GIT_MODES.has(tree.mode) || tree.type !== 'blob') { violations.push({ repoPath: `${commit}:${repoPath}`, reason: 'non-regular Git mode' }); continue; }
      entries.push({ repoPath: `${commit}:${repoPath}`, exemptionPath: repoPath, spec: tree.object, key: `history:${commit}:${repoPath}` });
    }
  }
  const reasons = await scanGitObjectEntries(entries, root, budget);
  for (const entry of entries) {
    const reason = reasons.get(entry.key);
    const acceptedReason = acceptedStructuralReason(entry.exemptionPath, reason, entry.repoPath);
    if (acceptedReason) violations.push({ repoPath: entry.repoPath, reason: acceptedReason });
  }
  return violations;
}

function executeWithAuthoritativeIndex(execute, root, indexFile) {
  if (indexFile === null) return execute;
  if (typeof indexFile !== 'string' || indexFile.length === 0 || indexFile.includes('\0')) throw new Error('private Phase 3C containment received an invalid GIT_INDEX_FILE');
  const authoritativeIndex = path.resolve(root, indexFile);
  return (command, args, options = {}) => execute(command, args, {
    ...options,
    env: { ...options.env, GIT_INDEX_FILE: authoritativeIndex },
  });
}

export async function checkPrivateArtifactContainment({ root = REPO_ROOT, execute = execFileSync, ranges = [], commits = [], includeIgnored = true, indexFile = null, testLimits = {}, budget = new ScanBudget() } = {}) {
  const authoritativeExecute = executeWithAuthoritativeIndex(execute, root, indexFile);
  const ownWorktrees = registeredWorktreeDirectories(root, authoritativeExecute);
  const ignoreExcludes = worktreeContainerToolOwnedExcludePathspecs(ownWorktrees.containerDirectories);
  const ignoredVisible = includeIgnored
    ? gitPaths(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', ...(ignoreExcludes.length ? ['--', ...ignoreExcludes] : [])], root, authoritativeExecute)
    : [];
  const visible = new Set(uniqueValidatedGitPaths([
    ...gitPaths(['ls-files', '-z'], root, authoritativeExecute),
    ...gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], root, authoritativeExecute),
    ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, authoritativeExecute),
    ...ignoredVisible,
  ]));
  if (visible.size > MAX_STRUCTURAL_SCAN_CANDIDATES) throw new Error('private Phase 3C containment candidate-count cap exceeded');
  const rangeCommits = ranges.flatMap(range => commitsForRange(range, root, authoritativeExecute));
  const checkedCommits = [...new Set([...commits.map(commit => assertCommitSha(commit, 'history')), ...rangeCommits])];
  if (checkedCommits.length > reducedContainmentLimit(testLimits.maxCheckedCommits, MAX_HISTORY_COMMITS)) throw new Error('private Phase 3C containment checked-commit cap exceeded');
  const index = await currentIndexCandidateViolations(root, authoritativeExecute, budget);
  const worktree = worktreeContentViolations(root, authoritativeExecute, budget, { includeIgnored, ownWorktrees });
  const historyBudget = new HistoryTraversalBudget(reducedContainmentLimit(testLimits.maxHistoryPaths, MAX_STRUCTURAL_SCAN_CANDIDATES - budget.candidates));
  const violations = [
    ...findForbiddenPrivateArtifactPaths([...visible]),
    ...index.violations,
    ...stagedIndexContentViolations(root, authoritativeExecute, index.entries),
    ...worktree.violations,
    ...await historyViolations(checkedCommits, root, authoritativeExecute, budget, historyBudget),
  ];
  if (violations.length) {
    const summary = [...new Map(violations.map(item => [`${item.repoPath}\0${item.reason}`, item])).values()];
    throw new Error(`private Phase 3C artifact containment failure: ${summary.map(item => `${item.repoPath} (${item.reason})`).join(', ')}`);
  }
  return { checked_path_count: visible.size, checked_commit_count: checkedCommits.length, checked_ignored_count: worktree.ignoredCount, worktree_scan_duration_ms: worktree.durationMs, scanned_candidate_count: budget.candidates, scanned_logical_bytes: budget.logicalBytes };
}

function outgoingCommitsForNewRemoteRef(localSha, root, execute) {
  return gitLines(['rev-list', '--reverse', `--max-count=${MAX_HISTORY_COMMITS + 1}`, assertCommitSha(localSha, 'local')], root, execute);
}
function peeledCommitSha(objectSha, root, execute) {
  try {
    return assertCommitSha(String(gitOutput(['rev-parse', '--verify', `${assertCommitSha(objectSha, 'local')}^{commit}`], root, execute)).trim(), 'local');
  } catch (_error) {
    return null;
  }
}
async function inspectOutgoingRefObject({ localRef, localSha, root, execute, budget }) {
  const queue = [{ sha: assertCommitSha(localSha, 'local'), depth: 0 }];
  const seen = new Set();
  const violations = [];
  let commit = null;
  while (queue.length) {
    const { sha, depth } = queue.shift();
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (depth > 16) throw new Error('private Phase 3C pre-push containment tag-depth cap exceeded');
    const type = String(gitOutput(['cat-file', '-t', sha], root, execute)).trim();
    if (type === 'commit') {
      commit ??= sha;
      const key = `outgoing-commit:${localRef}:${sha}`;
      const reasons = await scanGitObjectEntries([{ repoPath: localRef, spec: sha, key, type: 'commit' }], root, budget);
      const reason = reasons.get(key);
      if (reason) violations.push({ repoPath: localRef, reason });
      continue;
    }
    if (type === 'tag') {
      const bytes = gitOutput(['cat-file', 'tag', sha], root, execute, { encoding: null });
      budget.admit(bytes.length, localRef);
      const reason = structuralPrivateArtifactReason(bytes);
      if (reason) violations.push({ repoPath: localRef, reason });
      const headerEnd = bytes.indexOf(Buffer.from('\n\n'));
      const headers = bytes.subarray(0, headerEnd === -1 ? bytes.length : headerEnd).toString('ascii');
      const target = /^object ((?:[0-9a-f]{40}|[0-9a-f]{64}))$/m.exec(headers)?.[1];
      if (!target) throw new Error('private Phase 3C pre-push containment received a malformed tag object');
      queue.push({ sha: target, depth: depth + 1 });
      continue;
    }
    if (type === 'blob') {
      const key = `outgoing-ref:${localRef}:${sha}`;
      const reasons = await scanGitObjectEntries([{ repoPath: localRef, spec: sha, key }], root, budget);
      const reason = reasons.get(key);
      if (reason) violations.push({ repoPath: localRef, reason });
      continue;
    }
    if (type === 'tree') {
      const candidate = await candidateCommitTreeViolations(sha, root, execute, budget);
      violations.push(...candidate.violations.map(item => ({ ...item, repoPath: `${localRef}:${item.repoPath.slice(item.repoPath.indexOf(':') + 1)}` })));
      continue;
    }
    throw new Error('private Phase 3C pre-push containment received an unsupported Git object');
  }
  return { violations, commit };
}
export async function checkPrePushPrivateArtifactContainment({ root = REPO_ROOT, execute = execFileSync, remoteName, stdin } = {}) {
  if (typeof remoteName !== 'string' || remoteName.length === 0) throw new Error('private Phase 3C pre-push containment requires a remote name or URL');
  const updates = String(stdin ?? '').split(/\r?\n/).filter(Boolean);
  if (updates.length > MAX_STRUCTURAL_SCAN_CANDIDATES) throw new Error('private Phase 3C containment candidate-count cap exceeded');
  const ranges = [];
  const commits = [];
  const outgoingBudget = new ScanBudget();
  const objectViolations = [];
  for (const update of updates) {
    const fields = update.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error('private Phase 3C pre-push containment received malformed ref update');
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if (!localRef.startsWith('refs/') || !remoteRef.startsWith('refs/')) throw new Error('private Phase 3C pre-push containment received malformed ref update');
    if (isZeroSha(localSha)) continue; // deletion exports no new blob
    assertCommitSha(localSha, 'local');
    const inspected = await inspectOutgoingRefObject({ localRef, localSha, root, execute, budget: outgoingBudget });
    objectViolations.push(...inspected.violations);
    if (inspected.commit === null) continue;
    if (isZeroSha(remoteSha)) commits.push(...outgoingCommitsForNewRemoteRef(inspected.commit, root, execute));
    else {
      const remoteCommit = peeledCommitSha(assertCommitSha(remoteSha, 'remote'), root, execute);
      if (remoteCommit === null) commits.push(...outgoingCommitsForNewRemoteRef(inspected.commit, root, execute));
      else ranges.push(`${remoteCommit}..${inspected.commit}`);
    }
  }
  if (objectViolations.length) {
    const summary = [...new Map(objectViolations.map(item => [`${item.repoPath}\0${item.reason}`, item])).values()];
    throw new Error(`private Phase 3C artifact containment failure: ${summary.map(item => `${item.repoPath} (${item.reason})`).join(', ')}`);
  }
  return checkPrivateArtifactContainment({ root, execute, ranges, commits, budget: outgoingBudget });
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
    const trustedWorkflow = assertCommitSha(environment.GITHUB_SHA, 'trusted workflow');
    // pull_request_target deliberately runs the checker from the current
    // trusted default-branch commit. The event base may be older when an open
    // PR is synchronized after this workflow is introduced.
    // It never materializes candidate files: the exact candidate tree and
    // history are scanned through Git objects only.
    for (const sha of [base, head]) if (!eventCommitIsAvailable(sha, root, execute)) throw new Error('private Phase 3C CI containment event commit is unavailable');
    const trustedBaseRoot = canonicalContainmentRoot(root, trustedWorkflow, execute);
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
    for (const sha of [base, head]) if (!isZeroSha(sha) && !eventCommitIsAvailable(sha, root, execute)) throw new Error('private Phase 3C CI containment event commit is unavailable');
    const candidateRoot = canonicalContainmentRoot(root, head, execute);
    // GitHub uses all zeroes when a ref is created. There is no valid
    // ZERO_SHA..head range, so enumerate the bounded candidate ancestry
    // directly and let the ordinary checked-commit cap fail closed.
    const options = isZeroSha(base)
      ? { commits: commitsForNewPush(head, candidateRoot, execute) }
      : { ranges: [`${base}..${head}`] };
    return { ...await checkPrivateArtifactContainment({ root: candidateRoot, execute, ...options }), github_event_head: head };
  }
  throw new Error(`private Phase 3C CI containment does not support GitHub event ${String(name)}`);
}

export function parseCli(args) {
  const result = { ranges: [], prePushRemote: null, preCommit: false, commitMessageFile: null, githubEvent: false, root: null, attestGitHubHandoff: false };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--range') { if (result.ranges.length) throw new Error('disclosure-safe usage: duplicate --range'); const value = args[++index]; if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('disclosure-safe usage: --range requires base..head'); result.ranges.push(value); continue; }
    if (token === '--pre-push') { if (result.prePushRemote !== null) throw new Error('disclosure-safe usage: duplicate --pre-push'); const value = args[++index]; if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('disclosure-safe usage: --pre-push requires remote name'); result.prePushRemote = value; continue; }
    if (token === '--pre-commit') { if (result.preCommit) throw new Error('disclosure-safe usage: duplicate --pre-commit'); result.preCommit = true; continue; }
    if (token === '--commit-msg') { if (result.commitMessageFile !== null) throw new Error('disclosure-safe usage: duplicate --commit-msg'); const value = args[++index]; if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('disclosure-safe usage: --commit-msg requires a message file'); result.commitMessageFile = value; continue; }
    if (token === '--github-event') { if (result.githubEvent) throw new Error('disclosure-safe usage: duplicate --github-event'); result.githubEvent = true; continue; }
    if (token === GITHUB_EVENT_HANDOFF_FLAG) { if (result.attestGitHubHandoff) throw new Error('disclosure-safe usage: duplicate GitHub handoff attestation'); result.attestGitHubHandoff = true; continue; }
    if (token === '--root') { if (result.root !== null) throw new Error('disclosure-safe usage: duplicate --root'); const value = args[++index]; if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('disclosure-safe usage: --root requires an absolute path'); result.root = value; continue; }
    throw new Error('disclosure-safe usage: unknown containment option');
  }
  if ((result.prePushRemote !== null ? 1 : 0) + Number(result.preCommit) + (result.commitMessageFile !== null ? 1 : 0) + Number(result.githubEvent) > 1) throw new Error('disclosure-safe usage: pre-commit, commit-message, pre-push, and GitHub-event modes are exclusive');
  if (result.ranges.length && (result.prePushRemote !== null || result.preCommit || result.commitMessageFile !== null || result.githubEvent)) throw new Error('disclosure-safe usage: --range is only valid in direct containment mode');
  if (result.root !== null && !result.githubEvent) throw new Error('disclosure-safe usage: --root requires --github-event');
  if (result.attestGitHubHandoff && (!result.githubEvent || result.root === null)) throw new Error('disclosure-safe usage: GitHub handoff attestation requires --github-event and --root');
  return result;
}
async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.commitMessageFile !== null) {
    const result = checkCommitMessagePrivateArtifactContainment(cli.commitMessageFile);
    console.log(`PHASE3_PRIVATE_ARTIFACT_COMMIT_MESSAGE_PASS scanned_logical_bytes=${result.scanned_logical_bytes}`);
    return;
  }
  const result = cli.githubEvent
    ? await checkGitHubEventPrivateArtifactContainment({ root: cli.root ?? REPO_ROOT })
    : cli.prePushRemote !== null
      ? await checkPrePushPrivateArtifactContainment({ remoteName: cli.prePushRemote, stdin: readFileSync(0, 'utf8') })
      : await checkPrivateArtifactContainment({
        ranges: cli.ranges,
        includeIgnored: !cli.preCommit,
        indexFile: cli.preCommit && Object.hasOwn(process.env, 'GIT_INDEX_FILE') ? process.env.GIT_INDEX_FILE : null,
      });
  if (cli.attestGitHubHandoff) console.log(githubEventHandoffAttestation(result.github_event_head));
  else console.log(`PHASE3_PRIVATE_ARTIFACT_CONTAINMENT_PASS checked_paths=${result.checked_path_count} checked_commits=${result.checked_commit_count} scanned_candidates=${result.scanned_candidate_count} scanned_logical_bytes=${result.scanned_logical_bytes}`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
