## 2026-09-04 - Commission label repair RPC classification

Classifies the local commission-label repair candidate’s re-emitted earned-state recorder as trigger-only in the generated RPC idempotency inventory. The function is not browser-callable: it returns `trigger`, and all application-role execute privileges remain revoked. The entry must be removed after the repair is applied and the live schema registry is refreshed.
