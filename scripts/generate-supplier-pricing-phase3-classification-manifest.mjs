#!/usr/bin/env node
/**
 * Deterministic, proposal-only Phase 3 classification packet generator.
 * It never connects to Supabase. Capture is a separate, reviewed read-only
 * query. --write is a deterministic, local artifact materialization mode.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(ROOT, 'docs', 'audits', '2026-07-22-supplier-pricing-phase3-product-snapshot.json');
const MANIFEST = path.join(ROOT, 'docs', 'audits', '2026-07-22-supplier-pricing-phase3-proposed-classification-manifest.json');
const args = new Set(process.argv.slice(2));
const snapshotPath = process.argv.includes('--snapshot') ? process.argv[process.argv.indexOf('--snapshot') + 1] : SNAPSHOT;

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
export function canonical(value) { return `${JSON.stringify(stable(value), null, 2)}\n`; }
export function sha256(value) { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
export function without(object, key) { const copy = { ...object }; delete copy[key]; return copy; }
export function assert(condition, message) { if (!condition) throw new Error(message); }

export function loadSnapshot(file = snapshotPath) {
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert(snapshot.format === 'crx-supplier-pricing-phase3-pre-stage-a-product-snapshot-v1', 'unsupported snapshot format');
  assert(Array.isArray(snapshot.products) && snapshot.products.length > 0, 'snapshot has no products');
  const ids = snapshot.products.map(product => product.id);
  assert(ids.every((id, index) => index === 0 || ids[index - 1] < id), 'snapshot Product UUIDs are not strictly sorted');
  assert(new Set(ids).size === ids.length, 'snapshot has duplicate Product UUIDs');
  assert(snapshot.snapshot_sha256 === sha256(without(snapshot, 'snapshot_sha256')), 'snapshot SHA-256 drift');
  return snapshot;
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
    current_phase3: defaults,
  };
}
export function makeManifest(snapshot) {
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
      evidence: {
        candidate_evidence: evidence,
        source: 'pre_stage_a_product_snapshot',
        source_product_sha256: sha256(product),
      },
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
    approval_state: 'all_fields_pending_owner_review',
    format: 'crx-supplier-pricing-phase3-proposed-classification-manifest-v1',
    generated_from_snapshot_sha256: snapshot.snapshot_sha256,
    migration_high_water: snapshot.migration_high_water,
    provisional_warning: 'Pre-Stage-A proposal only. Regenerate from the live Stage A schema after the separately approved migration is applied; this artifact does not approve, merge, apply, or activate any classification.',
    rows,
    snapshot_timestamp_utc: snapshot.snapshot_timestamp_utc,
    summary: {
      active_product_count: active,
      active_return_conflict_count: activeReturnConflicts,
      disposition_counts: { family_assigned: 0, standalone: 0, unresolved: rows.length },
      full_tote_text_candidate_count: fullToteCandidates,
      inactive_product_count: inactive,
      name_only_no_return_candidate_count: noReturnCandidates,
      product_count: rows.length,
    },
  };
  return { ...manifest, manifest_sha256: sha256(manifest) };
}

function main() {
  const manifest = makeManifest(loadSnapshot());
  if (args.has('--compare')) {
    const committed = readFileSync(MANIFEST, 'utf8');
    assert(committed === canonical(manifest), 'manifest reproducibility drift');
    console.log(`PHASE3_CLASSIFICATION_MANIFEST_REPRODUCIBLE_PASS ${manifest.manifest_sha256}`);
    return;
  }
  if (args.has('--summary')) {
    console.log(JSON.stringify({ manifest_sha256: manifest.manifest_sha256, summary: manifest.summary }, null, 2));
    return;
  }
  const output = canonical(manifest);
  if (args.has('--write')) {
    writeFileSync(MANIFEST, output, { encoding: 'utf8' });
    console.log(`PHASE3_CLASSIFICATION_MANIFEST_WRITE_PASS ${manifest.manifest_sha256}`);
    return;
  }
  if (args.has('--slice')) {
    const offset = Number(process.argv[process.argv.indexOf('--slice') + 1]);
    const length = Number(process.argv[process.argv.indexOf('--slice') + 2]);
    assert(Number.isInteger(offset) && offset >= 0 && Number.isInteger(length) && length > 0, 'invalid --slice offset/length');
    process.stdout.write(output.slice(offset, offset + length));
    return;
  }
  process.stdout.write(output);
}
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main();
