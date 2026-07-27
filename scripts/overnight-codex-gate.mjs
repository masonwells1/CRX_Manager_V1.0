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
 *   Passing the prompt via a FILE avoids argv-escaping landmines.
 * - Resolves the newest codex.exe (version-hashed dir) and falls back to the
 *   `codex` shim on PATH. Runs `codex exec --sandbox read-only -C <repoRoot>`
 *   with NO `-m`, so the review runs on whatever agent the Codex config names.
 *   That is deliberate: `gpt-5.6-sol` is the configured default and is the
 *   review agent of the three 5.6 agents (sol = reviewer, terra = builder,
 *   luna = low-risk). Pinning `-m` here would silently diverge from the config
 *   the rest of the harness follows.
 *   with stdin closed (non-TTY stdin otherwise blocks "Reading additional input
 *   from stdin…" → hang). Prints Codex's output to stdout; exits with its code.
 *
 * READ-ONLY by construction: `--sandbox read-only` means Codex cannot edit files,
 * run mutating SQL, push, or deploy. This wrapper adds no write capability — it is
 * only a permission-friendly shell around the same `codex exec` the skill documents.
 */
import { spawnSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
const args = ['exec', '--sandbox', 'read-only', '-C', repoRoot, prompt]

const res = spawnSync(codex, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'], // stdin IGNORED so codex never blocks on it
  timeout: timeoutSec * 1000,
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
})

if (res.error) {
  if (res.error.code === 'ETIMEDOUT') fail(`codex timed out after ${timeoutSec}s — split into a smaller batch`, 124)
  fail(`failed to launch codex (${codex}): ${res.error.message}`)
}
process.stdout.write(res.stdout || '')
if (res.stderr) process.stderr.write(res.stderr)
process.exit(res.status == null ? 1 : res.status)
