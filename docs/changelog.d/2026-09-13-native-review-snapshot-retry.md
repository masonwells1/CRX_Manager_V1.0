## 2026-09-13 - Keep trusted snapshot failures retryable

CodeRabbit identified that the distinct candidate snapshot check name was missing from the existing completed trusted gate exclusion. Both display names of the single trusted job now participate in that exclusion. Completion, GitHub Actions app identity, workflow ID and workflow path remain mandatory; pending or foreign checks still block dispatch. Candidate birth validation and actual review delivery requirements remain unchanged.

Focused executable regressions verify retry after a completed trusted snapshot failure and rejection of pending, foreign-app and foreign-workflow snapshot checks. Original review findings and branches are preserved; no application, database, permission or billing changes are included.
