#!/usr/bin/env node
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildPostStageASnapshot, parseSupabaseJson, POST_STAGE_A_SNAPSHOT_FORMAT } from './capture-supplier-pricing-phase3-post-stage-a-snapshot.mjs';
import { canonical, loadSnapshot, makeManifest, sha256 } from './generate-supplier-pricing-phase3-classification-manifest.mjs';
import { buildOwnerDecisionSheet, ownerDecisionSheetHash } from './generate-supplier-pricing-phase3-owner-decision-sheet.mjs';
import { verifyManifest } from './verify-supplier-pricing-phase3-classification-manifest.mjs';
import { verifyOwnerDecisionSheet } from './verify-supplier-pricing-phase3-owner-decision-sheet.mjs';
import { checkPrivateArtifactContainment } from './check-supplier-pricing-phase3-private-artifacts.mjs';
import { assertExternalArtifactPath, loadValidatedSnapshot, OWNER_DECISION_SHEET_NAME, POST_STAGE_A_MANIFEST_NAME, POST_STAGE_A_SNAPSHOT_NAME, PRE_STAGE_A_SNAPSHOT_NAME, readValidatedPrivateArtifact, REPO_ROOT, validatePostStageASnapshot, without, writePrivateArtifactAtomic } from './supplier-pricing-phase3-private-artifacts.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'crx-phase3c-synthetic-'));
const external = path.join(temp, 'external'); mkdirSync(external);
const id1 = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';
const secretName = 'LEAK-NAME-ALPHA'; const secretSku = 'LEAK-SKU-BRAVO';
function product(id, name = 'Synthetic One', sku = 'SYN-1') { return { id, sku, product_name: name, product_form: 'liquid', container_size: 1, container_type: 'Jug', container_unit: 'gal', unit_size: '1 gal', inventory_unit: 'gal', is_active: true, pricing_version: 7, updated_at: '2026-07-26T00:00:00.000Z', product_family_id: null, return_policy: 'unknown', packaging_variant: null, is_full_tote_only: false, active_return_statuses: [] }; }
function payload(products = [product(id1), product(id2, 'Synthetic Two', 'SYN-2')]) { return { format: POST_STAGE_A_SNAPSHOT_FORMAT, metadata: { stage_a_ledger_present: true, migration_high_water: '20260726223520', product_families_count: 0, supplier_cost_basis_enabled: false, capture_timestamp_utc: '2026-07-26T00:00:00.000000Z' }, products }; }
function throws(fn, message = 'invalid|drift|must|snapshot|private') { assert.throws(fn, new RegExp(message)); }
function writeSnapshot(snapshot, name = POST_STAGE_A_SNAPSHOT_NAME, directory = external) { mkdirSync(directory, { recursive: true }); const file = path.join(directory, name); writeFileSync(file, canonical(snapshot), 'utf8'); return file; }
function rehash(snapshot) { return { ...snapshot, snapshot_sha256: sha256(without(snapshot, 'snapshot_sha256')) }; }
function run(args, env = {}) { return spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...env } }); }
function sanitizedFixtureGitEnv(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) if (key.toUpperCase().startsWith('GIT_')) delete environment[key];
  return environment;
}
function git(root, args, inheritedEnv = {}) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedFixtureGitEnv(inheritedEnv) }); }
function fixtureGitExecute(command, args, options = {}) { return execFileSync(command, args, { ...options, env: sanitizedFixtureGitEnv(options.env) }); }
function fixtureRepo(name, inheritedEnv = {}) {
  const root = path.join(temp, name); mkdirSync(root); git(root, ['init', '--quiet'], inheritedEnv); git(root, ['config', 'user.email', 'synthetic@example.invalid'], inheritedEnv); git(root, ['config', 'user.name', 'Synthetic'], inheritedEnv);
  writeFileSync(path.join(root, 'README.md'), 'synthetic baseline\n'); git(root, ['add', 'README.md'], inheritedEnv); git(root, ['commit', '--quiet', '-m', 'synthetic baseline'], inheritedEnv);
  return root;
}
function fixtureContainment(root, inheritedEnv = {}) { return checkPrivateArtifactContainment({ root, execute: (command, args, options) => fixtureGitExecute(command, args, { ...options, env: inheritedEnv }) }); }
function containmentFails(root, expectedPath, expectedReason, inheritedEnv = {}) {
  assert.throws(() => fixtureContainment(root, inheritedEnv), error => error.message.includes(expectedPath) && error.message.includes(expectedReason));
}
function assertRejectedWithoutSyntheticDisclosure(script, args) {
  const result = run([script, ...args]);
  assert.notEqual(result.status, 0, `${script} accepted invalid arguments`);
  const output = `${result.stdout}${result.stderr}`;
  assert(!output.includes(secretName) && !output.includes(secretSku) && !output.includes(id1), `${script} exposed synthetic identifiers`);
}

try {
  const snapshot = buildPostStageASnapshot(payload());
  const snapshotFile = writeSnapshot(snapshot);
  assert.deepEqual(loadSnapshot(snapshotFile), snapshot);
  assert.deepEqual(validatePostStageASnapshot(snapshot), snapshot);
  const manifest = makeManifest(snapshot); const sheet = buildOwnerDecisionSheet(manifest);
  assert.deepEqual(verifyManifest(snapshot, canonical(manifest)), { count: 2, hash: manifest.manifest_sha256 });
  assert.deepEqual(verifyOwnerDecisionSheet(manifest, sheet), { count: 2, hash: ownerDecisionSheetHash(sheet) });
  assert.equal(parseSupabaseJson(JSON.stringify({ boundary: 'public', rows: [{ phase3_snapshot: payload() }], warning: '' })).format, POST_STAGE_A_SNAPSHOT_FORMAT);
  throws(() => parseSupabaseJson(JSON.stringify({ boundary: 'public', rows: [{ phase3_snapshot: payload(), extra: true }], warning: '' })), 'envelope');

  // Every saved v2 contract must reject a tampered-but-rehashed file before a consumer uses it.
  const mutations = [
    value => { value.unexpected = true; }, value => { value.format = 'wrong'; }, value => { value.stage_a_migration_version = '20260723193311'; }, value => { value.stage_a_ledger_present = false; },
    value => { value.migration_high_water = '20260723193312x'; }, value => { value.product_families_count = 1; }, value => { value.supplier_cost_basis_enabled = true; }, value => { value.expected_old_phase3_defaults.return_policy = 'returnable'; },
    value => { value.capture_timestamp_utc = '2026-07-26T00:00:00.000Z'; }, value => { value.products = []; }, value => { value.products[0].extra = true; }, value => { value.products[0].id = 'not-a-uuid'; },
    value => { value.products[0].product_form = 'other'; }, value => { value.products[0].container_size = '1'; }, value => { value.products[0].container_type = 'jug'; }, value => { value.products[0].pricing_version = -1; },
    value => { value.products[0].updated_at = ''; }, value => { value.products[0].active_return_statuses = ['received', 'approved']; }, value => { value.products[0].return_policy = 'returnable'; }, value => { value.products.reverse(); },
  ];
  for (const [index, mutate] of mutations.entries()) { const bad = structuredClone(snapshot); mutate(bad); const file = writeSnapshot(rehash(bad), POST_STAGE_A_SNAPSHOT_NAME, path.join(temp, `bad-${Math.random().toString(16).slice(2)}`)); let rejected = false; try { const loaded = loadSnapshot(file); makeManifest(loaded); } catch (_error) { rejected = true; } assert(rejected, `tampered rehashed snapshot mutation ${index} was accepted`); }

  // Input admission is exact: no relative, repo-resident, case-variant, symlink, or hard-link snapshot can be read.
  throws(() => loadSnapshot(POST_STAGE_A_SNAPSHOT_NAME), 'absolute');
  const repoSnapshot = path.join(REPO_ROOT, POST_STAGE_A_SNAPSHOT_NAME); writeFileSync(repoSnapshot, canonical(snapshot), 'utf8');
  try { throws(() => loadSnapshot(repoSnapshot), 'outside'); } finally { rmSync(repoSnapshot); }
  throws(() => loadSnapshot(path.join(external, POST_STAGE_A_SNAPSHOT_NAME.toUpperCase())), 'approved');
  const hardSource = path.join(temp, 'hard-source.json'); writeFileSync(hardSource, canonical(snapshot)); const hardSnapshot = path.join(external, 'hard', POST_STAGE_A_SNAPSHOT_NAME); mkdirSync(path.dirname(hardSnapshot)); linkSync(hardSource, hardSnapshot); throws(() => loadSnapshot(hardSnapshot), 'hard-linked');
  try { const linked = path.join(external, 'link', POST_STAGE_A_SNAPSHOT_NAME); mkdirSync(path.dirname(linked)); symlinkSync(hardSource, linked, 'file'); throws(() => loadSnapshot(linked), 'symbolic'); } catch (error) { if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error; }

  // A pathname replacement after descriptor validation is detected before bytes are consumed.
  const readRaceTarget = path.join(REPO_ROOT, 'phase3c-read-race-target.synthetic'); writeFileSync(readRaceTarget, 'repository read target unchanged');
  const readRaceArtifact = writeSnapshot(snapshot, POST_STAGE_A_SNAPSHOT_NAME, path.join(temp, 'read-race'));
  try {
    throws(() => readValidatedPrivateArtifact(readRaceArtifact, POST_STAGE_A_SNAPSHOT_NAME, REPO_ROOT, { beforeRead: () => { rmSync(readRaceArtifact); linkSync(readRaceTarget, readRaceArtifact); } }), 'hard-linked|changed');
    assert.equal(readFileSync(readRaceTarget, 'utf8'), 'repository read target unchanged');
  } finally { rmSync(readRaceTarget, { force: true }); }

  // Atomic output must not follow/rewrite a repository hard-link, including a deterministic last-moment replacement.
  const repoTarget = path.join(REPO_ROOT, 'phase3c-atomic-target.synthetic'); writeFileSync(repoTarget, 'repository target unchanged');
  try {
    const output = path.join(external, POST_STAGE_A_MANIFEST_NAME); linkSync(repoTarget, output); throws(() => writePrivateArtifactAtomic(output, POST_STAGE_A_MANIFEST_NAME, 'new bytes'), 'hard-linked'); assert.equal(readFileSync(repoTarget, 'utf8'), 'repository target unchanged'); rmSync(output);
    writeFileSync(output, 'initial private bytes');
    throws(() => writePrivateArtifactAtomic(output, POST_STAGE_A_MANIFEST_NAME, 'new bytes', { beforeFinalValidation: () => { rmSync(output); linkSync(repoTarget, output); } }), 'hard-linked');
    assert.equal(readFileSync(repoTarget, 'utf8'), 'repository target unchanged');
  } finally { rmSync(repoTarget, { force: true }); }

  // Renamed private content is rejected from the index and worktree without scanning arbitrary directories.
  const realRepoWorktreeBefore = git(REPO_ROOT, ['rev-parse', '--is-inside-work-tree']); const realRepoBareBefore = git(REPO_ROOT, ['config', '--bool', 'core.bare']);
  assert.equal(realRepoWorktreeBefore.trim(), 'true'); assert.equal(realRepoBareBefore.trim(), 'false');
  const hostileGitContext = {
    GIT_DIR: path.join(REPO_ROOT, '.git'), GIT_WORK_TREE: REPO_ROOT,
    GIT_INDEX_FILE: path.join(REPO_ROOT, '.git', 'index'), GIT_COMMON_DIR: path.join(REPO_ROOT, '.git'),
  };
  const hostileRepo = fixtureRepo('containment-hostile-git-context', hostileGitContext);
  assert.equal(git(hostileRepo, ['rev-parse', '--is-inside-work-tree'], hostileGitContext).trim(), 'true');
  assert.equal(path.resolve(git(hostileRepo, ['rev-parse', '--show-toplevel'], hostileGitContext).trim()), path.resolve(hostileRepo));
  assert.equal(git(hostileRepo, ['config', '--bool', 'core.bare'], hostileGitContext).trim(), 'false');
  assert.equal(git(hostileRepo, ['log', '-1', '--format=%s'], hostileGitContext).trim(), 'synthetic baseline');
  assert.match(git(hostileRepo, ['show', '--format=', '--name-only', 'HEAD'], hostileGitContext), /^README\.md$/m);
  assert.doesNotThrow(() => fixtureContainment(hostileRepo, hostileGitContext));
  assert.equal(git(REPO_ROOT, ['rev-parse', '--is-inside-work-tree']).trim(), 'true'); assert.equal(git(REPO_ROOT, ['config', '--bool', 'core.bare']).trim(), 'false');
  const stagedRepo = fixtureRepo('containment-staged'); const stagedPath = 'renamed-public.txt'; writeFileSync(path.join(stagedRepo, stagedPath), canonical({ format: POST_STAGE_A_SNAPSHOT_FORMAT })); git(stagedRepo, ['add', stagedPath]); containmentFails(stagedRepo, stagedPath, 'approved private JSON format signature');
  const divergenceRepo = fixtureRepo('containment-divergence'); const divergencePath = 'sanitized-after-stage.txt'; writeFileSync(path.join(divergenceRepo, divergencePath), canonical({ format: 'crx-supplier-pricing-phase3-post-stage-a-proposed-classification-manifest-v2' })); git(divergenceRepo, ['add', divergencePath]); writeFileSync(path.join(divergenceRepo, divergencePath), 'sanitized worktree copy\n'); containmentFails(divergenceRepo, divergencePath, 'approved private JSON format signature');
  const untrackedRepo = fixtureRepo('containment-untracked'); const untrackedPath = 'renamed-owner-sheet.txt'; writeFileSync(path.join(untrackedRepo, untrackedPath), canonical({ format: 'crx-supplier-pricing-phase3-proposed-classification-manifest-v1' })); containmentFails(untrackedRepo, untrackedPath, 'approved private JSON format signature');
  const headerRepo = fixtureRepo('containment-owner-header'); const headerPath = 'renamed-csv.txt'; writeFileSync(path.join(headerRepo, headerPath), buildOwnerDecisionSheet(manifest).split('\n', 1)[0]); containmentFails(headerRepo, headerPath, 'owner decision sheet CSV header');
  const benignRepo = fixtureRepo('containment-benign'); writeFileSync(path.join(benignRepo, 'public.md'), `Public format name: ${POST_STAGE_A_SNAPSHOT_FORMAT}\n`); writeFileSync(path.join(benignRepo, 'source.mjs'), `const format = ${JSON.stringify(POST_STAGE_A_SNAPSHOT_FORMAT)};\n`); assert.doesNotThrow(() => fixtureContainment(benignRepo));

  // Writer and verifier entry points use the same validated loaders and reveal no rejected row data.
  const privateDir = path.join(temp, 'private-cli'); mkdirSync(privateDir); const cliSnapshot = writeSnapshot(snapshot, POST_STAGE_A_SNAPSHOT_NAME, privateDir);
  const writeResult = run(['scripts/generate-supplier-pricing-phase3-classification-manifest.mjs', '--write', '--snapshot', cliSnapshot, '--manifest', path.join(privateDir, POST_STAGE_A_MANIFEST_NAME)]); assert.equal(writeResult.status, 0, writeResult.stderr);
  assert.equal(run(['scripts/generate-supplier-pricing-phase3-classification-manifest.mjs', '--compare', '--snapshot', cliSnapshot, '--manifest', path.join(privateDir, POST_STAGE_A_MANIFEST_NAME)]).status, 0);
  assert.equal(run(['scripts/verify-supplier-pricing-phase3-classification-manifest.mjs', '--snapshot', cliSnapshot, '--manifest', path.join(privateDir, POST_STAGE_A_MANIFEST_NAME)]).status, 0);
  const cliSheet = path.join(privateDir, OWNER_DECISION_SHEET_NAME); assert.equal(run(['scripts/generate-supplier-pricing-phase3-owner-decision-sheet.mjs', '--snapshot', cliSnapshot, '--sheet', cliSheet]).status, 0);
  assert.equal(run(['scripts/verify-supplier-pricing-phase3-owner-decision-sheet.mjs', '--snapshot', cliSnapshot, '--sheet', cliSheet]).status, 0);
  for (const args of [[], ['--summary', '--write'], ['--write', '--write'], ['--write', '--snapshot'], ['--write', 'junk'], ['--wat'], ['--summary', '--manifest', 'x'], ['--write', '--snapshot', cliSnapshot, '--snapshot', cliSnapshot, '--manifest', path.join(privateDir, POST_STAGE_A_MANIFEST_NAME)]]) assert.notEqual(run(['scripts/generate-supplier-pricing-phase3-classification-manifest.mjs', ...args]).status, 0);
  const invalidPathOptions = [
    ['--snapshot', cliSnapshot, '--snapshot', cliSnapshot], ['--unknown'], ['--snapshot'], ['positional-junk'],
  ];
  for (const args of [['--unknown', '--unknown'], ['--snapshot'], ['positional-junk']]) assertRejectedWithoutSyntheticDisclosure('scripts/capture-supplier-pricing-phase3-post-stage-a-snapshot.mjs', args);
  for (const args of invalidPathOptions) assertRejectedWithoutSyntheticDisclosure('scripts/generate-supplier-pricing-phase3-classification-manifest.mjs', args);
  for (const args of [...invalidPathOptions, ['--manifest', path.join(privateDir, POST_STAGE_A_MANIFEST_NAME), '--manifest', path.join(privateDir, POST_STAGE_A_MANIFEST_NAME)]]) assertRejectedWithoutSyntheticDisclosure('scripts/verify-supplier-pricing-phase3-classification-manifest.mjs', args);
  for (const args of [...invalidPathOptions, ['--sheet', cliSheet, '--sheet', cliSheet]]) assertRejectedWithoutSyntheticDisclosure('scripts/generate-supplier-pricing-phase3-owner-decision-sheet.mjs', args);
  for (const args of [...invalidPathOptions, ['--sheet', cliSheet, '--sheet', cliSheet]]) assertRejectedWithoutSyntheticDisclosure('scripts/verify-supplier-pricing-phase3-owner-decision-sheet.mjs', args);
  const leak = buildPostStageASnapshot(payload([product(id1, secretName, secretSku), product(id2)])); const leakFile = writeSnapshot(leak, POST_STAGE_A_SNAPSHOT_NAME, path.join(temp, 'leak')); const badManifest = canonical({ ...makeManifest(leak), rows: [{ ...makeManifest(leak).rows[0], product_id: 'bad' }] }); const output = run(['--input-type=module', '--eval', `import {loadSnapshot} from './scripts/generate-supplier-pricing-phase3-classification-manifest.mjs'; import {verifyManifest} from './scripts/verify-supplier-pricing-phase3-classification-manifest.mjs'; try { verifyManifest(loadSnapshot(${JSON.stringify(leakFile)}), ${JSON.stringify(badManifest)}); } catch (e) { console.error(e.message); process.exit(1); }`]); assert.notEqual(output.status, 0); assert(!`${output.stdout}${output.stderr}`.includes(secretName) && !`${output.stdout}${output.stderr}`.includes(secretSku) && !`${output.stdout}${output.stderr}`.includes(id1));

  // Frozen historical v1 stays deterministic, but only an explicit approved v1 basename is accepted.
  const v1Product = { id: id1, sku: 'SYN-V1', product_name: 'Synthetic only', product_form: 'synthetic-form', container_size: '1', container_type: 'jug', container_unit: 'gal', unit_size: '1 gal', inventory_unit: 'gal', is_active: true, pricing_version: 7, updated_at: '2026-07-26T00:00:00.000Z', active_return_statuses: [] };
  const v1 = { format: 'crx-supplier-pricing-phase3-pre-stage-a-product-snapshot-v1', snapshot_timestamp_utc: '2026-07-23T00:00:00.000Z', migration_high_water: '20260722202622', expected_old_phase3_defaults: { product_family_id: null, return_policy: 'unknown', packaging_variant: null, is_full_tote_only: false }, products: [v1Product] }; v1.snapshot_sha256 = sha256(v1);
  const v1File = writeSnapshot(v1, PRE_STAGE_A_SNAPSHOT_NAME, path.join(temp, 'v1')); assert.equal(makeManifest(loadSnapshot(v1File)).manifest_sha256, '849757da67a2abdeb5e99683ebfc624822e23b08748987dacc69cc7ba52dd1c8');
  assert.doesNotThrow(() => checkPrivateArtifactContainment({ execute: fixtureGitExecute }));
  console.log('supplier-pricing Phase 3C private-artifact tests passed');
} finally { rmSync(temp, { recursive: true, force: true }); }
