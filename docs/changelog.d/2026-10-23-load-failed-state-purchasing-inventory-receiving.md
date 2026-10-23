## 2026-10-23 — purchasing, inventory and receiving screens say a failed load could not be loaded (To-Do 10.5, third money PR)

- **Purchase Orders:** a failed list said "No purchase orders" under four 0 counts; a failed refresh
  kept the old list as if current. The Outstanding Items tab said "All PO items have been fully
  received" with an Outstanding Value of $0.00. Both now hide their cards and show the failed state
  with Try again. A cost-review flag read with no list disables "Costs to confirm" instead of showing 0.
- **Purchase Order detail:** a failed purchase order read said "Purchase order not found"; a failed
  or empty line read showed the header over no lines with Receive Items, Edit and Submit still
  offered. Both now show "This purchase order could not be loaded" with Try again (a missing or
  hidden purchase order still says not found). A failed receiving-history read said "No items have
  been received yet."; it now says the history could not be loaded, with Try again. A cost-history
  read with no list says it could not be loaded instead of "No cost changes recorded yet."
- **New Purchase Order** and **Quick Receive:** a product catalog that answers with no list counts as
  failed (it showed "No products found"); New PO's Retry shows the loading state again.
- **Receiving Hub:** an inbound purchase order read with no list showed "Nothing on order"; it now
  shows the failed state, which has a Try again button instead of "please refresh".
- **Receiving Log:** a failed log read said "No receiving records" or kept the rows from before it,
  and an older filter's read could land after a newer one and replace its rows. Only the newest read
  may now set the rows, and a failure shows the failed state with Try again (desktop table and phone
  cards; the phone cards show a placeholder while loading instead of "No receiving records"). A failed totals read hid the cards and the
  "received with issues this week" alert with no message; it now says the totals could not be loaded.
- **Inventory:** a failed stock read showed every total as 0 and "No inventory records"; a read with
  no list left the page on its loading skeleton for good. Both now hide the totals, show the failed
  state with Try again, clear any selected rows and turn off Export CSV, Download PDF and Create Hold
  (whose free-stock warning needs the stock). A failed holds read hid the Active
  Holds panel; a failed forecast read said "No planned demand data"; both now say they could not be
  loaded, with Try again. In the receive dialog a failed open-PO read said "No open purchase orders
  found for this product"; it now says the read failed, and only the newest dialog's read may fill the
  list. Product and customer pickers treat a read with no list as failed.
- **Transaction history (ledger):** a transaction read with no list said "No transactions found"; a
  stock-position read with no list left the dialog on "Loading transactions..." for good. Both now
  show the error.
- **Cycle Counts:** a failed list said "No cycle counts yet"; it now shows the failed state with Try
  again. A count whose lines failed to load showed an empty count (0 products, 0 variances) with
  Complete & Apply Adjustments and Cancel Count still offered; it now says the lines could not be
  loaded, with Try again, and offers no actions until they load (nor while they are loading). The pre-completion refresh and the
  location list treat a read with no list as failed.
- Lot Trace already said a failed lookup was not a "no results" answer, so it is unchanged.
- Not changed (low risk, left for later): receiver, creator and staff names that fall back to
  "Unknown" or an empty filter, the PO edit dialog's product search, and silent row caps on the
  receiving log (500) and inbound purchase orders (500).
- Proof: forced each failure against a local fake Supabase server in the dev app and watched the
  failed state, then Try again showing the record. New tests
  (`src/pages/PurchasingInventory.loadFailed.test.tsx`) fail on the old code: 28 of 30. The other
  two pin behaviour that already worked: a ledger read error already showed an error, and a missing
  or hidden purchase order still says "Purchase order not found".
