## 2026-08-26 — the fragment convention's own docs catch up with it

Follow-up to PR #482's two advisory review threads, filed right after its merge:

- `AGENTS.md`'s fragment rule claimed a per-change file "cannot conflict" — the same
  absolute overclaim already corrected in `docs/changelog.d/README.md` during review.
  It now states the honest version: collisions require two sessions to independently
  pick an identical date and slug, so put a distinctive noun from the change in the slug.
- `docs/reference/agent-guardrails.md`'s ledger-guard paragraph — the canonical guard
  inventory agents consult — still listed only the legacy shared ledger targets and
  never mentioned fragments, which would have kept sessions appending to
  `docs/CHANGELOG.md` and colliding. It now leads with the fragment as the PREFERRED
  target and records the validation the guard and stop hook apply (ADDED-only, dated
  heading with detail, survival re-validated via `.claude/hooks/changelog-entry-lib.mjs`).

This entry is itself written under the convention it documents.
