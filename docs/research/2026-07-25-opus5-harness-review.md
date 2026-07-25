# Harness review — cross-agent sync + Claude Opus 5 tuning

**Date:** 2026-07-25
**Scope:** `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.claude/hooks/`, `.claude/commands/`, `.claude/skills/`, `.claude/workflows/`, `.codex/hooks.json`, `.agents/`, `docs/workflows/AGENT_COLLABORATION.md`, `docs/manual/AGENT_ONBOARDING.md`
**Status:** REVIEW ONLY — nothing in the harness was changed. Every item below is a proposal awaiting Mason's go-ahead.

---

## Plain-English summary

Two separate questions were asked, and they have two different answers.

**"Are we in sync across Claude, Codex, and Hermes?"** Claude and Codex are *mostly* in sync — the documents agree and the generated Codex adapters match their Claude sources. But there is one real hole: six safety hooks run for Claude and do not run for Codex, and three of them are the ones that enforce the landing and hands-free rules `AGENTS.md` describes as applying to everyone. Hermes is not in the harness at all — no rules, no guards, nothing. It is currently the least-supervised agent touching a live production app.

**"How do we change things for Opus 5?"** The good news: the harness is already close. Anthropic's Opus 5 prompting guide names five habits that used to help older models and now *hurt*, and this project only has two of them. The bigger opportunity is the things that are simply missing — there is no effort-level guidance and no subagent budget anywhere, and Opus 5 both delegates and writes more than earlier models did.

---

## Part 1 — Cross-agent sync

### 1.1 BLOCKER — Codex does not run six hooks that Claude runs

`.claude/settings.json` wires 35 distinct hook scripts. `.codex/hooks.json` wires 29. The six missing from Codex:

| Hook | Missing from Codex is… | Why it matters |
|---|---|---|
| `pr-merge-guard.mjs` | **a real gap** | This is the gate on merging a PR to `main`. `AGENTS.md` says the branch → PR → checks → merge path "applies to Claude, Codex, and Mason alike." For Codex it is documented but not enforced. |
| `unattended-autopilot.mjs` | **a real gap** | This is the hook that implements armed hands-free mode — the deny set that parks pushes/merges for morning review. The 2026-07-13 policy explicitly covers Codex. Codex has no mechanism to obey it. |
| `autopilot-intent-reminder.mjs` | **a real gap** | Tells the agent when a run is armed. Codex can be inside an armed run and not know it. |
| `worktree-cleanup.mjs` | minor | Session hygiene, not safety. |
| `session-heartbeat.mjs` | minor | Telemetry only. |
| `codex-push-guard.mjs` | **correct as-is** | This one demands a Codex verdict before a risky push. Codex running it on itself would be circular. Leave it Claude-only, but say so in a comment so a future reader doesn't "fix" it. |

This is sharpened by an asymmetry already in the contract: since 2026-07-22 Codex holds a *standing execution authorization* that Claude does not have — it begins reversible in-scope work right after stating a plan. So the agent with the widest autonomy has the thinnest enforced guard net. The documents say the two are equal; the code says they are not.

**Proposed fix:** add `pr-merge-guard`, `unattended-autopilot`, and `autopilot-intent-reminder` to `.codex/hooks.json` through the existing adapter (no new hook logic — the adapter pattern already exists and works). Then re-run `npm run test:agent-workflows`.

**Caveat:** I have not confirmed the Codex CLI's hook runner supports the `Stop`/`UserPromptSubmit` semantics these three rely on. That needs a live check on Mason's machine before this is called done — the adapter exists but I could not execute Codex here.

### 1.2 BLOCKER — Hermes is invisible to the entire contract

A full-text search of the repository for "hermes" returns **zero hits** — not in `AGENTS.md`, not in `docs/`, not in any hook, not in any settings file.

Consequences, in plain English: Hermes has no copy of the CRX hard rules (money-as-cents, RLS on new tables, idempotency keys, `src/lib/db.ts` only). It gets none of the PreToolUse guards that refuse a bad Write. It is not covered by the push/merge/migration gates. If Hermes writes a migration, nothing in this project stops it.

`AGENTS.md` opens with "This is the shared, project-level contract for every coding agent in this repository." That sentence is currently false.

**Proposed fix, in order:**
1. Confirm what Hermes actually is and what surface it reads (see the open question at the end — I don't want to guess at this).
2. Give it an entry point that loads `AGENTS.md` (the same way `CLAUDE.md` does with `@AGENTS.md`).
3. Route its hooks through the same `.claude/hooks/` implementations via an adapter, exactly as `.codex/hooks.json` does. Do **not** copy hook logic — the one-source-of-truth rule in `CLAUDE.md` is right and should hold for a third agent.
4. Add Hermes to the routing table in `docs/workflows/AGENT_COLLABORATION.md` and to the read-order in `docs/manual/AGENT_ONBOARDING.md`.

Until step 3 lands, my recommendation is that Hermes be treated as read-only / advisory and not be allowed to write migrations or money code.

### 1.3 Clean — the Claude↔Codex document layer

These checks passed and need no action:

- `node scripts/sync-agent-workflows.mjs --check` → `PASS - 35 Codex workflow file(s) match .claude sources.`
- `.agents/README.md` and `CLAUDE.md` agree that `.claude/` is source and `.agents/` is generated.
- `AGENTS.md` and `CLAUDE.md` do not contradict each other; `CLAUDE.md` stays routing-only as designed.
- No hardcoded migration/page/function counts in the always-loaded files.
- No stale Claude model IDs anywhere in the harness (the only model IDs present are Codex's `gpt-5.5`, which are correct and current).

### 1.4 MEDIUM — three smaller consistency items

- **`AGENT_COLLABORATION.md` is Claude-and-Codex only.** Its routing table has five rows, all two-model. A third agent breaks the framing of every entry ("Both agents review…").
- **Verification commands are PowerShell-flavored.** `CLAUDE.md` and `AGENT_COLLABORATION.md` label the maintenance block ```powershell. The commands themselves are cross-platform npm/node. Harmless on Mason's Windows box, mildly confusing for an agent running on Linux (as this session is). Suggest dropping the language tag or using ```bash.
- **`.claude/settings.json` still allow-lists a bare UUID MCP server** (`mcp__50e15046-…`) alongside the named `mcp__supabase__*` entries, and a bare `mcp__Claude_Preview`. These are probably historical. Worth a pass to delete dead entries — an allow-list is a security surface, and entries nobody can identify are the ones that age badly.

---

## Part 2 — Claude Opus 5 tuning

Source: Anthropic's [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) and [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). Opus 5 runs with thinking on by default, defaults to `high` effort, and serves a 1M-token context window.

Headline: **Opus 5 performs well on existing prompts out of the box.** Nothing here is urgent or breaking. These are efficiency and calibration wins.

### 2.1 Anti-patterns Anthropic says to remove — and whether this repo has them

| Opus 5 anti-pattern | Present here? | Verdict |
|---|---|---|
| "Only report high-severity issues" / "be conservative" in review prompts — Opus 5 obeys literally and finds less | **No** — grep across `.claude/agents`, `commands`, `skills`, `workflows` found zero instances. The reviewers correctly say "report everything, filter later." | Clean. Do not introduce this. |
| Instructing re-checks the model already does ("double-check your answer") | **Partially** — 7 files use double-check/re-verify language | See 2.2 |
| "Use a subagent to verify" scaffolding causing over-verification | **Yes, heavily** — 99 references to skeptic/refute/adversarial across commands and workflows | See 2.3 — but this one needs care |
| Prompting the model not to think / not to reason | **No** | Clean. |
| Carried-over effort defaults never re-swept | **N/A** — no effort setting exists anywhere | See 2.4 |

### 2.2 Trim redundant self-verification language — LOW risk, small win

Seven files carry "double-check / re-verify" phrasing aimed at Claude re-checking its own output. Opus 5 already self-corrects reliably, and these instructions compound: they add tokens without improving results.

Important distinction, because getting this wrong would be bad: **the project's Verification Standard is not the anti-pattern.** "Done means the changed behavior ran and was observed" is a *production safety* rule about executing real code against a real database. Opus 5 does not replace that. Keep it exactly as written. What to trim is only the "and then check your work again" style of instruction layered on top.

### 2.3 Subagent budget — the highest-value change

Opus 5 delegates to subagents noticeably more readily than earlier models. This harness is built on fan-out: `foundation-ultra-review` launches 6 agents plus standing reviewers, `review-workflow` runs 4 layers each with adversarial skeptics, `preflight`, `ship`, `migration-review`, and the overnight hunts all fan out. There is currently **no cap anywhere** on how many agents a run may spawn.

The risk is not correctness — it is cost and wall-clock time growing quietly, on a model that already defaults to `high` effort.

But two things here are genuinely *not* the anti-pattern and should be defended:

- **The Codex cross-model gate stays.** Anthropic's warning is about a model verifying *itself*. Codex is a different vendor and model; that gate is the real independent check and is the backbone of the money/RLS/migration policy. Untouched.
- **The adversarial skeptics are a deliberate precision trade.** `review-workflow.md` is explicit that same-model skeptics exist to cut false positives, and `migration-review` only drops a BLOCKER if *both* skeptics refute it. On a live financial app that conservatism is defensible even at a token cost. My recommendation is to keep them on migration/money/RLS paths and consider trimming them on low-risk paths — not to strip them wholesale.

**Proposed addition** to `CLAUDE.md` (Claude-only routing, so it does not touch the shared contract):

```text
Delegate to a subagent only for large, genuinely independent, parallelizable work — a wide
multi-file investigation, or a review layer the workflow already defines. Do not delegate work
you can finish in a handful of tool calls, and do not spawn a subagent to double-check your own
output. Where one agent suffices, use one. The defined fan-outs in .claude/workflows/ are the
budget: do not add ad-hoc agents on top of them.
```

Note the last sentence — the existing workflow scripts are already deterministic caps. The rule is "don't exceed what the script defines," which preserves every review layer while stopping improvised sprawl.

### 2.4 Effort levels — currently unset, and worth setting

Nothing in `.claude/settings.json` or any agent definition sets an effort level, so everything runs at the `high` default. Anthropic's guidance is that `low` and `medium` hold quality on much of this work at a fraction of tokens and latency, and `xhigh` is worth it for demanding agentic work. Notably, **review accuracy holds at lower effort** — which supports a fast pass now and a thorough pass later.

Proposed mapping for CRX, matched to this project's own risk tiers:

| Work | Effort | Reasoning |
|---|---|---|
| `/status`, `/parked`, `/fleet`, doc updates, single-file UI tweak | `low` | Mechanical; quality holds |
| `/preflight`, routine code review, non-money multi-file work | `medium` | Where the token savings are largest |
| Money, inventory, RLS, migrations, `/ship`, `/codex-gauntlet` | `high` (default) | Current behavior — no change |
| `/foundation-ultra-review`, `/migration-review`, overnight hunts | `xhigh` | Demanding long-horizon agentic work |

This wants an eval sweep on real tasks before being locked in — Anthropic explicitly says to re-run an effort sweep rather than carrying defaults over. I'd treat the table as a starting hypothesis, not a settled config.

### 2.5 Response length — matters more here than on most projects

Opus 5's default user-facing responses run longer than prior Opus models, and it narrates more during agentic work. Mason has zero coding background, so the failure mode is specific and real: a longer answer is not a clearer one, and burying the recommended next step under four paragraphs of narration is exactly what this project's own guidance says not to do.

The effort parameter controls *thinking*, not *speaking* — length has to be asked for explicitly.

Proposed addition to `CLAUDE.md`:

```text
<tone_preference>
Keep responses focused and concise. Lead with the outcome — the first sentence answers "what
happened" or "what did you find" — then supporting detail. Keep caveats short. Give a high-level
summary unless Mason asks for depth. Before your first tool call, say in one sentence what you're
about to do; while working, update only on an important finding or a change of direction.
</tone_preference>
```

### 2.6 Written deliverable length — a real cost on this repo

Files Claude writes to disk are longer on Opus 5 than on prior models. This project generates a *lot* of them: `docs/audits/`, `docs/reports/`, `docs/handoffs/`, `docs/loops/`, plus every review artifact. Left alone, each of those gets meaningfully longer for no added substance — and Mason has to read them.

Proposed addition:

```text
Match the length of written documents to what the task needs: cover the substance, but do not pad
with filler sections, redundant summaries, or boilerplate. Reports and audits lead with findings,
not with a restatement of the assignment.
```

### 2.7 Task scope — pairs with an existing gap

Opus 5 can widen a task's scope on its own judgment. `AGENTS.md` already handles the *stopping* side well (approval gates, one categorical verdict). It says less about the *scope* side. Anthropic's recommended phrasing fits this project almost verbatim:

```text
Deliver what was asked, at the scope intended. Make routine judgment calls yourself, and check in
only when different readings would lead to materially different work. If the request seems mistaken
or a better approach exists, say so in a sentence and continue with the task as asked rather than
quietly narrowing, widening, or transforming it.
```

This one belongs in `AGENTS.md` rather than `CLAUDE.md` — scope discipline should apply to Codex and Hermes too — which means it needs Mason's sign-off as a contract edit.

### 2.8 Long context — an assumption worth revisiting later

Opus 5 has a 1M-token context window as both default and maximum, with instruction-following holding across it. Several design choices here — the `PreCompact` hook's reminder block, the handoff-packet workflow, aggressive doc-splitting to keep always-loaded files lean — were built when context was the binding constraint. They are not wrong now, and I am **not** recommending changes: the handoff packets also serve cross-agent and cross-session purposes that have nothing to do with context size. Flagging it only so the assumption gets re-examined deliberately rather than inherited by accident.

---

## Recommended order of work

1. **Close the Codex hook gap** (1.1) — three hooks through the existing adapter. Highest safety value, smallest diff.
2. **Decide what Hermes is and gate it** (1.2) — needs Mason's input first; until then, Hermes stays advisory.
3. **Add the Opus 5 tuning block to `CLAUDE.md`** (2.3, 2.5, 2.6) — Claude-only, reversible, no contract change.
4. **Add the scope paragraph to `AGENTS.md`** (2.7) — contract edit, needs sign-off.
5. **Effort sweep** (2.4) — measure on real tasks before committing to the table.
6. **Housekeeping** (1.4) — dead MCP allow-list entries, language tags.

Items 1, 3, 4, and 6 are all small, reversible edits and could land in a single PR once approved.

---

## What was and was not verified

**PROOF — Ran:**
- `node scripts/sync-agent-workflows.mjs --check` → PASS, 35 files match.
- Hook-reference diff between `.claude/settings.json` and `.codex/hooks.json` (extracted and compared script paths) → the six-hook gap in 1.1 is measured, not inferred.
- Full-repo case-insensitive search for "hermes" → 0 hits.
- Grep for the five Opus 5 anti-patterns across `.claude/agents`, `commands`, `skills`, `workflows`, `AGENTS.md`, `CLAUDE.md`, `docs/` → results as tabled in 2.1.
- Read in full: `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `AGENT_COLLABORATION.md`, `AGENT_ONBOARDING.md`, `.agents/README.md`, `.codex/hooks.json`.
- Fetched both current Anthropic Opus 5 prompting pages.

**Not verified:**
- Whether the Codex CLI's hook runner honors the `Stop` / `UserPromptSubmit` semantics that `unattended-autopilot` and `autopilot-intent-reminder` depend on. Needs a live Codex run on Mason's machine before 1.1 can be called done.
- Anything about Hermes — its model, surface, config location, or current permissions. Nothing about it exists in this repo to read.
- The effort table in 2.4 is a hypothesis from Anthropic's general guidance, not measured against CRX tasks.
- No harness file was modified, so no behavior change was executed or observed. This document is the deliverable.
