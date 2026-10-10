## 2026-10-06 — guard cleanup, part 2: the unwired reminder files are deleted

Completes the removal recorded in `2026-10-04-guard-cleanup-part-2.md`.

**Removed**

- `dangerous-phrase-warning.mjs`, `codex-gauntlet-reminder.mjs`, `agent-pair-review-reminder.mjs`, `codex-to-claude-handoff-reminder.mjs` and `autopilot-intent-reminder.mjs` under `.claude/hooks/`, with their tests and `overnight-intent-clear.test.mjs`. Nothing loaded them since part 1 unwired them.

**Proof observed**

- Mason ran the `git rm` on 2026-10-06, because the main checkout's older review-proof guard refuses an agent's shell delete under `.claude/hooks`.
- A repository search afterwards found no remaining import, wiring or test entry, only history notes. `npm run test:correction-guards`, `npm run test:agent-workflows`, `npm run check:docs` and `npm run agent-health` passed after the deletion.

**Fixed after Luna round 1 (`gpt-6-luna` xhigh, head b68631da2)**

- `codex-push-lib.mjs`: the single-quote blanking added in part 2 hid real programs when shells disagree on where a quote ends. Commands the part-1 guards denied got through: a backtick around a quote, an ANSI-C `$'\''` string, PowerShell `\'`, and a heredoc, here-string or `#` comment apostrophe spanning a line. A narrower fallback fixed those, but Luna round 2 (head edf827605) found four more: quotes nested in `"$( )"`, PowerShell curly single and double quotes, and a `@"…"@` here-string. With the same HIGH surviving two rounds, the blanking was **removed** rather than patched again. Only the `$( … )` regrouping stays, which hides no text. The cost: awk's quoted `$1`/`$2` (two of the three original false alarms) are still refused, as on main.
- `live-testdata-lib.mjs`: the `uid` allowance now covers only `auth.uid()`; `public.uid()` and `evil.uid()` are blocked again.
- `agent-guardrails.md`: the sentence naming six intent reminders now names the one left.
- Proof: 21 shapes run through the real `pr-merge-guard.mjs` and `codex-push-guard.mjs` on this head and on the part-1 head. The only change toward allowing is the read-only `while read` loop. All twelve attack shapes from both Luna rounds deny on both. `x=$($P pr merge 1 --admin)`, which part 1 allows, is denied here. `trap '$P pr merge …' EXIT` is allowed on both: a pre-existing gap that this PR does not touch. Each shape is a regression case in `codex-push-lib.test.mjs` and `guards.test.mjs`; `test:correction-guards`, `test:agent-workflows` and `check:docs` exit 0.
- Not changed: Luna's `eval` / `Invoke-Expression` finding (still denied by the evaluator check) and its cmd.exe `%P%` finding (equally allowed before this PR).
