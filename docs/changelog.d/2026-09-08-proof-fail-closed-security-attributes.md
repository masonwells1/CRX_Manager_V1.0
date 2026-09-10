## 2026-09-08 - Fail closed on unmodeled routine changes and RPC extraction

Migration-proof generation now rejects routine alteration attributes other than
the existing fixed `search_path` form or a validated rename. This prevents
unmodeled attributes such as `LEAKPROOF`, volatility, parallel-safety, cost,
and row estimates from being certified without catalog-level context. The RPC
call-site matcher also reports dynamic client-property and `Reflect.get`
extractions as unresolved even when their invocation happens later, keeping
indirect endpoint selection out of reviewer blind spots.
