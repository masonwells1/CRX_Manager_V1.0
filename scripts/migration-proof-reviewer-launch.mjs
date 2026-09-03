// The migration reviewer runs in a deliberately Git-free temporary directory.
// Keep its launch contract separate and testable so a missing CLI flag cannot
// silently make governed migration reviews impossible to start.
export function buildMigrationReviewerExecArgs({ reviewCwd, model, effort }) {
  return [
    'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
    '--model', model, '-c', `model_reasoning_effort="${effort}"`,
    '--sandbox', 'read-only', '-C', reviewCwd, '-c', 'approval_policy=never',
    '--disable', 'hooks',
  ];
}
