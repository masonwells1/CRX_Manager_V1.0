## 2026-09-13 - Preserve confirmed receipts, bills and payments when browser cleanup fails

Fixed GitHub Codex review finding 4000489880 on inventory delivery PR #673. The shared uncertain-intent hook deliberately preserves the original request when acknowledgment cleanup fails; six remaining post-commit calls across five screens must treat that bookkeeping failure separately from the confirmed transaction.

Inventory receiving, Receiving Hub, Quick Receive, vendor-bill creation (normal and saved-receipt recovery), and normal vendor-payment completion now warn, report the cleanup error through the shared Sentry module, and continue their confirmed-success refresh, completion or navigation. Purchase Order receiving and Inventory Hold/Adjustment already use this pattern. No RPC payload, money calculation, grant, permission or live database state changes.

Rendered tests exercise sessionStorage acknowledgment removal failure with the real durable-intent hook, real RPC-result guard and fake IndexedDB, including retained keys and unchanged receiving retries. Inventory receiving also restores its frozen fields when reopening a locked receipt after the success handler cleared the visible form. The inventory migration remains NOT APPLIED; shipping this frontend delivery does not authorize a live migration.
