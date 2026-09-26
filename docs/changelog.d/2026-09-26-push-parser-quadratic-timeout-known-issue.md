## 2026-09-26 - Known issue: push-parsing path runs past the hook time limit on huge inputs

- **What was found:** round 3 of the independent Opus review of PR #795 timed all three guards on
  ~200 KB adversarial inputs. Two inputs push two guards far past their 15 s PreToolUse limits, and a
  hook that is cut off emits nothing, which ALLOWS the command:

  | Input (~200 KB) | Codex guard (`.codex/hooks/production-action-guard.mjs`) | Claude push guard (`.claude/hooks/codex-push-guard.mjs`) |
  |---|---|---|
  | `;` repeated | ~95 s | > 60 s (killed) |
  | `'a'\|` repeated | ~28 s | ~21 s |

  The Claude merge guard (`.claude/hooks/pr-merge-guard.mjs`) stays under 0.6 s on the same inputs.
- **Not caused by PR #795:** re-measured on 2026-09-26 against `origin/main` and the PR branch at 10 K,
  20 K and 40 K characters — identical, quadratic growth on both (at 40 K: ~4 s for `;`, ~1.3 s for
  `'a'|`, both guards, both branches). The slow path is the shared push parsing both slow guards run
  (suspects: the unbounded `[^;&|]*` tails in `GIT_PUSH_RE` / `GIT_PUSH_PREFIX_RE`, `eachPush`,
  `shellSegments`, and the Codex guard's computed-text / protected-path scans).
- **Status:** not fixed. Recommended as its own small PR after #795 lands: make those scans linear
  (bounded runs, one pass per segment), with a fail-closed size backstop, and timing tests asserting
  ~200 KB of `;` and `'a'|` is answered well inside the hook limits. Guard files, so the Luna rounds and
  the exact-SHA `gpt-6-sol` review apply.
- **Also recorded:** PR #795 was brought up to date with `main` at `bf32063` (#796, GPT-6 review routing);
  the one conflict (`docs/reference/agent-guardrails.md`, same table row) kept main's `gpt-6-sol` text and
  re-added #795's push-budget sentence. GitHub had not started the main CI run for `d7b330e`; the merge
  push started it.
