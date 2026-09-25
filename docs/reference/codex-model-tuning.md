# Codex Model Tuning

Read this only when choosing a Codex (OpenAI) model or reasoning effort, writing a Codex prompt, or changing a script that runs `codex`. The shared owner, safety, delivery, and verification rules remain in `AGENTS.md`; the Claude equivalent is `docs/reference/claude-model-tuning.md`.

Last verified: 2026-09-25.

## The GPT-6 family

OpenAI's current models are GPT-6 Astra (`gpt-6-astra`, most capable, launched early September 2026), GPT-6 Sol (`gpt-6-sol`, complex coding and agentic work, launched 2026-09-22), and GPT-6 Luna (`gpt-6-luna`, fast and cheap for focused high-volume work, launched 2026-09-22). Reasoning effort is `none`, `low`, `medium`, `high`, `xhigh`, or `max`. There is no GPT-6 Terra.

## Which model does which job

Mason's standing tier decision (2026-09-20, carried to GPT-6 on 2026-09-25): Luna iterates, Sol is the once-at-the-end gate for risky work, Astra reviews plans. The **Pinned now** column is what scripts, skills, and the proof gates use today. Use it. The **GPT-6 target** column takes effect only when the switch below lands.

| Job | Pinned now | GPT-6 target | Effort |
|---|---|---|---|
| Iterating code review (advisory, every kind of work) | `gpt-5.6-luna` | `gpt-6-luna` | `xhigh` |
| Early escalation of one review round for genuinely complex work (say why) | `gpt-5.6-sol` | `gpt-6-sol` | `high` |
| Final exact-SHA ship gate for risky work (the only proof the push, merge, and migration guards accept) | `gpt-5.6-sol` | `gpt-6-sol` | `high` |
| Plan, spec, or architecture review; a problem two review rounds could not settle | none (no script runs Astra yet; it has been run by hand, e.g. `docs/plans/2026-09-11-open-pr-backlog-plan.md`) | `gpt-6-astra` | `high`; `max` only for a foundation-wide or money-critical plan |
| Builder for a standard unit (`scripts/codex-build.mjs` default) | `gpt-5.6-terra` | `gpt-6-sol` | `medium` (the script defaults to `xhigh` until the switch) |
| Builder for a money, database, or complex unit | `gpt-5.6-sol` | `gpt-6-sol` | `high` |
| Mechanical sweeps and read-only subagent scans | `gpt-5.6-luna` | `gpt-6-luna` | `medium` |
| Bug-hunt driver (`scripts/codex-hunt.mjs`) | `gpt-5.3-codex-spark` | `gpt-6-luna` | `medium` |

Never lower effort on a money, RLS, or migration path to save tokens. Never run a Luna round through `scripts/write-codex-push-proof.mjs`: it unlinks the existing proof for that HEAD when it starts.

Astra is not a gate. An Astra verdict is advisory evidence for Mason and does not replace the Sol proof on a risky diff.

## Prompting GPT-6 well

OpenAI's GPT-6 guidance (September 2026) matches this repository's design; keep it that way.

- **Keep instructions lean.** GPT-6 follows long instructions well and does not need handholding written for weaker models. Do not add "read these five documents before every edit" rules; `AGENTS.md` routes guidance by task.
- **Contradictions are the main hazard.** GPT-6 is more sensitive to instructions in contextual files (`AGENTS.md`, skills, hook reminders, project docs). When two sources disagree it may pause, change direction, or follow the wrong one. `AGENTS.md` sets the priority order; fix a conflicting lower source rather than adding another rule on top.
- **State the finish line.** Every Codex prompt says what done looks like, what the model may decide alone, and when to stop. `AGENTS.md` defines done by task type and the stop rule; review prompts end with a machine-readable verdict line.
- **Give review prompts a frozen input.** Review a frozen diff file from a neutral directory with the CRX failure classes inlined. Never run an advisory review with `-C <repo>`: the repository's own instruction files tell the reviewer to start a review, and it recurses (observed 2026-08-23).
- **Pin model and effort on every scripted call** (`-m <id> -c model_reasoning_effort="<effort>"`). Scripts ignore the user config on purpose, so an unpinned call silently uses whatever that machine's default is.

## Switching the pins to GPT-6 (pending, needs Mason)

The proof gates hard-require `gpt-5.6-sol` at `high` in three separate places, so a `gpt-6-sol` proof is rejected today. Changing that is a protected change to a gate Mason decided on. It needs his approval and must run on a machine with the Codex CLI, because the new model IDs have to be smoke-tested and the change itself needs a Sol proof. A cloud session without `codex` cannot do it.

1. Update the Codex CLI, then confirm each model answers: `codex exec -m gpt-6-sol -c model_reasoning_effort="high" "Reply OK"`, and the same for `gpt-6-luna` at `xhigh` and `gpt-6-astra` at `high`.
2. In one PR, define the gate model once and import it everywhere. `scripts/write-codex-push-proof.mjs` already exports `CODEX_REVIEW_MODEL` / `CODEX_REVIEW_EFFORT`. Make `proofValid` in `.claude/hooks/codex-push-lib.mjs` and `REQUIRED_CODEX_MODEL` / `REQUIRED_CODEX_EFFORT` in `.claude/hooks/migration-apply-lib.mjs` use that one value instead of their own literals. Then set it to `gpt-6-sol`.
3. In the same PR, move the advisory and builder pins: the Luna literal in `scripts/overnight-codex-gate.mjs`, the builder default in `scripts/codex-build.mjs`, the hunter model in `scripts/codex-hunt.mjs`, and the runnable commands in `.claude/skills/codex-review/SKILL.md`. Update this table, the denial text in `.codex/hooks/production-action-guard.mjs`, and `docs/reference/agent-guardrails.md`. Then run `node scripts/sync-agent-workflows.mjs --write`.
4. Update the pinned tests, and add negative tests that reject `gpt-5.6-sol` and `gpt-6-luna` in both the push proof and the migration-apply proof, so the cheap tier still cannot satisfy the gate.
5. Do not accept both old and new IDs. Proofs expire in minutes and bind to one HEAD, so old proofs die on their own. The one exception: if `gpt-5.6-sol` is no longer served when the switch PR needs its own final proof, add a temporary exact-ID list (`["gpt-6-sol", "gpt-5.6-sol"]`, never a pattern) and remove it in the next PR. The merge guard runs from `main`, so the switch PR's own proof is otherwise minted at the old ID.
6. Add a `docs/manual/DECISION_LOG.md` entry and a `docs/changelog.d/` entry. The final Sol pass on the exact candidate SHA runs last.

## External guidance

- OpenAI, "Introducing GPT-6 Sol and Luna": `https://openai.com/index/introducing-gpt-6-sol-and-luna/`
- OpenAI, "GPT-6 Astra": `https://openai.com/index/gpt-6-astra/`
- OpenAI Developers, "Rethinking skills and prompts for GPT-6 Astra": `https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra`
