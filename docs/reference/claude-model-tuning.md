# Claude Model Tuning

Read this only when choosing a Claude model or reasoning effort, delegating work, or writing a reviewer prompt. The shared owner, safety, delivery, and verification rules remain in `AGENTS.md`.

## Response and Context Discipline

- Follow the owner-communication contract in `AGENTS.md`: lead with the outcome, use plain English, stay concise, and give one recommended next step.
- Match document length to the task. Reports, audits, and handoffs lead with findings and omit filler, repeated summaries, and boilerplate.
- Keep startup context small. Put task-specific procedures in skills or workflow documents and load them only when relevant. An `@` import organizes content but still loads that content into every Claude session.

## Delegation

- Delegate only large, genuinely independent work whose saved time or isolated context justifies coordination overhead.
- Do not delegate a task that can be completed in a handful of tool calls, and do not spawn an agent merely to repeat the coordinator’s own check.
- A workflow-defined fan-out is a hard cap for that run, not a default. Do not add ad-hoc agents on top of it.
- Keep one writer per checkout. Use separate clean worktrees and disjoint ownership for concurrent writers.

## Verification and Review Prompts

- Do not add generic “double-check your answer” loops. Run the real verification required by `AGENTS.md`: execute the changed behavior, inspect the result, and use independent review where the risk requires it.
- Reviewer prompts must request every correctness, safety, and scope finding, then classify or filter findings in a later pass. Never hide real findings with a severity-only prompt.
- Bounded overnight sweeps are the settled exception: `overnight-bug-hunt.js`, `money-inventory-hunt.js`, and `whole-codebase-audit.js` retain their existing significance caps because uncapped fan-out is too costly. Do not add that cap elsewhere without a new decision.
- Avoid chasing speculative reviewer suggestions that do not affect correctness, safety, or the requested outcome; that creates unnecessary abstractions and tests.

## Model and Effort Routing

This mapping is a starting point, not a reason to lower rigor on risky work. Never lower effort on a money, RLS, or migration path to save tokens.

| Work | Starting effort |
|---|---|
| Mechanical read-only status, parked-work inventory, fleet checks, simple documentation | `low` |
| Routine implementation, review, and non-money multi-file work | `medium` |
| Money, inventory, RLS, migrations, shipping, and adversarial review | `high` |
| Foundation-wide review, migration review, and overnight hunts | `xhigh` |

`money-inventory-hunt.js` deliberately pins its finder and verifier calls to `high` until a real effort comparison proves a better setting. Do not change that based only on the table above.

The July 2026 tuning was measured on Opus 5. Applying it to Fable 5 remains provisional but binding until a newer CRX harness review replaces it; a Fable 5 session must not treat this guidance as Opus-only or skip it. Background and measurements: `docs/research/2026-07-25-opus5-harness-review.md`.

## External Guidance

- Anthropic recommends keeping `CLAUDE.md` concise, loading domain procedures through skills, and using hooks for behavior that must happen every time: `https://code.claude.com/docs/en/best-practices`.
- Anthropic’s instruction-loading reference explains that imported files still consume startup context and that path-scoped rules or on-demand skills reduce noise: `https://code.claude.com/docs/en/memory`.
