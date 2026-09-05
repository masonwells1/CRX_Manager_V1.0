Standard launcher for any mission loop — the one way to start "run the X loop" or "read docs/loops/Y.md and execute it". Mason's recorded loop-harness spec applies here (memory: `feedback_capture-loop-harness-spec`): every loop confirms **Driver, Granularity, Worktree, Definition of done, Delivery gate** before any code runs — **no ad-hoc variants**. This command turns that spec into a checked launch sequence instead of something to remember.

**The mission doc** is everything after `/run-loop` (e.g. `/run-loop docs/loops/structure-wave-2-loop-2026-07-02.md`). If Mason named a loop instead of a path ("run the structure wave loop"), find the matching doc in `docs/loops/` and confirm the match to him in one line before proceeding.

## Step 1: Validate the mission doc (HARD STOP on failure)

```bash
node scripts/validate-mission-doc.mjs docs/loops/<mission>.md
```

- **Exit 0** ("MISSION DOC OK") → continue. Surface any ⚠ warnings (worktree path missing on disk, or checked out on a different branch than the doc states) to Mason in the Step 3 summary — warnings don't block, but he should see them.
- **Exit non-zero** → **STOP. Do not launch. Do not "run it anyway".** The validator prints a fill-in template naming the missing slot(s) — fix the doc **with Mason** (these are his calls: who drives, how big a cycle is, which worktree, when it ends, what stays gated), then re-run Step 1. If the doc lacks the 5 slots, the validator already failed it by design — that is the loop-harness spec working, not an obstacle to route around.

## Step 2: Collision check (parallel sessions are real here)

```bash
git worktree list
```

Mason runs many concurrent sessions/worktrees. Compare the list against the worktree + branch the mission doc states:

- Another session appears to be working **in the same worktree** (its branch has recent commits not from you, the tree has fresh WIP that isn't yours, or the worktree is checked out on a different branch than the doc states) → **STOP and ask Mason** which session owns it. Never assume; never launch two sessions into one tree (see memory: `project_parallel-sessions-collision-check`).
- The worktree doesn't exist yet and the doc's Step 0 says to create it → creating it is part of executing the doc (Step 4), not a blocker.

## Step 3: Echo a 3-line plain-English launch summary

Before executing anything, tell Mason exactly what he's getting — pulled from the doc, not paraphrased from memory:

```
Driver:             <who drives each cycle + who reviews — e.g. "Claude implements, Codex reviews every cycle, no owner input unless needed">
Definition of done: <what ends the loop — e.g. "every worklist item DONE (proven + Codex-clean + committed) or PARKED with reason; ledger complete">
Delivery gate:      <what will NOT happen without his OK — e.g. "no live migration apply, no edge-fn deploy, no data deletion, no merge/push to main">
```

If Mason is present, a one-word go ("go" / "run it") is enough. If this is an armed unattended run (autopilot flag verified, not assumed — and remember the flag is 3-state: absent = interactive rules, active = hands-free gates, stale/expired/malformed = authorization LAPSED and ALL live applies park; never delete or rewrite the flag), print the summary and proceed.

## Step 4: Execute the mission doc start-to-finish

Follow the doc **exactly as written** — its hard gates, per-cycle protocol, worklist order, and ledger requirements are the contract. While executing:

- **Keep momentum on reversible work.** Don't pause to ask "should I keep going?" between cycles.
- **Pause ONLY at the hard gates:** deploying an edge function or deleting data always needs Mason's explicit OK in the current conversation. A live migration apply follows the settled 2026-07-13 rule: in an interactive session it needs Mason's in-chat OK; in a pre-authorized armed run it may apply hands-free ONLY through migration-apply-guard's full proof gate (hash-bound reviewer proof with both reviewers + hash-bound Codex proof, both fresh), and a DESTRUCTIVE migration never applies autonomously, armed or not. (The doc may gate more, e.g. "never push to main"; the doc's gates add to these, never replace them.)
- **Stop/pause from Mason = hard halt.** Checkpoint the ledger, then stop (see memory: `feedback_stop-pause-scope-are-hard-halts`).
- **Prove each cycle ran** per the doc's protocol (PROOF — Ran: … · Saw: … lines in the ledger) — tests passing alone is not proof.
- At the end, land the doc's definition-of-done deliverables (ledger handoff, parked-migration apply-order, plain-English summary for Mason) before declaring the loop finished.

## Model & Context Budget (standing, Mason 2026-08-18 — recorded in `docs/manual/DECISION_LOG.md`)

Mason's 30-day usage analysis (2026-08-18) attributed the bulk of the month's token spend — estimated at roughly 40% — to a handful of marathon loop sessions, almost entirely premium-model context re-reads. Two standing rules apply to every loop this launcher starts:

- **Delegate mechanical cycle steps to cheaper models — within the loop's existing structure.** Status checks, doc syncs, grep/read sweeps, and evidence *gathering* may go to subagents on a cheaper model (`sonnet`; `haiku` for pure reads) via the Agent tool's `model` option. This re-tiers steps the loop already delegates or that are genuinely mechanical; it never adds agents on top of a workflow's defined fan-out, and the subagent-budget rule in `docs/reference/claude-model-tuning.md` still governs. The session's own model is reserved for judgment: plans, money/RLS/migration reasoning, reviews, and fixes. Hard floors: **never delegate ledger writes or PROOF lines** — the driver runs the decisive verification itself and records what it observed; subagent reads locate and gather, they do not prove. Never push a money, RLS, or migration decision below the session model — and never below `sonnet` even when the session model is itself cheap. Never lower a reviewer's pinned model/effort — the effort table in that same reference still governs.
- **Obey the session-size sentinel's marathon cap.** On Mason's machine a global user-scope hook (`~/.claude/hooks/session-size-sentinel.mjs` — advisory text injection, not a hard block) warns at 12MB of transcript and issues a MARATHON CAP notice at 25MB, firing on prompt submission and mid-turn after tool calls; the statusline shows a 🔥 HANDOFF flag at the same cap. Where the hook is absent (Codex sandbox, remote runners, another machine), **this written cap binds on its own.** The cap boundary is: **finish only the atomic step already in flight** (the current cycle if one is mid-execution — never leave the ledger half-written), then **do not start another cycle**. Instead: checkpoint the ledger at that boundary, write the handoff, continue the mission in a fresh session, then wind down. An orchestrator additionally hands the driver role — the same role the mission doc's Driver slot already defines, no wider — to the successor and tells worker sessions where the new orchestrator lives. Handing off at the cap is Mason's recorded standing decision (2026-08-18, `docs/manual/DECISION_LOG.md`): a capped session does not keep cycling and does not need a fresh in-chat OK to hand off. Hard gates transfer UNCHANGED to the successor — a handoff never launders an approval, a lapsed/expired autopilot flag stays lapsed (Step 3's three-state flag rules apply in the successor exactly as here), and the successor re-verifies the flag itself before any gated action.

## Hard Rules

- NEVER skip or soften Step 1. A mission doc that fails validation does not run — period.
- NEVER launch into a worktree another session may own without Mason's answer.
- NEVER invent an ad-hoc loop variant because the doc is incomplete — incomplete docs go back to Mason.
- At the 25MB MARATHON CAP, hand off per the Model & Context Budget section above — never keep cycling in a capped session, whether or not the sentinel hook is present to say so.
- Edge-fn deploys and data deletion stay gated on Mason's explicit OK no matter what the mission doc says. Live migration applies stay behind migration-apply-guard no matter what the doc says — interactive = in-chat OK; armed hands-free = full proof + Codex gate; destructive = never autonomous (settled 2026-07-13).
