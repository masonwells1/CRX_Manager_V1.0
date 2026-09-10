## 2026-09-05 - Revoke stale migration proof pairs before re-review

Starting a migration review now removes both prior proof files before any review setup can fail. A blocked or failed re-review therefore cannot leave an older clean authorization available for a later apply. The correction-guard suite now exercises proof-pair revocation, and the documented `proof:save-job-field-acres` command is restored.
