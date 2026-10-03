## 2026-10-03 — Slimmer agent guidance; Claude plans then proceeds

Mason asked for leaner `AGENTS.md`/`CLAUDE.md`, as much agent autonomy as possible, and no CodeRabbit
step that needs him.

- `AGENTS.md` (11,995 → ~8,800 bytes) and `CLAUDE.md` (3,283 → ~2,000 bytes): removed text that
  repeated the global rules, `ship.md`, and `codex-model-tuning.md`; every hard rule, approval gate,
  and the autonomous-landing conditions are unchanged and still pinned by `scripts/check-agent-guidance.mjs`.
- Claude no longer waits for Mason's OK after posting a plan; Codex and Claude now both plan, then
  proceed (Mason, 2026-10-03). Hard-gated actions still need his explicit approval.
  `docs/workflows/SAFE_DEVELOPMENT_RULES.md` updated to match.
- New explicit rule: agents request a skipped CodeRabbit review themselves and never ask Mason to
  comment, label, or click for CodeRabbit (already the practice since 2026-09-27; now pinned by the checker).

**Proof observed:** `node scripts/check-agent-guidance.mjs` (all PASS),
`npm run test:agent-workflows` (exit 0), `node scripts/check-doc-drift.mjs` (exit 0).

- `.claude/hooks/session-context-reminder.mjs`: the session-start reminder now says "post a short
  plan, then continue", with its test updated. The auto-mode classifier first refused this edit as
  self-modification and allowed it after Mason's explicit approval in chat. Mason's global
  `~/.claude/CLAUDE.md` (outside the repository) got the same change.

**Not done here:** `.claude/hooks/ship-intent-reminder.mjs` still says "Claude waits for Mason's OK"
in its per-prompt ship reminder. The classifier refused that edit too (Mason's approval named only
the two files above), so it waits for his separate approval.
