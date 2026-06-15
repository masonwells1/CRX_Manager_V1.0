import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Tests the --strict gate added to scripts/db-invariant-sweeps/run-sweeps.mjs
// (Codex June-14 gauntlet HIGH #2): an autonomous run must never mistake the
// print-only Claude-mode fallback (exit 0) for a passed sweep. With --strict
// (or DB_SWEEPS_REQUIRE_LIVE=1), when no real linked-live run is possible the
// runner must exit 2 instead.
const SCRIPT = path.resolve(process.cwd(), 'scripts/db-invariant-sweeps/run-sweeps.mjs');

// Run the script with both strict-triggering inputs removed from the inherited
// environment so behavior is determined ONLY by this test's args/extraEnv —
// never by the parent. We strip SUPABASE_DB_URL (forces Claude print-only mode)
// AND DB_SWEEPS_REQUIRE_LIVE (otherwise a CI/gauntlet job that exports it would
// make the default-mode case strict and flip its exit code). extraEnv re-adds
// only what a given test wants.
function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'SUPABASE_DB_URL' && k !== 'DB_SWEEPS_REQUIRE_LIVE') env[k] = v;
  }
  Object.assign(env, extraEnv);
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
}

describe('db-invariant-sweeps --strict gate', () => {
  it('default mode prints and exits 0 when live is unreachable (print-only fallback)', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CLAUDE MODE');
  });

  it('--strict exits 2 (not a silent pass) when live is unreachable', () => {
    const r = run(['--strict']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('STRICT MODE FAILURE');
  });

  it('DB_SWEEPS_REQUIRE_LIVE=1 behaves the same as --strict', () => {
    const r = run([], { DB_SWEEPS_REQUIRE_LIVE: '1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('STRICT MODE FAILURE');
  });

  it('--list short-circuits before the strict check (still exits 0)', () => {
    const r = run(['--strict', '--list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Discovered');
  });
});
