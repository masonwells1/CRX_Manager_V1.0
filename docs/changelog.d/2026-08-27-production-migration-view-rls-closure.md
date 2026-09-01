## 2026-08-27 — Production migration view/RLS closure

Exact-commit adversarial review proved that an unrestricted owner-run view could expose `auth.users`
or RLS-protected public data through CRX's default relation grants. View creation is now excluded
entirely from the automated migration allowlist.

Regression tests cover direct authentication-schema access, a protected customer table, and a
Unicode-escaped schema identifier. Views remain available through the separately reviewed manual
migration path.
