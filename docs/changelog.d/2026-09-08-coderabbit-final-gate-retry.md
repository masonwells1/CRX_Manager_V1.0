## 2026-09-08 - Let the CodeRabbit final-review gate recover safely

- The final-review gate now treats completed runs from its own trusted workflow as control-plane history rather than candidate checks, so a failed attempt can be retried on the same frozen pull-request head.
- The exclusion is bound to the current gate workflow's authoritative ID and path; failed checks from every other workflow, including same-named jobs, still block review requests.
