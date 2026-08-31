## 2026-08-31 — CLAUDE.md Model Tuning section extended to the Claude 5 family (Fable 5)

The project `CLAUDE.md` Model Tuning section was titled and worded as Opus-5-only
("Model Tuning (Claude Opus 5)", "Opus 5 obeys that literally", "Opus 5 self-corrects
reliably"). Mason now also runs Claude Fable 5 sessions (the Claude 5 tier above Opus),
and a Fable session could read the section as not applying to it and skip the
review-prompt, effort, and tone rules.

Changed (docs-only, no behavior code touched):

- Retitled the section **Model Tuning (Claude 5 Family — Opus 5 / Fable 5)** and added
  one sentence stating the Opus 5 calibration carries over to Fable 5 until a newer
  harness review supersedes it.
- Reworded the two model-specific bullets ("Opus 5 self-corrects…", "Opus 5 follows
  that literally…") to name the model family instead of one model. No rule, settled
  exception, date, or effort mapping was changed.

Proof observed: grep confirmed no script, test, or hook asserts on the old heading text
(only historical mentions in `docs/manual/DECISION_LOG.md` and
`docs/research/2026-07-25-opus5-harness-review.md`, left as history). Not verified: no
re-run of the 2026-07-25 harness review against Fable 5 — the calibration carry-over is
declared, not measured, and the section still says an effort sweep is pending.

Mason's global `~/.claude/CLAUDE.md` received the matching update in the same session
(not tracked in this repo).
