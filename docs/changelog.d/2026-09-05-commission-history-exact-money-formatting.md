## 2026-09-05 - Keep commission history formatting exact

- Formatted the new commission balance and payment-detail dollar fields without `Number()` or `toFixed()` rounding.
- Exact decimal text remains lossless at any size; JSON numbers fail visibly once JavaScript can no longer distinguish adjacent cent values.
- Added regression coverage for exact cents, negative amounts, malformed values, fractional-cent rejection, and unsafe JSON transport amounts.
