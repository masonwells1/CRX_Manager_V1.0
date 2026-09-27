#!/usr/bin/env node
/**
 * overnight-codex-gate.mjs — run a headless, read-only Codex review for the
 * overnight bug hunt, wrapped so the call rides the `Bash(node scripts/:*)`
 * permission allow-list and never pauses an unattended run for approval.
 *
 * Usage:
 *   node scripts/overnight-codex-gate.mjs <promptFile> [--timeout 540] [--sol --reason "<why>"]
 *
 * - <promptFile>: a UTF-8 text file containing the full Codex prompt (candidate
 *   findings for the finding-gate, or a staged diff + ask for the fix-gate).
 *   Passing the prompt via a FILE avoids argv-escaping landmines; the contents
 *   are then fed to codex on STDIN (like codex-hunt.mjs), so a large staged
 *   diff never hits the Windows ~32K command-line length cap.
 * - `--sol`: run the review on `gpt-6-sol` at high effort instead of the
 *   default. DEFAULT SINCE 2026-09-20 is Luna at xhigh (Mason's standing
 *   review-tier decision), re-pinned to `gpt-6-luna` on 2026-09-23 when the
 *   GPT-6 class shipped: these loops run many rounds, and the cheap tier is what
 *   makes that affordable. Pass `--sol` for the one end-of-run adversarial pass,
 *   or for genuinely complex work Luna is out of its depth on.
 *   This wrapper is ADVISORY either way — it writes no proof JSON, so it can
 *   never satisfy (or corrupt) the push / migration-apply gates, which keep
 *   hard-requiring a `gpt-6-sol`/high proof minted by write-codex-push-proof.mjs.
 * - Resolves the newest codex.exe (version-hashed dir) and falls back to the
 *   `codex` shim on PATH. Runs an ephemeral, user-config-isolated
 *   `codex exec` review under the read-only sandbox. The model and effort are
 *   always pinned explicitly here and never inherited from workstation
 *   configuration — an unpinned call would silently take whatever
 *   ~/.codex/config.toml happens to say, making the reviewing tier a property of
 *   the workstation instead of this wrapper.
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

// Review tier. Luna/xhigh is the default (2026-09-20); `--sol` opts into the
// frontier tier for the one end-of-run pass. Both are advisory — see the header.
const useSol = process.argv.includes('--sol')
const reviewModel = useSol ? CODEX_REVIEW_MODEL : 'gpt-6-luna'
const reviewEffort = useSol ? CODEX_REVIEW_EFFORT : 'xhigh'
// Escalating to Sol requires a stated reason, and the wrapper enforces that rather than trusting
// the caller to write one into a report afterwards. An unattended loop that can escalate spend
// silently makes the "say why" rule unauditable — the only reliable moment to capture the reason
// is the moment of escalation.
const rIdx = process.argv.indexOf('--reason')
const solReason = rIdx > -1 ? String(process.argv[rIdx + 1] || '').trim() : ''
// An option token is not a reason: `--sol --reason --timeout 600` must refuse, not record "--timeout".
if (useSol && (!solReason || solReason.startsWith('--'))) {
  fail('--sol requires --reason "<why Luna was not enough>" — Sol escalation must never be silent')
}
// Log the tier WE selected, rather than relying on the CLI banner. An unattended loop is
// required to record the model and effort that produced a verdict; if that record depends on
// optional CLI output, a banner change silently makes the audit trail unfalsifiable. stderr,
// so it lands in the trace file and never contaminates the stdout verdict.
console.error(`[overnight-codex-gate] tier: ${reviewModel} / ${reviewEffort}${useSol ? ` (--sol; reason: ${solReason})` : ' (default)'}`)

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
  '--model', reviewModel, '-c', `model_reasoning_effort="${reviewEffort}"`,
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
