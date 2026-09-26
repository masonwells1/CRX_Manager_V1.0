## 2026-09-05 - Enforce hard-link refusal through alternate state-directory names

Fable 5.1 independently reviewed PR #612 at fa46c27d0 and identified a missing
deny branch: the resolved-path classifier returned `aliased` for a multi-link file
inside the state directory, but the early deny loop handled only `proof` and
`evidence`. The later lexical directory check did not see Windows short names or
the external name of a junction target.

The early loop now denies `aliased` as well. Regression cases cover Read and
NotebookRead through the state directory's Windows 8.3 name and through a
junction's external target. The short-directory Read case failed on the prior
implementation with an empty (allow) response before the fix was applied.

Also correct the earlier changelog's claim that accepting colons in the shell
function-name pattern added protection. Its unanchored predecessor already
matched the prefix; the refusal was not new. No shell exemption or cleanup
eligibility changes are included.
