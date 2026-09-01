## 2026-08-27 - Production migration hard rules and main freeze

Exact-commit adversarial review proved that the automated SQL allowlist admitted database objects
that require deeper CRX security proof and that a `main` merge could race the final database apply.

The automated path now parks tables, functions, procedures, policies, grants, and revokes for manual
review. After Mason's protected-environment approval, a separate environment-only administrative
credential creates an exact no-bypass ruleset that freezes `main` through the database transaction.
The workflow verifies the freeze and removes only its own run-scoped rule during cleanup; a failed
cleanup remains fail-closed with `main` frozen for manual inspection.
