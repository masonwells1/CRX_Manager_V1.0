## 2026-09-13 - Separate workflow execution provenance from PR base

CodeRabbit identified an unnecessary equality between the trusted workflow execution SHA and the original PR base SHA. Execution now validates independently as a 40-character SHA and is authenticated in the original workflow run name alongside the original head/base. Original candidate, trusted workflow, event, repository, actor and timing validations remain required; execution never substitutes for the expected PR base. Tests execute separate execution provenance through snapshot capture and actual review delivery, and reject malformed or unauthenticated execution values before provider spending.

The deploy-check summary now describes receipt plus native label dispatch; its generated adapter is synchronized. The merge checklist explicitly includes receipt/live base SHA matching alongside exact head matching. No application, database, account permission or billing changes are included.
