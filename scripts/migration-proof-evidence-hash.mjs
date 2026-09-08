// Capture and fingerprint every repository input that migration-proof reviewers
// can see. The capture is the immutable in-memory source of the prompt; the
// hash is calculated from that same capture, never from a later working-tree read.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fixedGitExecutable, GIT_CALL_TIMEOUT_MS, protectedGitEnv } from '../.claude/hooks/protected-git.mjs';

const normal = (value) => value.replaceAll('\\', '/');

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function framed(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

function safeStat(rootReal, full, { optional = false } = {}) {
  let stat;
  try { stat = lstatSync(full); }
  catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') throw new Error(`required migration-proof input is missing: ${full}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`migration-proof input is a symlink or reparse point: ${full}`);
  const resolved = realpathSync(full);
  if (!contained(rootReal, resolved)) throw new Error(`migration-proof input resolves outside the checkout: ${full}`);
  return stat;
}

function safeWalk(rootReal, root, predicate) {
  const start = safeStat(rootReal, root, { optional: true });
  if (!start) return [];
  if (!start.isDirectory()) throw new Error(`migration-proof evidence path is not a directory: ${root}`);
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const child = safeStat(rootReal, full);
      if (child.isDirectory()) visit(full);
      else if (child.isFile() && predicate(normal(path.relative(root, full)))) files.push(full);
      else if (!child.isFile()) throw new Error(`migration-proof evidence contains an unsupported filesystem entry: ${full}`);
    }
  };
  visit(root);
  return files;
}

function decodeTrackedGitPaths(output) {
  if (!Buffer.isBuffer(output)) throw new Error('trusted Git did not return raw evidence bytes');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch {
    throw new Error('trusted Git returned evidence paths that are not valid UTF-8');
  }
  if (!Buffer.from(text, 'utf8').equals(output)) {
    throw new Error('trusted Git evidence-path UTF-8 round-trip did not preserve its raw bytes');
  }
  if (text && !text.endsWith('\0')) throw new Error('trusted Git returned an unterminated zero-delimited evidence path list');
  return text ? text.slice(0, -1).split('\0') : [];
}

export function reviewableEvidencePaths(root, prefixes, predicate, { execute = execFileSync } = {}) {
  const rootReal = realpathSync(root);
  let output;
  try {
    output = execute(fixedGitExecutable(), ['--no-replace-objects', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...prefixes], {
      encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: GIT_CALL_TIMEOUT_MS,
      windowsHide: true, shell: false, env: protectedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // The migration-apply guard's isolated filesystem fixtures are deliberately
    // not Git repositories. They cannot mint production proof because the real
    // wrapper separately requires a protected origin/main policy; retain their
    // hermetic safe-walk behavior without weakening a real checkout's allowlist.
    if (/not a git repository/i.test(String(error.stderr || error.message || error))) {
      return prefixes.flatMap((prefix) => safeWalk(rootReal, path.join(root, prefix), predicate)
        .map((file) => normal(path.relative(root, file))));
    }
    throw new Error(`could not enumerate trusted Git reviewable migration-proof evidence: ${error.message || error}`);
  }
  return decodeTrackedGitPaths(output).map(normal).map((relative) => {
    if (!relative || !prefixes.some((prefix) => relative.startsWith(prefix))) {
      throw new Error(`Git returned an evidence path outside the trusted roots: ${relative}`);
    }
    const stat = safeStat(rootReal, path.resolve(root, relative));
    if (!stat.isFile()) throw new Error(`Git returned a non-file migration-proof evidence path: ${relative}`);
    return relative;
  }).filter(predicate);
}

function collectPaths(root, stateDir) {
  const rootReal = realpathSync(root);
  const relativeStateDir = path.relative(root, stateDir);
  if (!contained(root, stateDir)) throw new Error(`migration-proof state directory is outside the checkout: ${stateDir}`);
  const inputs = new Set([
    '.claude/schema-registry.json',
    'docs/reference/migration-history.md',
    'src/types/index.ts',
    'scripts/write-apply-proofs.mjs',
    // These two imports decide which executable reviewer and ACL policy checks
    // produced the verdict. A proof cannot survive either changing mid-review.
    'scripts/write-codex-push-proof.mjs',
    'scripts/migration-security-definer-guard.mjs',
    'scripts/migration-routine-references.mjs',
    'scripts/rpc-call-site-matcher.mjs',
    'scripts/migration-proof-evidence-hash.mjs',
    'scripts/migration-proof-reviewer-launch.mjs',
    '.claude/hooks/protected-git.mjs',
    normal(path.join(relativeStateDir, 'applied-migrations.json')),
  ]);
  for (const file of reviewableEvidencePaths(root, ['supabase/migrations/'], (relative) => relative.endsWith('.sql'))) inputs.add(file);
  for (const file of reviewableEvidencePaths(root, ['src/'], (relative) => /\.(?:ts|tsx)$/.test(relative) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relative))) inputs.add(file);
  for (const file of reviewableEvidencePaths(root, ['supabase/functions/'], (relative) => /\.(?:ts|tsx)$/.test(relative) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relative))) inputs.add(file);
  return { rootReal, paths: [...inputs].sort() };
}

export function captureMigrationProofEvidence({
  projectDir,
  stateDir = path.join(projectDir, '.claude', 'session-state'),
  protectedBaseCommit = null,
}) {
  if (protectedBaseCommit !== null && !/^[a-f0-9]{40}$/i.test(protectedBaseCommit)) {
    throw new Error('migration-proof protected base must be a full commit SHA');
  }
  const root = path.resolve(projectDir);
  const resolvedStateDir = path.resolve(stateDir);
  const { rootReal, paths } = collectPaths(root, resolvedStateDir);
  const files = new Map();
  for (const relative of paths) {
    const full = path.resolve(root, relative);
    const stat = safeStat(rootReal, full, { optional: true });
    files.set(relative, stat ? readFileSync(full) : null);
  }
  const hash = createHash('sha256');
  framed(hash, 'CRX_MIGRATION_PROOF_EVIDENCE_INPUTS_V3');
  framed(hash, 'protected-origin-main');
  framed(hash, protectedBaseCommit || 'UNBOUND');
  for (const relative of paths) {
    const bytes = files.get(relative);
    framed(hash, relative);
    framed(hash, bytes === null ? 'ABSENT' : 'PRESENT');
    if (bytes !== null) framed(hash, bytes);
  }
  const evidenceHash = hash.digest('hex');
  return {
    evidenceHash,
    protectedBaseCommit,
    has(relative) { return files.get(normal(relative)) !== null && files.has(normal(relative)); },
    text(relative) {
      const bytes = files.get(normal(relative));
      if (bytes === undefined || bytes === null) throw new Error(`captured migration-proof input is absent: ${relative}`);
      return bytes.toString('utf8');
    },
    paths(prefix, predicate = () => true) {
      const normalPrefix = normal(prefix);
      return paths.filter((relative) => relative.startsWith(normalPrefix) && files.get(relative) !== null && predicate(relative));
    },
  };
}

export function migrationProofEvidenceHash(options) {
  return captureMigrationProofEvidence(options).evidenceHash;
}
