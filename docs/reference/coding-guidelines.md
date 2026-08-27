# Coding guidelines (fuller version)

> Moved out of `CLAUDE.md` on 2026-06-15 so it doesn't load on every turn (Anthropic: a bloated CLAUDE.md makes Claude follow instructions *less*). `CLAUDE.md`'s "Working Principles" now carries a short distilled version of the four principles below; this file keeps the full text Mason asked to preserve. Where these differ from the CRX-specific rules in `CLAUDE.md`, **the CRX rules win.**

## Provenance
- The four principles ("Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution") are the popular community "Karpathy CLAUDE.md" by **Forrest Chang** (`github.com/multica-ai/andrej-karpathy-skills`), distilled from Andrej Karpathy's LLM-coding observations. It is a third-party *derivative* — Karpathy did not author it.
- The "NEVER STOP" passage is Andrej Karpathy's *actual* committed text (`github.com/karpathy/autoresearch`, `program.md`), written for an autonomous ML-experiment loop — **not** a coding-agent rule he publishes for general use.

---

## The four principles (verbatim)

### 1. Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**
Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First
**Minimum code that solves the problem. Nothing speculative.**
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes
**Touch only what you must. Clean up only your own mess.**
When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution
**Define success criteria. Loop until verified.**
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## "NEVER STOP" (verbatim — Karpathy, `autoresearch/program.md`)

> **CRX precedence:** this governs *task momentum* only (don't pause mid-task to ask "should I keep going?"). Routine reversible work, commits, feature-branch pushes, protected green-PR merges, and verification are covered by Mason's standing authorization. It does **NOT** override the CRX Hard Red Lines in `AGENTS.md`, including force-push/history rewrite, irreversible business-data deletion, secret/auth/permission/account changes, or accepting a red/ambiguous release gate. Existing migration and production-action guards remain authoritative.

**NEVER STOP**: Once the experiment loop has begun (after the initial setup), do NOT pause to ask the human if you should continue. Do NOT ask "should I keep going?" or "is this a good stopping point?". The human might be asleep, or gone from a computer and expects you to continue working *indefinitely* until you are manually stopped. You are autonomous. If you run out of ideas, think harder — read papers referenced in the code, re-read the in-scope files for new angles, try combining previous near-misses, try more radical architectural changes. The loop runs until the human interrupts you, period.
