// Builds a child-process environment for hook tests that run from a scratch
// project directory. Git hooks inherit GIT_* values from their parent Git
// process; those repository-local values would otherwise make a scratch hook
// resolve the parent checkout despite its cwd and CLAUDE_PROJECT_DIR.

import { spawnSync } from "node:child_process";

const LOCAL_ENV_FALLBACK = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

export function gitLocalEnvironmentNames() {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return LOCAL_ENV_FALLBACK;

  const names = result.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? names : LOCAL_ENV_FALLBACK;
}

const LOCAL_GIT_ENV_NAMES = gitLocalEnvironmentNames();
const INDEXED_CONFIG_ENV_RE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

export function scratchHookEnvironment(projectDir, inheritedEnv = process.env) {
  const env = { ...inheritedEnv };

  for (const name of LOCAL_GIT_ENV_NAMES) delete env[name];
  // GIT_CONFIG_COUNT is repository-local; its indexed key/value payload is
  // separate variables, so Git does not list each numbered name above.
  for (const name of Object.keys(env)) {
    if (INDEXED_CONFIG_ENV_RE.test(name)) delete env[name];
  }

  env.CLAUDE_PROJECT_DIR = projectDir;
  return env;
}
