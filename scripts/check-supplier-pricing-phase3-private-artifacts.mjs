#!/usr/bin/env node
/** Fail closed if a private Phase 3C artifact is present in any Git-visible path. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVED_SERIALIZED_FORMATS, OWNER_DECISION_CSV_HEADER, PRIVATE_ARTIFACT_BASENAMES, REPO_ROOT } from './supplier-pricing-phase3-private-artifacts.mjs';

const PRIVATE_ARTIFACT_BASENAMES_LOWER = new Set([...PRIVATE_ARTIFACT_BASENAMES].map(name => name.toLowerCase()));
const IGNORED_PRIVATE_ARTIFACT_PATHSPECS = [
  ...[...PRIVATE_ARTIFACT_BASENAMES].map(name => `:(icase,glob)**/${name}`),
  ':(icase,glob)**/private-artifacts/**',
];
const SERIALIZED_PRIVATE_SIGNATURES = [
  ...[...APPROVED_SERIALIZED_FORMATS].map(format => `${JSON.stringify('format')}: ${JSON.stringify(format)}`),
  OWNER_DECISION_CSV_HEADER,
];

function gitOutput(args, root = REPO_ROOT, execute = execFileSync) {
  return execute('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitPaths(args, root = REPO_ROOT, execute = execFileSync) {
  const output = gitOutput(args, root, execute);
  return String(output).split('\0').filter(Boolean);
}

export function forbiddenArtifactReason(repoPath) {
  const segments = repoPath.split(/[\\/]/).filter(Boolean);
  if (segments.some(segment => segment.toLowerCase() === 'private-artifacts')) return 'private-artifacts directory';
  if (segments.some(segment => PRIVATE_ARTIFACT_BASENAMES_LOWER.has(segment.toLowerCase()))) return 'private artifact basename';
  return null;
}

export function findForbiddenPrivateArtifactPaths(paths) {
  return paths.map(repoPath => ({ repoPath, reason: forbiddenArtifactReason(repoPath) })).filter(item => item.reason);
}

function isNodeModulesPath(repoPath) { return repoPath.split(/[\\/]/).includes('node_modules'); }
function privateSignatureReason(text) {
  if (text.includes(OWNER_DECISION_CSV_HEADER)) return 'owner decision sheet CSV header';
  return SERIALIZED_PRIVATE_SIGNATURES.some(signature => text.includes(signature)) ? 'approved private JSON format signature' : null;
}
function readWorktreeCandidate(root, repoPath) {
  const file = path.resolve(root, repoPath);
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink()) return null;
  return readFileSync(file, 'utf8');
}
function readIndexCandidate(root, repoPath, execute) {
  return String(gitOutput(['show', `:${repoPath}`], root, execute));
}
function contentViolations(root, execute) {
  const staged = new Set(gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], root, execute));
  const modified = new Set(gitPaths(['diff', '--name-only', '-z', '--diff-filter=ACMR'], root, execute));
  const untracked = new Set(gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, execute));
  const violations = [];
  for (const repoPath of staged) {
    if (isNodeModulesPath(repoPath)) continue;
    const reason = privateSignatureReason(readIndexCandidate(root, repoPath, execute));
    if (reason) violations.push({ repoPath, reason });
  }
  for (const repoPath of new Set([...modified, ...untracked])) {
    if (isNodeModulesPath(repoPath)) continue;
    const text = readWorktreeCandidate(root, repoPath);
    const reason = text === null ? null : privateSignatureReason(text);
    if (reason) violations.push({ repoPath, reason });
  }
  return violations;
}

export function checkPrivateArtifactContainment({ root = REPO_ROOT, execute = execFileSync } = {}) {
  const visible = new Set([
    ...gitPaths(['ls-files', '-z'], root, execute),
    ...gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], root, execute),
    ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, execute),
    ...gitPaths(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...IGNORED_PRIVATE_ARTIFACT_PATHSPECS], root, execute),
  ]);
  const violations = [
    ...findForbiddenPrivateArtifactPaths([...visible]),
    ...contentViolations(root, execute),
  ];
  if (violations.length) throw new Error(`private Phase 3C artifact containment failure: ${violations.map(item => `${item.repoPath} (${item.reason})`).join(', ')}`);
  return { checked_path_count: visible.size };
}

function main() {
  const result = checkPrivateArtifactContainment();
  console.log(`PHASE3_PRIVATE_ARTIFACT_CONTAINMENT_PASS checked_paths=${result.checked_path_count}`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main();
