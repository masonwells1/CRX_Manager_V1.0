#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, currentProduct, loadSnapshot, makeManifest, sha256, without } from './generate-supplier-pricing-phase3-classification-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'docs', 'audits', '2026-07-22-supplier-pricing-phase3-proposed-classification-manifest.json');
const snapshot = loadSnapshot();
const expected = makeManifest(snapshot);
const committedText = readFileSync(MANIFEST, 'utf8');
const manifest = JSON.parse(committedText);
if (committedText !== canonical(manifest)) throw new Error('manifest byte drift: canonical LF UTF-8 JSON required');
if (manifest.manifest_sha256 !== sha256(without(manifest, 'manifest_sha256'))) throw new Error('manifest SHA-256 drift');
if (committedText !== canonical(expected)) throw new Error('manifest content, count, ordering, row hash, or policy drift');
if (manifest.rows.length !== snapshot.products.length) throw new Error('manifest row count drift');
const ids = manifest.rows.map(row => row.product_id);
if (!ids.every((id, index) => index === 0 || ids[index - 1] < id)) throw new Error('manifest UUID order drift');
if (new Set(ids).size !== ids.length) throw new Error('manifest duplicate Product UUID');
for (const [index, row] of manifest.rows.entries()) {
  const sourceProduct = snapshot.products[index];
  if (row.row_sha256 !== sha256(without(row, 'row_sha256'))) throw new Error(`row SHA-256 drift: ${row.product_id}`);
  if (row.product_id !== sourceProduct.id) throw new Error(`row source identity drift: ${row.product_id}`);
  if (canonical(row.current_product) !== canonical(currentProduct(sourceProduct, snapshot.expected_old_phase3_defaults))) throw new Error(`row current Product drift: ${row.product_id}`);
  if (row.disposition !== 'unresolved' || row.proposed_phase3.return_policy !== 'unknown') throw new Error(`nonconservative classification drift: ${row.product_id}`);
  if (Object.values(row.field_decisions).some(decision => decision.approval !== 'pending_owner_review')) throw new Error(`approval drift: ${row.product_id}`);
}
console.log(`PHASE3_CLASSIFICATION_MANIFEST_VERIFY_PASS ${manifest.manifest_sha256} ${manifest.rows.length}`);
