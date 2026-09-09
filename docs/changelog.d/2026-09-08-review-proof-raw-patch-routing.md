## 2026-09-08 - review-proof raw patch routing

The review-proof guard now extracts destination headers when Codex supplies an
`apply_patch` payload as a raw `tool_input` string. This closes the path-field
protection gap for hook, CI workflow, review-config, wrapper-proof, and review
state destinations while retaining the existing allowance for documentation
that only mentions those paths in prose.

Focused JSON/stdin entrypoint tests cover raw and structured patch updates and
`Move to` headers, including the stop-wrap acknowledgment valve's prohibition
on patch moves or deletes. The shared review-proof and production-action guard
suites passed. Thirteen probes through the actual Codex hook adapter also
observed protected edits, moves and deletes denied, and documentation edits
and moves allowed. Broader checks remain part of protected delivery.
