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
// complete file's canonical-LF text must match its reviewed SHA-256 before this privacy guard permits it.
const SAFE_CATALOG_SIGNATURE_SHA256 = Object.freeze({
  'scripts/smoke/seed-supplier-pricing-phase1a.sql': '84fc11066636842212d53684971a438af3366c6667872b9488f5d9c2df172884',
  'scripts/smoke/seed-wells-cost-basis-rollout.sql': '62cf247b3c92d2b87464e1ab3e0ee126c7e75b5aafa332dcd9eea311edbcc52b',
  'scripts/smoke/smoke-supplier-cost-basis-phase2.sql': '75a3b7de436ea2e95d89eecbe486533523e64c4d0c87ddb1795feabae48b32ab',
  'scripts/smoke/smoke-supplier-pricing-phase1a-bootstrap-compat.sql': '082d5686741077c607387294359aac7b82ff58c11fcc25f076428cc7ec121052',
  'scripts/smoke/smoke-supplier-pricing-phase1a-forward-correction.sql': '8e6a8d74bfecda549fb5c5f79c24741a007f201fb6efd85d4a8da917c795fdb7',
  'scripts/smoke/smoke-supplier-pricing-phase1a.sql': 'c62ecd2c09f7831623baa6054ba677168f5bc5cbc7e2f28c9b1d5b5927959d9b',
  'src/lib/productPricingWorkbook.test.ts': '0448b3d95a4a7d192f7b9bbd5c4015bce8534782da40a8d891706e3c1f8bcfff',
  'src/pages/ProductDetail.pricing-flow.test.tsx': '5ad97e6130ee54c2b6a2dcb8efcae7527ef73d784f3e8dd50042203d522f5bc9',
  'src/pages/Products.pricing-flow.test.tsx': '977091c8d37aebe8b51e01e25f288b02cdb7b56fa302cba92b1b7af292c8338a',
  'supabase/migrations/20260722064814_wells_cost_basis_rollout_gate.sql': 'd231ce0ae752b384729afe11891418a5d4e32a4dbdb081ce1f41dab0efa2e276',
  'tests/e2e/comprehensive-ui-workflow.spec.ts': '7c10aa05cb45766585f88a18883a48ced8fcbabf5979defc8df8bdf995739d97',
  'tests/e2e/concurrent-operations.spec.ts': '401474d9e990f589329a29e24bdc7d7e4b4046ccc3559c947e3ba43c5081555f',
  'tests/e2e/mega-workflow.spec.ts': 'a1a01804e75e39c78784c2e86a99b57c4f8ae737ea9314ea55bc8e763dd2aac4',
  'tests/e2e/period-close-accounting.spec.ts': '79aaee30bc879d18b4b04c5c648b5486659249d7d98b90901633ece2f6e5bc43',
  'tests/e2e/pricing-edge-cases.spec.ts': '4b85908a6b3ead900d013bfb66fdafd792754727b7703c46794968aabff9bf12',
  'tests/phase1a-ui/supplier-pricing-phase1a.spec.ts': 'f3f7580493abd92f57fd3bed1e7159b57e0676f510846810297388280f51caa2',
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

export function canonicalTextSha256(text) {
  return createHash('sha256').update(text.replace(/\r\n?|\n/g, '\n'), 'utf8').digest('hex');
}

export function isKnownSafeCatalogSignature(file, text, allowlist = SAFE_CATALOG_SIGNATURE_SHA256) {
  const expectedHash = allowlist[file];
  return typeof expectedHash === 'string'
    && canonicalTextSha256(text) === expectedHash;
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
