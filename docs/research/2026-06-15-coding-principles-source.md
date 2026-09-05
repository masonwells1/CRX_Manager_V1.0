# Historical Coding-Principles Source

This preserves the full source text Mason asked to retain when it was moved out of `CLAUDE.md` on 2026-06-15. It is historical background, not active policy. `AGENTS.md` and `docs/reference/coding-guidelines.md` are authoritative where the wording below conflicts with current CRX authority, safety, or verification rules.

## Provenance

- The four principles ("Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution") are the popular community "Karpathy CLAUDE.md" by Forrest Chang (`github.com/multica-ai/andrej-karpathy-skills`), distilled from Andrej Karpathy's LLM-coding observations. It is a third-party derivative; Karpathy did not author it.
- The "NEVER STOP" passage is Andrej Karpathy's committed text (`github.com/karpathy/autoresearch`, `program.md`), written for an autonomous machine-learning experiment loop, not as a general coding-agent rule.

## The Four Principles (Preserved Verbatim)

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

## "NEVER STOP" (Preserved Verbatim — Karpathy, `autoresearch/program.md`)

> **CRX precedence:** This governs task momentum only after the applicable setup or approval checkpoint. It does not override current CRX hard gates, explicit task restrictions, or the tool-specific authority in `AGENTS.md`.

**NEVER STOP**: Once the experiment loop has begun (after the initial setup), do NOT pause to ask the human if you should continue. Do NOT ask "should I keep going?" or "is this a good stopping point?". The human might be asleep, or gone from a computer and expects you to continue working *indefinitely* until you are manually stopped. You are autonomous. If you run out of ideas, think harder — read papers referenced in the code, re-read the in-scope files for new angles, try combining previous near-misses, try more radical architectural changes. The loop runs until the human interrupts you, period.
