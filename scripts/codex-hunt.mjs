#!/usr/bin/env node
/**
 * codex-hunt.mjs — run a headless, HARDENED, read-only Codex as the HUNTER (the
 * driver step) of the CRX Codex-driven bug hunt. Codex reads the repo + migration
 * files and reports candidate bugs / flawed logic back to Claude over stdout.
 *
 * MIRROR of the Claude-driven overnight-bug-hunt:
 *   Codex finds  →  Claude verifies against the LIVE DB + decides  →
 *   Claude writes the fix (through the project guardrails)  →
 *   Codex glances at the finished fix.
 *
 * Usage:
 *   node scripts/codex-hunt.mjs <promptFile> [--timeout 900]
 *
 * - <promptFile>: UTF-8 text file with the full prompt for ONE slice. The prompt
 *   is piped to Codex on STDIN (not argv) so there is NO Windows command-line
 *   length limit, however large the slice's file list grows.
 *
 * HARDENED INVOCATION — `codex exec` with:
 *   --model gpt-5.3-codex-spark : pin the cheap read-only hunter model; the
 *       gate/glance steps use overnight-codex-gate.mjs (gpt-5.6-sol) instead.
 *   --ignore-user-config : do NOT load ~/.codex/config.toml. That strips the
 *       Supabase / Vercel / GitHub / Sentry marketplace plugins off this run.
 *       Auth still resolves from CODEX_HOME, so the model still works.
 *   --sandbox read-only  : model-generated shell commands cannot write or reach
 *       the network.
 *   --ephemeral          : do not persist session files to disk.
 *
 * RESIDUAL (be honest): `--sandbox read-only` governs shell commands, not Codex's
 * own built-in tools. Codex retains `web.run` and `tool_search` (which can
 * *discover* GitHub/Vercel tools on demand). We do NOT rely on Codex being fully
 * sealed — the real safety boundary is on the CLAUDE side (`.claude/hooks/loop-guard.mjs`
 * blocks every push / wrong-branch commit / live-DB write / migration / deploy),
 * because Claude is the ONLY actor that takes consequential actions. The hunter
 * only emits text that Claude independently verifies. Every hunt prompt also
 * instructs Codex to READ AND REPORT ONLY — never call a non-read tool.
 */
import { spawnSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function fail(msg, code = 2) {
  console.error(`[codex-hunt] ${msg}`)
  process.exit(code)
}

const promptFile = process.argv[2]
if (!promptFile) fail('missing <promptFile> argument')
if (!existsSync(promptFile)) fail(`prompt file not found: ${promptFile}`)
const tIdx = process.argv.indexOf('--timeout')
const timeoutSec = tIdx > -1 ? Number(process.argv[tIdx + 1]) || 900 : 900

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
// Prompt goes on STDIN (codex reads instructions from stdin when no positional
// prompt is given), so there is no argv length limit.
// Model is pinned to the read-only spark hunter — `--ignore-user-config` drops any
// workstation default, so an unpinned run would fall to the CLI's built-in model.
const args = ['exec', '--ignore-user-config', '--model', 'gpt-5.3-codex-spark', '--sandbox', 'read-only', '--ephemeral', '-C', repoRoot]

const res = spawnSync(codex, args, {
  input: prompt,                         // prompt via stdin — no argv length cap
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: timeoutSec * 1000,
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
})

// Preserve whatever output we got — even on timeout/error — so a partial Codex run
// is never silently mistaken for "clean". Findings are on stdout; trace on stderr.
if (res.stdout) process.stdout.write(res.stdout)
if (res.stderr) process.stderr.write(res.stderr)

if (res.error) {
  if (res.error.code === 'ETIMEDOUT') {
    fail(`codex timed out after ${timeoutSec}s (partial output preserved above) — hunt a smaller slice`, 124)
  }
  fail(`failed to launch codex (${codex}): ${res.error.message}`)
}
process.exit(res.status == null ? 1 : res.status)
