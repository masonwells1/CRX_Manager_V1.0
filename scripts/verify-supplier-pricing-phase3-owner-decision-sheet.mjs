#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, makeManifest } from './generate-supplier-pricing-phase3-classification-manifest.mjs';
import { buildOwnerDecisionSheet, ownerDecisionSheetHash } from './generate-supplier-pricing-phase3-owner-decision-sheet.mjs';
import { assert, OWNER_DECISION_SHEET_NAME, parseNamedPathOptions, POST_STAGE_A_SNAPSHOT_NAME, readValidatedPrivateArtifact, REPO_ROOT } from './supplier-pricing-phase3-private-artifacts.mjs';

export function verifyOwnerDecisionSheet(manifest, text) {
  const expected = buildOwnerDecisionSheet(manifest);
  assert(text === expected, 'owner decision sheet count, order, UUID, current-value, hash, or pending-default drift');
  return { count: manifest.rows.length, hash: ownerDecisionSheetHash(text) };
}
function main() {
  const cli = parseNamedPathOptions(process.argv.slice(2), ['--snapshot', '--sheet']);
  const snapshotPath = cli['--snapshot'] || (process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR ? path.join(process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR, POST_STAGE_A_SNAPSHOT_NAME) : null);
  const sheetPath = cli['--sheet'] || (process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR ? path.join(process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR, OWNER_DECISION_SHEET_NAME) : null);
  assert(snapshotPath, 'private post-Stage-A snapshot path required');
  const result = verifyOwnerDecisionSheet(makeManifest(loadSnapshot(snapshotPath)), readValidatedPrivateArtifact(sheetPath, OWNER_DECISION_SHEET_NAME, REPO_ROOT).text);
  console.log(`PHASE3_OWNER_DECISION_SHEET_VERIFY_PASS count=${result.count} sha256=${result.hash}`);
}
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main();
