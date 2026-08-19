#!/usr/bin/env node
/**
 * overnight-codex-gate.mjs — run a headless, read-only Codex review for the
 * overnight bug hunt, wrapped so the call rides the `Bash(node scripts/:*)`
 * permission allow-list and never pauses an unattended run for approval.
 *
 * Usage:
 *   node scripts/overnight-codex-gate.mjs <promptFile> [--timeout 540]
 *
 * - <promptFile>: a UTF-8 text file containing the full Codex prompt (candidate
 *   findings for the finding-gate, or a staged diff + ask for the fix-gate).
 *   Passing the prompt via a FILE avoids argv-escaping landmines; the contents
 *   are then fed to codex on STDIN (like codex-hunt.mjs), so a large staged
 *   diff never hits the Windows ~32K command-line length cap.
 * - Resolves the newest codex.exe (version-hashed dir) and falls back to the
 *   `codex` shim on PATH. Runs an ephemeral, user-config-isolated
 *   `codex exec --model gpt-5.6-sol -c model_reasoning_effort="high"`
 *   review under the read-only sandbox. Adversarial reviews never inherit a
 *   cheaper builder model or reasoning level from workstation configuration.
 *   spawnSync writes the prompt to stdin and closes it, so codex never blocks
 *   waiting on input. Prints Codex's output to stdout; exits with its code.
 *
 * READ-ONLY by construction: `--sandbox read-only` means Codex cannot edit files,
 * run mutating SQL, push, or deploy. This wrapper adds no write capability — it is
 * only a permission-friendly shell around the same `codex exec` the skill documents.
 */
import { spawnSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_REVIEW_EFFORT, CODEX_REVIEW_MODEL } from './write-codex-push-proof.mjs'

function fail(msg, code = 2) {
  console.error(`[overnight-codex-gate] ${msg}`)
  process.exit(code)
}

const promptFile = process.argv[2]
if (!promptFile) fail('missing <promptFile> argument')
if (!existsSync(promptFile)) fail(`prompt file not found: ${promptFile}`)
const tIdx = process.argv.indexOf('--timeout')
const timeoutSec = tIdx > -1 ? Number(process.argv[tIdx + 1]) || 540 : 540

const prompt = readFileSync(promptFile, 'utf8')
if (!prompt.trim()) fail('prompt file is empty')

// repo root = this script lives in <root>/scripts/
let repoRoot
try {
  repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
} catch {
  repoRoot = process.cwd()
}

// Resolve the newest codex.exe under the version-hashed bin dir; fall back to PATH `codex`.
function resolveCodex() {
  const binDir = 'C:/Users/mason/AppData/Local/OpenAI/Codex/bin'
  try {
    if (existsSync(binDir)) {
      const candidates = readdirSync(binDir)
        .map((d) => join(binDir, d, 'codex.exe'))
        .filter((p) => existsSync(p))
        .map((p) => ({ p, m: statSync(p).mtimeMs }))
        .sort((a, b) => b.m - a.m)
      if (candidates.length) return candidates[0].p
    }
  } catch { /* fall through */ }
  return 'codex' // PATH shim
}

const codex = resolveCodex()
const args = [
  'exec', '--ephemeral', '--ignore-user-config',
  '--model', CODEX_REVIEW_MODEL, '-c', `model_reasoning_effort="${CODEX_REVIEW_EFFORT}"`,
  '--sandbox', 'read-only', '-C', repoRoot,
]

const res = spawnSync(codex, args, {
  input: prompt, // prompt via stdin — a large diff would blow the Windows ~32K argv cap
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'], // spawnSync writes `input` then closes stdin, so codex cannot block on it
  timeout: timeoutSec * 1000,
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
})

// Preserve whatever output we got — even on timeout/error — so a partial Codex run
// is never silently mistaken for "clean" (same discipline as codex-hunt.mjs).
process.stdout.write(res.stdout || '')
if (res.stderr) process.stderr.write(res.stderr)

if (res.error) {
  // GATE-FAILED goes to STDOUT: overnight runs redirect stdout to the verdict file
  // and stderr to a trace file, so a stderr-only failure would leave the verdict
  // file empty — indistinguishable from "gate found nothing".
  if (res.error.code === 'ETIMEDOUT') {
    process.stdout.write(`\nGATE-FAILED: codex timed out after ${timeoutSec}s — split into a smaller batch\n`)
    fail(`codex timed out after ${timeoutSec}s — split into a smaller batch`, 124)
  }
  process.stdout.write(`\nGATE-FAILED: failed to launch codex (${codex}): ${res.error.message}\n`)
  fail(`failed to launch codex (${codex}): ${res.error.message}`)
}
if (res.status !== 0) {
  process.stdout.write(`\nGATE-FAILED: codex exited with code ${res.status == null ? 'null' : res.status}\n`)
}
process.exit(res.status == null ? 1 : res.status)
