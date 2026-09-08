// Minimal, deterministic Git execution context for proof and apply gates.
// These gates must never accept PATH, GIT_*, global-config, or replacement-object
// overrides when deciding whether production work has been reviewed.
import { existsSync } from 'node:fs';
import path from 'node:path';

// Keep each subprocess comfortably below the shortest hook deadline. A timeout
// is a refusal at callers; it must never become an implicit approval.
export const GIT_CALL_TIMEOUT_MS = 1_500;

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
