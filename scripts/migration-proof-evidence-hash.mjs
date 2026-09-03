// Deterministic fingerprint of every repository input the migration-proof reviewer
// can see or that defines how the parent constructs its prompt. This is deliberately
// a superset of the rendered evidence bundle: a harmless extra invalidates a stale
// proof, while an omitted input could leave a reviewed prompt silently outdated.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function walk(root, predicate) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (predicate(entry.name)) files.push(full);
    }
  };
  visit(root);
  return files;
}

export function migrationProofEvidenceHash({ projectDir, stateDir = path.join(projectDir, '.claude', 'session-state') }) {
  const root = path.resolve(projectDir);
  const inputs = new Set([
    '.claude/schema-registry.json',
    '.claude/agents/rls-security-reviewer.md',
    '.claude/agents/migration-drift-reviewer.md',
    'docs/reference/migration-history.md',
    'src/types/index.ts',
    'scripts/write-apply-proofs.mjs',
    'scripts/migration-proof-evidence-hash.mjs',
  ]);
  const ledger = path.relative(root, path.join(stateDir, 'applied-migrations.json')).replaceAll('\\', '/');
  inputs.add(ledger);
  for (const file of walk(path.join(root, 'supabase', 'migrations'), (name) => name.endsWith('.sql'))) {
    inputs.add(path.relative(root, file).replaceAll('\\', '/'));
  }
  for (const file of walk(path.join(root, 'src'), (name) => /\.(?:ts|tsx)$/.test(name) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(name))) {
    inputs.add(path.relative(root, file).replaceAll('\\', '/'));
  }

  const hash = createHash('sha256');
  hash.update('CRX_MIGRATION_PROOF_EVIDENCE_INPUTS_V1\0');
  for (const relative of [...inputs].sort()) {
    const full = path.resolve(root, relative);
    hash.update(relative).update('\0');
    if (!existsSync(full)) {
      hash.update('ABSENT\0');
      continue;
    }
    hash.update(readFileSync(full));
    hash.update('\0');
  }
  return hash.digest('hex');
}
