## 2026-09-30 — last approval-only landing statements now say "cleared"

Codex review of PR #836 (P2) found live instructions that still required CodeRabbit to have
**approved** the head before an apply or merge. Since 2026-09-28 the gates also accept a clean
follow-up after an earlier approval (`coderabbitClearedHead()`), so an agent following those
lines could refuse a landing the gates allow. Each one now says CodeRabbit **cleared** the head
(APPROVED it, or a clean follow-up after an earlier approval):

- `.claude/commands/ship.md`: Step 5 intro and item 3, the "Do NOT run the Sol pass yet" note, and
  the migration Hard Rule.
- `docs/workflows/SAFE_DEVELOPMENT_RULES.md`: the landing checklist item.
- `.claude/skills/codex-review/SKILL.md` (and its synced `.agents/` copy): the autonomous-merge line.
- `docs/manual/OWNER_PLAYBOOK.md`: Mason's plain-English description of the rule.
- The merge guard's autonomous-landing code comment; the gate already called
  `coderabbitClearedHead()`.

Historical `docs/manual/DECISION_LOG.md` entries are left as written; the 2026-09-28 entry records
the change. No gate logic changed.
