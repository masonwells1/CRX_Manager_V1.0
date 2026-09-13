## 2026-09-13 — Preserve explicit peer-completed retries and recovered hold identities

The fresh inventory delivery #658 received a Codex P1: a peer completion removed the visible lock while this tab retained its original receipt for replay. An identical new action could then report success by replaying the earlier transaction. Peer-completed attempts now remain visibly frozen until this tab acknowledges the outcome. Acknowledgment releases the lock, and the next identical action receives a fresh key. Existing missing-event replay protection remains intact.

The recovered-hold path now loads the existing product/customer lists and resets the search filter before reopening, so staff can see the identity of the frozen request after reload. Read-only lookup callbacks are stable to avoid repeated recovery fetches.

All 182 checks across 12 affected suites passed, including peer acknowledgment followed by identical new work, retained original-key replay, and rendered restored hold identities. Type checking and lint passed. Fresh independent exact-candidate review, normal checked publication and remote CI remain required for delivery. Migration `20260908130000_bind_create_inventory_hold_receipt_to_intent.sql` remains parked; no live inventory or database changes are performed during verification.
