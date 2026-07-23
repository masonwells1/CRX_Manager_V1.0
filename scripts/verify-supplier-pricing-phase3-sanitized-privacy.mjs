#!/usr/bin/env node
/** Verify the sanitized Stage A diff contains aggregate evidence only. */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_AGGREGATE_AUDIT = 'docs/audits/2026-07-22-supplier-pricing-phase3-classification-review.md';
const EXPECTED_CHECKSUM = 'bf85cc649657735fa26ba8c7e753d653c76ba238ce63c7605ce723393ea322c4';
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const FORMAT_MARKER_PREFIX = ['supplier', 'pricing', 'phase3'].join('-');

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

export function detectPrivateCatalogFile(file, text) {
  const hits = detectPrivateCatalogContent(text);
  if ((text.match(UUID_PATTERN) || []).length < 2) return hits;
  const tableLines = text.split(/\r?\n/);
  const hasTableHeader = predicate => tableLines.some((line, index) => {
    const fields = headerFields(line);
    if (!predicate(fields)) return false;
    const beforeHeader = tableLines.slice(Math.max(0, index - 12), index + 1).join('\n');
    const afterHeader = tableLines.slice(index, index + 13).join('\n');
    return !(/\binsert\s+into\b/i.test(beforeHeader) && /^\s*\)\s*(?:values|select)\b/im.test(afterHeader));
  });
  const hasProductTable = hasTableHeader(fields => (fields.includes('product_id') || fields.includes('id'))
    && fields.includes('product_name') && fields.includes('sku'));
  const hasManifestTable = hasTableHeader(fields => ['product_id', 'current_product', 'decisions', 'row_sha256'].every(field => fields.includes(field)));
  return [...new Set([
    ...hits,
    ...(hasProductTable ? ['delimited_product_schema'] : []),
    ...(hasManifestTable ? ['delimited_manifest_schema'] : []),
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
    rowFieldHits += (text.match(/\b(product_id|product_name|sku|formulation|package(?:_size)?|inventory_unit)\b/gi) || []).length;
    uuidHits += (text.match(UUID_PATTERN) || []).length;
  }
  if (forbidden.length || privateContentFiles.length || rowFieldHits || uuidHits) {
    throw new Error(`SANITIZED_PRIVACY_CHECK_FAILED forbidden_files=${forbidden.length} catalog_content_files=${privateContentFiles.length} audit_row_fields=${rowFieldHits} audit_uuids=${uuidHits}`);
  }
  console.log(`SANITIZED_PRIVACY_CHECK_PASS scope=${base ? 'diff' : 'whole_tree'} scanned_files=${scannedFiles.length} forbidden_files=0 catalog_content_files=0 audit_row_fields=0 audit_uuids=0 aggregate_present=${aggregatePresent} aggregate_rows=${aggregatePresent ? 604 : 'not_checked'} unresolved=${aggregatePresent ? 604 : 'not_checked'} evidence_flags=${aggregatePresent ? 21 : 'not_checked'} checksum=${aggregatePresent ? EXPECTED_CHECKSUM : 'not_checked'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
