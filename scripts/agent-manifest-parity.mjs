// Pure logic for the hook-manifest parity check (2026-07-16 scaffolding review,
// sync-adapter finding). Both the Claude side (.claude/settings.json) and the
// Codex side (.codex/hooks.json) wire the SAME shared implementations under
// .claude/hooks/. Nothing enforced that the two wirings stay in step, so a NEW
// Claude-side guard could be added to settings.json and silently never fire for
// Codex — the designated builder. This diffs the two hook-script sets and FAILS
// on any asymmetry that isn't an explicitly-declared, deliberate one-sided hook.
//
// Adding a new guard therefore forces a conscious choice: wire it on BOTH sides,
// or add it to CLAUDE_ONLY_HOOKS / CODEX_ONLY_HOOKS below with the reason. The
// check can't be satisfied by accident.

// Deliberately Claude-only hooks (NOT wired for Codex), each with why:
export const CLAUDE_ONLY_HOOKS = new Set([
  // Codex has its OWN production guard (.codex/hooks/production-action-guard.mjs)
  // that covers pushes AND PR merges, so Codex doesn't wire Claude's push/merge
  // guards.
  "codex-push-guard.mjs",
  "pr-merge-guard.mjs",
  // Autopilot enforcement (the armed hands-free-run concept) is a Claude-session
  // mechanism; prompt-router.mjs keeps its intent reminder Claude-only internally.
  "unattended-autopilot.mjs",
  // Worktree lifecycle: Claude manages .claude/worktrees/; Codex worktrees live
  // elsewhere and are never swept, so cleanup and its liveness heartbeat are
  // Claude-only. posttool-router.mjs also owns the PostToolUse heartbeat dispatch;
  // the direct manifest reference below remains for Claude SessionStart.
  "worktree-cleanup.mjs",
  "session-heartbeat.mjs",
  // SessionStart context injection (post-compact money/RLS re-anchor + session
  // onboarding) replaces the former prompt-type hooks, which fail outside the
  // REPL. The note recorded here before PR #414 read: "Codex has no SessionStart
  // event; its contract comes from AGENTS.md." The first clause is false —
  // .codex/hooks.json registers a SessionStart group (session-snapshot.mjs,
  // session-staleness.mjs, worktree-awareness.mjs), so the event is wired on that
  // side; what the Codex harness does with that registration, including whether it
  // consumes additionalContext, is not verified here. The second clause stands as
  // recorded (AGENTS.md is the shared contract for every agent), but nothing
  // establishes it as the operative reason for leaving this hook Claude-only.
  "session-context-reminder.mjs",
]);

// Deliberately Codex-only shared hooks (in .codex/hooks.json but NOT settings.json).
// Currently none — every hook Codex wires is also wired for Claude.
export const CODEX_ONLY_HOOKS = new Set([]);

// Extract the set of .claude/hooks/<name>.mjs referenced anywhere in a manifest's
// raw text (settings.json or .codex/hooks.json). Text-based on purpose: it catches
// the hook wherever it appears (command string, commandWindows, etc.) without
// depending on the manifest's exact JSON shape.
export function extractClaudeHookRefs(manifestText) {
  const refs = [...String(manifestText || "").matchAll(/\.claude[\\/]hooks[\\/]([\w.-]+\.mjs)/g)].map((m) => m[1]);
  return new Set(refs);
}

// Compare the two hook sets against the deliberate one-sided allowlists.
//   { ok, claudeOnlyUnexpected, codexOnlyUnexpected }
// ok is false iff a hook is one-sided WITHOUT being declared in the matching
// allowlist — i.e. a NEW, undeclared asymmetry.
export function hookManifestParity({ claudeHooks, codexHooks, claudeOnly = CLAUDE_ONLY_HOOKS, codexOnly = CODEX_ONLY_HOOKS } = {}) {
  const claude = claudeHooks instanceof Set ? claudeHooks : new Set(claudeHooks || []);
  const codex = codexHooks instanceof Set ? codexHooks : new Set(codexHooks || []);
  // In Claude but not Codex, and not declared Claude-only → unexpected.
  const claudeOnlyUnexpected = [...claude].filter((h) => !codex.has(h) && !claudeOnly.has(h)).sort();
  // In Codex but not Claude, and not declared Codex-only → unexpected.
  const codexOnlyUnexpected = [...codex].filter((h) => !claude.has(h) && !codexOnly.has(h)).sort();
  return {
    ok: claudeOnlyUnexpected.length === 0 && codexOnlyUnexpected.length === 0,
    claudeOnlyUnexpected,
    codexOnlyUnexpected,
  };
}
