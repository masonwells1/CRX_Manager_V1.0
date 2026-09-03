// Capture and fingerprint every repository input that migration-proof reviewers
// can see. The capture is the immutable in-memory source of the prompt; the
// hash is calculated from that same capture, never from a later working-tree read.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

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
    const stat = safeStat(rootReal, dir);
    if (!stat.isDirectory()) throw new Error(`migration-proof evidence path is not a directory: ${dir}`);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const child = safeStat(rootReal, full);
      if (child.isDirectory()) visit(full);
      else if (child.isFile() && predicate(entry.name)) files.push(full);
      else if (!child.isFile()) throw new Error(`migration-proof evidence contains an unsupported filesystem entry: ${full}`);
    }
  };
  visit(root);
  return files;
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
    'scripts/migration-proof-evidence-hash.mjs',
    normal(path.join(relativeStateDir, 'applied-migrations.json')),
  ]);
  for (const file of safeWalk(rootReal, path.join(root, 'supabase', 'migrations'), (name) => name.endsWith('.sql'))) {
    inputs.add(normal(path.relative(root, file)));
  }
  for (const file of safeWalk(rootReal, path.join(root, 'src'), (name) => /\.(?:ts|tsx)$/.test(name) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(name))) {
    inputs.add(normal(path.relative(root, file)));
  }
  return { rootReal, paths: [...inputs].sort() };
}

export function captureMigrationProofEvidence({ projectDir, stateDir = path.join(projectDir, '.claude', 'session-state') }) {
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
  framed(hash, 'CRX_MIGRATION_PROOF_EVIDENCE_INPUTS_V2');
  for (const relative of paths) {
    const bytes = files.get(relative);
    framed(hash, relative);
    framed(hash, bytes === null ? 'ABSENT' : 'PRESENT');
    if (bytes !== null) framed(hash, bytes);
  }
  const evidenceHash = hash.digest('hex');
  return {
    evidenceHash,
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
