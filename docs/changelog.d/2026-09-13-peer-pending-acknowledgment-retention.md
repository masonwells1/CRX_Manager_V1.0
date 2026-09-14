## 2026-09-13 - Preserve the original retry after a peer-owned definitive rejection

The GitHub Codex review of PR #683 identified that definitive rejection released this tab's acknowledgment and attempt even when another live tab still owned the pending request. A later peer completion could therefore unlock this tab without reconciling the original receipt, allowing identical business work under a fresh key.

The shared mutation hook now retains the local attempt and acknowledgment while the coordinator's surviving record remains pending. Claim release and the definitive disposition are unchanged; deletion and confirmed receipt resolution still retire the original acknowledgment through their existing paths.

The regression extends the real hook and IndexedDB two-tab race through both a peer-completion storage event and a reload. Both cases failed on the previous implementation because the form unlocked. Both now stay locked, retry with the original payload/key, and mint a new key only after this tab acknowledges the receipt. All 213 tests across 16 suites, typecheck, lint and build passed. No RPC, money math, database migration, live data or account permission changed. The inventory migration remains unapplied; protected delivery and final reviews are still required.
