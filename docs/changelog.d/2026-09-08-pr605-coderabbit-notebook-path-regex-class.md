## 2026-09-08 — PR #605: CodeRabbit round on `537625b59` — `notebook_path`, regex literals in the comment stripper, `okAllow` completion

CodeRabbit (assertive profile, review 5141301027 on `537625b59`) requested changes with two
Majors and one Minor, each verified against the code before fixing:

1. **`notebook_path` unread (autopilot armed check).** `autopilotDecision` read
   `file_path || path || filePath`; NotebookEdit sends `notebook_path`, so an armed
   `NotebookEdit({ notebook_path: ".claude/hooks/x.mjs" })` judged an empty path and returned
   `"allow"`. Fixed by class: `notebook_path` joins the field set in the armed check, the
   overnight handshake, `hold-latch-lib` and review-proof-guard's path candidates, and
   `protected-surface-parity.test.mjs` now probes NotebookEdit through `notebook_path` so the
   four-list parity holds for the real field. Four new armed cases plus one handshake case; the
   previous lib fails at `PROVEN BYPASS: armed NotebookEdit via notebook_path of a hook denied`.
2. **Regex literal opened a fake block comment (env-guard).** `stripComments` had no regex
   state, so the `/*` inside the character class of `/[/*]/` (or `/a\/*b/`) opened a block
   comment that never closed, and the key lookup or `'service_role'` literal after it vanished
   before the scan. Fixed: a regex state with character-class and escape tracking; a `/` starts a
   regex when the previous non-blank token cannot end an operand (or is an expression keyword such
   as `return`), is division after an identifier, number or closed string, and `)`/`]` count as
   regex starts because doubt keeps MORE text. Six new deny cases and three new allow cases; the
   previous hook fails at `PROVEN BYPASS: a /[/*]/ character class does not open a block comment`.
3. **`okAllow` accepted a crashed hook (migration-apply-guard.test).** The helper only rejected a
   deny decision, so a nonzero exit or signal with no output satisfied an allow assertion. It now
   requires normal completion first, keeping the diagnostic dump on failure.
