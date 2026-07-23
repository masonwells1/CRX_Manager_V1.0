import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  countAuditRowFields,
  detectPrivateCatalogFile,
  hasValidAggregateAuditText,
  isKnownSafeSqlFixture,
  requirePathInScope,
  resolveAggregateAuditPath,
} from './verify-supplier-pricing-phase3-sanitized-privacy.mjs';

const phase3 = ['supplier', 'pricing', 'phase3'].join('-');
const renamedManifest = JSON.stringify({
  format: `${phase3}-proposed-classification-manifest-v1`,
  rows: [{
    product_id: '11111111-1111-4111-8111-111111111111',
    current_product: { id: '22222222-2222-4222-8222-222222222222' },
    decisions: [],
    row_sha256: 'test-only',
  }],
});
assert.deepEqual(detectPrivateCatalogFile('artifacts/classification.json', renamedManifest).sort(), ['format_marker', 'manifest_row_schema']);
assert.deepEqual(detectPrivateCatalogFile('docs/audits/aggregate.md', '| Products represented | 604 |\nAggregate-only audit text.'), []);
assert.equal(countAuditRowFields('packaging_variant'), 1);
assert.deepEqual(detectPrivateCatalogFile('exports/classification.dat', `format=${phase3}-product-snapshot-v1`), ['format_marker']);
const renamedSnapshot = JSON.stringify({ products: [
  { id: '33333333-3333-4333-8333-333333333333', product_name: 'Example', SKU: 'EX-1' },
  { id: '44444444-4444-4444-8444-444444444444', product_name: 'Example Two', SKU: 'EX-2' },
] });
assert.deepEqual(detectPrivateCatalogFile('exports/classification', renamedSnapshot), ['snapshot_product_schema']);
const productIdSnapshot = JSON.stringify({ products: [
  { product_id: '99999999-9999-4999-8999-999999999999', product_name: 'Example', SKU: 'EX-3' },
  { product_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', product_name: 'Example Two', SKU: 'EX-4' },
] });
assert.deepEqual(detectPrivateCatalogFile('exports/product-classification', productIdSnapshot), ['snapshot_product_schema']);
const productHeader = ['product_id', 'product_name', 'sku'].join(',');
const renamedCsv = `${productHeader}\n55555555-5555-4555-8555-555555555555,Example,EX-1\n66666666-6666-4666-8666-666666666666,Example Two,EX-2`;
assert.deepEqual(detectPrivateCatalogFile('exports/classification.csv', renamedCsv), ['delimited_product_schema']);
assert.deepEqual(detectPrivateCatalogFile('exports/classification.txt', renamedCsv), ['delimited_product_schema']);
assert.deepEqual(detectPrivateCatalogFile('docs/audits/classification.csv', renamedCsv), ['delimited_product_schema']);
const insertInto = ['INSERT', 'INTO'].join(' ');
const productColumns = ['id', 'product_name', 'sku'].join(', ');
const nonCatalogTable = ['public', 'fixture_rows'].join('.');
const safeNonCatalogSql = `${insertInto} ${nonCatalogTable} (
  ${productColumns}
) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Example', 'EX-5'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Example Two', 'EX-6');`;
assert.deepEqual(detectPrivateCatalogFile('exports/classification.sql', safeNonCatalogSql), []);
const productTable = ['public', 'products'].join('.');
const bulkCatalogSql = `${insertInto} ${productTable} (
  ${productColumns}
) VALUES
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Catalog One', 'CAT-1'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Catalog Two', 'CAT-2');`;
assert.deepEqual(detectPrivateCatalogFile('exports/classification.sql', bulkCatalogSql), ['delimited_product_schema']);
const fixturePath = 'fixtures/known.sql';
const fixtureHash = createHash('sha256').update(bulkCatalogSql, 'utf8').digest('hex');
assert.equal(isKnownSafeSqlFixture(fixturePath, bulkCatalogSql, { [fixturePath]: fixtureHash }), true);
assert.equal(isKnownSafeSqlFixture(fixturePath, `${bulkCatalogSql}\n-- appended`, { [fixturePath]: fixtureHash }), false);
const manifestHeader = ['product_id', 'current_product', 'decisions', 'row_sha256'].join('|');
const renamedManifestTable = `${manifestHeader}\n77777777-7777-4777-8777-777777777777|{}|[]|a\n88888888-8888-4888-8888-888888888888|{}|[]|b`;
assert.deepEqual(detectPrivateCatalogFile('exports/classification.md', renamedManifestTable), ['delimited_manifest_schema']);
assert.equal(hasValidAggregateAuditText(`| Products represented | 604 |\n| Rows unresolved | 604 |\n| Name-only no-return evidence flags | 21 |\nbf85cc649657735fa26ba8c7e753d653c76ba238ce63c7605ce723393ea322c4`), true);
assert.equal(hasValidAggregateAuditText('| Products represented | 604 |'), false);

const root = path.join(path.sep, 'repo');
assert.deepEqual(resolveAggregateAuditPath(root, 'docs/audits/aggregate.md').relative, 'docs/audits/aggregate.md');
assert.throws(() => resolveAggregateAuditPath(root, '../outside.md'), /aggregate_audit_path_invalid/);
assert.throws(() => resolveAggregateAuditPath(root, path.join(path.sep, 'outside.md')), /aggregate_audit_path_invalid/);
assert.doesNotThrow(() => requirePathInScope('docs/audits/aggregate.md', ['docs/audits/aggregate.md']));
assert.throws(() => requirePathInScope('docs/audits/aggregate.md', []), /aggregate_audit_outside_scope/);
const headScopeCheck = spawnSync(process.execPath, ['scripts/verify-supplier-pricing-phase3-sanitized-privacy.mjs', 'HEAD'], { encoding: 'utf8' });
assert.notEqual(headScopeCheck.status, 0);
assert.match(headScopeCheck.stderr, /aggregate_audit_outside_scope/);

console.log('supplier-pricing-phase3-sanitized-privacy: 22 assertions passed');
