# Coding Guidelines

Before changing code, check `docs/manual/DECISION_LOG.md` before reopening a settled design choice and `docs/manual/KNOWN_ISSUES.md` before claiming a problem is new.

Read this for every code change. `AGENTS.md` carries the short always-loaded version; this file explains how to apply it.

The earlier third-party principles and Karpathy experiment-loop passage Mason asked to preserve remain available as historical source material in `docs/research/2026-06-15-coding-principles-source.md`. They are not active policy where they conflict with `AGENTS.md`.

## Build the Simplest Complete Solution

- Implement the requested outcome and the real edge cases shown by current source, data, tests, or business rules. Do not add features for hypothetical future needs.
- Prefer an existing project pattern over a new abstraction. Prefer a direct function over a framework, factory, wrapper, compatibility layer, or configuration system used once.
- Add a dependency only when the existing stack cannot reasonably solve the problem and the dependency materially reduces risk or maintenance.
- Keep functions and components focused on one responsibility. Split code when it clarifies a meaningful boundary or makes testing easier, not to satisfy an arbitrary line count.
- Shorter is useful only when it remains obvious. Do not trade readable control flow and names for dense expressions or clever one-liners.

## Make Surgical Changes

- Every changed line should trace to the requested outcome, a required test, or a directly exposed defect.
- Match existing style and reuse shared helpers, types, components, and database patterns.
- Do not add `any` or `@ts-ignore`. The existing `src/lib/reportPdf.ts` `columnStyles` cast is the one narrow compatibility exception; do not copy it elsewhere.
- Do not reformat or refactor adjacent code merely because you would write it differently.
- Remove imports, branches, helpers, and tests made obsolete by your change. Mention unrelated dead code; do not remove it unless asked.
- Keep behavior changes separate from mechanical cleanup when separating them makes review and rollback clearer.

## Keep Business Rules Obvious

- Use names that describe the business meaning, units, and state. Money names include their units, such as `_cents`.
- Keep authoritative financial, inventory, lifecycle, and permission rules in PostgreSQL where every caller receives the same protection.
- Prefer explicit validation and state transitions over permissive fallback behavior that hides bad data.
- Comments explain why a constraint exists, which business invariant it protects, or why an apparently simpler alternative is unsafe. Do not narrate what the code plainly says.

## Verify Against the Goal

- Define observable completion before implementing. For a bug, reproduce the failing behavior when practical; for a feature, name the user-visible or data result that proves it works.
- Run the smallest meaningful check first and expand verification according to risk. Do not run broad suites repeatedly without a new reason.
- A new test can repeat the same mistaken assumption as the implementation. Observe the actual UI, RPC result, database invariant, or integration path required by `AGENTS.md`.
- Stop adding abstractions, fallbacks, or tests once the requested behavior is complete, the required checks pass, and no evidence-backed risk remains.

## Agent Momentum

Continue safe, authorized work until the stated outcome is complete. A failed approach is a signal to diagnose and try a safe alternative, not to hand the task back. This does not override the hard gates in `AGENTS.md` or an explicit restriction from Mason.

## Sources

- OpenAI recommends starting with the smallest instruction set that preserves the product contract, making autonomy explicit, and calibrating verification to risk: `https://developers.openai.com/api/docs/guides/latest-model`.
- Anthropic recommends short project instructions, removing self-evident guidance, loading detailed procedures through skills, and pruning rules that do not change behavior: `https://code.claude.com/docs/en/best-practices`.
