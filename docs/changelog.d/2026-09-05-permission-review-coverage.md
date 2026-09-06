## 2026-09-05 - Preserve review coverage for newly editable configuration

PR #605 permits native configuration edits without repeated prompts. The latest
Codex review found that several newly editable paths were missing from the shared
risky-path classifier. Changes to `.coderabbit.yaml`, `.codex/config.toml`,
`.claude/settings.local.json`, and `scripts/check-*`, `scripts/validate-*`, and
`scripts/verify-*` now require independent exact-commit review even when the diff
has no security-related keywords. Both agents use this shared classifier.

The path-field writer refusal now directs agents to native Edit/Write and explains
the review requirement, rather than claiming the removed ask tier still applies.
Regression coverage exercises each configuration path and the actual denial text.
No merge authorization, branch protection, or production setting is changed.
