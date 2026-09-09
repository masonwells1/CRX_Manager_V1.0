## 2026-09-05 — Mason overrode the Codex objection on PR #605 and merges it himself

The third exact-SHA Codex review of PR #605 left one HIGH finding open: removing the `ask` entries
for the enforcement surfaces (settings, hooks, CI workflows, pre-push checks, the proof-minting
script) lets a mistaken or hijacked session rewrite the guards natively. Codex asked for the
protected-path rules back or an immutable external boundary.

The finding was put to Mason in plain English with the recommendation to keep those gate files
prompted and open everything else. He answered "open it all I'll merge".

### What this commit does

- Adds the 2026-09-05 entry to `docs/manual/DECISION_LOG.md` recording the decision, the
  reasoning, and the operative rule: no agent self-certifies past `BLOCKERS`; a Codex objection to
  a settings change goes to Mason, and only Mason's own GitHub merge lands it.
- No change to `.claude/settings.json` or any hook in this commit.

### How PR #605 lands

- The agent-side merge gate (`pr-merge-guard.mjs`) refuses this PR because no clean exact-SHA
  Codex proof exists for its head; that is correct and is not bypassed.
- CI must be green and CodeRabbit reviews the frozen candidate as usual. Mason then clicks
  **Merge** on GitHub. The Codex proof gate binds agents, not the owner.

### Verification

- `node scripts/check-agent-guidance.mjs` and `node scripts/check-agent-workflows.mjs` pass.
- Not verified: nothing here runs; this commit is documentation only.
