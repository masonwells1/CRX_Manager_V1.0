## 2026-08-27 — Global ledger guard and quoted-grant closure

Exact-commit adversarial review found that quoted `supabase_migrations` identifiers disappeared from
the top-level skeleton before the protected-schema check, and that unrestricted `GRANT` statements
could expose the ledger. Protected-schema text is now rejected before tokenization. Automated grants
were first narrowed to executable objects and known CRX roles; the final fail-closed allowlist now
parks every `GRANT` and `REVOKE` for the separately reviewed manual path.

The same review proved that a workstation could retain a fresh-looking local ledger snapshot while
the GitHub workflow advanced production, then attempt an older direct migration. A new source-only
bootstrap migration installs one exact database trigger that serializes every ledger-insert channel
and rejects missing timestamps or timestamps that do not advance the ledger. The workflow verifies that trigger's exact
shape and function-body hash before candidate SQL and immediately before its own ledger insert.
