## 2026-09-03 - Keep failed commission reports visibly unconfirmed

- Publish a commission report's cutoff and both result sets only after the balance and payment-detail RPCs succeed together.
- Preserve the last successful report after a failed refresh and show an explicit warning that empty tables are not a confirmed zero.
- Added a rendered regression test for the failed-refresh path.
