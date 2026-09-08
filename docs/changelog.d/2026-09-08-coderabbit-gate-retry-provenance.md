## 2026-09-08 - CodeRabbit gate retry provenance

The final CodeRabbit review gate now ignores completed failures left by an earlier
run of that exact trusted gate job, so retrying a frozen candidate no longer
wedges on its own historical failure. The gate still blocks on concurrent runs,
pending checks, other jobs in the trusted workflow, and same-name checks from every
other workflow or app. Focused Node regression tests cover those narrow retry
boundaries and pin the trusted workflow to its one `final-review-gate` job.
