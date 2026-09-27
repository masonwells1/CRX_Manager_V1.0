# Codex Model Tuning

Read this only when choosing a Codex (OpenAI) model or reasoning effort, writing a Codex prompt, or changing a script that runs `codex`. The shared owner, safety, delivery, and verification rules remain in `AGENTS.md`; the Claude equivalent is `docs/reference/claude-model-tuning.md`.

Last verified: 2026-09-26 (against the pins on `main` after PR #796).

## The GPT-6 family

OpenAI's current models are GPT-6 Astra (`gpt-6-astra`, most capable, launched early September 2026), GPT-6 Sol (`gpt-6-sol`, complex coding and agentic work, launched 2026-09-22), and GPT-6 Luna (`gpt-6-luna`, fast and cheap for focused high-volume work, launched 2026-09-22). Reasoning effort is `none`, `low`, `medium`, `high`, `xhigh`, or `max`. `gpt-6-terra` and `gpt-6-spark` are refused for this account on the current CLI, so the retired three-tier split collapsed onto Luna (volume) and Sol (money).

## Which model does which job

Mason's standing decisions: the 2026-09-20 tier split (Luna iterates, Sol is the once-at-the-end gate for risky work), moved to GPT-6 and with Luna as builder on 2026-09-23 (PR #796), plus Astra for plan review on 2026-09-25. Every scripted call pins the model below; the proof gates accept only `gpt-6-sol` at `high`.

| Job | Model | Effort | Where it is pinned |
|---|---|---|---|
| Iterating code review (advisory, every kind of work) | `gpt-6-luna` | `xhigh` | `scripts/overnight-codex-gate.mjs`, `/codex-review` Step 3A |
| Early escalation of one review round for genuinely complex work (say why) | `gpt-6-sol` | `high` | `overnight-codex-gate.mjs --sol` |
| Final exact-SHA ship gate for risky work (the only proof the push, merge, and migration guards accept) | `gpt-6-sol` | `high` | `scripts/write-codex-push-proof.mjs`, `.claude/hooks/codex-push-lib.mjs`, `.claude/hooks/migration-apply-lib.mjs`, `.codex/hooks/production-action-guard.mjs` |
| Builder for a standard or mechanical unit | `gpt-6-luna` | `xhigh` | `scripts/codex-build.mjs` default |
| Builder for a money, database, or complex unit | `gpt-6-sol` | `xhigh` (script default) | the mission doc passes `--model gpt-6-sol` |
| Read-only bug hunter | `gpt-6-luna` | not pinned (CLI default) | `scripts/codex-hunt.mjs` |
| Plan, spec, or architecture review; a problem two review rounds could not settle | `gpt-6-astra` | `high`; `max` only for a foundation-wide or money-critical plan | run by hand (no script), e.g. `docs/plans/2026-09-11-open-pr-backlog-plan.md` |

Never lower effort on a money, RLS, or migration path to save tokens. Never run a Luna round through `scripts/write-codex-push-proof.mjs`: it unlinks the existing proof for that HEAD when it starts.

Luna builds and reviews, so a Luna round on Codex-built code is self-review. That is accepted for ordinary reversible work; the Sol gate stays independent and is the one that guards money. Astra is not a gate: an Astra verdict is advisory evidence for Mason and never replaces the Sol proof on a risky diff.

Not yet proven when this was written (see `docs/changelog.d/2026-09-23-gpt6-model-routing.md`): an end-to-end GPT-6 review producing a parseable verdict, and `xhigh` as an accepted effort for `gpt-6-luna`. Run one real Luna round and one Sol gate before trusting the pins on money work.

## Prompting GPT-6 well

OpenAI's GPT-6 guidance (September 2026) matches this repository's design; keep it that way.

- **Keep instructions lean.** GPT-6 follows long instructions well and does not need handholding written for weaker models. Do not add "read these five documents before every edit" rules; `AGENTS.md` routes guidance by task.
- **Contradictions are the main hazard.** GPT-6 is more sensitive to instructions in contextual files (`AGENTS.md`, skills, hook reminders, project docs). When two sources disagree it may pause, change direction, or follow the wrong one. `AGENTS.md` sets the priority order; fix a conflicting lower source rather than adding another rule on top.
- **State the finish line.** Every Codex prompt says what done looks like, what the model may decide alone, and when to stop. `AGENTS.md` defines done by task type and the stop rule; review prompts end with a machine-readable verdict line.
- **Give review prompts a frozen input.** Review a frozen diff file from a neutral directory with the CRX failure classes inlined. Never run an advisory review with `-C <repo>`: the repository's own instruction files tell the reviewer to start a review, and it recurses (observed 2026-08-23).
- **Pin model and effort on every scripted call** (`-m <id> -c model_reasoning_effort="<effort>"`). Scripts ignore the user config on purpose, so an unpinned call silently uses whatever that machine's default is.

## Changing a pinned model later

- Probe new names with a known-bogus control in the same batch: a valid model reaches the usage-limit or answer stage, an invalid one stops at "not supported". The refusal text alone proves nothing.
- The proof identity is an exact string match. Move every enforcement point listed in the table above, the `.codex/` mirror, and every test fixture together, and keep negative tests proving the cheap tier cannot satisfy the gate.
- A PR that changes the gate model cannot satisfy its own new requirement, because the merge guard runs from `main`. Mason merges that PR by hand. Do not widen a validator to accept both models to get around it.
- Update this table, `docs/reference/agent-guardrails.md`, a `docs/manual/DECISION_LOG.md` entry, and a `docs/changelog.d/` entry in the same change, then run `node scripts/sync-agent-workflows.mjs --write`.

## External guidance

- OpenAI, "Introducing GPT-6 Sol and Luna": `https://openai.com/index/introducing-gpt-6-sol-and-luna/`
- OpenAI, "GPT-6 Astra": `https://openai.com/index/gpt-6-astra/`
- OpenAI Developers, "Rethinking skills and prompts for GPT-6 Astra": `https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra`
