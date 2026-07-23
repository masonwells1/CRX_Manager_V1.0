#!/usr/bin/env node
/** Verify the sanitized Stage A diff contains aggregate evidence only. */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const base = args.find(arg => !arg.startsWith('--'));
const aggregateAuditArg = args.find(arg => arg.startsWith('--aggregate-audit='));
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const lines = output => output.trim().split(/\r?\n/).filter(Boolean);
const untracked = git(['ls-files', '--others', '--exclude-standard']).trim().split(/\r?\n/).filter(Boolean);
const scopedFiles = base
  ? lines(git(['diff', '--no-ext-diff', '--name-only', base]))
  : lines(git(['ls-files', '--cached', '--others', '--exclude-standard']));
const scannedFiles = [...new Set([...scopedFiles, ...untracked])];
const forbidden = scannedFiles.filter(file =>
  /(?:^|\/)(?:supplier-pricing-phase3-(?:product-snapshot|proposed-classification-manifest)\.json|(?:generate|verify)-supplier-pricing-phase3-classification-manifest\.mjs)$/i.test(file)
);
const auditFiles = scannedFiles.filter(file => /^docs\/audits\/.*supplier-pricing-phase3/i.test(file));
const aggregateAuditPath = aggregateAuditArg
  ? aggregateAuditArg.slice('--aggregate-audit='.length)
  : 'docs/audits/2026-07-22-supplier-pricing-phase3-classification-review.md';
const aggregateAudit = path.join(ROOT, aggregateAuditPath);
const expectedChecksum = 'bf85cc649657735fa26ba8c7e753d653c76ba238ce63c7605ce723393ea322c4';
const aggregatePresent = existsSync(aggregateAudit);
if (base && !aggregatePresent) throw new Error('SANITIZED_PRIVACY_CHECK_FAILED aggregate_audit_missing');
if (aggregatePresent) {
  const aggregateText = readFileSync(aggregateAudit, 'utf8');
  if (!aggregateText.includes('| Products represented | 604 |')
    || !aggregateText.includes('| Rows unresolved | 604 |')
    || !aggregateText.includes('| Name-only no-return evidence flags | 21 |')
    || !aggregateText.includes(expectedChecksum)) {
    throw new Error('SANITIZED_PRIVACY_CHECK_FAILED aggregate_consistency');
  }
}
let rowFieldHits = 0;
let uuidHits = 0;
for (const file of auditFiles) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute)) continue;
  const text = readFileSync(absolute, 'utf8');
  rowFieldHits += (text.match(/\b(product_id|product_name|sku|formulation|package(?:_size)?|inventory_unit)\b/gi) || []).length;
  uuidHits += (text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || []).length;
}
if (forbidden.length || rowFieldHits || uuidHits) {
  throw new Error(`SANITIZED_PRIVACY_CHECK_FAILED forbidden_files=${forbidden.length} audit_row_fields=${rowFieldHits} audit_uuids=${uuidHits}`);
}
console.log(`SANITIZED_PRIVACY_CHECK_PASS scope=${base ? 'diff' : 'whole_tree'} scanned_files=${scannedFiles.length} forbidden_files=0 audit_row_fields=0 audit_uuids=0 aggregate_present=${aggregatePresent} aggregate_rows=${aggregatePresent ? 604 : 'not_checked'} unresolved=${aggregatePresent ? 604 : 'not_checked'} evidence_flags=${aggregatePresent ? 21 : 'not_checked'} checksum=${aggregatePresent ? expectedChecksum : 'not_checked'}`);
