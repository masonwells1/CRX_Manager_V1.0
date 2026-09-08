## 2026-09-08 - Close final migration-proof review gaps

- Bound migration-proof acceptance to the current authoritative GitHub `main` reviewer-policy commit, so an otherwise-valid proof cannot outlive a charter update merely because its old policy commit remains in the candidate history.
- Added complete literal production RPC inventory evidence, including escaped JavaScript member names, and fail-closed handling for malformed accesses.
- Marked catalog-derived or dynamically constructed historic routine DDL as unverified in inspection packets and refused proof minting until a proof-bound `pg_proc` snapshot can establish the effective signature, overload, body, and ACL.
