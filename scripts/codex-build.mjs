#!/usr/bin/env node
/**
 * codex-build.mjs — run a headless, WRITE-ENABLED Codex (gpt-5.5) as the BUILDER
 * of the CRX Workflow-Waves loop. This is the INVERSE of scripts/codex-hunt.mjs:
 *
 *   codex-hunt.mjs  : Codex read-only  → FINDS bugs  → Claude fixes.
 *   codex-build.mjs : Codex WRITES code in the worktree → Claude reviews + gates.
 *
 * Role split for the loop (see docs/loops/workflow-waves-loop-2026-07.md):
 *   Claude (Opus 4.8) = orchestrator/advisor: grounds each unit, writes the build
 *     spec, reviews Codex's diff, runs the guard-equivalent checks + review
 *     subagents, and is the ONLY actor that commits / pushes / applies migrations.
 *   Codex (gpt-5.5)   = builder: edits the working tree per the spec, self-checks
 *     with typecheck/build/test. It never reaches the live DB / Vercel / GitHub.
 *
 * Usage:
 *   node scripts/codex-build.mjs <promptFile> [--timeout 1800] [--model gpt-5.5]
 *
 * - <promptFile>: UTF-8 file with the FULL, self-contained build spec for ONE unit
 *   (or one fix-round). Piped to Codex on STDIN — no Windows argv length cap, and
 *   it sidesteps the known "codex exec hangs on an interactive stdin" issue because
 *   spawnSync feeds a fixed buffer and closes the pipe.
 *
 * HARDENED INVOCATION — `codex exec` with:
 *   --ignore-user-config : do NOT load ~/.codex/config.toml. This strips the
 *       Supabase / Vercel / GitHub / Sentry marketplace plugins off the builder so
 *       Codex can only touch the repo — every consequential live action stays on
 *       the Claude side. (Auth still resolves from CODEX_HOME, so the model works.)
 *       Because the user config is ignored, the model + reasoning effort are pinned
 *       explicitly below (the config normally sets model = "gpt-5.5").
 *   --sandbox danger-full-access : REQUIRED on Windows. Codex has no OS-level
 *       sandbox on Windows, so `--sandbox workspace-write` silently degrades to
 *       READ-ONLY (Codex refuses to write). Full-access is the only mode that lets
 *       a headless Codex actually edit the tree here. It is acceptable because the
 *       run is bounded on other axes (see RESIDUAL): the isolated worktree, the
 *       stripped tools, and — the real gate — Claude reviewing every diff.
 *   -c approval_policy="never" : run fully autonomously (no interactive approval
 *       prompt to stall an unattended loop).
 *   -c model_reasoning_effort="xhigh" : match Mason's standing Codex config.
 *   --ephemeral : do not persist session files (each round gets a fresh, fully
 *       self-contained spec from Claude, so no cross-round session state is needed).
 *
 * RESIDUAL (be honest): under `danger-full-access` Codex's shell + built-in tools
 * (`web.run` / `tool_search`) are NOT network-sandboxed — it could reach the web or
 * run arbitrary local commands. We do NOT rely on Codex being sealed. The boundary is:
 *   (1) `--ignore-user-config` strips the Supabase / Vercel / GitHub / Sentry plugins,
 *       so Codex has no live-DB / deploy / push TOOLS — only a shell + the repo;
 *   (2) it runs in an ISOLATED worktree the loop owns (no other tree is touched);
 *   (3) CLAUDE reviews every diff before commit, the pre-commit hook + migration-apply
 *       -guard fire on CLAUDE's commit/apply (NOT on Codex's raw writes), and CLAUDE is
 *       the only actor that pushes or touches the live DB.
 * Treat everything Codex writes as UNTRUSTED until Claude has read the diff + run gates.
 *
 * Exit codes: passthrough of codex's status; 124 on timeout (partial output kept).
 */
import { spawnSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function fail(msg, code = 2) {
  console.error(`[codex-build] ${msg}`)
  process.exit(code)
}

const promptFile = process.argv[2]
if (!promptFile) fail('missing <promptFile> argument')
if (!existsSync(promptFile)) fail(`prompt file not found: ${promptFile}`)

const tIdx = process.argv.indexOf('--timeout')
const timeoutSec = tIdx > -1 ? Number(process.argv[tIdx + 1]) || 1800 : 1800
const mIdx = process.argv.indexOf('--model')
const model = mIdx > -1 ? String(process.argv[mIdx + 1] || 'gpt-5.5') : 'gpt-5.5'

const prompt = readFileSync(promptFile, 'utf8')
if (!prompt.trim()) fail('prompt file is empty')

// repo root = the worktree this loop owns (script lives in <root>/scripts/)
let repoRoot
try {
  repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
} catch {
  repoRoot = process.cwd()
}

// Resolve the newest codex.exe under the version-hashed bin dir; fall back to PATH.
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

// Prompt on STDIN (codex reads instructions from stdin when no positional prompt is
// given), so there is no argv length limit however large the file list grows.
const args = [
  'exec',
  '--ignore-user-config',
  '-m', model,
  '-c', 'model_reasoning_effort="xhigh"',
  '-c', 'approval_policy="never"',
  '--sandbox', 'danger-full-access', // Windows has no OS sandbox; workspace-write degrades to read-only
  '--ephemeral',
  '-C', repoRoot,
]

const res = spawnSync(codex, args, {
  input: prompt,                          // prompt via stdin — no argv length cap
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: timeoutSec * 1000,
  maxBuffer: 96 * 1024 * 1024,
  windowsHide: true,
})

// Preserve whatever we got — even on timeout — so a partial build is never silently
// taken for "clean". Codex's summary is on stdout; its reasoning trace on stderr.
if (res.stdout) process.stdout.write(res.stdout)
if (res.stderr) process.stderr.write(res.stderr)

if (res.error) {
  if (res.error.code === 'ETIMEDOUT') {
    fail(`codex timed out after ${timeoutSec}s (partial edits + output preserved) — ` +
      `review the working tree, then re-spec a smaller slice`, 124)
  }
  fail(`failed to launch codex (${codex}): ${res.error.message}`)
}
process.exit(res.status == null ? 1 : res.status)
