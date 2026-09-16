## 2026-09-12 - Reject ambiguous manual review history

Comment-based CodeRabbit requests can also produce a late same-head review
without attesting its base. Native dispatch and reconciliation now reject
retained manual review/full-review/resume requests and retargeted PR history.
Human request comments remain preserved; clearing them is not an authorized
way to manufacture an unused candidate. A fresh PR provides an unambiguous
review boundary while preserving the original branch, work and findings.

The native runbook also requires checking and refreshing an existing PR's
cached base metadata before publishing a new candidate. This keeps the new
head private until its actual base is established. Existing exact-head/base
independent proof, CI and formal provider review remain required.
