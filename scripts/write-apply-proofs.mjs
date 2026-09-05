#!/usr/bin/env node
// The ONLY sanctioned producer of migration-apply-guard proof files. Pass the
// migration NAMES (without .sql) as args. For EACH migration it executes EVERY
// required reviewer's charter (.claude/agents/<reviewer>.md) as its own real,
// read-only run of the trusted Codex CLI (same trusted-binary resolution +
// terminal machine-token verdict as scripts/write-codex-push-proof.mjs) and —
// ONLY when ALL charters return CLEAN with the file content unchanged — mints
// BOTH proofs the guard checks: migration-review-<name>.json (reviewer half,
// every listed reviewer = a run that genuinely happened) and
// codex-review-mig-<name>.json (separate Sol/high half). Written with Node (clean
// UTF-8, no BOM — a BOM blocks the guard hook's JSON parse).
//
// queryHash is computed from the on-disk migration file (CRLF→LF normalized) —
// hands-free applies REQUIRE it to match the transmitted SQL exactly (Codex P1
// 2026-07-13); if your apply call sends different bytes (e.g. trailing newline
// stripped), the guard prints the expected hash to paste in.
//
// There is deliberately NO way to stamp a proof without the Codex run:
//   --codex-verdict <v> was REMOVED 2026-07-16 (scaffolding design review):
//   a caller-supplied verdict let one command mint the Sol/high gate
//   without any separate Sol/high reviewer process running.
//   Unconditional reviewer-proof stamping was REMOVED the same day (Codex
//   round-3 review of PR #142): a "clean, both reviewers ran" JSON written on
//   the caller's say-so is assertion, not evidence. The subagent reviewers
//   still run per /migration-review (their findings drive the fix loop); the
//   machine verdict here is what makes the stamped proof evidence.
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  CODEX_REVIEW_EFFORT,
  CODEX_REVIEW_MODEL,
  CODEX_REVIEW_PERMISSION_CONFIG,
  CODEX_REVIEW_PERMISSION_PROFILE,
  codexExecutable,
  codexReviewProofVerdict,
} from './write-codex-push-proof.mjs';
import {
  REVIEW_TIMEOUT_MS,
  clearApplyProofs,
  createReviewerPacket,
  buildReviewerCodexArgs,
  buildReviewerCharterPrompt,
  normalizeMigrationSql,
  snapshotMigrationSql,
} from './write-apply-proofs-lib.mjs';

const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--codex-verdict')) {
  console.error(
    '--codex-verdict was removed (2026-07-16): a CLI-supplied verdict let a session\n' +
    'mint the Sol/high gate without Codex actually running. Just pass the\n' +
    'migration name(s) — the wrapper now always runs the trusted Codex CLI itself\n' +
    'and only mints on a CLEAN machine verdict.'
  );
  process.exit(2);
}

// The Codex run is NOT optional (Codex round-3 review of the 2026-07-16 wave 1
// PR): a wrapper that stamps a "clean, both reviewers ran" proof purely on the
// caller's say-so is a self-certification path, however honest the caller. Every
// proof this wrapper mints — the reviewer half AND the Codex half — is therefore
// backed by a real, machine-verdict Codex review of the exact file content. The
// subagent reviewers still run per /migration-review (their findings drive the
// fix loop); this machine verdict is what makes the stamped JSON evidence rather
// than assertion. `--codex` is accepted as a no-op for backward compatibility.
const names = rawArgs.filter((a) => a !== '--codex');
if (names.length === 0) {
  console.error('usage: node scripts/write-apply-proofs.mjs <migName> [<migName> ...]   (runs a trusted Codex review per migration; no flags)');
  process.exit(1);
}

const stateDir = path.join(process.cwd(), '.claude', 'session-state');
mkdirSync(stateDir, { recursive: true });

// Each required reviewer's CHARTER (its .claude/agents/*.md instruction file) is
// executed as its own read-only Codex run with a terminal machine token, so the
// reviewers the proof records are reviews that genuinely ran — not an assertion
// (Codex round-4 review of PR #142: a proof naming reviewers that never ran let
// a hands-free apply pass the two-reviewer requirement on say-so).
const REQUIRED_REVIEWERS = ['rls-security-reviewer', 'migration-drift-reviewer'];

function hashFile(file) {
  const sql = normalizeMigrationSql(readFileSync(file, 'utf8'));
  return createHash('sha256').update(sql).digest('hex');
}

let exitCode = 0;

function runCodexCharter(codexBin, reviewerName, migRelPath, migrationSql, queryHash, safe, reviewRoot) {
  const charterFile = path.join(process.cwd(), '.claude', 'agents', `${reviewerName}.md`);
  if (!existsSync(charterFile)) {
    return { verdict: null, error: `reviewer charter ${charterFile} not found` };
  }
  const prompt = buildReviewerCharterPrompt(
    reviewerName,
    readFileSync(charterFile, 'utf8'),
    migRelPath,
    migrationSql,
    queryHash,
  );
  console.log(`Running trusted Codex as "${reviewerName}" on ${migRelPath} (this can take a few minutes)...`);
  // `--disable hooks`: the repo's own Stop hook (stop-wrap.mjs) blocks whenever the
  // working tree has unacknowledged dirty files, which a READ-ONLY reviewer child can
  // never resolve. When it blocks, Codex is forced to keep talking past its verdict —
  // and codexReviewProofVerdict() rightly rejects a run with prose after the token, so
  // a genuinely CLEAN review mints nothing. Observed 2026-07-27: both charters returned
  // BLOCKERS: 0 / HIGH: 0 / MED: 0 and were discarded, twice, because a SIBLING session
  // kept editing this shared checkout mid-review (any ack goes stale within minutes).
  // Same root cause and same fix as the 2026-07-20 headless-`claude -p` incident, which
  // added `--settings '{"disableAllHooks":true}'` to scripts/run-claude-review.mjs.
  // This does NOT weaken the gate: the child is still confined to a sanitized,
  // read-only packet with network denied, and the
  // single-token / terminal-token / hash-binding / 30-min-expiry rules all still apply.
  const args = buildReviewerCodexArgs({
    model: CODEX_REVIEW_MODEL,
    effort: CODEX_REVIEW_EFFORT,
    cwd: reviewRoot,
    permissionProfile: CODEX_REVIEW_PERMISSION_PROFILE,
    permissionConfig: CODEX_REVIEW_PERMISSION_CONFIG,
  });
  const result = spawnSync(codexBin, args, {
    cwd: reviewRoot,
    encoding: 'utf8',
    // Codex CLI 0.145+ reads the complete prompt from stdin when the final
    // argument is `-`. This avoids Windows' argv size limit for large SQL while
    // preserving shell:false and a deterministic EOF.
    stdio: ['pipe', 'pipe', 'pipe'],
    input: `${prompt}\n`,
    shell: false,
    timeout: REVIEW_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const capturePath = path.join(stateDir, `codex-review-mig-${safe}-${reviewerName}-capture.txt`);
  writeFileSync(capturePath, `exit=${result.status}\n\nSTDOUT\n${result.stdout || ''}\n\nSTDERR\n${result.stderr || ''}\n`, 'utf8');
  console.log(`  → captured to ${capturePath}`);
  return { verdict: codexReviewProofVerdict({ status: result.status, stdout: result.stdout }), error: null };
}

for (const name of names) {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const { reviewerFile, codexFile } = clearApplyProofs(stateDir, safe);
  // A failed re-review must never leave an older still-fresh proof usable.
  // Clear both proof halves before any fallible lookup, packet build, or child run.
  const migFile = path.join(process.cwd(), 'supabase', 'migrations', `${name}.sql`);
  if (!existsSync(migFile)) {
    console.error(`ERROR: ${migFile} not found — nothing can be reviewed, so NO proof is minted for "${name}".`);
    exitCode = 1;
    continue;
  }
  // One read supplies BOTH the attached review bytes and their hash. The final
  // disk hash below remains the TOCTOU check for edits during the review.
  const { migrationSql, queryHash } = snapshotMigrationSql(migFile);

  let codexBin;
  try {
    codexBin = codexExecutable();
  } catch (error) {
    console.error(String(error.message || error));
    console.error('No proof minted — PARK the migration for Mason rather than self-certifying.');
    exitCode = 2;
    continue;
  }
  const migRelPath = path.posix.join('supabase', 'migrations', `${name}.sql`);

  // Run EVERY required reviewer against a sanitized snapshot packet. The child
  // can read the migration corpus and drift evidence, but never the real
  // worktree (including untracked files or accidental local secrets).
  let allClean = true;
  let reviewRoot;
  try {
    reviewRoot = createReviewerPacket({
      sourceRoot: process.cwd(),
      migRelPath,
      migrationSql,
      queryHash,
    });
    for (const reviewerName of REQUIRED_REVIEWERS) {
      const { verdict, error } = runCodexCharter(
        codexBin,
        reviewerName,
        migRelPath,
        migrationSql,
        queryHash,
        safe,
        reviewRoot,
      );
      if (error) {
        console.error(`ERROR: ${error} — NO proofs minted for "${name}".`);
        allClean = false;
        break;
      }
      if (verdict !== 'clean') {
        console.error(`"${reviewerName}" did NOT return a terminal CLEAN token for ${name} — NO proofs minted. Fix the findings in its capture, or PARK the migration for Mason. Never self-certify.`);
        allClean = false;
        break;
      }
    }
  } catch (error) {
    console.error(`Could not build or run the sanitized migration-review packet: ${error.message}`);
    allClean = false;
  } finally {
    if (reviewRoot) rmSync(reviewRoot, { recursive: true, force: true });
  }
  if (!allClean) { exitCode = 1; continue; }

  const hashAfter = existsSync(migFile) ? hashFile(migFile) : null;
  if (hashAfter !== queryHash) {
    console.error(`${name}.sql changed while the reviews were running — the verdicts no longer describe this content. NO proofs minted; re-run on the final file.`);
    exitCode = 1;
    continue;
  }

  const ts = new Date().toISOString();
  // Reviewer half — every name listed corresponds to a charter run that actually
  // executed above and returned CLEAN (captures alongside in session-state).
  writeFileSync(reviewerFile, JSON.stringify({
    migration: name,
    timestamp: ts,
    reviewers: REQUIRED_REVIEWERS,
    reviewerEvidence: 'each reviewer charter executed by the trusted Codex CLI with a terminal machine verdict; see codex-review-mig-*-capture.txt',
    findings: 'clean',
    queryHash,
  }, null, 2), { encoding: 'utf8' });
  console.log(`wrote ${reviewerFile}`);
  writeFileSync(
    codexFile,
    JSON.stringify({
      queryHash,
      verdict: 'clean',
      model: CODEX_REVIEW_MODEL,
      reasoning_effort: CODEX_REVIEW_EFFORT,
      timestamp: ts,
    }, null, 2),
    { encoding: 'utf8' },
  );
  console.log(`wrote ${codexFile} (all reviewer charters returned CLEAN machine verdicts from ${CODEX_REVIEW_MODEL}/${CODEX_REVIEW_EFFORT})`);
}

process.exit(exitCode);
