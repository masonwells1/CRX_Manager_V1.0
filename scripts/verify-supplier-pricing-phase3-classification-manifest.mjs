#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, currentProduct, loadSnapshot, makeManifest, phase3Values, sha256, without } from './generate-supplier-pricing-phase3-classification-manifest.mjs';
import { assert, parseNamedPathOptions, POST_STAGE_A_MANIFEST_NAME, POST_STAGE_A_SNAPSHOT_NAME, PRE_STAGE_A_MANIFEST_NAME, readValidatedPrivateArtifact, REPO_ROOT } from './supplier-pricing-phase3-private-artifacts.mjs';

export function verifyManifest(snapshot, committedText) {
  const expected = makeManifest(snapshot);
  const manifest = JSON.parse(committedText);
  assert(committedText === canonical(manifest), 'manifest byte drift: canonical LF UTF-8 JSON required');
  assert(manifest.manifest_sha256 === sha256(without(manifest, 'manifest_sha256')), 'manifest SHA-256 drift');
  assert(committedText === canonical(expected), 'manifest content, count, ordering, row hash, expected-old, or policy drift');
  assert(manifest.rows.length === snapshot.products.length, 'manifest row count drift');
  const ids = manifest.rows.map(row => row.product_id);
  assert(ids.every((id, index) => index === 0 || ids[index - 1] < id), 'manifest UUID order drift');
  assert(new Set(ids).size === ids.length, 'manifest duplicate Product UUID');
  for (const [index, row] of manifest.rows.entries()) {
    const sourceProduct = snapshot.products[index];
    assert(row.row_sha256 === sha256(without(row, 'row_sha256')), `row ${index + 1} SHA-256 drift`);
    assert(row.product_id === sourceProduct.id, `row ${index + 1} source identity drift`);
    assert(canonical(row.current_product) === canonical(currentProduct(sourceProduct, snapshot.expected_old_phase3_defaults)), `row ${index + 1} current Product drift`);
    assert(canonical(row.expected_old_phase3) === canonical(phase3Values(sourceProduct, snapshot.expected_old_phase3_defaults)), `row ${index + 1} expected-old Phase 3 drift`);
    assert(row.disposition === 'unresolved' && canonical(row.proposed_phase3) === canonical({ is_full_tote_only: false, packaging_variant: null, product_family_id: null, return_policy: 'unknown' }), `row ${index + 1} nonconservative classification drift`);
    assert(Object.values(row.field_decisions).every(decision => decision.approval === 'pending_owner_review'), `row ${index + 1} approval drift`);
  }
  return { count: manifest.rows.length, hash: manifest.manifest_sha256 };
}

function main() {
  const cli = parseNamedPathOptions(process.argv.slice(2), ['--snapshot', '--manifest']);
  const snapshotPath = cli['--snapshot'] || (process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR ? path.join(process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR, POST_STAGE_A_SNAPSHOT_NAME) : null);
  assert(snapshotPath, 'private snapshot path required: set CRX_PHASE3_PRIVATE_ARTIFACT_DIR or pass --snapshot <path>');
  const snapshot = loadSnapshot(snapshotPath);
  const manifestName = snapshot.format.includes('post-stage-a') ? POST_STAGE_A_MANIFEST_NAME : PRE_STAGE_A_MANIFEST_NAME;
  const manifestPath = cli['--manifest'] || (process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR ? path.join(process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR, manifestName) : null);
  const result = verifyManifest(snapshot, readValidatedPrivateArtifact(manifestPath, manifestName, REPO_ROOT).text);
  console.log(`PHASE3_CLASSIFICATION_MANIFEST_VERIFY_PASS count=${result.count} sha256=${result.hash}`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main();
