## 2026-08-28 - Hands-free migration proof content-binding diagnostic

The migration apply guard now retains the reason when a fresh, clean, exact-name reviewer proof is
present but its SQL hash is missing or mismatched. In an armed hands-free run it fails closed with the
specific content-binding refusal before the generic missing-proof instructions. Interactive applies
retain their existing generic refusal. Regression coverage proves both missing and mismatched
reviewer hashes are identified without weakening the authorization gate.
