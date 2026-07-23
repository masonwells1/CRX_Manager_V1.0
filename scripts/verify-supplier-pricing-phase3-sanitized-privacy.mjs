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
const SAFE_SQL_FIXTURE_SHA256 = Object.freeze({
  'scripts/smoke/seed-supplier-pricing-phase1a.sql': '21304bd81361e59e938c98071cf0d504f63ea68f9f9129443d33467fd53bd65f',
  'scripts/smoke/seed-wells-cost-basis-rollout.sql': '8a28c59d0668ae7254a6c9c974f144c793d448975021e56881eddf1ba5192231',
  'scripts/smoke/smoke-supplier-cost-basis-phase2.sql': 'dc6107e701275e715d1b82a816a568d1b7610f48ac4c22da52fc8790e7294eb9',
  'scripts/smoke/smoke-supplier-pricing-phase1a-bootstrap-compat.sql': '06742b81da30e425f87e46fb9beb5d6e1f455aaddf7774cfe6526d98a4cca348',
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

const SQL_IDENTIFIER_PATTERN = String.raw`(?:"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_$]*)`;
const PRODUCT_INSERT_PATTERN = new RegExp(
  String.raw`\binsert\s+into\s*(?:(?<schema>${SQL_IDENTIFIER_PATTERN})\s*\.\s*)?(?<table>${SQL_IDENTIFIER_PATTERN})\s*(?:(?:as\s+)(?<asAlias>${SQL_IDENTIFIER_PATTERN})\s*|(?<bareAlias>${SQL_IDENTIFIER_PATTERN})\s*)?\(`,
  'gi',
);

function stripSqlComments(text) {
  let result = '';
  let index = 0;
  let quote = null;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (quote) {
      result += character;
      if (character === quote) {
        if (text[index + 1] === quote) {
          result += next;
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
      index += 1;
      continue;
    }
    if (character === '-' && next === '-') {
      while (index < text.length && text[index] !== '\n') {
        result += ' ';
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      result += '  ';
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        result += text[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < text.length) {
        result += '  ';
        index += 2;
      }
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

function normalizeSqlIdentifier(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^"(?:""|[^"])*"$/.test(trimmed)) return trimmed.slice(1, -1).replaceAll('""', '"').toLowerCase();
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function readBalancedSqlParentheses(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) {
        if (text[index + 1] === quote) {
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function splitSqlColumnList(text) {
  const fields = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) {
        if (text[index + 1] === quote) {
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if ((character === ',' && depth === 0) || index === text.length) {
      fields.push(text.slice(start, index));
      start = index + 1;
    }
  }
  return fields.map(normalizeSqlIdentifier).filter(Boolean);
}

function sqlInsertColumnListLines(text) {
  const stripped = stripSqlComments(text);
  const lineNumbers = new Set();
  const insertPattern = /\binsert\s+into\b/gi;
  let match;
  while ((match = insertPattern.exec(stripped))) {
    const statementEnd = stripped.indexOf(';', match.index);
    const openIndex = stripped.indexOf('(', match.index + match[0].length);
    if (openIndex < 0 || (statementEnd >= 0 && openIndex > statementEnd)) continue;
    const closeIndex = readBalancedSqlParentheses(stripped, openIndex);
    if (closeIndex === null) continue;
    const firstLine = stripped.slice(0, openIndex).split('\n').length - 1;
    const lastLine = stripped.slice(0, closeIndex).split('\n').length - 1;
    for (let line = firstLine; line <= lastLine; line += 1) lineNumbers.add(line);
  }
  return lineNumbers;
}

export function detectProductCatalogSqlInsert(text) {
  const stripped = stripSqlComments(text);
  const fileUuidCount = (stripped.match(UUID_PATTERN) || []).length;
  PRODUCT_INSERT_PATTERN.lastIndex = 0;
  let match;
  while ((match = PRODUCT_INSERT_PATTERN.exec(stripped))) {
    const schema = normalizeSqlIdentifier(match.groups.schema);
    const table = normalizeSqlIdentifier(match.groups.table);
    if (table !== 'products' || (schema && schema !== 'public')) continue;
    const openIndex = match.index + match[0].lastIndexOf('(');
    const closeIndex = readBalancedSqlParentheses(stripped, openIndex);
    if (closeIndex === null) continue;
    const insertBody = stripped.slice(closeIndex + 1);
    const insertVerb = insertBody.match(/^\s*(values|select)\b/i)?.[1]?.toLowerCase();
    if (!insertVerb) continue;
    const columns = new Set(splitSqlColumnList(stripped.slice(openIndex + 1, closeIndex)));
    const statementEnd = stripped.indexOf(';', closeIndex);
    const statement = stripped.slice(match.index, statementEnd < 0 ? stripped.length : statementEnd);
    const hasCatalogUuids = insertVerb === 'values'
      ? fileUuidCount >= 2
      : (statement.match(UUID_PATTERN) || []).length >= 2;
    if (hasCatalogUuids
      && (columns.has('id') || columns.has('product_id')) && columns.has('product_name') && columns.has('sku')) {
      return true;
    }
  }
  return false;
}

export function isKnownSafeSqlFixture(file, text, allowlist = SAFE_SQL_FIXTURE_SHA256) {
  const expectedHash = allowlist[file];
  return typeof expectedHash === 'string'
    && createHash('sha256').update(text, 'utf8').digest('hex') === expectedHash;
}

export function detectPrivateCatalogFile(file, text) {
  const hits = detectPrivateCatalogContent(text);
  if ((text.match(UUID_PATTERN) || []).length < 2) return hits;
  const tableLines = text.split(/\r?\n/);
  const sqlColumnLines = sqlInsertColumnListLines(text);
  const hasDelimitedTableHeader = predicate => tableLines.some((line, index) => {
    if (sqlColumnLines.has(index)) return false;
    const fields = headerFields(line);
    return predicate(fields);
  });
  const hasProductTable = hasDelimitedTableHeader(fields => (fields.includes('product_id') || fields.includes('id'))
    && fields.includes('product_name') && fields.includes('sku'));
  const hasManifestTable = hasDelimitedTableHeader(fields => ['product_id', 'current_product', 'decisions', 'row_sha256'].every(field => fields.includes(field)));
  const hasProductSqlInsert = detectProductCatalogSqlInsert(text);
  return [...new Set([
    ...hits,
    ...(hasProductTable ? ['delimited_product_schema'] : []),
    ...(hasManifestTable ? ['delimited_manifest_schema'] : []),
    ...(hasProductSqlInsert && !isKnownSafeSqlFixture(file, text) ? ['sql_product_catalog_insert'] : []),
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
