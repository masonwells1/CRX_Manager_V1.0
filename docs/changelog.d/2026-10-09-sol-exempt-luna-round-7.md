## 2026-10-09 - Sol exemption: Luna round 7 (owner playbook wording, entry dates)

Luna's seventh review of PR #888 (after the escaping fix) raised one HIGH, one MED and two LOWs.

- **HIGH, not changed: Mason decided.** It repeats the `DECISION_LOG.md` question. Mason kept
  the log eligible ("keep it", 2026-10-09).
- **MED, refuted.** It said a binary file named `.md` could skip Sol, because the guard checks
  the path and git mode but not the content. Nothing loads or runs a docs file except the
  agent-instruction pages, and those are never eligible. CodeRabbit still reads the content of
  every change.
- **LOW, fixed.** `docs/manual/OWNER_PLAYBOOK.md` opened with "every change ... gets a Sol
  review" before naming the exception. It now says "almost every change".
- **LOW, partly fixed.** Two entries are dated 2026-10-10, which is the UTC date they were
  written on (about 02:00 UTC), but still 2026-10-09 for Mason. The playbook's Last verified line
  now says 2026-10-09. The two entries keep their names: the ledger guard refuses a renamed
  changelog entry, so a moved record does not count as a written one.

### Proof observed

- `node scripts/check-doc-drift.mjs` and `npm run test:agent-workflows` pass.
