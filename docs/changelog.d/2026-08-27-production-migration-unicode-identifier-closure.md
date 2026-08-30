## 2026-08-27 - Production migration Unicode identifier closure

- Reject PostgreSQL Unicode-escaped identifiers and strings anywhere in an automated migration.
- Cover an authenticated `SECURITY DEFINER` function that disguises the protected migration ledger
  schema with a Unicode-escaped identifier.
