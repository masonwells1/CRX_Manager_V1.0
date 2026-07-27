import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRE_STAGE_A_SNAPSHOT_NAME = '2026-07-22-supplier-pricing-phase3-product-snapshot.json';
export const PRE_STAGE_A_MANIFEST_NAME = '2026-07-22-supplier-pricing-phase3-proposed-classification-manifest.json';
export const POST_STAGE_A_SNAPSHOT_NAME = '2026-07-26-supplier-pricing-phase3-post-stage-a-product-snapshot.json';
export const POST_STAGE_A_MANIFEST_NAME = '2026-07-26-supplier-pricing-phase3-post-stage-a-proposed-classification-manifest.json';
export const OWNER_DECISION_SHEET_NAME = '2026-07-26-supplier-pricing-phase3-owner-decision-sheet.csv';
export const PRE_STAGE_A_SNAPSHOT_FORMAT = 'crx-supplier-pricing-phase3-pre-stage-a-product-snapshot-v1';
export const POST_STAGE_A_SNAPSHOT_FORMAT = 'crx-supplier-pricing-phase3-post-stage-a-product-snapshot-v2';
export const STAGE_A_MIGRATION_VERSION = '20260723193312';
export const SAFE_PHASE3_DEFAULTS = Object.freeze({ is_full_tote_only: false, packaging_variant: null, product_family_id: null, return_policy: 'unknown' });
export const PRIVATE_ARTIFACT_BASENAMES = new Set([PRE_STAGE_A_SNAPSHOT_NAME, PRE_STAGE_A_MANIFEST_NAME, POST_STAGE_A_SNAPSHOT_NAME, POST_STAGE_A_MANIFEST_NAME, OWNER_DECISION_SHEET_NAME]);
export const APPROVED_SNAPSHOT_BASENAMES = new Set([PRE_STAGE_A_SNAPSHOT_NAME, POST_STAGE_A_SNAPSHOT_NAME]);
export const APPROVED_SERIALIZED_FORMATS = new Set([
  PRE_STAGE_A_SNAPSHOT_FORMAT,
  POST_STAGE_A_SNAPSHOT_FORMAT,
  'crx-supplier-pricing-phase3-proposed-classification-manifest-v1',
  'crx-supplier-pricing-phase3-post-stage-a-proposed-classification-manifest-v2',
]);
export const OWNER_DECISION_HEADERS = [
  'product_id', 'sku', 'product_name', 'product_form', 'container_size', 'container_type', 'container_unit', 'unit_size', 'inventory_unit', 'is_active', 'pricing_version', 'updated_at',
  'current_product_family_id', 'current_return_policy', 'current_packaging_variant', 'current_is_full_tote_only', 'active_return_statuses',
  'disposition_decision', 'family_decision', 'packaging_decision', 'tote_only_decision', 'return_policy_decision', 'unresolved_acknowledgment', 'owner_note', 'overall_approval_state',
];
export const OWNER_DECISION_CSV_HEADER = OWNER_DECISION_HEADERS.join(',');
/** The only production packet location. This is deliberately not configurable by environment. */
export const APPROVED_PRIVATE_ARTIFACT_ROOT = path.resolve(homedir(), '.codex', 'private-artifacts', 'CRX_Manager', 'supplier-pricing-phase3');

export function assert(condition, message) { if (!condition) throw new Error(message); }
export function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key]) ])); return value; }
export function canonical(value) { return `${JSON.stringify(stable(value), null, 2)}\n`; }
export function sha256(value) { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
export function without(object, key) { const copy = { ...object }; delete copy[key]; return copy; }

function exactPathEqual(left, right) { return path.resolve(left) === path.resolve(right); }
function canonicalRepoRoot(repoRoot) { return realpathSync(repoRoot); }
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameStatIdentity(left, right) {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink
    && left.mode === right.mode;
}
export function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertPlainDirectory(directory, label) {
  assert(existsSync(directory), `${label} must exist`);
  const entry = lstatSync(directory);
  assert(entry.isDirectory() && !entry.isSymbolicLink(), `${label} must be a non-link directory`);
  const followed = statSync(directory);
  assert(followed.isDirectory() && sameFile(entry, followed), `${label} changed during validation`);
  return realpathSync(directory);
}
function hermeticGitEnvironment(environment = process.env) {
  const clean = { ...environment };
  for (const key of Object.keys(clean)) if (key.toUpperCase().startsWith('GIT_')) delete clean[key];
  return clean;
}
function hasBareGitMarkers(directory) {
  try {
    return ['HEAD', 'config'].every(name => lstatSync(path.join(directory, name)).isFile())
      && ['objects', 'refs'].every(name => lstatSync(path.join(directory, name)).isDirectory());
  } catch (_error) { return false; }
}
function assertNotInsideGitDirectory(directory) {
  const canonicalDirectory = realpathSync(directory);
  let current = canonicalDirectory;
  while (true) {
    if (existsSync(path.join(current, '.git')) || hasBareGitMarkers(current)) throw new Error('approved private artifact root must not be inside a Git worktree, bare repository, or Git administration directory');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  let output;
  try {
    output = execFileSync('git', ['-C', canonicalDirectory, 'rev-parse', '--is-inside-work-tree', '--is-inside-git-dir', '--git-dir', '--git-common-dir'], {
      encoding: 'utf8', env: hermeticGitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('approved private artifact root Git-boundary check is unavailable');
    if (error?.status === 128) return;
    throw new Error('approved private artifact root Git-boundary check failed');
  }
  const [insideWorktree, insideGitDirectory] = String(output).trim().split(/\r?\n/);
  if (insideWorktree === 'true' || insideGitDirectory === 'true') throw new Error('approved private artifact root must not be inside a Git worktree, bare repository, or Git administration directory');
}
function approvedRoot({ testApprovedRoot } = {}) {
  const configured = testApprovedRoot ?? APPROVED_PRIVATE_ARTIFACT_ROOT;
  assert(typeof configured === 'string' && path.isAbsolute(configured), 'approved private artifact root must be absolute');
  const resolved = path.resolve(configured);
  const canonicalRoot = assertPlainDirectory(resolved, 'approved private artifact root');
  assert(exactPathEqual(resolved, canonicalRoot), 'approved private artifact root must be canonical and must not be a symlink or junction alias');
  assertNotInsideGitDirectory(canonicalRoot);
  return canonicalRoot;
}
/**
 * Admits only the canonical mission directory. testApprovedRoot is an injected
 * fixture seam; no CLI reads it and production callers never set it.
 */
export function assertExternalPrivateDirectory(directory, repoRoot = REPO_ROOT, options = {}) {
  assert(typeof directory === 'string' && path.isAbsolute(directory), 'CRX_PHASE3_PRIVATE_ARTIFACT_DIR must be an absolute path');
  const root = canonicalRepoRoot(repoRoot);
  const expected = approvedRoot(options);
  assert(!isPathInside(expected, root), 'approved private artifact root must resolve outside the repository');
  assert(exactPathEqual(directory, expected), 'private artifact directory must be the exact canonical mission-approved directory');
  const current = assertPlainDirectory(directory, 'private artifact directory');
  assert(exactPathEqual(current, expected), 'private artifact directory changed during validation');
  return expected;
}

function assertRegularSingleLink(file, label) {
  const entry = lstatSync(file);
  assert(!entry.isSymbolicLink(), `${label} must not be a symbolic link or reparse point`);
  assert(entry.isFile(), `${label} must be a regular file`);
  const followed = statSync(file);
  assert(followed.isFile() && sameFile(entry, followed), `${label} changed during validation`);
  assert(entry.nlink === 1 && followed.nlink === 1, `${label} must not be hard-linked`);
  return entry;
}

export function assertExternalArtifactPath(file, expectedBasename, repoRoot = REPO_ROOT, { mustExist = false, testApprovedRoot } = {}) {
  assert(typeof file === 'string' && path.isAbsolute(file), `private ${expectedBasename} path must be absolute`);
  assert(path.basename(file) === expectedBasename, `private artifact filename must be ${expectedBasename}`);
  const parent = assertExternalPrivateDirectory(path.dirname(path.resolve(file)), repoRoot, { testApprovedRoot });
  const expected = path.join(parent, expectedBasename);
  assert(exactPathEqual(file, expected), `private ${expectedBasename} path must be the exact approved artifact path`);
  try {
    assertRegularSingleLink(expected, 'private artifact path');
    assert(exactPathEqual(realpathSync(expected), expected), 'private artifact path must not be a symlink or junction alias');
  } catch (error) {
    if (error?.code === 'ENOENT' && !mustExist) return expected;
    if (error?.code === 'ENOENT') throw new Error('private artifact input must exist');
    throw error;
  }
  return expected;
}

export function privateArtifactPath(directory, basename, repoRoot = REPO_ROOT, options = {}) {
  const privateDirectory = assertExternalPrivateDirectory(directory, repoRoot, options);
  return assertExternalArtifactPath(path.join(privateDirectory, basename), basename, repoRoot, options);
}
function assertOpenedArtifactMatchesPath(fd, resolved, expectedBasename, label, repoRoot, options) {
  const parent = assertExternalPrivateDirectory(path.dirname(resolved), repoRoot, options);
  assert(exactPathEqual(resolved, path.join(parent, expectedBasename)), `${label} changed during validation`);
  const descriptor = fstatSync(fd);
  let entry; let followed;
  try { entry = lstatSync(resolved); followed = statSync(resolved); }
  catch (_error) { throw new Error(`${label} changed during validation`); }
  assert(descriptor.isFile() && entry.isFile() && followed.isFile(), `${label} must be a regular file`);
  assert(!entry.isSymbolicLink(), `${label} must not be a symbolic link or reparse point`);
  assert(descriptor.nlink === 1 && entry.nlink === 1 && followed.nlink === 1, `${label} must not be hard-linked`);
  assert(sameStatIdentity(descriptor, entry) && sameStatIdentity(descriptor, followed), `${label} changed during validation`);
  assert(exactPathEqual(realpathSync(resolved), resolved), `${label} must not be a symlink or junction alias`);
  return descriptor;
}
function readExactDescriptor(fd, size, label) {
  assert(Number.isSafeInteger(size) && size >= 0, `${label} has an invalid size`);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    assert(count > 0, `${label} changed during read`);
    offset += count;
  }
  return bytes;
}
export function readValidatedPrivateArtifact(file, expectedBasename, repoRoot = REPO_ROOT, { beforeOpen, beforeRead, afterFirstRead, afterRead, testApprovedRoot } = {}) {
  const options = { testApprovedRoot };
  const resolved = assertExternalArtifactPath(file, expectedBasename, repoRoot, { mustExist: true, ...options });
  const noFollow = process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number' ? 0 : constants.O_NOFOLLOW;
  let fd;
  try {
    beforeOpen?.({ path: resolved });
    assertExternalArtifactPath(resolved, expectedBasename, repoRoot, options);
    fd = openSync(resolved, constants.O_RDONLY | noFollow);
    const before = assertOpenedArtifactMatchesPath(fd, resolved, expectedBasename, 'private artifact path', repoRoot, options);
    beforeRead?.({ fd, path: resolved });
    assertOpenedArtifactMatchesPath(fd, resolved, expectedBasename, 'private artifact path', repoRoot, options);
    const first = readExactDescriptor(fd, before.size, 'private artifact descriptor');
    afterFirstRead?.({ fd, path: resolved });
    const between = fstatSync(fd);
    assert(sameStatIdentity(before, between), 'private artifact descriptor changed during read');
    assertOpenedArtifactMatchesPath(fd, resolved, expectedBasename, 'private artifact path', repoRoot, options);
    const second = readExactDescriptor(fd, before.size, 'private artifact descriptor');
    afterRead?.({ fd, path: resolved });
    const after = fstatSync(fd);
    assert(sameStatIdentity(before, after) && after.isFile() && after.nlink === 1, 'private artifact descriptor changed during read');
    assert(first.equals(second), 'private artifact bytes changed during read');
    assertOpenedArtifactMatchesPath(fd, resolved, expectedBasename, 'private artifact path', repoRoot, options);
    return { path: resolved, text: first.toString('utf8') };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseNamedPathOptions(argumentsList, optionNames) {
  const values = Object.fromEntries(optionNames.map(name => [name, null]));
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    assert(Object.hasOwn(values, token), 'disclosure-safe usage: unknown flag or positional argument');
    assert(values[token] === null, 'disclosure-safe usage: duplicate option');
    const value = argumentsList[++index];
    assert(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'disclosure-safe usage: option value required');
    values[token] = value;
  }
  return values;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_KEYS = ['id', 'sku', 'product_name', 'product_form', 'container_size', 'container_type', 'container_unit', 'unit_size', 'inventory_unit', 'is_active', 'pricing_version', 'updated_at', 'product_family_id', 'return_policy', 'packaging_variant', 'is_full_tote_only', 'active_return_statuses'];
const V2_KEYS = ['capture_timestamp_utc', 'expected_old_phase3_defaults', 'format', 'migration_high_water', 'product_families_count', 'products', 'snapshot_sha256', 'stage_a_migration_version', 'stage_a_ledger_present', 'supplier_cost_basis_enabled'];
export const PRODUCT_FORM_ALLOWLIST = Object.freeze(['liquid', 'dry']);
export const CONTAINER_TYPE_ALLOWLIST = Object.freeze(['Jug', 'Drum', 'Pallet', 'Mini-Bulk', 'Shuttle', 'Bag', 'Tote', 'Ea', 'Jar']);
const CONTAINER_TYPES = new Set(CONTAINER_TYPE_ALLOWLIST);
function exactKeys(value, keys, label) { assert(value && typeof value === 'object' && !Array.isArray(value), `${label} is invalid`); assert(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${label} key set is invalid`); }
function safeNullableString(value) { return value === null || typeof value === 'string'; }
function strictProduct(product, index) {
  exactKeys(product, PRODUCT_KEYS, `Product row ${index + 1}`);
  assert(typeof product.id === 'string' && UUID.test(product.id), `Product row ${index + 1} has invalid UUID`);
  assert(typeof product.product_name === 'string' && safeNullableString(product.sku), `Product row ${index + 1} has invalid text metadata`);
  assert(product.product_form === null || PRODUCT_FORM_ALLOWLIST.includes(product.product_form), `Product row ${index + 1} has invalid product form`);
  assert(product.container_size === null || (typeof product.container_size === 'number' && Number.isFinite(product.container_size)), `Product row ${index + 1} has invalid container size`);
  assert(product.container_type === null || CONTAINER_TYPES.has(product.container_type), `Product row ${index + 1} has invalid container type`);
  assert(['container_unit', 'unit_size', 'inventory_unit'].every(key => safeNullableString(product[key])), `Product row ${index + 1} has invalid unit metadata`);
  assert(typeof product.is_active === 'boolean' && typeof product.is_full_tote_only === 'boolean', `Product row ${index + 1} has invalid boolean metadata`);
  assert(Number.isSafeInteger(product.pricing_version) && product.pricing_version >= 0, `Product row ${index + 1} has invalid pricing version`);
  assert(typeof product.updated_at === 'string' && product.updated_at.length > 0 && Number.isFinite(Date.parse(product.updated_at)), `Product row ${index + 1} has invalid updated timestamp`);
  assert(product.product_family_id === null && product.return_policy === 'unknown' && product.packaging_variant === null && product.is_full_tote_only === false, `Product row ${index + 1} has non-default classification`);
  assert(Array.isArray(product.active_return_statuses) && product.active_return_statuses.every(status => ['requested', 'approved', 'received'].includes(status)) && product.active_return_statuses.every((status, i) => i === 0 || product.active_return_statuses[i - 1] < status) && new Set(product.active_return_statuses).size === product.active_return_statuses.length, `Product row ${index + 1} has invalid active-return statuses`);
}
export function validatePostStageASnapshot(snapshot) {
  exactKeys(snapshot, V2_KEYS, 'post-Stage-A snapshot');
  assert(snapshot.format === POST_STAGE_A_SNAPSHOT_FORMAT, 'post-Stage-A snapshot format is invalid');
  assert(snapshot.stage_a_migration_version === STAGE_A_MIGRATION_VERSION && snapshot.stage_a_ledger_present === true, 'post-Stage-A snapshot Stage A proof is invalid');
  assert(typeof snapshot.migration_high_water === 'string' && /^\d{14}$/.test(snapshot.migration_high_water) && snapshot.migration_high_water >= STAGE_A_MIGRATION_VERSION, 'post-Stage-A snapshot migration high-water is invalid');
  assert(snapshot.product_families_count === 0 && snapshot.supplier_cost_basis_enabled === false, 'post-Stage-A snapshot safe defaults are invalid');
  exactKeys(snapshot.expected_old_phase3_defaults, Object.keys(SAFE_PHASE3_DEFAULTS), 'post-Stage-A snapshot defaults');
  assert(canonical(snapshot.expected_old_phase3_defaults) === canonical(SAFE_PHASE3_DEFAULTS), 'post-Stage-A snapshot defaults are invalid');
  assert(typeof snapshot.capture_timestamp_utc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(snapshot.capture_timestamp_utc) && Number.isFinite(Date.parse(snapshot.capture_timestamp_utc)), 'post-Stage-A snapshot capture timestamp is invalid');
  assert(Array.isArray(snapshot.products) && snapshot.products.length > 0, 'post-Stage-A snapshot has no products'); snapshot.products.forEach(strictProduct);
  const ids = snapshot.products.map(product => product.id); assert(ids.every((id, index) => index === 0 || ids[index - 1] < id) && new Set(ids).size === ids.length, 'post-Stage-A snapshot Product UUID order is invalid');
  assert(typeof snapshot.snapshot_sha256 === 'string' && snapshot.snapshot_sha256 === sha256(without(snapshot, 'snapshot_sha256')), 'snapshot SHA-256 drift');
  return snapshot;
}
export function parseExpectedV2Binding(environment = process.env) {
  const hash = environment.CRX_PHASE3_EXPECTED_SNAPSHOT_SHA256;
  const count = environment.CRX_PHASE3_EXPECTED_PRODUCT_COUNT;
  assert(typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash), 'post-Stage-A snapshot external hash binding is missing or invalid');
  assert(typeof count === 'string' && /^[1-9][0-9]*$/.test(count) && Number.isSafeInteger(Number(count)), 'post-Stage-A snapshot external count binding is missing or invalid');
  return { snapshot_sha256: hash.toLowerCase(), product_count: Number(count) };
}
export function assertV2SnapshotBinding(snapshot, binding) {
  assert(binding && typeof binding === 'object', 'post-Stage-A snapshot external bindings are required');
  assert(typeof binding.snapshot_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(binding.snapshot_sha256) && Number.isSafeInteger(binding.product_count) && binding.product_count > 0, 'post-Stage-A snapshot external bindings are invalid');
  assert(snapshot.snapshot_sha256.toLowerCase() === binding.snapshot_sha256.toLowerCase(), 'post-Stage-A snapshot external hash binding mismatch');
  assert(snapshot.products.length === binding.product_count, 'post-Stage-A snapshot external count binding mismatch');
}
export function loadValidatedSnapshot(file, repoRoot = REPO_ROOT, binding = null, options = {}) {
  assert(file && typeof file === 'string' && path.isAbsolute(file), 'private snapshot path must be absolute');
  const basename = path.basename(file); assert(APPROVED_SNAPSHOT_BASENAMES.has(basename), 'private snapshot filename is not approved');
  const { text } = readValidatedPrivateArtifact(file, basename, repoRoot, options);
  let snapshot; try { snapshot = JSON.parse(text); } catch { throw new Error('private snapshot JSON is invalid'); }
  assert(text === canonical(snapshot), 'private snapshot byte drift: canonical LF UTF-8 JSON required');
  const expectedFormat = basename === POST_STAGE_A_SNAPSHOT_NAME ? POST_STAGE_A_SNAPSHOT_FORMAT : PRE_STAGE_A_SNAPSHOT_FORMAT;
  assert(snapshot?.format === expectedFormat, 'private snapshot basename and format do not match');
  if (basename === POST_STAGE_A_SNAPSHOT_NAME) { validatePostStageASnapshot(snapshot); assertV2SnapshotBinding(snapshot, binding); return snapshot; }
  assert(Array.isArray(snapshot.products) && snapshot.products.length > 0, 'snapshot has no products');
  const ids = snapshot.products.map(product => product.id); assert(ids.every((id, index) => index === 0 || ids[index - 1] < id) && new Set(ids).size === ids.length, 'snapshot Product UUID order is invalid');
  assert(snapshot.snapshot_sha256 === sha256(without(snapshot, 'snapshot_sha256')), 'snapshot SHA-256 drift');
  return snapshot;
}

function safeUnlinkOwnedTemp(temporary, fd, expectedBasename, repoRoot, options, expectedIdentity) {
  try {
    assertExternalPrivateDirectory(path.dirname(temporary), repoRoot, options);
    assert(exactPathEqual(temporary, path.join(path.dirname(temporary), path.basename(temporary))), 'private temporary path changed during cleanup');
    const descriptor = fstatSync(fd); const entry = lstatSync(temporary); const followed = statSync(temporary);
    if (entry.isFile() && !entry.isSymbolicLink() && sameFile(descriptor, entry) && sameFile(descriptor, followed) && (!expectedIdentity || sameFile(expectedIdentity, descriptor)) && entry.nlink === 1 && path.basename(temporary).startsWith(`.${expectedBasename}.`)) { unlinkSync(temporary); return true; }
  } catch (_error) { /* A swapped path is deliberately left untouched. */ }
  return false;
}
function safeUnlinkClosedOwnedTemp(temporary, expectedBasename, repoRoot, options, expectedIdentity) {
  try {
    assertExternalPrivateDirectory(path.dirname(temporary), repoRoot, options);
    const entry = lstatSync(temporary); const followed = statSync(temporary);
    if (entry.isFile() && !entry.isSymbolicLink() && sameStatIdentity(entry, followed) && sameFile(expectedIdentity, entry) && entry.nlink === 1 && path.basename(temporary).startsWith(`.${expectedBasename}.`)) { unlinkSync(temporary); return true; }
  } catch (_error) { /* An untrusted swapped path is deliberately left untouched. */ }
  return false;
}
function safeUnlinkOwnedCreatedTarget(target, fd, expectedBasename, repoRoot, options) {
  try {
    const parent = assertExternalPrivateDirectory(path.dirname(target), repoRoot, options);
    assert(exactPathEqual(target, path.join(parent, expectedBasename)), 'private artifact path changed during cleanup');
    const descriptor = fstatSync(fd);
    const entry = assertRegularSingleLink(target, 'private artifact path');
    if (sameFile(descriptor, entry) && descriptor.isFile() && descriptor.nlink === 1 && entry.nlink === 1 && exactPathEqual(realpathSync(target), target)) unlinkSync(target);
  } catch (_error) { /* A swapped or out-of-root pathname is deliberately left untouched. */ }
}
function openValidatedFinalDescriptor(target, expectedBasename, repoRoot, options) {
  const noFollow = process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number' ? 0 : constants.O_NOFOLLOW;
  let fd; let created = false;
  try { fd = openSync(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); created = true; }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    fd = openSync(target, constants.O_RDWR | noFollow);
  }
  try { return { fd, identity: assertOpenedArtifactMatchesPath(fd, target, expectedBasename, 'private artifact path', repoRoot, options), created }; }
  catch (error) {
    if (created) safeUnlinkOwnedCreatedTarget(target, fd, expectedBasename, repoRoot, options);
    closeSync(fd);
    throw error;
  }
}
/**
 * Stages exact bytes in an owned temp file, then writes through a validated final
 * descriptor. Node exposes no portable renameat/dirfd primitive on Windows, so
 * this intentionally trades pathname-rename atomicity for a fail-closed parent
 * replacement boundary: no final pathname is mutated after descriptor checks.
 */
export function writePrivateArtifactAtomic(file, expectedBasename, text, { repoRoot = REPO_ROOT, beforeTempOpen, afterTempOpenBeforeWrite, afterTempWriteBeforePublication, beforeFinalValidation, beforeFinalOpen, beforeRename, afterFinalOpenBeforeWrite, afterFinalWriteBeforeReadback, testApprovedRoot } = {}) {
  const options = { testApprovedRoot };
  const target = assertExternalArtifactPath(file, expectedBasename, repoRoot, options);
  const parent = path.dirname(target); const canonicalParent = assertExternalPrivateDirectory(parent, repoRoot, options);
  const temporary = path.join(parent, `.${expectedBasename}.${randomBytes(16).toString('hex')}.tmp`);
  const intended = Buffer.from(text, 'utf8');
  let temporaryFd; let temporaryIdentity; let finalFd; let finalCreated = false;
  try {
    beforeTempOpen?.({ target, temporary });
    assert(exactPathEqual(assertExternalPrivateDirectory(parent, repoRoot, options), canonicalParent), 'private artifact parent changed during write');
    temporaryFd = openSync(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    afterTempOpenBeforeWrite?.({ target, temporary, fd: temporaryFd });
    assertOpenedArtifactMatchesPath(temporaryFd, temporary, path.basename(temporary), 'private artifact temporary path', repoRoot, options);
    writeFileSync(temporaryFd, intended); fsyncSync(temporaryFd);
    temporaryIdentity = assertOpenedArtifactMatchesPath(temporaryFd, temporary, path.basename(temporary), 'private artifact temporary path', repoRoot, options);
    assert(readExactDescriptor(temporaryFd, intended.length, 'private artifact temporary descriptor').equals(intended), 'private artifact temporary bytes changed during write');
    afterTempWriteBeforePublication?.({ target, temporary, fd: temporaryFd });
    beforeFinalValidation?.({ target, temporary });
    assert(exactPathEqual(assertExternalPrivateDirectory(parent, repoRoot, options), canonicalParent), 'private artifact parent changed during write');
    assert(sameStatIdentity(temporaryIdentity, assertOpenedArtifactMatchesPath(temporaryFd, temporary, path.basename(temporary), 'private artifact temporary path', repoRoot, options)), 'private artifact temporary path changed during write');
    assert(readExactDescriptor(temporaryFd, intended.length, 'private artifact temporary descriptor').equals(intended), 'private artifact temporary bytes changed during write');
    beforeFinalOpen?.({ target, temporary });
    assert(exactPathEqual(assertExternalPrivateDirectory(parent, repoRoot, options), canonicalParent), 'private artifact parent changed before final open');
    assertExternalArtifactPath(target, expectedBasename, repoRoot, options);
    ({ fd: finalFd, created: finalCreated } = openValidatedFinalDescriptor(target, expectedBasename, repoRoot, options));
    beforeRename?.({ target, temporary, fd: finalFd });
    afterFinalOpenBeforeWrite?.({ target, temporary, fd: finalFd });
    assert(exactPathEqual(assertExternalPrivateDirectory(parent, repoRoot, options), canonicalParent), 'private artifact parent changed before final write');
    assert(sameStatIdentity(temporaryIdentity, assertOpenedArtifactMatchesPath(temporaryFd, temporary, path.basename(temporary), 'private artifact temporary path', repoRoot, options)), 'private artifact temporary path changed before final write');
    assert(readExactDescriptor(temporaryFd, intended.length, 'private artifact temporary descriptor').equals(intended), 'private artifact temporary bytes changed before final write');
    assertOpenedArtifactMatchesPath(finalFd, target, expectedBasename, 'private artifact path', repoRoot, options);
    ftruncateSync(finalFd, 0); writeFileSync(finalFd, intended); fsyncSync(finalFd);
    const finalIdentity = assertOpenedArtifactMatchesPath(finalFd, target, expectedBasename, 'private artifact path', repoRoot, options);
    afterFinalWriteBeforeReadback?.({ target, temporary, fd: finalFd });
    assert(sameStatIdentity(finalIdentity, assertOpenedArtifactMatchesPath(finalFd, target, expectedBasename, 'private artifact path', repoRoot, options)), 'private artifact path changed during final write');
    assert(readExactDescriptor(finalFd, intended.length, 'private artifact descriptor').equals(intended), 'private artifact bytes changed during final write');
    assert(sameStatIdentity(finalIdentity, assertOpenedArtifactMatchesPath(finalFd, target, expectedBasename, 'private artifact path', repoRoot, options)), 'private artifact path changed during final write');
    return target;
  } catch (error) {
    if (finalFd !== undefined && finalCreated) safeUnlinkOwnedCreatedTarget(target, finalFd, expectedBasename, repoRoot, options);
    throw error;
  } finally {
    if (finalFd !== undefined) closeSync(finalFd);
    if (temporaryFd !== undefined) {
      const removedOpen = safeUnlinkOwnedTemp(temporary, temporaryFd, expectedBasename, repoRoot, options, temporaryIdentity);
      closeSync(temporaryFd);
      if (!removedOpen && temporaryIdentity) safeUnlinkClosedOwnedTemp(temporary, expectedBasename, repoRoot, options, temporaryIdentity);
    }
  }
}
