import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalTextSha256,
  countAuditRowFields,
  detectPrivateCatalogFile,
  hasCatalogRowSignature,
  hasValidAggregateAuditText,
  isKnownSafeCatalogSignature,
  requirePathInScope,
  resolveAggregateAuditPath,
} from './verify-supplier-pricing-phase3-sanitized-privacy.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase3 = ['supplier', 'pricing', 'phase3'].join('-');
const testUuid = seed => {
  const digit = seed.toString(16).at(-1);
  return [digit.repeat(8), digit.repeat(4), `4${digit.repeat(3)}`, `8${digit.repeat(3)}`, digit.repeat(12)].join('-');
};
const catalogText = (firstSeed, secondSeed) => `id product_name sku ${testUuid(firstSeed)} ${testUuid(secondSeed)}`;

const renamedManifest = JSON.stringify({
  format: `${phase3}-proposed-classification-manifest-v1`,
  rows: [{
    product_id: testUuid(1),
    current_product: { id: testUuid(2) },
    decisions: [],
    row_sha256: 'test-only',
  }],
});
assert.deepEqual(detectPrivateCatalogFile('artifacts/classification.json', renamedManifest).sort(), ['format_marker', 'manifest_row_schema']);
assert.deepEqual(detectPrivateCatalogFile('docs/audits/aggregate.md', '| Products represented | 604 |\nAggregate-only audit text.'), []);
assert.equal(countAuditRowFields('packaging_variant'), 1);
assert.deepEqual(detectPrivateCatalogFile('exports/classification.dat', `format=${phase3}-product-snapshot-v1`), ['format_marker']);

const renamedSnapshot = JSON.stringify({ products: [
  { id: testUuid(3), product_name: 'Example', SKU: 'EX-1' },
  { id: testUuid(4), product_name: 'Example Two', SKU: 'EX-2' },
] });
assert.deepEqual(detectPrivateCatalogFile('exports/classification', renamedSnapshot).sort(), ['catalog_row_signature', 'snapshot_product_schema']);

const productIdSnapshot = JSON.stringify({ products: [
  { product_id: testUuid(5), product_name: 'Example', SKU: 'EX-3' },
  { product_id: testUuid(6), product_name: 'Example Two', SKU: 'EX-4' },
] });
assert.deepEqual(detectPrivateCatalogFile('exports/product-classification', productIdSnapshot).sort(), ['catalog_row_signature', 'snapshot_product_schema']);

const productHeader = ['product_id', 'product_name', 'sku'].join(',');
const renamedCsv = `${productHeader}\n${testUuid(7)},Example,EX-1\n${testUuid(8)},Example Two,EX-2`;
assert.deepEqual(detectPrivateCatalogFile('exports/classification.csv', renamedCsv), ['catalog_row_signature']);
assert.deepEqual(detectPrivateCatalogFile('exports/classification.txt', renamedCsv), ['catalog_row_signature']);
assert.deepEqual(detectPrivateCatalogFile('docs/audits/classification.csv', renamedCsv), ['catalog_row_signature']);

const nonCatalogSql = `INSERT INTO audit_fixture_rows (id, sku) VALUES ('${testUuid(9)}', 'ONE'), ('${testUuid(10)}', 'TWO');`;
assert.equal(hasCatalogRowSignature(nonCatalogSql), false);
assert.deepEqual(detectPrivateCatalogFile('exports/non-catalog.sql', nonCatalogSql), []);

const genericCatalog = catalogText(11, 12);
const genericFixturePath = 'fixtures/known-catalog.txt';
const genericFixtureHash = canonicalTextSha256(genericCatalog);
assert.equal(hasCatalogRowSignature(genericCatalog), true);
assert.equal(isKnownSafeCatalogSignature(genericFixturePath, genericCatalog, { [genericFixturePath]: genericFixtureHash }), true);
assert.equal(isKnownSafeCatalogSignature(genericFixturePath, `${genericCatalog}x`, { [genericFixturePath]: genericFixtureHash }), false);
assert.equal(canonicalTextSha256(`${genericCatalog}\r\nnext\rline\nlast`), canonicalTextSha256(`${genericCatalog}\nnext\nline\nlast`));
assert.deepEqual(detectPrivateCatalogFile('exports/catalog.txt', genericCatalog), ['catalog_row_signature']);

const insertInto = ['INSERT', 'INTO'].join(' ');
const catalogRows = (firstSeed, secondSeed) => `id, product_name, sku) VALUES ('${testUuid(firstSeed)}', 'One', 'ONE'), ('${testUuid(secondSeed)}', 'Two', 'TWO');`;
const adversarialSyntaxSamples = [
  ['one_line', `${insertInto} products (${catalogRows(13, 14)}`],
  ['one_per_line', `${insertInto} products (\n id,\n product_name,\n sku\n) VALUES ('${testUuid(15)}', 'One', 'ONE'), ('${testUuid(16)}', 'Two', 'TWO');`],
  ['quoted_target', `${insertInto} "public"."products" ("id", "product_name", "sku") VALUES ('${testUuid(17)}', 'One', 'ONE'), ('${testUuid(18)}', 'Two', 'TWO');`],
  ['as_alias', `${insertInto} public.products AS p (${catalogRows(19, 20)}`],
  ['bare_alias', `${insertInto} public.products p (${catalogRows(21, 22)}`],
  ['comments', `${insertInto} /* target */ -- comment\n "public" /* schema */ . "products" AS p (id, /* field */ product_name, sku) VALUES ('${testUuid(23)}', 'One', 'ONE'), ('${testUuid(24)}', 'Two', 'TWO');`],
  ['only', `${insertInto} ONLY public.products (${catalogRows(25, 26)}`],
  ['target_star', `${insertInto} public.products * (${catalogRows(27, 28)}`],
  ['overriding', `${insertInto} products OVERRIDING SYSTEM VALUE (${catalogRows(29, 30)}`],
  ['cte_before', `WITH seed AS (SELECT '${testUuid(31)}'::uuid) ${insertInto} products (${catalogRows(32, 33)}`],
  ['cte_after', `${insertInto} products (id, product_name, sku) WITH seed AS (SELECT '${testUuid(34)}'::uuid) SELECT '${testUuid(35)}'::uuid, 'One', 'ONE';`],
  ['parenthesized_select', `${insertInto} products (id, product_name, sku) (SELECT '${testUuid(36)}'::uuid, 'One', 'ONE' UNION ALL SELECT '${testUuid(37)}'::uuid, 'Two', 'TWO');`],
  ['temp_load', `CREATE TEMP TABLE staging (id uuid, product_name text, sku text); INSERT INTO staging VALUES ('${testUuid(38)}', 'One', 'ONE'), ('${testUuid(39)}', 'Two', 'TWO');`],
  ['semicolon_string', `${insertInto} products (${catalogRows(40, 41).replace("'One'", "'One; still data'")}`],
];
for (const [label, sample] of adversarialSyntaxSamples) {
  assert.equal(hasCatalogRowSignature(sample), true, `${label} must match generic signature`);
  assert.ok(detectPrivateCatalogFile(`exports/${label}.sql`, sample).includes('catalog_row_signature'), `${label} must refuse`);
}

const safeFixturePaths = [
  'scripts/smoke/seed-supplier-pricing-phase1a.sql',
  'scripts/smoke/seed-wells-cost-basis-rollout.sql',
  'scripts/smoke/smoke-supplier-cost-basis-phase2.sql',
  'scripts/smoke/smoke-supplier-pricing-phase1a-bootstrap-compat.sql',
  'scripts/smoke/smoke-supplier-pricing-phase1a-forward-correction.sql',
  'scripts/smoke/smoke-supplier-pricing-phase1a.sql',
  'src/lib/productPricingWorkbook.test.ts',
  'src/pages/ProductDetail.pricing-flow.test.tsx',
  'src/pages/Products.pricing-flow.test.tsx',
  'supabase/migrations/20260722064814_wells_cost_basis_rollout_gate.sql',
  'tests/e2e/comprehensive-ui-workflow.spec.ts',
  'tests/e2e/concurrent-operations.spec.ts',
  'tests/e2e/mega-workflow.spec.ts',
  'tests/e2e/period-close-accounting.spec.ts',
  'tests/e2e/pricing-edge-cases.spec.ts',
  'tests/phase1a-ui/supplier-pricing-phase1a.spec.ts',
];
for (const safeFixturePath of safeFixturePaths) {
  const safeFixtureText = readFileSync(path.join(workspaceRoot, safeFixturePath), 'utf8');
  const headBlobText = execFileSync('git', ['show', `HEAD:${safeFixturePath}`], { cwd: workspaceRoot, encoding: 'utf8' });
  const crlfText = headBlobText.replace(/\n/g, '\r\n');
  assert.equal(hasCatalogRowSignature(safeFixtureText), true, `${safeFixturePath} must have generic signature`);
  assert.equal(hasCatalogRowSignature(headBlobText), true, `${safeFixturePath} HEAD blob must have generic signature`);
  assert.equal(canonicalTextSha256(safeFixtureText), canonicalTextSha256(headBlobText), `${safeFixturePath} worktree and HEAD canonical hashes must match`);
  assert.equal(canonicalTextSha256(crlfText), canonicalTextSha256(headBlobText), `${safeFixturePath} CRLF canonical hash must match`);
  assert.equal(isKnownSafeCatalogSignature(safeFixturePath, safeFixtureText), true, `${safeFixturePath} worktree must match allowlist hash`);
  assert.equal(isKnownSafeCatalogSignature(safeFixturePath, headBlobText), true, `${safeFixturePath} HEAD blob must match allowlist hash`);
  assert.equal(isKnownSafeCatalogSignature(safeFixturePath, crlfText), true, `${safeFixturePath} CRLF equivalent must match allowlist hash`);
  assert.deepEqual(detectPrivateCatalogFile(safeFixturePath, safeFixtureText), [], `${safeFixturePath} must be exactly allowlisted`);
  assert.deepEqual(detectPrivateCatalogFile(safeFixturePath, headBlobText), [], `${safeFixturePath} HEAD blob must be allowlisted`);
  assert.deepEqual(detectPrivateCatalogFile(safeFixturePath, crlfText), [], `${safeFixturePath} CRLF equivalent must be allowlisted`);
  assert.equal(isKnownSafeCatalogSignature(safeFixturePath, `${safeFixtureText}\nX`), false, `${safeFixturePath} content append must lose exemption`);
  assert.ok(detectPrivateCatalogFile(safeFixturePath, `${safeFixtureText}\nX`).includes('catalog_row_signature'), `${safeFixturePath} content append must refuse`);
}

const manifestHeader = ['product_id', 'current_product', 'decisions', 'row_sha256'].join('|');
const renamedManifestTable = `${manifestHeader}\n${testUuid(42)}|{}|[]|a\n${testUuid(43)}|{}|[]|b`;
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

console.log('supplier-pricing-phase3-sanitized-privacy: generic signature regressions passed');
