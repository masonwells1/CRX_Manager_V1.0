## 2026-09-26 — `/ship` sizing: every change that is not Trivial takes the full pipeline

CodeRabbit's second review of PR #797 (at `cb037319`) found a gap left by the previous fix. The
Trivial light path now excludes auth, permission, inventory, and other business-critical changes,
but the Substantial definition still listed only multiple files, SQL, money, RLS, lifecycles, and
RPCs, so a one-file auth or permission change fit neither size.

`.claude/commands/ship.md` Step 0.5 now defines Substantial as everything that is not Trivial and
names the same risk categories, so such a change always takes the full pipeline, including the Sol
review `AGENTS.md` requires.

**Proof observed (cloud session):** `npm run test:agent-workflows` and the 53 top-level hook and
script test files passed.
