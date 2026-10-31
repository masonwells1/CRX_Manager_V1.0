## 2026-10-29 — A booked price changes straight away, without a re-send

- Mason, 2026-10-27: a rep can change a booked price straight away. A higher price shows a warning
  and needs the rep's confirmation tick; who, when, the old price and who ticked are recorded;
  below cost still needs an admin. Before this (#1105), a changed price had to be re-sent to the
  customer before Convert, Partial Order or Schedule Job would bill it.
- New migration `20261029120000_booking_price_override.sql` (row 1005 placeholder, NOT APPLIED):
  - New table `quote_price_changes`: one row per changed booked price on a sent quote, with the
    old and new price in whole cents, who changed it and when, and who ticked "grower agreed" for
    a raise. Admins and sales reps can read it; only `save_quote` writes it.
  - `save_quote` records each change. A higher price without the tick is refused
    (`QUOTE_PRICE_RAISE_NEEDS_GROWER_CONFIRMATION`) and nothing is saved.
  - The sent-price check accepts a line the customer was sent at its latest recorded price.
- Quote Builder: a raised price on a sent quote shows "Grower agreed to $X (was $Y)" with a tick
  box under the price, and Save asks for it. The banner no longer asks for a re-send after a
  price change. Five #1105 screen tests were updated to the new rule.
- Unchanged: a new line, a changed customer, or a price changed outside Save still needs a
  re-send; edits stay owner-only; below-cost approval; how a sent line is priced.
- Proof (local replay of main `91487a92`, synthetic data): booking scenarios S19 (today's price
  with the tick: billed $13.99 with no re-send, recorded with who confirmed), S19b (raise without
  the tick: refused, price unchanged), S20 (lower price: billed $12.00, no tick needed, recorded)
  and S20b (a price changed outside Save: re-send still needed) pass; every other scenario gives
  the same result as main. Tests: `src/lib/bookingPriceOverrideMigration.test.ts`, the price-lock
  helper test, and two new Quote Builder tests.
