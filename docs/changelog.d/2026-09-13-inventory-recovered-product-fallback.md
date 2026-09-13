## 2026-09-13 - Inventory: show the saved product when its name cannot load

After a lost hold reply, reloading could leave the locked hold dialog without a product if the
product had been deactivated or its lookup failed. The dialog now shows `Saved product (name
unavailable)` instead of an empty or unrelated picker. The retry still sends the original product,
customer, quantity and key. The existing lookup error warning remains visible through its toast.

The next independent Opus review confirmed the earlier substantive fixes and identified this
display gap. Its two product observations are corrected here; the recovery limitation disclosure
now also covers an ordinary reload that adopts a peer's pending request, not only duplicated tabs.

Observed proof: 132 tests passed across ten affected suites. Rendered checks cover unavailable
product/customer lookup, deactivated product, exact retries, and both resolved-mirror write failure
and acknowledgement-removal failure after confirmed Hold/Adjust success. Those cleanup failures
still show success plus a warning and refreshed inventory; they retain the original retry until the
browser can safely retire its record. Blindly clearing the attempt in a `finally` would misrepresent
that durable acknowledgement and is deliberately avoided.

A real-hook test also removes both localStorage and IndexedDB while preserving the tab's saved
acknowledgement. Changed input is refused, and the original payload/key/requestVersion are restored.
The review's alleged phantom fresh request is therefore not reproduced: `applyRecord(null)` retains
the saved attempt as the fallback offered to the coordinator. No speculative recovery rewrite was
needed. Optional presentation/hardening observations remain in the private reconciliation.

No SQL implementation or prover change, no live apply and no inventory transaction. Fresh final
candidate reviews, remote checks and actual CodeRabbit review remain required before merge.
