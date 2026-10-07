## 2026-10-06 — guard cleanup, part 2: the unwired reminder files are deleted

Completes the removal recorded in `2026-10-04-guard-cleanup-part-2.md`.

**Removed**

- `dangerous-phrase-warning.mjs`, `codex-gauntlet-reminder.mjs`, `agent-pair-review-reminder.mjs`, `codex-to-claude-handoff-reminder.mjs` and `autopilot-intent-reminder.mjs` under `.claude/hooks/`, with their tests and `overnight-intent-clear.test.mjs`. Nothing loaded them since part 1 unwired them.

**Proof observed**

- Mason ran the `git rm` on 2026-10-06, because the main checkout's older review-proof guard refuses an agent's shell delete under `.claude/hooks`.
- A repository search afterwards found no remaining import, wiring or test entry, only history notes. `npm run test:correction-guards`, `npm run test:agent-workflows`, `npm run check:docs` and `npm run agent-health` passed after the deletion.

**Fixed after Luna round 1 (`gpt-6-luna` xhigh, head b68631da2)**

- `codex-push-lib.mjs`: the single-quote blanking added in part 2 hid real programs when shells disagree on where a quote ends. Commands the part-1 guards denied got through: a backtick around a quote, an ANSI-C `$'\''` string, and PowerShell `\'`. A heredoc, here-string or `#` comment apostrophe spanning a line did the same. Such texts now keep the old, stricter reading; a backslash before anything but a quote (awk's `-F'\t'`) does not count.
- `live-testdata-lib.mjs`: the `uid` allowance now covers only `auth.uid()`; `public.uid()` and `evil.uid()` are blocked again.
- `agent-guardrails.md`: the sentence naming six intent reminders now names the one left.
- Proof: through the real `pr-merge-guard.mjs` and `codex-push-guard.mjs`, all eight of those shapes deny on this head as they do on the part-1 head. The three read-only commands that part 1 denies are allowed, and `x=$($P pr merge 1 --admin)`, which part 1 allows, is denied. Each shape is a regression case in `codex-push-lib.test.mjs` and `guards.test.mjs`; `test:correction-guards`, `test:agent-workflows` and `check:docs` exit 0.
- Not changed: Luna's `eval` / `Invoke-Expression` finding (still denied by the evaluator check) and its cmd.exe `%P%` finding (equally allowed before this PR).
