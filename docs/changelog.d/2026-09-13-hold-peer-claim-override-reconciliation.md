## 2026-09-13 — Reconcile a peer-claimed hold before offering an override

The authenticated GitHub Codex review of PR #680 at
`0579a688153146bacf49810923d1c6613d6ff99d` found P2 comment 4001688758:
a definitive stock refusal can release this tab's claim while a live peer still
owns the original non-force hold. Offering an admin reason prompt then changes
the frozen request and conflicts before any override can reach the server.

InventoryPage now reads the synchronous unresolved-intent survivor after
classification. A surviving request returns through the existing unchanged
reconciliation flow; only a fully released request throws the refusal to the
ordinary admin override handler. Neither the hook nor the server contract changed.

The rendered regression uses the real hook and IndexedDB coordinator, adds a
live peer claim to the actual pending request before returning the stock refusal,
and observes the peer-owned record remain pending with its original key. The
preceding implementation opened an unusable override instead of reconciliation.
The correction offers no override and successfully retries the same non-force
payload and key. All 20 InventoryPage recovery tests passed, including ordinary
admin overrides and exact forced retries.

Broader validation passed all 212 recovery tests across 16 suites; typecheck,
lint and build passed. Fresh exact-head independent review is required before
publication; remote checks and final CodeRabbit review remain required for merge.
No CodeRabbit review was requested for PR #680 before this finding. Its reviewed
head and prior PRs are preserved; delivery continues through a new immutable
candidate. Migration 20260908130000 remains NOT APPLIED, and its executable
contents and the existing PostgreSQL proof inputs are unchanged. No live data or
production transaction ran. Vercel's previous deployment remains the rollback path.
