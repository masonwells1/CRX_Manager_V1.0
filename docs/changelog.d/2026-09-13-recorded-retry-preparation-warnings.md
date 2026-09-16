## 2026-09-13 - Recorded transactions retain warnings after retry preparation fails

Fixed GitHub Codex findings on Quick Receive, Receiving Hub and vendor payment recovery. A locked retry that cannot prepare its durable record now says nothing further was sent, warns against recording the same goods or payment on another device, and preserves whether the earlier transaction is known recorded or may already be recorded. Fresh receiving/payment attempts retain their separate preparation-failure message.

Extended existing rendered tests using the real durable-intent hook: after a confirmed transaction and failed acknowledgment cleanup, another mirror-storage write failure blocks retry before the RPC. The recorded-once banner and original key remain, no extra RPC is sent, and recovery subsequently retries the unchanged original request.

No SQL, grants, storage format or live data changed. The targeted five suites passed all 56 tests, and the broader 17 focused suites passed all 208 tests. Typecheck, lint and production build passed.
