#!/usr/bin/env node
/** Fail closed if a private Phase 3C artifact is present in any Git-visible path. */
import { execFileSync } from 'node:child_process';
import { lstatSync, openSync, readSync, closeSync } from 'node:fs';
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
function gitPathsAllowNoMatch(args, root = REPO_ROOT, execute = execFileSync) {
  try { return gitPaths(args, root, execute); }
  catch (error) {
    if (error?.status === 1) return [];
    throw error;
  }
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
function readWorktreeCandidatePrefix(root, repoPath) {
  const file = path.resolve(root, repoPath);
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink()) return null;
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(16 * 1024);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
  } finally { closeSync(fd); }
}
function trackedContentViolations(root, execute) {
  const violations = [];
  for (const signature of SERIALIZED_PRIVATE_SIGNATURES) {
    const reason = signature === OWNER_DECISION_CSV_HEADER ? 'owner decision sheet CSV header' : 'approved private JSON format signature';
    for (const repoPath of gitPathsAllowNoMatch(['grep', '--cached', '-I', '-l', '-z', '-F', '-e', signature], root, execute)) violations.push({ repoPath, reason });
  }
  return violations;
}
function contentViolations(root, execute) {
  const modified = new Set(gitPaths(['diff', '--name-only', '-z', '--diff-filter=ACMR'], root, execute));
  const untracked = new Set(gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root, execute));
  const violations = trackedContentViolations(root, execute);
  for (const repoPath of new Set([...modified, ...untracked])) {
    if (isNodeModulesPath(repoPath)) continue;
    const text = readWorktreeCandidatePrefix(root, repoPath);
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
