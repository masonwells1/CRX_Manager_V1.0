import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countAuditRowFields,
  detectPrivateCatalogFile,
  detectProductCatalogSqlInsert,
  hasValidAggregateAuditText,
  isKnownSafeSqlFixture,
  requirePathInScope,
  resolveAggregateAuditPath,
} from './verify-supplier-pricing-phase3-sanitized-privacy.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
assert.equal(detectProductCatalogSqlInsert(bulkCatalogSql), true);
assert.deepEqual(detectPrivateCatalogFile('exports/classification.sql', bulkCatalogSql), ['sql_product_catalog_insert']);
const fixturePath = 'fixtures/known.sql';
const fixtureHash = createHash('sha256').update(bulkCatalogSql, 'utf8').digest('hex');
assert.equal(isKnownSafeSqlFixture(fixturePath, bulkCatalogSql, { [fixturePath]: fixtureHash }), true);
assert.equal(isKnownSafeSqlFixture(fixturePath, `${bulkCatalogSql}\n-- appended`, { [fixturePath]: fixtureHash }), false);

const sqlVariants = [
  ['one_line', `${insertInto} products (id, product_name, sku) VALUES ('12121212-1212-4121-8121-121212121212', 'One', 'ONE'), ('13131313-1313-4131-8131-131313131313', 'Two', 'TWO');`],
  ['one_per_line', `${insertInto} products (\n  id,\n  product_name,\n  sku\n) VALUES ('14141414-1414-4141-8141-141414141414', 'One', 'ONE'), ('15151515-1515-4151-8151-151515151515', 'Two', 'TWO');`],
  ['quoted_target', `${insertInto} "public"."products" ("id", "product_name", "sku") VALUES ('16161616-1616-4161-8161-161616161616', 'One', 'ONE'), ('17171717-1717-4171-8171-171717171717', 'Two', 'TWO');`],
  ['as_alias', `${insertInto} public.products AS p (id, product_name, sku) VALUES ('18181818-1818-4181-8181-181818181818', 'One', 'ONE'), ('19191919-1919-4191-8191-191919191919', 'Two', 'TWO');`],
  ['bare_alias', `${insertInto} public.products p (id, product_name, sku) VALUES ('20202020-2020-4202-8202-202020202020', 'One', 'ONE'), ('21212121-2121-4212-8212-212121212121', 'Two', 'TWO');`],
  ['select_rows', `${insertInto} products (id, product_name, sku) SELECT '24242424-2424-4242-8242-242424242424'::uuid, 'One', 'ONE' UNION ALL SELECT '25252525-2525-4252-8252-252525252525'::uuid, 'Two', 'TWO';`],
  ['comments', `${insertInto} /* target */ -- line comment\n "public" /* schema */ . /* table */ "products" AS p (\n  "id", /* required */\n  "product_name",\n  "sku"\n) VALUES ('22222222-2222-4222-8222-222222222222', 'One', 'ONE'), ('23232323-2323-4232-8232-232323232323', 'Two', 'TWO');`],
];
for (const [label, sql] of sqlVariants) {
  assert.equal(detectProductCatalogSqlInsert(sql), true, `${label} SQL signature should be recognized`);
  assert.deepEqual(detectPrivateCatalogFile(`exports/${label}.sql`, sql), ['sql_product_catalog_insert']);
}

const safeFixturePaths = [
  'scripts/smoke/seed-supplier-pricing-phase1a.sql',
  'scripts/smoke/seed-wells-cost-basis-rollout.sql',
  'scripts/smoke/smoke-supplier-cost-basis-phase2.sql',
  'scripts/smoke/smoke-supplier-pricing-phase1a-bootstrap-compat.sql',
];
for (const safeFixturePath of safeFixturePaths) {
  const safeFixtureText = readFileSync(path.join(workspaceRoot, safeFixturePath), 'utf8');
  assert.equal(detectProductCatalogSqlInsert(safeFixtureText), true, `${safeFixturePath} must have Product catalog signature`);
  assert.equal(isKnownSafeSqlFixture(safeFixturePath, safeFixtureText), true, `${safeFixturePath} must match allowlist hash`);
  assert.deepEqual(detectPrivateCatalogFile(safeFixturePath, safeFixtureText), [], `${safeFixturePath} must be exactly allowlisted`);

  const appendedComment = `${safeFixtureText}\n-- changed fixture byte`;
  assert.deepEqual(detectPrivateCatalogFile(safeFixturePath, appendedComment), ['sql_product_catalog_insert'], `${safeFixturePath} appended byte must refuse`);

  const splitProductName = safeFixtureText.replace(/product_name/i, '\nproduct_name');
  assert.notEqual(splitProductName, safeFixtureText, `${safeFixturePath} must contain product_name`);
  assert.deepEqual(detectPrivateCatalogFile(safeFixturePath, splitProductName), ['sql_product_catalog_insert'], `${safeFixturePath} reformatted Product column must refuse`);
}
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

console.log('supplier-pricing-phase3-sanitized-privacy: 62 assertions passed');
