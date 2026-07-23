#!/usr/bin/env node
/** Verify the sanitized Stage A diff contains aggregate evidence only. */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_AGGREGATE_AUDIT = 'docs/audits/2026-07-22-supplier-pricing-phase3-classification-review.md';
const EXPECTED_CHECKSUM = 'bf85cc649657735fa26ba8c7e753d653c76ba238ce63c7605ce723393ea322c4';
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const AUDIT_ROW_FIELD_PATTERN = /\b(product_id|product_name|sku|formulation|package(?:_size)?|packaging_variant|inventory_unit)\b/gi;
const FORMAT_MARKER_PREFIX = ['supplier', 'pricing', 'phase3'].join('-');
// Pre-existing synthetic fixtures and tests only. A matching path is insufficient: the
// complete file content must match its reviewed SHA-256 before this privacy guard permits it.
const SAFE_CATALOG_SIGNATURE_SHA256 = Object.freeze({
  'scripts/smoke/seed-supplier-pricing-phase1a.sql': '21304bd81361e59e938c98071cf0d504f63ea68f9f9129443d33467fd53bd65f',
  'scripts/smoke/seed-wells-cost-basis-rollout.sql': '8a28c59d0668ae7254a6c9c974f144c793d448975021e56881eddf1ba5192231',
  'scripts/smoke/smoke-supplier-cost-basis-phase2.sql': 'dc6107e701275e715d1b82a816a568d1b7610f48ac4c22da52fc8790e7294eb9',
  'scripts/smoke/smoke-supplier-pricing-phase1a-bootstrap-compat.sql': '06742b81da30e425f87e46fb9beb5d6e1f455aaddf7774cfe6526d98a4cca348',
  'scripts/smoke/smoke-supplier-pricing-phase1a-forward-correction.sql': '9ea12fcec19e6d00f8f5313e6d845478e0c18e9708ac699df1c96020a95228dc',
  'scripts/smoke/smoke-supplier-pricing-phase1a.sql': '5c10bb8f081172c79ab3a80170ba139f285f490f6677edfcf64bed9fcb104775',
  'src/lib/productPricingWorkbook.test.ts': '361b555c1a5191698c706dddad0e5e3177bbc2b2e4cd4a46cc045752e8fea772',
  'src/pages/ProductDetail.pricing-flow.test.tsx': 'e9797d817082c5af1bcfee957e14425d51f865495989c447303bf68250ffa684',
  'src/pages/Products.pricing-flow.test.tsx': '0b84a2a28739b0dc8feb422956635e05c16158cba99693520335d5f61a7b9d29',
  'supabase/migrations/20260722064814_wells_cost_basis_rollout_gate.sql': 'cd103109565a0b81fd218a5e89df3de30dd430997dbebea728f51616e25efb56',
  'tests/e2e/comprehensive-ui-workflow.spec.ts': 'edecb39c14ad4d6bd9aabb199d02eb3389182730d0482a2f20cbcc350dd18bc9',
  'tests/e2e/concurrent-operations.spec.ts': 'f686fcebfe82e9e8febd5f4898bc400fd4e3797350a98f6a7b7c5aa2f0aec42b',
  'tests/e2e/mega-workflow.spec.ts': '2002b63cafa427c4bfe9d023438e41e43ef2425cc3560667fb7dcd400673c0a0',
  'tests/e2e/period-close-accounting.spec.ts': 'b1d17098bfb9767e4c2d66d11be1508d6ef4edee476511174669cd01d76432f9',
  'tests/e2e/pricing-edge-cases.spec.ts': '35e7b131dd631b7837c74f109e340a180a4e8def0e0e7b0bba50fe5f4ae22df9',
  'tests/phase1a-ui/supplier-pricing-phase1a.spec.ts': 'db9073cca13c5726c053906eb3daa811e2818183d3229fff792123623348e098',
});

const lines = output => output.trim().split(/\r?\n/).filter(Boolean);
const normalizePath = value => value.split(path.sep).join('/');

export function resolveAggregateAuditPath(root, candidate = DEFAULT_AGGREGATE_AUDIT) {
  if (!candidate || path.isAbsolute(candidate) || candidate.split(/[\\/]+/).includes('..')) {
    throw new Error('SANITIZED_PRIVACY_CHECK_FAILED aggregate_audit_path_invalid');
  }
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('SANITIZED_PRIVACY_CHECK_FAILED aggregate_audit_path_invalid');
  }
  return { absolute, relative: normalizePath(relative) };
}

export function requirePathInScope(relativePath, scannedFiles) {
  if (!scannedFiles.includes(relativePath)) {
    throw new Error('SANITIZED_PRIVACY_CHECK_FAILED aggregate_audit_outside_scope');
  }
}

export function hasValidAggregateAuditText(text) {
  return typeof text === 'string'
    && text.includes('| Products represented | 604 |')
    && text.includes('| Rows unresolved | 604 |')
    && text.includes('| Name-only no-return evidence flags | 21 |')
    && text.includes(EXPECTED_CHECKSUM);
}

export function countAuditRowFields(text) {
  return (text.match(AUDIT_ROW_FIELD_PATTERN) || []).length;
}

export function detectPrivateCatalogContent(text) {
  const hits = [];
  if (new RegExp(`${FORMAT_MARKER_PREFIX}-(?:product-snapshot|proposed-classification-manifest)(?:-v\\d+)?`, 'i').test(text)) {
    hits.push('format_marker');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return hits;
  }

  let hasKnownFormat = false;
  let hasManifestRow = false;
  let hasSnapshotArray = false;
  const walk = value => {
    if (Array.isArray(value)) {
      if (value.some(item => isSnapshotProductRow(item))) hasSnapshotArray = true;
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const keys = new Set(Object.keys(value).map(key => key.toLowerCase()));
    const format = value.format;
    if (typeof format === 'string'
      && /supplier[-_ ]pricing[-_ ]phase[-_ ]?3[-_ ](?:product[-_ ]snapshot|proposed[-_ ]classification[-_ ]manifest)/i.test(format)) {
      hasKnownFormat = true;
    }
    if (['product_id', 'current_product', 'decisions', 'row_sha256'].every(key => keys.has(key))) {
      hasManifestRow = true;
    }
    Object.values(value).forEach(walk);
  };
  walk(parsed);

  const uuidCount = (text.match(UUID_PATTERN) || []).length;
  return [...new Set([
    ...hits,
    ...(hasKnownFormat ? ['format_marker'] : []),
    ...(hasManifestRow ? ['manifest_row_schema'] : []),
    ...(hasSnapshotArray && uuidCount >= 2 ? ['snapshot_product_schema'] : []),
  ])];
}

function isSnapshotProductRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = new Set(Object.keys(value).map(key => key.toLowerCase()));
  return (keys.has('product_id') || keys.has('id')) && keys.has('product_name') && keys.has('sku');
}

function headerFields(line) {
  if (!/[|,\t]/.test(line)) return [];
  return line
    .split(/[|,\t]/)
    .map(field => field.trim().replace(/^["'`]+|["'`]+$/g, '').toLowerCase())
    .filter(Boolean);
}

export function hasCatalogRowSignature(text) {
  return (text.match(UUID_PATTERN) || []).length >= 2
    && /\b(?:id|product_id)\b/i.test(text)
    && /\bproduct_name\b/i.test(text)
    && /\bsku\b/i.test(text);
}

export function isKnownSafeCatalogSignature(file, text, allowlist = SAFE_CATALOG_SIGNATURE_SHA256) {
  const expectedHash = allowlist[file];
  return typeof expectedHash === 'string'
    && createHash('sha256').update(text, 'utf8').digest('hex') === expectedHash;
}

export function detectPrivateCatalogFile(file, text) {
  const hits = detectPrivateCatalogContent(text);
  const tableLines = text.split(/\r?\n/);
  const hasDelimitedTableHeader = predicate => tableLines.some(line => {
    const fields = headerFields(line);
    return predicate(fields);
  });
  const hasManifestTable = hasDelimitedTableHeader(fields => ['product_id', 'current_product', 'decisions', 'row_sha256'].every(field => fields.includes(field)));
  const hasCatalogSignature = hasCatalogRowSignature(text);
  return [...new Set([
    ...hits,
    ...(hasManifestTable ? ['delimited_manifest_schema'] : []),
    ...(hasCatalogSignature && !isKnownSafeCatalogSignature(file, text) ? ['catalog_row_signature'] : []),
  ])];
}

function readTextIfReadable(absolute) {
  const buffer = readFileSync(absolute);
  return buffer.includes(0) ? null : buffer.toString('utf8');
}

function main() {
  const args = process.argv.slice(2);
  const base = args.find(arg => !arg.startsWith('--'));
  const aggregateAuditArg = args.find(arg => arg.startsWith('--aggregate-audit='));
  const aggregateAuditPath = aggregateAuditArg
    ? aggregateAuditArg.slice('--aggregate-audit='.length)
    : DEFAULT_AGGREGATE_AUDIT;
  const git = gitArgs => execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard']));
  const scopedFiles = base
    ? lines(git(['diff', '--no-ext-diff', '--name-only', base]))
    : lines(git(['ls-files', '--cached', '--others', '--exclude-standard']));
  const scannedFiles = [...new Set([...scopedFiles, ...untracked])];
  const forbidden = scannedFiles.filter(file =>
    /(?:^|\/)(?:supplier-pricing-phase3-(?:product-snapshot|proposed-classification-manifest)\.json|(?:generate|verify)-supplier-pricing-phase3-classification-manifest\.mjs)$/i.test(file)
  );
  const auditFiles = scannedFiles.filter(file => /^docs\/audits\/.*supplier-pricing-phase3/i.test(file));
  const { absolute: aggregateAudit, relative: aggregateAuditRelative } = resolveAggregateAuditPath(ROOT, aggregateAuditPath);
  const aggregatePresent = existsSync(aggregateAudit);
  if ((base || aggregateAuditArg) && aggregatePresent) requirePathInScope(aggregateAuditRelative, scannedFiles);
  if (base && !aggregatePresent) throw new Error('SANITIZED_PRIVACY_CHECK_FAILED aggregate_audit_missing');
  if (aggregatePresent && !hasValidAggregateAuditText(readFileSync(aggregateAudit, 'utf8'))) {
    throw new Error('SANITIZED_PRIVACY_CHECK_FAILED aggregate_consistency');
  }

  let rowFieldHits = 0;
  let uuidHits = 0;
  const privateContentFiles = [];
  for (const file of scannedFiles) {
    const absolute = path.join(ROOT, file);
    if (!existsSync(absolute)) continue;
    const text = readTextIfReadable(absolute);
    if (text) {
      const contentHits = detectPrivateCatalogFile(file, text);
      if (contentHits.length) privateContentFiles.push(file);
    }
    if (!auditFiles.includes(file) || text === null) continue;
    rowFieldHits += countAuditRowFields(text);
    uuidHits += (text.match(UUID_PATTERN) || []).length;
  }
  if (forbidden.length || privateContentFiles.length || rowFieldHits || uuidHits) {
    throw new Error(`SANITIZED_PRIVACY_CHECK_FAILED forbidden_files=${forbidden.length} catalog_content_files=${privateContentFiles.length} audit_row_fields=${rowFieldHits} audit_uuids=${uuidHits}`);
  }
  console.log(`SANITIZED_PRIVACY_CHECK_PASS scope=${base ? 'diff' : 'whole_tree'} scanned_files=${scannedFiles.length} forbidden_files=0 catalog_content_files=0 audit_row_fields=0 audit_uuids=0 aggregate_present=${aggregatePresent} aggregate_rows=${aggregatePresent ? 604 : 'not_checked'} unresolved=${aggregatePresent ? 604 : 'not_checked'} evidence_flags=${aggregatePresent ? 21 : 'not_checked'} checksum=${aggregatePresent ? EXPECTED_CHECKSUM : 'not_checked'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
