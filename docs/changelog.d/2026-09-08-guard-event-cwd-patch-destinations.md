## 2026-09-08 - guard event cwd patch destinations

The production-action and review-proof guards now resolve raw native
`apply_patch` destination headers from the hook event's working directory.
This prevents a bare protected filename from bypassing either guard when Codex
runs the tool inside a nested hooks directory. Explicit nested `workdir` or
`cwd` still takes precedence and resolves relative to the event directory.

Focused JSON/stdin and Codex-adapter checks cover Windows and POSIX path forms,
dot-segment resolution, update and Move-to patches, protected destinations, and
ordinary documentation controls. Broader verification remains for the normal
protected delivery step.
