import { buildCodexExecArgs } from './write-codex-push-proof.mjs';

// The migration reviewer runs in a deliberately Git-free temporary directory.
// Reuse the push-proof packet profile exactly: a merely read-only sandbox can
// still expose unrelated local files to a prompt-injected reviewer.
export function buildMigrationReviewerExecArgs({ reviewCwd, model, effort, platform = process.platform }) {
  return buildCodexExecArgs({
    root: reviewCwd,
    prompt: '',
    model,
    effort,
    platform,
  });
}
