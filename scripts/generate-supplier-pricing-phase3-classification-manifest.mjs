#!/usr/bin/env node
/** Deterministic, proposal-only Phase 3 classification manifest generator. */
import { readValidatedPrivateArtifact } from './supplier-pricing-phase3-private-artifacts.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert, canonical, loadValidatedSnapshot, POST_STAGE_A_MANIFEST_NAME, POST_STAGE_A_SNAPSHOT_NAME,
  PRE_STAGE_A_MANIFEST_NAME, PRE_STAGE_A_SNAPSHOT_NAME, PRE_STAGE_A_SNAPSHOT_FORMAT, POST_STAGE_A_SNAPSHOT_FORMAT, REPO_ROOT, parseExpectedV2Binding, sha256, stable, without, writePrivateArtifactAtomic,
} from './supplier-pricing-phase3-private-artifacts.mjs';

const PRE_STAGE_A_MANIFEST_FORMAT = 'crx-supplier-pricing-phase3-proposed-classification-manifest-v1';
export const POST_STAGE_A_MANIFEST_FORMAT = 'crx-supplier-pricing-phase3-post-stage-a-proposed-classification-manifest-v2';
const args = process.argv.slice(2);

export { canonical, sha256, stable, without };

export function loadSnapshot(file, binding = null) {
  return loadValidatedSnapshot(file, REPO_ROOT, binding);
}

function candidateEvidence(product) {
  const name = product.product_name || '';
  return {
    full_tote_text_candidate: /\b(?:full\s*tote|tote)\b/i.test(name),
    no_return_name_only_candidate: /\bno\s*return\b/i.test(name),
    source: 'product_name_text_only',
  };
}
function fieldDecision(proposedValue, evidence) {
  return { approval: 'pending_owner_review', evidence, proposed_value: proposedValue };
}
export function phase3Values(product, defaults) {
  return {
    is_full_tote_only: product.is_full_tote_only ?? defaults.is_full_tote_only,
    packaging_variant: product.packaging_variant ?? defaults.packaging_variant,
    product_family_id: product.product_family_id ?? defaults.product_family_id,
    return_policy: product.return_policy ?? defaults.return_policy,
  };
}
export function currentProduct(product, defaults) {
  return {
    active_return_statuses: product.active_return_statuses,
    container_size: product.container_size,
    container_type: product.container_type,
    container_unit: product.container_unit,
    id: product.id,
    inventory_unit: product.inventory_unit,
    is_active: product.is_active,
    pricing_version: product.pricing_version,
    product_form: product.product_form,
    product_name: product.product_name,
    sku: product.sku,
    unit_size: product.unit_size,
    updated_at: product.updated_at,
    current_phase3: phase3Values(product, defaults),
  };
}

function preStageAManifest(snapshot) {
  const defaults = snapshot.expected_old_phase3_defaults;
  const rows = snapshot.products.map(product => {
    const evidence = candidateEvidence(product);
    const unresolvedReason = evidence.no_return_name_only_candidate
      ? 'Name-only NO RETURN text is candidate evidence, not approved policy truth.'
      : evidence.full_tote_text_candidate
        ? 'Full-tote text is candidate evidence, not an activated metadata value.'
        : 'No unambiguous governed family or policy source exists in the pre-Stage-A snapshot.';
    const row = {
      active_return_precheck: { conflict: product.active_return_statuses.length > 0, statuses: product.active_return_statuses },
      confidence: 'low',
      current_product: currentProduct(product, defaults),
      disposition: 'unresolved',
      evidence: { candidate_evidence: evidence, source: 'pre_stage_a_product_snapshot', source_product_sha256: sha256(product) },
      expected_old_phase3: defaults,
      field_decisions: {
        disposition: fieldDecision('unresolved', 'pre_stage_a_snapshot_and_conservative_rule'),
        is_full_tote_only: fieldDecision(false, evidence.full_tote_text_candidate ? 'name_text_candidate_only' : 'no_approved_source'),
        packaging_variant: fieldDecision(null, 'no_approved_source'),
        product_family_id: fieldDecision(null, 'no_unambiguous_family_identity_evidence'),
        return_policy: fieldDecision('unknown', evidence.no_return_name_only_candidate ? 'name_only_no_return_candidate' : 'no_approved_policy_source'),
      },
      product_id: product.id,
      proposed_phase3: { is_full_tote_only: false, packaging_variant: null, product_family_id: null, return_policy: 'unknown' },
      reviewer_note: unresolvedReason,
    };
    return { ...row, row_sha256: sha256(row) };
  });
  const active = snapshot.products.filter(product => product.is_active).length;
  const inactive = snapshot.products.length - active;
  const noReturnCandidates = rows.filter(row => row.evidence.candidate_evidence.no_return_name_only_candidate).length;
  const fullToteCandidates = rows.filter(row => row.evidence.candidate_evidence.full_tote_text_candidate).length;
  const activeReturnConflicts = rows.filter(row => row.active_return_precheck.conflict).length;
  const manifest = {
    approval_state: 'all_fields_pending_owner_review', format: PRE_STAGE_A_MANIFEST_FORMAT,
    generated_from_snapshot_sha256: snapshot.snapshot_sha256, migration_high_water: snapshot.migration_high_water,
    provisional_warning: 'Pre-Stage-A proposal only. After the separately approved Stage A migration is applied, capture live read-only values with a future Stage-A-aware generator; this pre-Stage-A generator cannot consume that schema. This artifact does not approve, merge, apply, or activate any classification.',
    rows, snapshot_timestamp_utc: snapshot.snapshot_timestamp_utc,
    summary: { active_product_count: active, active_return_conflict_count: activeReturnConflicts, disposition_counts: { family_assigned: 0, standalone: 0, unresolved: rows.length }, full_tote_text_candidate_count: fullToteCandidates, inactive_product_count: inactive, name_only_no_return_candidate_count: noReturnCandidates, product_count: rows.length },
  };
  return { ...manifest, manifest_sha256: sha256(manifest) };
}

function postStageAManifest(snapshot) {
  const defaults = snapshot.expected_old_phase3_defaults;
  const rows = snapshot.products.map(product => {
    const expectedOld = phase3Values(product, defaults);
    const row = {
      active_return_precheck: { conflict: product.active_return_statuses.length > 0, statuses: product.active_return_statuses },
      confidence: 'low', current_product: currentProduct(product, defaults), disposition: 'unresolved',
      evidence: { source: 'post_stage_a_live_read_only_snapshot', source_product_sha256: sha256(product) },
      expected_old_phase3: expectedOld,
      field_decisions: {
        disposition: fieldDecision('unresolved', 'proposal_only_no_owner_approval'),
        is_full_tote_only: fieldDecision(false, 'proposal_only_no_owner_approval'),
        packaging_variant: fieldDecision(null, 'proposal_only_no_owner_approval'),
        product_family_id: fieldDecision(null, 'proposal_only_no_owner_approval'),
        return_policy: fieldDecision('unknown', 'proposal_only_no_owner_approval'),
      },
      product_id: product.id,
      proposed_phase3: { is_full_tote_only: false, packaging_variant: null, product_family_id: null, return_policy: 'unknown' },
      reviewer_note: 'Proposal only. Mason must make every row and field decision; this packet cannot authorize a migration.',
    };
    return { ...row, row_sha256: sha256(row) };
  });
  const active = snapshot.products.filter(product => product.is_active).length;
  const manifest = {
    approval_state: 'all_fields_pending_owner_review', format: POST_STAGE_A_MANIFEST_FORMAT,
    generated_from_snapshot_sha256: snapshot.snapshot_sha256, migration_high_water: snapshot.migration_high_water,
    provisional_warning: 'Post-Stage-A proposal only. This packet is not approval and cannot authorize, create, merge, apply, or activate a Stage C migration.',
    rows, snapshot_timestamp_utc: snapshot.capture_timestamp_utc,
    stage_a_migration_version: snapshot.stage_a_migration_version,
    summary: { active_product_count: active, active_return_conflict_count: rows.filter(row => row.active_return_precheck.conflict).length, disposition_counts: { family_assigned: 0, standalone: 0, unresolved: rows.length }, inactive_product_count: rows.length - active, product_count: rows.length },
  };
  return { ...manifest, manifest_sha256: sha256(manifest) };
}

export function makeManifest(snapshot) {
  if (snapshot.format === PRE_STAGE_A_SNAPSHOT_FORMAT) return preStageAManifest(snapshot);
  if (snapshot.format === POST_STAGE_A_SNAPSHOT_FORMAT) return postStageAManifest(snapshot);
  throw new Error('unsupported snapshot format');
}

function usageError() {
  throw new Error('disclosure-safe usage: --summary | --compare --snapshot <private-path> --manifest <private-path> | --write --snapshot <private-path> --manifest <private-path>');
}

function parseCli(argumentsList) {
  const values = { '--summary': false, '--compare': false, '--write': false, '--snapshot': null, '--manifest': null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    assert(Object.hasOwn(values, token), 'disclosure-safe usage: unknown flag or positional argument');
    if (token === '--summary' || token === '--compare' || token === '--write') { assert(values[token] === false, 'disclosure-safe usage: duplicate mode'); values[token] = true; continue; }
    assert(values[token] === null, 'disclosure-safe usage: duplicate option');
    const value = argumentsList[++index]; assert(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'disclosure-safe usage: option value required'); values[token] = value;
  }
  assert(Number(values['--summary']) + Number(values['--compare']) + Number(values['--write']) === 1, 'disclosure-safe usage: exactly one mode is required');
  return values;
}

function main() {
  let cli; try { cli = parseCli(args); } catch (_error) { usageError(); }
  const snapshotPath = cli['--snapshot'] || (process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR ? path.join(process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR, POST_STAGE_A_SNAPSHOT_NAME) : null);
  assert(snapshotPath, 'private snapshot path required: set CRX_PHASE3_PRIVATE_ARTIFACT_DIR or pass --snapshot <path>');
  const snapshot = loadSnapshot(snapshotPath, path.basename(snapshotPath) === POST_STAGE_A_SNAPSHOT_NAME ? parseExpectedV2Binding() : null);
  const format = snapshot.format;
  const manifestName = format === POST_STAGE_A_SNAPSHOT_FORMAT ? POST_STAGE_A_MANIFEST_NAME : PRE_STAGE_A_MANIFEST_NAME;
  const manifestPath = cli['--manifest'] || (process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR ? path.join(process.env.CRX_PHASE3_PRIVATE_ARTIFACT_DIR, manifestName) : null);
  const manifest = makeManifest(snapshot);
  const count = manifest.summary.product_count;
  if (cli['--summary']) {
    assert(!cli['--manifest'], 'disclosure-safe usage: summary accepts no manifest path');
    console.log(`PHASE3_CLASSIFICATION_MANIFEST_SUMMARY count=${count} sha256=${manifest.manifest_sha256}`);
    return;
  }
  if (cli['--compare']) {
    assert(manifestPath, 'private manifest path required');
    assert(readValidatedPrivateArtifact(manifestPath, manifestName, REPO_ROOT).text === canonical(manifest), 'manifest reproducibility drift');
    console.log(`PHASE3_CLASSIFICATION_MANIFEST_REPRODUCIBLE_PASS count=${count} sha256=${manifest.manifest_sha256}`);
    return;
  }
  if (cli['--write']) {
    assert(manifestPath, 'private manifest path required');
    const target = writePrivateArtifactAtomic(manifestPath, manifestName, canonical(manifest), { repoRoot: REPO_ROOT });
    console.log(`PHASE3_CLASSIFICATION_MANIFEST_WRITE_PASS count=${count} sha256=${manifest.manifest_sha256} path=${target}`);
    return;
  }
  usageError();
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main();
