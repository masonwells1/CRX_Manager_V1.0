## 2026-10-23 — Job chemical lines never fill a per-unit price that lost part of a cent

- Picking a product on Job Detail (and loading a crop program) converts the product's per-stock-unit
  price into the line's unit when the rate is in a smaller unit, such as a per-GAL price on an oz/ac
  line. That conversion rounded to whole cents: 150¢/GAL is 1.17¢/oz, kept as 1¢, so 128 oz billed
  $1.28 instead of $1.50 (rounding up over-bills the same way). The price is now filled only when
  the conversion is exact in whole cents (1280¢/GAL is exactly 10¢/oz); otherwise it is left blank
  and the job's save check asks for a price, as #1060 already did for a price that rounded to 0¢.
- `reconcileChemAutofillUnits` (`src/lib/chemCalculator.ts`) reports `priceIsExact`, and
  `autofillPriceText` blanks an inexact price. Recipe loads already left any converted price blank
  (`priceTextInLineUnit`). No server function converts a chemical price: `save_job` converts cost
  only, and `load_recipe_into_job` copies a recipe's price as stored and is no longer called.
- A chemical line with a quantity of 0 whose product states no price for the customer's tier now
  saves with a blank price (as $0) instead of being refused, the same way a customer-supplied line
  does: it bills nothing, the `job_chemicals` price trigger from #1060 skips quantity 0 too, and
  raising its quantity later is refused by that trigger and the screen's no-price check (Mason's
  choice, 2026-10-23). A blank left because a stated price is not whole cents in the line's unit
  still blocks at quantity 0: that product has a price, so a saved $0 would pass both checks once
  the quantity rose (Luna).
- The product pick now warns when it leaves a price blank for not being whole cents.
- Cost is still converted with rounding (it is not billed); unchanged here.
- Proof: unit tests in `chemCalculator.test.ts` and `cropProgramHelpers.test.ts`; a local
  click-through against a fake database showed a $1.50/GAL product's oz line with a blank price
  and a $12.80/GAL product's oz line filled at 10¢.
