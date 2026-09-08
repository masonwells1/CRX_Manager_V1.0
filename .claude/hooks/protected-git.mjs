// Minimal, deterministic Git execution context for proof and apply gates.
// These gates must never accept PATH, GIT_*, global-config, or replacement-object
// overrides when deciding whether production work has been reviewed.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Keep each subprocess comfortably below the shortest hook deadline. A timeout
// is a refusal at callers; it must never become an implicit approval.
export const GIT_CALL_TIMEOUT_MS = 1_500;
// This is deliberately a literal, not the checkout's origin URL: reviewer policy
// must remain anchored to CRX's authoritative GitHub repository even if a local
// config or remote-tracking ref has been rewritten.
export const AUTHORITATIVE_MAIN_REMOTE = 'https://github.com/masonwells1/CRX_Manager_V1.0.git';
export const AUTHORITATIVE_MAIN_POLICY = `${AUTHORITATIVE_MAIN_REMOTE} refs/heads/main via fixed Git ls-remote`;

export function fixedGitExecutable() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']
    : ['/usr/bin/git', '/usr/local/bin/git'];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('A fixed trusted Git executable is required for proof and apply gates.');
  return executable;
}

export function protectedGitEnv() {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_ATTR_NOSYSTEM = '1';
  const systemPath = process.platform === 'win32'
    ? path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32')
    : '/usr/bin:/bin';
  env.PATH = `${path.dirname(fixedGitExecutable())}${path.delimiter}${systemPath}`;
  return env;
}

export function parseAuthoritativeMainRef(output) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error('authoritative main lookup returned an ambiguous ref list');
  const match = /^([a-f0-9]{40})\s+refs\/heads\/main$/i.exec(lines[0]);
  if (!match) throw new Error('authoritative main lookup did not return a full main commit SHA');
  return match[1].toLowerCase();
}

export function authoritativeMainCommit({ execute = spawnSync } = {}) {
  const result = execute(fixedGitExecutable(), [
    '--no-replace-objects', 'ls-remote', '--refs', AUTHORITATIVE_MAIN_REMOTE, 'refs/heads/main',
  ], {
    encoding: 'utf8', timeout: GIT_CALL_TIMEOUT_MS, windowsHide: true, shell: false,
    env: protectedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result?.error || result?.status !== 0) {
    throw new Error(`could not read authoritative main from GitHub: ${result?.error?.message || result?.stderr || result?.status || 'unknown failure'}`);
  }
  return parseAuthoritativeMainRef(result.stdout);
}
