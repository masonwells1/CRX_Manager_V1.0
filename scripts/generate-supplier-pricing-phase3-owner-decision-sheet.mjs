#!/usr/bin/env node
/** Deterministic private owner worksheet. It is neither approval nor SQL. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, loadSnapshot, makeManifest, sha256 } from './generate-supplier-pricing-phase3-classification-manifest.mjs';
import { assert, OWNER_DECISION_HEADERS, OWNER_DECISION_SHEET_NAME, parseNamedPathOptions, POST_STAGE_A_SNAPSHOT_NAME, REPO_ROOT, writePrivateArtifactAtomic } from './supplier-pricing-phase3-private-artifacts.mjs';

export const OWNER_DECISION_SHEET_FORMAT = 'crx-supplier-pricing-phase3-owner-decision-sheet-v1';
export { OWNER_DECISION_HEADERS };
export const OWNER_DECISION_PENDING_HEADERS = [
  'disposition_decision', 'family_decision', 'packaging_decision', 'tote_only_decision', 'return_policy_decision', 'unresolved_acknowledgment', 'overall_approval_state',
];

export function spreadsheetSafe(value) {
  const text = value == null ? '' : String(value);
  return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
}
export function csvCell(value) {
  const text = spreadsheetSafe(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function buildOwnerDecisionSheet(manifest) {
  assert(manifest.format === 'crx-supplier-pricing-phase3-post-stage-a-proposed-classification-manifest-v2', 'owner sheet requires a post-Stage-A v2 proposal manifest');
  assert(manifest.approval_state === 'all_fields_pending_owner_review', 'owner sheet requires pending-only manifest');
  const lines = [OWNER_DECISION_HEADERS.join(',')];
  for (const row of manifest.rows) {
    const product = row.current_product;
    const current = row.expected_old_phase3;
    const values = [
      row.product_id, product.sku, product.product_name, product.product_form, product.container_size, product.container_type, product.container_unit, product.unit_size, product.inventory_unit, product.is_active, product.pricing_version, product.updated_at,
      current.product_family_id, current.return_policy, current.packaging_variant, current.is_full_tote_only, product.active_return_statuses.join('|'),
      'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', '', 'PENDING',
    ];
    lines.push(values.map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
export function ownerDecisionSheetHash(sheetText) {
  return sha256({ format: OWNER_DECISION_SHEET_FORMAT, csv: sheetText });
}

function main() {
  const cli = parseNamedPathOptions(process.argv.slice(2), ['--snapshot', '--sheet']);
  const snapshotPath = cli['--snapshot'] || (process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR ? path.join(process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR, POST_STAGE_A_SNAPSHOT_NAME) : null);
  assert(snapshotPath, 'private post-Stage-A snapshot path required');
  const outputPath = cli['--sheet'] || (process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR ? path.join(process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR, OWNER_DECISION_SHEET_NAME) : null);
  const snapshot = loadSnapshot(snapshotPath);
  const manifest = makeManifest(snapshot);
  const sheet = buildOwnerDecisionSheet(manifest);
  const target = writePrivateArtifactAtomic(outputPath, OWNER_DECISION_SHEET_NAME, sheet, { repoRoot: REPO_ROOT });
  console.log(`PHASE3_OWNER_DECISION_SHEET_WRITE_PASS count=${manifest.rows.length} sha256=${ownerDecisionSheetHash(sheet)} path=${target}`);
}
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main();
