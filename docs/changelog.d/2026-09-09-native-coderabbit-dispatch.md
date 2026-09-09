## 2026-09-09 - native CodeRabbit dispatch label

The final-review workflow now separates Mason's `ready-for-coderabbit` intent
label from CodeRabbit's native `coderabbit-review-dispatch` opt-in label. The
trusted default-branch workflow attaches the provider label only after its
current-head and required-check validations pass, and it retains a dedupe marker
if the dispatch API outcome is ambiguous.

The workflow waits up to six minutes for delivery, within a ten-minute job
timeout. Dispatch alone stays pending and cannot make the job successful.
Polling or a later reconciliation recognizes only an
exact-head CodeRabbit approval or a substantive CodeRabbit review summary as a
delivered review; a green `CodeRabbit` status, a skipped review, and empty bot
reply artifacts do not count. A subsequent push or invalidating workflow event
removes the dispatch label with the other gate labels.

Existing gate regressions are retained alongside native request, polling,
duplicate-prevention, evidence, refusal and race tests. The provider label must
already exist; the workflow does not create repository labels implicitly.

A real provider-label review remains unverified until the introducing PR is
bootstrapped with Mason's exact one-time authorization. CodeRabbit documents
that it reads feature-branch YAML, so that review can occur before merge without
executing PR code with a write credential. The steady-state default-branch
workflow must then be observed on a frozen candidate. See
`docs/reference/coderabbit-native-review.md` for the protected sequence.
