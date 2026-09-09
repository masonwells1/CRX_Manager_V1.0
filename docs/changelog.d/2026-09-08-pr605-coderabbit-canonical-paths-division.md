## 2026-09-08 — PR #605: CodeRabbit round on `06f0039a2` — canonical paths for the session-state / notes exceptions, division after `)`

CodeRabbit (assertive profile, review 5141893117 on `06f0039a2`) requested changes with two
Majors, both verified against the code before fixing:

1. **Substring exceptions passed traversals (CWE-22).** The overnight handshake let any path
   CONTAINING `session-state` through, and `hold-latch-lib` let any path matching its notes
   pattern through, so `../.claude/session-state/../../outside.txt` (and
   `.claude/session-state/../../src/App.tsx`) passed the handshake as if it were scratch state.
   Fixed by class: `canonicalToolPath()` (backslashes folded, `.`/`..` resolved) and
   `escapesTree()` live in `autopilot-lib.mjs`; the handshake now trusts only a FILE under
   `.claude/session-state/` on the canonical path with no traversal left, and the hold-latch
   exception is judged the same way. Seven handshake cases and four hold cases; the previous lib
   fails at `PROVEN BYPASS: a traversal through session-state is judged on its canonical path`.
2. **Division after `)` was read as a regex (env-guard).** `regexCanStart` counted every `)`
   and `]` as a regex start, so `(total + fee) / 2; // 'service_role'` kept its comment and
   refused benign code. Now `]` is division, and `)` is a regex start only when the matching
   `(` follows `if`/`while`/`for`/`with` (an unmatched paren stays doubt → regex, keeping
   more text). Three allow and two deny cases; the previous hook fails at
   `PROVEN FALSE REFUSAL: division after a parenthesized expression`.
