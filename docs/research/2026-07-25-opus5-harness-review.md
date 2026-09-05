# Harness review — cross-agent sync + Claude Opus 5 tuning

> Navigation note (2026-09-04): the cited agent-contract sections were later condensed and model-tuning guidance moved from `CLAUDE.md` to `docs/reference/claude-model-tuning.md`; this dated research remains historical evidence, not current routing.

**Date:** 2026-07-25
**Scope:** `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.claude/hooks/`, `.claude/commands/`, `.claude/skills/`, `.claude/workflows/`, `.codex/hooks.json`, `.agents/`, `docs/workflows/AGENT_COLLABORATION.md`, `docs/manual/AGENT_ONBOARDING.md`
**Status:** APPLIED. One item remains open — the P1 in §1.1a, which Mason approved on 2026-07-25 as its own separate PR. The two P2s Codex raised (§2.1a, §2.4) are **settled decisions, not open work**.

**Three of this review's own claims were wrong and are corrected in place rather than edited away:**
1. The first draft called the Claude/Codex hook wiring a BLOCKER. It isn't — `agent-manifest-parity.mjs` declares and build-enforces it (§1.1).
2. The correction to (1) over-rotated into calling the two merge guards *equivalent*. Codex refuted that with a P1: the Codex guard binds its proof to a possibly-stale local base (§1.1a).
3. §2.1 reported the severity-filter anti-pattern as absent. It is present in three workflows; the "clean" verdict came from a case-sensitive grep that missed capitalised text (§2.1a).

Each was caught by a different reviewer than the one that made the error. That is the cross-model gate earning its cost.

---

## Plain-English summary

Two separate questions were asked, and they have two different answers.

**"Are we in sync across Claude, Codex, and Hermes?"** Yes — better than expected. The documents agree, the generated Codex adapters match their Claude sources, and the six hooks that run for Claude but not Codex turned out to be *deliberate, declared, and build-enforced* rather than a gap (I called this a BLOCKER on first pass and was wrong — Codex runs its own production guard covering the same actions). Hermes is absent from the repo entirely, which is fine: Mason confirmed it is not actually in use. Two defects came out of this: the parity mechanism wasn't discoverable, which is now fixed, and — caught by Codex reviewing this very PR — Codex's merge guard binds its review proof to a possibly-stale *local* base where Claude's binds to GitHub's real one. That second one is a genuine P1 and is left open for its own change (§1.1a).

**"How do we change things for Opus 5?"** The harness is already close. Anthropic's Opus 5 guide names five habits that used to help older models and now *hurt*; this project has three of them — redundant self-verification language, uncapped subagent fan-out, and (missed on my first pass, found by Codex) severity caps in three overnight workflows. The bigger opportunity is what was simply missing: no effort-level guidance and no subagent budget anywhere, on a model that both delegates and writes more than its predecessors. Mason settled the two cost trade-offs on 2026-07-25 — overnight sweeps keep their finding caps, and the money/inventory night hunt stays at `high` effort until an actual sweep measures otherwise.

---

## Part 1 — Cross-agent sync

### 1.1 NOT A DEFECT — the Codex hook asymmetry is deliberate and enforced

**An earlier draft of this review called this a BLOCKER. That was wrong, and the correction matters because it removes the top item from the work list.**

The raw numbers are real: `.claude/settings.json` wires 35 distinct hook scripts, `.codex/hooks.json` wires 29. But `scripts/agent-manifest-parity.mjs` already diffs the two manifests and **fails the build on any one-sided hook that isn't explicitly declared**, with a written reason. All six divergences are declared:

| Hook | Declared reason |
|---|---|
| `codex-push-guard.mjs`, `pr-merge-guard.mjs` | Codex has its own `.codex/hooks/production-action-guard.mjs`, which covers pushes **and** PR merges. Verified: that file matches `merge_pull_request`, `gh pr merge` (including flags between `gh`, `pr`, and `merge`), `apply_migration`, `deploy_edge_function`, and `delete_branch`. **The coverage is equivalent; the base-binding is not — see 1.1a.** |
| `autopilot-intent-reminder.mjs`, `unattended-autopilot.mjs` | Autopilot is a Claude-session mechanism; Codex has no autopilot flag, so there is nothing for these to read. |
| `worktree-cleanup.mjs`, `session-heartbeat.mjs` | Claude manages `.claude/worktrees/`; Codex worktrees live elsewhere and are never swept. |

So Codex is *not* running unguarded on merges or live actions — it runs a different guard covering the same set of actions (though not, it turns out, with the same base-binding — §1.1a). `node scripts/agent-manifest-parity.test.mjs` passes with 18 assertions, and adding a new hook to one side without declaring it will fail `npm run test:agent-workflows`.

The declare-or-wire-both design is better than the change I proposed, and the *hook wiring* needs no fix. One gap was discoverability: nothing in `CLAUDE.md` pointed at the parity mechanism, so a reviewer comparing the two manifests reaches the wrong conclusion — as I did. **Fix applied:** a line in `CLAUDE.md` under "Claude Hooks and Agents" naming the parity script and the declare-or-wire-both rule.

But "declared" is not the same as "equivalent," and my first correction over-rotated into calling them equivalent. Codex caught that on PR #227. See 1.1a.

### 1.1a OPEN, P1 — the Codex merge guard binds its proof to a possibly-stale local base

**Found by Codex's independent review of PR #227 (2026-07-25), refuting my own "equivalent guard" conclusion. Verified in source before recording.**

The two merge guards do not bind their review proof to the same thing:

- `.claude/hooks/pr-merge-guard.mjs` asks GitHub for `baseRefOid` — the **current** tip of the base branch — and binds the proof to it, denying if GitHub returns an unusable value. Its inline comment names the hazard directly: local `origin/main` "can be stale (Codex round-6: a proof reviewed against an [older base])".
- `.codex/hooks/production-action-guard.mjs` does not. `resolvePullRequest()` requests `baseRefName,headRefName,headRefOid,mergeStateStatus,statusCheckRollup` — **`baseRefOid` is not among them**. `gatePullRequestMerge()` then calls `gateMainChange()` with only the head SHA, and `gateMainChange()` resolves the base with `git rev-parse origin/main` against the **local** checkout. The guard never runs `git fetch`.

**Consequence:** on a checkout whose `origin/main` is behind GitHub's real `main`, Codex can clear a risky money/RLS/migration merge on a Codex proof that reviewed a diff against a base the change will not actually land on. Claude's guard refuses that same situation. The failure is silent — everything looks green.

This is narrow (it needs a stale local checkout plus a risky diff plus a merge attempt) but it sits on exactly the money/RLS/migration path the whole gate exists to protect, and `AGENTS.md` treats stale-checkout risk as a first-class concern under Workspace Hygiene.

**Approved as a separate PR (Mason, 2026-07-25); not fixed in this change.** The fix is to have `resolvePullRequest()` request `baseRefOid` and thread it into `gateMainChange()` as the authoritative base, matching `pr-merge-guard.mjs`, plus regression tests in `.codex/hooks/production-action-guard.test.mjs`. That is a security-guard change to a file listed in the guard's own `PROTECTED_HARNESS_SOURCE` set, so it is its own reviewed change with Mason's sign-off — not a rider on a documentation PR.

### 1.2 CLOSED — Hermes is not in use

A full-text search for "hermes" across the pre-existing harness and docs returned zero hits — no contract, no guard, no entry point, nothing. (The only occurrences in the repository now are this review and its `DECISION_LOG.md` entry, both added by this change.) Mason confirmed on 2026-07-25 that Hermes is not actually part of the workflow, so no contract, entry point, or hook adapter is needed. `AGENTS.md`'s "every coding agent" scope stands as written for Claude and Codex.

If Hermes (or any third agent) is ever adopted, the work is: an entry point that imports `AGENTS.md`, hooks routed through the existing `.claude/hooks/` implementations via an adapter (never copied), and a `CODEX_ONLY_HOOKS`-style declaration in the parity script.

### 1.3 Clean — the Claude↔Codex document layer

These checks passed and need no action:

- `node scripts/sync-agent-workflows.mjs --check` → `PASS - 35 Codex workflow file(s) match .claude sources.`
- `.agents/README.md` and `CLAUDE.md` agree that `.claude/` is source and `.agents/` is generated.
- `AGENTS.md` and `CLAUDE.md` do not contradict each other; `CLAUDE.md` stays routing-only as designed.
- No hardcoded migration/page/function counts in the always-loaded files.
- ~~No stale Claude model IDs anywhere in the harness (the only model IDs present are Codex's `gpt-5.5`, which are correct and current).~~
  **Both halves of this were wrong — corrected 2026-07-27:**
  - *Claude side:* `~/.claude/settings.json` pinned the bare alias `"model": "opus"`, which resolves to
    **Opus 4.8**, not Opus 5. That default was inherited by the reviewer subagents, the workflow
    scripts (`gauntlet-sections-loop.js` — renamed from `gauntlet-sections-2-6-loop.js` on
    2026-07-27 when it was extended to sections 1–9 — `money-inventory-hunt.js`), and
    `scripts/run-claude-review.mjs`, so the whole Claude-side review apparatus — including the
    money/inventory and RLS gates — had been running a generation behind. All of those now pin the
    canonical ID `claude-opus-5`.
  - *Codex side:* `gpt-5.5` was **not** current. Codex now ships three 5.6 agents — `gpt-5.6-sol`
    (reviewer, and the configured default), `gpt-5.6-terra` (builder), `gpt-5.6-luna` (low-risk) —
    and the live `~/.codex/config.toml` reads `model = "gpt-5.6-sol"`. The operational skills,
    commands, and scripts were updated to match; historical ledgers, `docs/CHANGELOG.md`, and
    `docs/archive/**` keep `gpt-5.5` as accurate provenance of what actually ran at the time.

### 1.4 MEDIUM — three smaller consistency items

- **`AGENT_COLLABORATION.md` is Claude-and-Codex only.** Correct as written now that Hermes is out of scope. No change needed.
- **Verification commands were PowerShell-flavored.** `CLAUDE.md` labelled its maintenance block `powershell` though the commands are cross-platform npm/node — mildly confusing for an agent running on Linux, as this session was. **Fixed:** retagged to `bash`. `AGENT_COLLABORATION.md` still carries the same tag; left alone because it is inside the generated-adapter surface and not worth a sync cycle on its own.
- **`.claude/settings.json` allow-lists two bare-UUID MCP servers** (`mcp__50e15046-…` for Supabase, `mcp__0fb370f6-…` in the deny list for Vercel) alongside the named `mcp__supabase__*` entries. My first draft suggested deleting these as dead entries. **Do not do that without checking** — MCP server IDs are generated per install, and these are plausibly Mason's actual local Supabase and Vercel servers. Deleting them would silently break his setup or, worse, remove a *deny* entry. Left untouched; worth confirming against his live MCP config before any cleanup.

---

## Part 2 — Claude Opus 5 tuning

Source: Anthropic's [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) and [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). Opus 5 runs with thinking on by default, defaults to `high` effort, and serves a 1M-token context window.

Headline: **Opus 5 performs well on existing prompts out of the box.** Nothing here is urgent or breaking. These are efficiency and calibration wins.

### 2.1 Anti-patterns Anthropic says to remove — and whether this repo has them

| Opus 5 anti-pattern | Present here? | Verdict |
|---|---|---|
| "Only report high-severity issues" / "be conservative" in review prompts — Opus 5 obeys literally and finds less | **Yes, in 3 workflows** — my first pass said "no," which was a false negative from a case-sensitive grep. | See 2.1a |
| Instructing re-checks the model already does ("double-check your answer") | **Partially** — 7 files use double-check/re-verify language | See 2.2 |
| "Use a subagent to verify" scaffolding causing over-verification | **Yes, heavily** — 99 references to skeptic/refute/adversarial across commands and workflows | See 2.3 — but this one needs care |
| Prompting the model not to think / not to reason | **No** | Clean. |
| Carried-over effort defaults never re-swept | **N/A** — no effort setting exists anywhere | See 2.4 |

### 2.1a OPEN, P2 — three workflows cap findings before the filter pass

**Found by Codex reviewing this PR, after my own grep missed it. Verified in source.**

My first pass searched for `only report|only flag|be conservative|report only` **case-sensitively**, so it never matched the actual text, which begins with a capital R. The pattern is present:

- `.claude/workflows/overnight-bug-hunt.js:51` and `money-inventory-hunt.js:52` — "Prefer precision over volume. Report only what you can substantiate… **At most your 8 most significant findings.**"
- `.claude/workflows/whole-codebase-audit.js:29` — "…Report at most your **10 most significant findings** for this dimension."

This is the exact instruction shape Anthropic says Opus 5 now follows literally, and it conflicts with the rule this change adds to `CLAUDE.md`. The agent ranks and drops findings *before* the adversarial verification pass that was supposed to do the filtering, so a real correctness bug ranked 11th is never seen by anything.

**SETTLED (Mason, 2026-07-25): keep the caps, narrow the rule.** Bounded overnight sweeps are now an explicit exception in `CLAUDE.md` — the per-run cost of uncapped fan-out across many agents outweighs the tail findings. The accepted trade-off is stated plainly: on those runs a low-ranked correctness bug can be dropped before the skeptic pass ever sees it. The rule binds everywhere else, and no other review prompt may add a cap.

**Methodology note worth keeping:** a case-sensitive grep produced a confident "clean" verdict on the single most important anti-pattern in this review. Anti-pattern sweeps in this repo should use `grep -i`.

### 2.2 Trim redundant self-verification language — LOW risk, small win

Seven files carry "double-check / re-verify" phrasing aimed at Claude re-checking its own output. Opus 5 already self-corrects reliably, and these instructions compound: they add tokens without improving results.

Important distinction, because getting this wrong would be bad: **the project's Verification Standard is not the anti-pattern.** "Done means the changed behavior ran and was observed" is a *production safety* rule about executing real code against a real database. Opus 5 does not replace that. Keep it exactly as written. What to trim is only the "and then check your work again" style of instruction layered on top.

### 2.3 Subagent budget — the highest-value change

Opus 5 delegates to subagents noticeably more readily than earlier models. This harness is built on fan-out: `foundation-ultra-review` launches 6 agents plus standing reviewers, `review-workflow` runs 4 layers each with adversarial skeptics, `preflight`, `ship`, `migration-review`, and the overnight hunts all fan out. Each workflow script defines its own fan-out, but there is **no global ceiling** across a run and nothing stops an agent adding ad-hoc subagents on top of a script's defined set.

Terminology, since the distinction matters: the per-workflow fan-outs in `.claude/workflows/` are **hard caps, not defaults**. The rule added to `CLAUDE.md` is that an agent may not exceed the fan-out its workflow defines — the script is the ceiling for that run, and ad-hoc agents on top of it are forbidden. It is not a global budget across the session.

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

## What was applied

Mason approved the fixes on 2026-07-25. Changes made:

| Item | Change |
|---|---|
| 1.1 | `CLAUDE.md` now names `scripts/agent-manifest-parity.mjs` and the declare-or-wire-both rule, so the deliberate Claude/Codex hook asymmetry is discoverable instead of looking like a gap. |
| 1.2 | Closed — Hermes not in use. |
| 1.4 | `CLAUDE.md` maintenance block retagged `powershell` → `bash`. MCP allow-list left alone (see the warning above). |
| 2.3, 2.5, 2.6, 2.1 | New **Model Tuning (Claude Opus 5)** section in `CLAUDE.md`: `<tone_preference>` block, written-deliverable length calibration, subagent budget, the self-verification carve-out that protects the Verification Standard and the Codex gate, and a standing rule against severity-filtered review prompts. |
| 2.4 | Effort mapping documented in the same section, explicitly marked as a pre-sweep starting point, with a hard floor: never lower effort on a money/RLS/migration path. |
| 2.7 | Scope paragraph added to `AGENTS.md` under Plan and Approval Gates — applies to Codex as well as Claude. |

**Deliberately not done:** this change added no `effort` values to `.claude/workflows/*.js`. Anthropic's guidance is to re-run an effort sweep on real evals rather than carry defaults over; forcing untested effort levels into the money/inventory hunt and review workflows would be exactly the unmeasured change that guidance warns against. The policy is documented; the mechanical change waits for measurement.

**Correction (Codex, PR #227):** an earlier wording of the line above implied *no* workflow pins effort. That is wrong — `.claude/workflows/money-inventory-hunt.js` passes `effort: 'high'` at both its finder (`:293`) and verifier (`:334`) call sites. Consequence: the `xhigh` row of the 2.4 mapping does **not** reach the money/inventory night hunt, which is the highest-risk audit in the repo; it continues at `high` until that override is deliberately revisited. Flagged in `CLAUDE.md` so the mapping is not read as already in force. **SETTLED (Mason, 2026-07-25): it stays at `high`** until an effort sweep on real CRX tasks measures otherwise — nothing indicates `high` is currently failing, and `xhigh` costs more on the largest fan-out in the repo. The mapping's `xhigh` row therefore does not reach those agents by design, not by oversight.

---

## What was and was not verified

**PROOF — Ran:**
- `node scripts/sync-agent-workflows.mjs --check` → PASS, 35 files match.
- Hook-reference diff between `.claude/settings.json` and `.codex/hooks.json` (extracted and compared script paths) → the six-hook gap in 1.1 is measured, not inferred.
- Case-insensitive search for "hermes" across the pre-existing repository → 0 hits (this review and its decision-log entry are the only occurrences now, and were added afterward).
- Grep for the five Opus 5 anti-patterns across `.claude/agents`, `commands`, `skills`, `workflows`, `AGENTS.md`, `CLAUDE.md`, `docs/` → results as tabled in 2.1.
- Read in full: `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `AGENT_COLLABORATION.md`, `AGENT_ONBOARDING.md`, `.agents/README.md`, `.codex/hooks.json`.
- Fetched both current Anthropic Opus 5 prompting pages.

- Read `scripts/agent-manifest-parity.mjs` and `.codex/hooks/production-action-guard.mjs`, which is how the 1.1 error was caught. `node scripts/agent-manifest-parity.test.mjs` → 18 assertions passed.
- After the edits: `npm run test:agent-workflows` and `npm run agent-health` (results in the commit that applied them).

**Not verified:**
- The effort table in 2.4 is a hypothesis from Anthropic's general guidance, not measured against CRX tasks. It is documented as policy, not enforced in code, precisely because it is unmeasured.
- Whether the two bare-UUID MCP entries in `.claude/settings.json` correspond to Mason's live MCP servers. Unresolvable from this container; left untouched for that reason.
- The changes here are guidance text, not executable logic. The proof that they work is that the guidance-lint and agent-workflow suites still pass and the always-loaded files stay within their line budgets — not a behavioral run, because there is no behavior to run.
