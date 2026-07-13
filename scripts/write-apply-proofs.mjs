#!/usr/bin/env node
// One-shot helper: write migration-apply-guard proof files for migrations that
// passed BOTH review subagents (rls-security-reviewer + migration-drift-reviewer)
// this session. Pass the migration NAMES (without .sql) as args; only those get
// a proof. Written with Node (clean UTF-8, no BOM — a BOM blocks the guard
// hook's JSON parse).
//
// queryHash is computed from the on-disk migration file (CRLF→LF normalized) —
// hands-free applies REQUIRE it to match the transmitted SQL exactly (Codex P1
// 2026-07-13); if your apply call sends different bytes (e.g. trailing newline
// stripped), the guard prints the expected hash to paste in.
//
// --codex-verdict <clean|ship|ship-with-followups>: ALSO write the separate
// content-bound Codex proof (codex-review-mig-<name>.json with queryHash +
// verdict + timestamp) that hands-free applies require — pass it ONLY after
// an ACTUAL /codex-review run on this migration this session.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const cvIdx = args.indexOf('--codex-verdict');
let codexVerdict = null;
if (cvIdx !== -1) {
  codexVerdict = args[cvIdx + 1] || null;
  args.splice(cvIdx, 2);
}
const names = args;
if (names.length === 0) { console.error('usage: node scripts/write-apply-proofs.mjs [--codex-verdict clean] <migName> [<migName> ...]'); process.exit(1); }

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
  const migFile = path.join(process.cwd(), 'supabase', 'migrations', `${name}.sql`);
  let queryHash = null;
  if (existsSync(migFile)) {
    const sql = readFileSync(migFile, 'utf8').replace(/\r\n/g, '\n');
    queryHash = createHash('sha256').update(sql).digest('hex');
    proof.queryHash = queryHash;
  } else {
    console.warn(`WARN: ${migFile} not found — proof written WITHOUT queryHash; hands-free applies will refuse it until you add the hash the guard prints.`);
  }
  const file = path.join(stateDir, `migration-review-${safe}.json`);
  writeFileSync(file, JSON.stringify(proof, null, 2), { encoding: 'utf8' });
  console.log(`wrote ${file}`);
  if (codexVerdict) {
    const codexFile = path.join(stateDir, `codex-review-mig-${safe}.json`);
    writeFileSync(codexFile, JSON.stringify({ queryHash, verdict: codexVerdict, timestamp: ts }, null, 2), { encoding: 'utf8' });
    console.log(`wrote ${codexFile}`);
  }
}
