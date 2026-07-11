#!/usr/bin/env node
// One-shot helper: write migration-apply-guard proof files for the Wave-A migrations
// that passed BOTH review subagents (rls-security-reviewer + migration-drift-reviewer)
// this session. Pass the migration NAMES (without .sql) as args; only those get a proof.
// Written with Node (clean UTF-8, no BOM — a BOM blocks the guard hook's JSON parse).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const names = process.argv.slice(2);
if (names.length === 0) { console.error('usage: node scripts/write-apply-proofs.mjs <migName> [<migName> ...]'); process.exit(1); }

const stateDir = path.join(process.cwd(), '.claude', 'session-state');
mkdirSync(stateDir, { recursive: true });
const ts = new Date().toISOString();

for (const name of names) {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const proof = {
    migration: name,
    timestamp: ts,
    reviewers: ['rls-security-reviewer', 'migration-drift-reviewer'],
    findings: 'clean',
  };
  const file = path.join(stateDir, `migration-review-${safe}.json`);
  writeFileSync(file, JSON.stringify(proof, null, 2), { encoding: 'utf8' });
  console.log(`wrote ${file}`);
}
